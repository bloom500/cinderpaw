import { useCallback } from 'react';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { useUI } from '@/stores/ui';
import { useAgent } from '@/stores/agent';
import { useChatStream } from './useChatStream';
import { toIpcMessage, voiceToPersisted } from '@/lib/messageMapping';
import { currentInferParams } from '@/lib/inferParams';
import { autoTitle } from '@/lib/autoTitle';
import { splitThinking } from '@/lib/parseThink';
import { tauri, type PersistedMessage } from '@/lib/tauri';
import { buildMemoryContext, extractChatMemory } from '@/lib/chatMemory';
import { decodeToPcm16k } from '@/lib/audio';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

/**
 * The token line shown under a finished reply.
 *
 * `usageCompletionTokens` is the provider's own count and arrives only on cloud
 * streams; a local model never reports one. chars/4 is the fallback, and it is
 * a rule of thumb that is wrong by a different amount in every language and on
 * every tokenizer.
 *
 * Which one produced the number has to travel with it. The same mistake in the
 * cost ledger — our estimate stored in the column that says "the provider said
 * so" — is what made "is the cache working" unanswerable for a week, and this
 * number is worse to get wrong because a person reads it. So: the real one wins
 * where it exists, and `tokensEstimated` marks the rest.
 */
export function finalTokenStats(
  usageCompletionTokens: number | null,
  charCount: number,
  elapsedSec: number,
): { tokenCount: number; tokensPerSec: number; tokensEstimated: boolean } {
  const tokenCount = usageCompletionTokens ?? Math.round(charCount / 4);
  return {
    tokenCount,
    tokensPerSec: elapsedSec > 0 ? Math.round(tokenCount / elapsedSec) : 0,
    tokensEstimated: usageCompletionTokens === null,
  };
}

/** How a spoken answer is shaped, whatever tools the turn has. */
const VOICE_SHAPE = [
  '- Two or three sentences. If the full answer is longer, say the short version and offer the rest.',
  '- Plain spoken language. No markdown, no headings, no bullet lists, no code blocks, no emoji.',
  '- No preamble and no summary of what you are about to say — just say it.',
  '- If you need to show something long (code, a table, a list), say so briefly and write it in the chat instead.',
].join('\n');

/**
 * The brief for a call that CAN act: search, read, run things.
 *
 * The point is that being brief is a property of the words, not of the work — a
 * spoken answer that skipped the lookup is just a faster wrong answer.
 */
const VOICE_WITH_TOOLS = [
  'This turn is a VOICE CALL: your answer will be read out loud by a speech engine,',
  'and the person is listening, not reading.',
  '',
  'This changes how you SPEAK, not what you DO. Search, read files, run commands — use',
  'every tool exactly as you would in a typed conversation, and do the work before',
  'answering. Being brief is about the words, never about doing less.',
  '',
  VOICE_SHAPE,
].join('\n');

/**
 * The brief for a call that has NO tools, and the reason this pair exists.
 *
 * A voice call in chat mode with no tools enabled was still told to "search,
 * read files, run commands". It has none, so the only thing it can do is SAY it
 * searched — and the tool panel stays empty because nothing ran. From the
 * listener's side that is indistinguishable from broken telemetry, and it is
 * worse than a missing feature: it is the agent claiming work it did not do.
 */
const VOICE_WITHOUT_TOOLS = [
  'This turn is a VOICE CALL: your answer will be read out loud by a speech engine,',
  'and the person is listening, not reading.',
  '',
  'You have NO tools this turn: you cannot search the web, read files or run',
  'anything. Answer from what you already know. If the answer needs a lookup you',
  'cannot do, say so plainly in one sentence — never describe searching, checking',
  'or looking something up, because none of that is happening.',
  '',
  VOICE_SHAPE,
].join('\n');

/**
 * What a good answer is when it will be spoken out loud.
 *
 * Mirrors the sidecar's brief in `FeralAgent/src/dispatch.ts` — the agent path
 * receives it as a surface drawer, the plain chat path as a system-prompt suffix.
 * Kept as two copies rather than one shared file because the two live on
 * opposite sides of a process boundary; if they drift, the symptom is a spoken
 * answer that reads like a document, which is exactly what this fixes.
 */
export function voiceSurfaceBrief(hasTools: boolean): string {
  return hasTools ? VOICE_WITH_TOOLS : VOICE_WITHOUT_TOOLS;
}

export function buildUserContent(text: string, files: AttachedFile[]): string {
  const textFiles = files.filter((f) => f.content !== null);
  const imageFiles = files.filter((f) => f.kind === 'image' && f.dataUrl);
  // Binary files with no extractable text still reach the model as a path
  // reference (the agent can read them with its file tools). Previously these
  // were silently dropped — "I uploaded a file but it never reached you".
  const binaryFiles = files.filter((f) => f.content === null && f.kind !== 'image');
  if (textFiles.length === 0 && imageFiles.length === 0 && binaryFiles.length === 0) return text;
  const blocks = [
    // Closing marker lets the chat bubble reliably strip the inlined content
    // back out for display (showing a "Feral.pdf" chip instead of the whole
    // file) — see parseUserAttachments(). It also gives the model a clear file
    // boundary. Keep the marker format in sync with that parser.
    ...textFiles.map((f) => `[File: ${f.name}]\n${f.content}\n[/File: ${f.name}]`),
    // Text-only models can't see pixels — note the attachment so the model
    // can at least acknowledge it instead of silently ignoring the upload.
    ...imageFiles.map((f) => `[Image attached: ${f.name}]`),
    ...binaryFiles.map((f) =>
      f.path.startsWith('clipboard://')
        ? `[File attached: ${f.name} — binary, no extractable text]`
        : `[File attached: ${f.name} — binary file at path: ${f.path}. If you have file tools, you can read it from that path.]`,
    ),
  ];
  return `${blocks.join('\n\n')}\n\n${text}`;
}

export function useSendMessage() {
  const stream = useChatStream(useChat.getState().sessionId);

  return useCallback(
    async (
      text: string,
      files: AttachedFile[] = [],
      opts?: {
        voice?: ChatMessage['voice'];
        existingUserId?: string;
        /** `'voice'` when this answer will be spoken aloud. */
        surface?: 'voice' | 'text';
      },
    ) => {
      const chat = useChat.getState();
      const { reasoningMode, enabledTools } = useUI.getState();
      const { loaded, cloudModel } = useModel.getState();
      const modelName = cloudModel?.modelId ?? loaded?.name ?? '';

      const content = buildUserContent(text, files);
      const images = files
        .filter((f) => f.kind === 'image' && f.dataUrl)
        .map((f) => f.dataUrl!);

      const userMsg = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content,
        ...(images.length > 0 ? { images } : {}),
        ...(opts?.voice ? { voice: opts.voice } : {}),
        createdAt: Date.now(),
      };
      const asstMsg = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: '',
        thinkingComplete: true,
        createdAt: Date.now() + 1,
      };
      if (opts?.existingUserId) {
        // Voice flow: the user bubble was added optimistically (instant
        // playback + waveform) before transcription finished. Fill in the
        // transcript + final voice meta and clear the pending flag instead of
        // adding a duplicate message.
        chat.patchMessage(opts.existingUserId, {
          content,
          voicePending: false,
          ...(images.length > 0 ? { images } : {}),
          ...(opts?.voice ? { voice: opts.voice } : {}),
        });
      } else {
        chat.addMessage(userMsg);
      }
      chat.addMessage(asstMsg);
      chat.setStreamStatus('streaming');

      // Capture everything we need to finish this turn even if the user
      // navigates away mid-stream (which changes the active chat session
      // out from under us). All completion work keys off these captured
      // values, not "whatever session is current".
      const sessionId   = useChat.getState().sessionId;
      const asstId      = asstMsg.id;
      const snapshot    = useChat.getState().messages.map((m) => ({ ...m }));
      const isActive    = () => useChat.getState().sessionId === sessionId;

      // Save immediately so the chat appears in the sidebar's Recent
      // section while the model is still generating. The user can then
      // switch tabs and still see (and rejoin) the in-flight chat.
      // The store also marks this session as streaming so the sidebar
      // renders a spinner next to it.
      useConversations.getState().markStreaming(sessionId);
      try {
        await useConversations.getState().saveCurrent(autoTitle(useChat.getState().messages));
      } catch (err) {
        // Non-fatal — the final save in onDone will retry.
        console.error('[chat] failed initial save to Recent:', err);
      }

      const messages = useChat.getState().messages.slice(0, -1).map(toIpcMessage);

      // Agent mode override: when an active agent exists, its
      // system_prompt and tool list are authoritative. This lets the
      // same hook serve both Chat (user-controlled) and Agents
      // (agent-controlled) without two parallel code paths.
      const agent = useAgent.getState().current;
      const effectiveEnabledTools = agent ? agent.tools : enabledTools;
      const effectiveSystemPrompt = agent ? agent.system_prompt : undefined;

      const params = await currentInferParams({
        reasoningMode,
        modelName,
        enabledTools: effectiveEnabledTools,
        systemPromptOverride: effectiveSystemPrompt,
      });

      // A spoken answer needs a different shape than a written one. The agent path
      // gets this as a surface brief from the sidecar; the plain chat path has no
      // sidecar, so it goes into the system prompt here — same words, same reason.
      if (opts?.surface === 'voice') {
        // WHICH brief depends on whether this turn actually has tools. Telling a
        // toolless call to "search the web" is how the agent ends up narrating
        // work it never did, while the tool panel stays correctly empty.
        params.system_prompt = [params.system_prompt, voiceSurfaceBrief(effectiveEnabledTools.length > 0)]
          .filter(Boolean)
          .join('\n\n');
      }

      // Memory recall (chat mode only — agents carry their own prompt):
      // append what past conversations taught us about the user, so a fresh
      // chat doesn't open completely cold.
      if (!agent) {
        const memoryContext = await buildMemoryContext(sessionId);
        if (memoryContext) {
          params.system_prompt = params.system_prompt
            ? `${params.system_prompt}\n\n${memoryContext}`
            : memoryContext;
        }
      }

      // `buffer` is for think-tag parsing; `answer` is the clean (think-stripped)
      // text we persist when the turn completes. We accumulate both regardless
      // of whether the user is still on this chat, so the response is
      // recoverable from disk even if they navigated away.
      let buffer = '';
      let answer = '';
      let thinkingStartAt: number | null = null;
      let thinkingDurationMsFixed = false;
      let streamStartAt: number | null = null;
      let charCount = 0;
      // The provider's own completion count, when it sends one. `onUsage` fires
      // at most once, at the end of a cloud stream; a local model never sends
      // it. Kept here rather than read back off the live-token store because
      // that store is per-session and a second tab would clobber it mid-turn.
      let usageCompletionTokens: number | null = null;

      // RAF-based flushing: accumulate token patches between frames so React
      // re-renders once per animation frame (~60fps) instead of once per token.
      // This produces smooth word-by-word streaming without overwhelming the renderer.
      let rafId: number | null = null;
      const pendingPatch: Partial<ChatMessage> = {};

      const flushNow = () => {
        if (Object.keys(pendingPatch).length > 0) {
          // Only patch the live chat view when this session is on screen —
          // otherwise tokens would leak into whatever conversation the user
          // opened after switching tabs.
          if (isActive()) {
            useChat.getState().updateLastAssistantMessage({ ...pendingPatch });
          }
        }
        rafId = null;
      };

      const scheduleFlush = () => {
        if (rafId === null) {
          rafId = requestAnimationFrame(flushNow);
        }
      };

      const cancelFlush = () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      };

      // Persist the finished turn to THIS conversation by id — correct even
      // when it is no longer the active session (user switched tabs).
      const persistFinal = async () => {
        const persisted: PersistedMessage[] = snapshot.map((m) => ({
          role: m.role,
          content: m.id === asstId ? answer : m.content,
          thinking: m.thinking || undefined,
          voice: voiceToPersisted(m.voice),
          // This is the plain-chat path (no Feral agent, so nothing writes to
          // the scratchpad here) — but it re-saves the WHOLE conversation, so
          // omitting the field would wipe the stats off every earlier agent turn.
          scratch: m.scratch,
        }));
        try {
          await tauri.conversations.save(sessionId, autoTitle(snapshot), persisted);
          await useConversations.getState().refresh();
        } catch (err) {
          console.error('[chat] failed final save to Recent:', err);
        }
      };

      const streamMethod = cloudModel
        ? (cb: Parameters<typeof stream.start>[2]) => stream.startCloud(cloudModel, messages, params, cb)
        : (cb: Parameters<typeof stream.start>[2]) => stream.start(messages, params, cb);

      await streamMethod({
        onToken: (chunk) => {
          if (streamStartAt === null) streamStartAt = Date.now();
          charCount += chunk.length;
          buffer += chunk;
          const split = splitThinking(buffer);
          answer = split.answer;

          pendingPatch.content = split.answer;

          if (split.thinking !== null) {
            pendingPatch.thinking = split.thinking;
            pendingPatch.thinkingComplete = split.thinkingComplete;
            if (thinkingStartAt === null) thinkingStartAt = Date.now();
            if (split.thinkingComplete && !thinkingDurationMsFixed && thinkingStartAt !== null) {
              pendingPatch.thinkingDurationMs = Date.now() - thinkingStartAt;
              thinkingDurationMsFixed = true;
            }
          }

          scheduleFlush();
        },
        onDone: async () => {
          // Flush any remaining buffered patch before computing final stats
          cancelFlush();
          flushNow();

          const completedAt = Date.now();
          const elapsedSec = streamStartAt ? (completedAt - streamStartAt) / 1000 : 0;
          const stats = finalTokenStats(usageCompletionTokens, charCount, elapsedSec);
          if (isActive()) {
            useChat.getState().updateLastAssistantMessage({ completedAt, ...stats });
            useChat.getState().setStreamStatus('done');
          }
          useConversations.getState().unmarkStreaming(sessionId);
          await persistFinal();
          // Learning pass: extract durable user facts from the completed
          // turn into the shared knowledge graph. Fire-and-forget.
          if (!agent) {
            const turn = snapshot.map((m) => ({
              role: m.role,
              content: m.id === asstId ? answer : m.content,
            }));
            void extractChatMemory(turn, cloudModel);
          }
        },
        onError: (err) => {
          cancelFlush();
          if (isActive()) useChat.getState().setStreamStatus('error', err);
          useConversations.getState().unmarkStreaming(sessionId);
        },
        onStopped: () => {
          cancelFlush();
          if (isActive()) useChat.getState().setStreamStatus('stopped');
          useConversations.getState().unmarkStreaming(sessionId);
          // Persist the partial answer so the user doesn't lose the work
          // they waited for.
          void persistFinal();
        },
        onTruncated: (reason) => {
          // Model hit max_tokens before producing a natural stop.
          // Flush the pending patch, mark the message as truncated, and
          // still try to save it to Recent.
          cancelFlush();
          flushNow();
          if (isActive()) {
            useChat.getState().updateLastAssistantMessage({
              truncated: true,
              truncatedReason: reason,
            });
            useChat.getState().setStreamStatus('done');
          }
          useConversations.getState().unmarkStreaming(sessionId);
          void persistFinal();
        },
        onStart: (promptTokens) => {
          if (isActive()) useChat.getState().setLiveTokens(promptTokens);
        },
        onUsage: (promptTokens, completionTokens) => {
          usageCompletionTokens = completionTokens;
          if (isActive()) useChat.getState().setLiveTokens(promptTokens, completionTokens);
        },
      });
    },
    [stream],
  );
}

/**
 * Voice send: persist the blob, decode to 16 kHz PCM, transcribe on-device,
 * then push the transcript through the normal send pipeline tagged with voice
 * metadata. Transcription errors ("model-missing" | "voice-unavailable") are
 * re-thrown so the caller can surface a toast.
 */
/**
 * Persist a recorded blob to disk and return its on-disk asset path. Fast (a
 * single file write), so the caller can show the voice bubble immediately and
 * transcribe afterwards.
 */
export async function saveVoiceBlobToDisk(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
  console.log('[voice] saveVoiceBlob', { blobSize: blob.size, blobType: blob.type, ext, bytes: buf.length });
  const audioPath = await tauri.voice.saveBlob(Array.from(buf), ext);
  console.log('[voice] saved blob ->', audioPath);
  return audioPath;
}

/**
 * Transcribe a recorded blob. Routes by the chosen STT provider:
 *  - `groq` → cloud whisper-large-v3 (uploads the saved file; needs a key).
 *  - local (default) → decode to 16 kHz PCM + on-device whisper.
 * Slow either way, so it runs in the background after the optimistic bubble is
 * on screen. Errors ("stt-no-key" | "stt-cloud-failed" | "model-missing" |
 * "voice-unavailable") propagate to the caller for toast handling.
 */
export async function transcribeVoiceBlob(blob: Blob, audioPath: string): Promise<string> {
  const { whisperModel, sttProvider } = useUI.getState();
  if (sttProvider === 'groq') {
    // No language is ever sent. Whisper's `language` is an ORDER, not a hint:
    // an English UI once forced `language=en` on Romanian speech and turned
    // "Salut, Feral" into "Pozdvormiu Română!", and a stored preference is the
    // same mistake with the user's name on it. Detection runs per request, so a
    // wrong guess costs one turn instead of every turn after it.
    const transcript = await tauri.voice.transcribeCloud(audioPath, 'groq', undefined);
    console.log('[voice] cloud transcript ->', JSON.stringify(transcript));
    return transcript;
  }
  const pcm = await decodeToPcm16k(blob);
  console.log('[voice] transcribe decoded', { pcmLength: pcm.length });
  const transcript = await tauri.voice.transcribe(Array.from(pcm), whisperModel);
  console.log('[voice] transcript ->', JSON.stringify(transcript));
  return transcript;
}
