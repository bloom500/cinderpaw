import { useCallback } from 'react';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { useUI } from '@/stores/ui';
import { useAgent } from '@/stores/agent';
import { useChatStream } from './useChatStream';
import { toIpcMessage } from '@/lib/messageMapping';
import { currentInferParams } from '@/lib/inferParams';
import { autoTitle } from '@/lib/autoTitle';
import { splitThinking } from '@/lib/parseThink';
import { tauri, type PersistedMessage } from '@/lib/tauri';
import { buildMemoryContext, extractChatMemory } from '@/lib/chatMemory';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

export function buildUserContent(text: string, files: AttachedFile[]): string {
  const textFiles = files.filter((f) => f.content !== null);
  const imageFiles = files.filter((f) => f.kind === 'image' && f.dataUrl);
  if (textFiles.length === 0 && imageFiles.length === 0) return text;
  const blocks = [
    ...textFiles.map((f) => `[File: ${f.name}]\n${f.content}`),
    // Text-only models can't see pixels — note the attachment so the model
    // can at least acknowledge it instead of silently ignoring the upload.
    ...imageFiles.map((f) => `[Image attached: ${f.name}]`),
  ];
  return `${blocks.join('\n\n')}\n\n${text}`;
}

export function useSendMessage() {
  const stream = useChatStream(useChat.getState().sessionId);

  return useCallback(
    async (text: string, files: AttachedFile[] = []) => {
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
        createdAt: Date.now(),
      };
      const asstMsg = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: '',
        thinkingComplete: true,
        createdAt: Date.now() + 1,
      };
      chat.addMessage(userMsg);
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
          const tokenCount = Math.round(charCount / 4);
          const tokensPerSec = elapsedSec > 0 ? Math.round(tokenCount / elapsedSec) : 0;
          if (isActive()) {
            useChat.getState().updateLastAssistantMessage({ completedAt, tokenCount, tokensPerSec });
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
          if (isActive()) useChat.getState().setLiveTokens(promptTokens, completionTokens);
        },
      });
    },
    [stream],
  );
}
