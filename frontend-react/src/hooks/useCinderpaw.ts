/**
 * useCinderpaw — React integration for the Cinderpaw Agent sidecar.
 *
 * Wraps `cinderpaw_send_message` + `cinderpaw://agent-output` events into a
 * streaming callback interface. The only inference path the composer has.
 */

import { useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChat, type ChatMessage, type MemoryUsedItem, type TurnEnd, TOOL_CALL_LINGER_MS } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useAgent } from '@/stores/agent';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useNotifications } from '@/stores/notifications';
import { useFollowUps } from '@/stores/followUps';
import { notifyIfBackground, preview } from '@/lib/systemNotify';
import { failArtifactRequests, useArtifacts, type DraftEvent } from '@/stores/artifacts';
import { t } from '@/lib/i18n';
import { autoTitle } from '@/lib/autoTitle';
import { titleConversation } from '@/lib/chatTitle';
import { voiceToPersisted } from '@/lib/messageMapping';
import { splitThinking, stripStreamingToolCalls } from '@/lib/parseThink';
import { events, tauri, type CinderpawAgentEvent, type PersistedMessage } from '@/lib/tauri';
import {
  ensureCinderpawListener,
  registerCinderpawStream,
  requestCinderpawStop,
  isCinderpawStreaming,
} from '@/lib/cinderpawAgentStream';
import {
  beginLiveSession,
  updateLiveSession,
  pushLiveToolCall,
  completeLiveToolCall,
  endLiveSession,
  getLiveSession,
  getLiveToolStrip,
} from '@/lib/cinderpawLiveSession';
import { extractMainArg } from '@/components/chat/mascot/extractMainArg';
import { startActivity, finishActivity, type ToolActivity } from '@/hooks/useLiveToolActivity';
import { emojiForTool } from '@/components/chat/mascot/emojiForTool';
import type { MascotState } from '@/components/chat/mascot/frames';

interface StreamCallbacks {
  onToken:      (chunk: string) => void;
  onDone:       (finalContent?: string, stopped?: boolean) => void;
  onError:      (err: string) => void;
  onStopped:    () => void;
  onTruncated?: (reason: string) => void;
  onToolStart?: (callId: string, tool: string, args: Record<string, unknown>) => void;
  onToolDone?:  (callId: string, tool: string, result: unknown) => void;
  onUsage?:     (promptTokens: number, completionTokens: number) => void;
  onMemoryUsed?: (items: MemoryUsedItem[]) => void;
  /**
   * React-side id of the assistant message that this stream will populate.
   * Threaded into the inflight stream entry so the ask_user flow can attach
   * the question card to the right message (the card is rendered off
   * `message.askUser`, so without this the card never appears).
   */
  chatMessageId: string;
}

interface MascotStateSink {
  setMascotState(state: MascotState): void;
}

/**
 * Coerce a tool result of unknown shape into an ok/error boolean.
 *
 * The sidecar returns `{ ok: boolean, content: string, error?: string }`
 * for registered tools. Defensive: if `result` is missing or doesn't
 * follow that shape, treat it as success (legacy behaviour — older
 * versions of the sidecar returned the raw tool output as `result`).
 */
function isOkResult(result: unknown): boolean {
  if (result && typeof result === 'object' && 'ok' in (result as object)) {
    return Boolean((result as { ok: unknown }).ok);
  }
  return true;
}

export { type MascotStateSink };

/**
 * Join two answer segments with a blank line. Multi-step agent turns emit
 * prose, call a tool, then emit more prose; without joining, only the segment
 * after the LAST tool call survived (the rest was wiped on tool_start).
 */
const joinSegments = (a: string, b: string): string => (a && b ? a + '\n\n' + b : a + b);

/**
 * `JSON.stringify` that cannot throw.
 *
 * A tool result holding a cycle — a node that references its parent, a handle
 * that references its own registry — threw here, inside a stream callback with
 * nothing to catch it: the tool's preview vanished and the rejection went
 * unhandled. A tool that returns an awkward shape should still show its result.
 */
/** One line of untrusted text, trimmed to something a toast can hold. */
function toastText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return `${String(value)} [could not be shown in full]`;
  }
}

export function useCinderpawStream(chatSessionId: string) {
  const send = useCallback(
    async (
      content: string,
      callbacks: StreamCallbacks,
      images?: string[],
      surface?: 'voice' | 'text',
    ) => {
      await ensureCinderpawListener();

      // A fresh send is an implicit interrupt of any stream still in flight
      // for this session. Without this, the previous generation's chunks keep
      // racing the new one into the same chat (audit A2).
      if (isCinderpawStreaming(chatSessionId)) {
        await requestCinderpawStop(chatSessionId);
      }

      let messageId: string;
      try {
        // The Controls-panel temperature reaches the agent too. max_tokens does
        // not: no slider sets it, so the stored 4096 was a hidden cap on every
        // reply, and a long document written in one tool call was cut off and
        // shown as "The model returned an empty response" (25 Oct). Without it
        // the sidecar picks its own ceiling per provider.
        const { temperature } = useModel.getState().inferParams;
        messageId = await invoke<string>('cinderpaw_send_message', {
          content,
          sessionId: chatSessionId,
          images: images && images.length > 0 ? images : null,
          inferParams: { temperature },
          // Declared per message, not per session: the same conversation is
          // spoken to and typed in alternately, and the format brief has to follow
          // whichever is happening right now. Typed is 'text': it also tells the
          // sidecar this window can show request_secret's password field.
          surface: surface ?? 'text',
        });
      } catch (err) {
        callbacks.onError(String(err));
        return;
      }
      // A 👍 on this reply teaches only if it names the turn the engine knows.
      useChat.getState().patchMessage(callbacks.chatMessageId, { agentMessageId: messageId });

      registerCinderpawStream(messageId, {
        onChunk: (c) => callbacks.onToken(c),
        onDone: (fc, stopped) => callbacks.onDone(fc, stopped),
        onError: (m) => callbacks.onError(m),
        onStopped: () => callbacks.onStopped(),
        onToolStart: callbacks.onToolStart ? (cid, t, a) => callbacks.onToolStart!(cid, t, a) : undefined,
        onToolDone: callbacks.onToolDone ? (cid, t, r) => callbacks.onToolDone!(cid, t, r) : undefined,
        onUsage: callbacks.onUsage ? (p, c) => callbacks.onUsage!(p, c) : undefined,
        onMemoryUsed: callbacks.onMemoryUsed,
        // Ask_user events carry the sidecar's requestId, not a stream
        // messageId — so the stream manager can't tie the question to a
        // specific message on its own. Pass the React-side asstId so the
        // ask_user flow can patch the right message with `askUser` (which
        // is what makes AskUserCard actually appear in the chat list).
        chatMessageId: callbacks.chatMessageId,
        // Lets requestCinderpawStop(sessionId) stop only this session's streams.
        sessionId: chatSessionId,
      });
    },
    [chatSessionId],
  );

  return { send };
}

export function useCinderpawSendMessage(chatSessionId: string, mascotSink?: MascotStateSink) {
  const { send } = useCinderpawStream(chatSessionId);

  return useCallback(
    async (
      content: string,
      images?: string[],
      opts?: {
        voice?: ChatMessage['voice'];
        existingUserId?: string;
        /** `'voice'` when this answer will be spoken aloud — see `cinderpaw_send_message`. */
        surface?: 'voice' | 'text';
      },
    ) => {
      const chat = useChat.getState();
      useFollowUps.getState().clearSession(chatSessionId);

      const userMsg = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content,
        ...(images && images.length > 0 ? { images } : {}),
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
        // Voice flow: the user bubble was added optimistically before
        // transcription. Fill in the transcript instead of duplicating it.
        chat.patchMessage(opts.existingUserId, {
          content,
          voicePending: false,
          ...(images && images.length > 0 ? { images } : {}),
          ...(opts?.voice ? { voice: opts.voice } : {}),
        });
      } else {
        chat.addMessage(userMsg);
      }
      chat.addMessage(asstMsg);
      chat.setStreamStatus('streaming');

      const sessionId = useChat.getState().sessionId;
      const snapshot  = [...useChat.getState().messages];
      const asstId    = asstMsg.id;
      const agentId   = useAgent.getState().current?.id ?? null;
      const isActive  = () => useChat.getState().sessionId === sessionId;

      // Mirror every streaming update keyed by sessionId — even while the
      // user is on another chat/tab — so re-entering this conversation can
      // rehydrate the live state instead of the stale disk snapshot.
      beginLiveSession(sessionId);
      const syncToolStrip = () => {
        if (!isActive()) return;
        const strip = getLiveToolStrip(sessionId);
        if (strip) useChat.setState({ toolCallStream: strip });
      };

      useConversations.getState().markStreaming(sessionId);
      try {
        await useConversations.getState().saveCurrent(autoTitle(useChat.getState().messages), agentId);
      } catch (err) {
        console.error('[cinderpaw] failed initial save to Recent:', err);
      }

      const state = {
        buffer: '',
        answer: '',
        // Prose from segments BEFORE the current one, joined. A multi-step
        // answer (prose → tool → prose → tool → prose) accumulates here so
        // the whole response survives instead of only the last segment.
        committed: '',
        thinkingStartMs: 0,
        thinkingDurationRecorded: false,
        toolCallCount: 0,
        // What the agent wrote in its own scratchpad this turn. Accumulated
        // here rather than read off the bubble strip because that strip holds
        // four entries and is wiped five seconds after the turn ends — it
        // answers "what is it doing", and this has to answer "what did it do".
        scratch: { edits: 0, added: 0, removed: 0 },
        // The widgets drawn inside this reply: one per tool call, in order.
        // Built here, next to the mascot's bubbles, because this is the one
        // place that knows which reply a tool event belongs to.
        tools: [] as ToolActivity[],
        // Set when the person stops the turn or it fails; saved with the reply.
        ended: undefined as TurnEnd | undefined,
        // The memories this turn was given, kept here so a reply that finishes
        // while another chat is on screen still saves them.
        memoryUsed: undefined as MemoryUsedItem[] | undefined,
      };
      /**
       * A turn that ends with a tool still open never gets that tool's result.
       * Its widget would spin forever; saying why it stopped is the honest
       * display, the same conclusion the mascot strip draws as `cancelled`.
       */
      /** How the turn ended, on the reply on screen and in what persistFinal saves. */
      const markEnded = (end: TurnEnd) => {
        state.ended = end;
        if (isActive()) useChat.getState().updateLastAssistantMessage({ ended: end });
      };
      const settleTools = (why: string) => {
        if (!state.tools.some((a) => a.status === 'running')) return;
        state.tools = state.tools.map((a) =>
          a.status === 'running' ? { ...a, status: 'failed' as const, endedAt: Date.now(), error: why } : a,
        );
        syncTools();
      };
      /** Push the widgets to the mirror, and to the screen when this chat is on it. */
      const syncTools = () => {
        const toolActivity = [...state.tools];
        updateLiveSession(sessionId, { toolActivity });
        if (isActive()) useChat.getState().updateLastAssistantMessage({ toolActivity });
      };

      const persistFinal = async () => {
        // The snapshot was taken when the turn started, and the store replaces a
        // message object as it streams rather than mutating it. So `thinking`,
        // which arrives DURING the turn, was read off the stale copy and saved as
        // undefined: the block was there until you left the chat and never came
        // back. The snapshot still decides WHICH messages belong to this save;
        // the store decides what each of them currently says.
        const live = new Map(useChat.getState().messages.map((m) => [m.id, m] as const));
        const persisted: PersistedMessage[] = snapshot.map((s0) => {
          const m = live.get(s0.id) ?? s0;
          const mem = m.id === asstId ? state.memoryUsed : m.memoryUsed;
          return {
          role: m.role,
          content: m.id === asstId ? joinSegments(state.committed, state.answer) : m.content,
          thinking: m.thinking || undefined,
          thinking_ms: m.thinkingDurationMs,
          voice: voiceToPersisted(m.voice),
          // The turn being finalised has its stats in `state`; earlier messages
          // in the snapshot carry their own from when they were live. Without
          // the first half the line vanished on the very save meant to keep it.
          scratch:
            m.id === asstId && state.scratch.edits > 0 ? { ...state.scratch } : m.scratch,
          tools: m.id === asstId
            ? (state.tools.length > 0 ? state.tools : undefined)
            : (m.toolActivity && m.toolActivity.length > 0 ? m.toolActivity : undefined),
          created_at: m.createdAt,
          ended: m.id === asstId ? state.ended : m.ended,
          memory_used: mem?.length ? mem : undefined,
          }; });
        try {
          await tauri.conversations.save(sessionId, autoTitle(snapshot), persisted, agentId);
          await useConversations.getState().refresh();
          // After the first answer, a short name instead of the first message cut at 40 characters.
          void titleConversation(sessionId, persisted);
        } catch (err) {
          console.error('[cinderpaw] failed final save to Recent:', err);
        }
      };

      // The streamed text, rendered. The buffer is read whole each time, so
      // one call after many tokens is the same as one call after each.
      let tokenFrame: number | null = null;
      const renderTokens = () => {
        tokenFrame = null;
        const split = splitThinking(state.buffer);
        // Suppress tool-call text anywhere in the stream (prose before a
        // mid-message <tool_call> stays visible; the call itself never does).
        const visibleAnswer = stripStreamingToolCalls(split.answer);
        state.answer = visibleAnswer;
        const display = joinSegments(state.committed, visibleAnswer);
        updateLiveSession(sessionId, {
          content: display,
          ...(split.thinking !== null
            ? { thinking: split.thinking, thinkingComplete: split.thinkingComplete }
            : {}),
          agentPhase: 'thinking',
        });
        if (isActive()) {
          const chat = useChat.getState();
          const patch: Partial<ChatMessage> = { content: display };
          if (split.thinking !== null) {
            if (state.thinkingStartMs === 0) state.thinkingStartMs = Date.now();
            patch.thinking = split.thinking;
            patch.thinkingComplete = split.thinkingComplete;
            if (split.thinkingComplete && !state.thinkingDurationRecorded && state.thinkingStartMs > 0) {
              patch.thinkingDurationMs = Date.now() - state.thinkingStartMs;
              state.thinkingDurationRecorded = true;
            }
          }
          chat.updateLastAssistantMessage(patch);
          if (chat.agentPhase !== 'thinking') chat.setAgentPhase('thinking');
        }
      };
      /** Renders what is buffered now: every other event reads the answer the tokens built. */
      const flushTokens = () => {
        if (tokenFrame === null) return;
        cancelAnimationFrame(tokenFrame);
        renderTokens();
      };

      await send(content, {
        // Pass the React-side asst message id so the ask_user flow can
        // attach the question card to the right message (the card reads
        // off `message.askUser`; without this the card never renders).
        chatMessageId: asstId,
        onToken: (token) => {
          useConversations.getState().setProviderWait(sessionId, 0);
          state.buffer += token;
          // Once per frame, like the local chat's stream: a burst of tokens
          // was a burst of renders inside one frame. A hidden window paints no
          // frames and runs no frame callbacks, so there it updates at once.
          if (tokenFrame !== null) return;
          if (document.hidden) renderTokens();
          else tokenFrame = requestAnimationFrame(renderTokens);
        },
        onToolStart: (_callId, tool, args) => {
          flushTokens();
          state.toolCallCount += 1;
          // Commit the prose emitted before this tool call so it survives the
          // buffer reset; otherwise only the segment after the LAST tool call
          // reached the bubble (the "only the last sentence" bug).
          if (state.answer.trim()) state.committed = joinSegments(state.committed, state.answer);
          // Everything said so far is `committed` now, so its length is where
          // this call sits in the reply: the timeline draws the tool there.
          state.tools.push({ ...startActivity(tool, args), at: state.committed.length });
          syncTools();
          state.buffer = '';
          state.answer = '';
          state.thinkingStartMs = 0;
          state.thinkingDurationRecorded = false;
          // The mirror is authoritative for the tool strip — it accumulates
          // even while the user is on another chat, and `syncToolStrip`
          // copies it into the store only when this session is on screen.
          pushLiveToolCall(sessionId, {
            id: crypto.randomUUID(),
            kind: 'tool',
            name: tool,
            emoji: emojiForTool(tool),
            mainArg: extractMainArg(tool, args),
            status: 'running',
            startedAt: Date.now(),
            endedAt: null,
          });
          updateLiveSession(sessionId, {
            content: state.committed,
            thinking: null,
            agentPhase: 'calling',
            agentTool: tool,
          });
          if (isActive()) {
            useChat.getState().clearStreamingContent();
            // Keep prior segments on screen while the tool runs; clearing to ''
            // is what made earlier prose vanish.
            useChat.getState().updateLastAssistantMessage({ content: state.committed });
            useChat.getState().setAgentPhase('calling', tool);
            syncToolStrip();
          }
        },
        onToolDone: (_callId, tool, result) => {
          flushTokens();
          // Last running call of this tool: events carry no per-call id, and
          // the newest open one is the one a result belongs to.
          for (let i = state.tools.length - 1; i >= 0; i--) {
            const a = state.tools[i];
            if (a.tool === tool && a.status === 'running') {
              state.tools[i] = finishActivity(a, result);
              break;
            }
          }
          syncTools();
          // Scratchpad telemetry. `write_file` and `edit_file` report the line
          // delta they already had in hand, so this is a read of an existing
          // field, not a second measurement that could disagree with the first.
          const d = (result as { data?: Record<string, unknown> } | null | undefined)?.data;
          if (d?.scratch === true && isOkResult(result)) {
            state.scratch.edits += 1;
            state.scratch.added += typeof d.linesAdded === 'number' ? d.linesAdded : 0;
            state.scratch.removed += typeof d.linesRemoved === 'number' ? d.linesRemoved : 0;
          }
          // Find the most recent running entry with this tool name and
          // flip it to done/error. The mirror keys by id but we pair by
          // (name, status) so out-of-order events still resolve.
          const live = getLiveSession(sessionId);
          const lastRunning = live
            ? [...live.toolCallStream].reverse().find(
                (e) => e.kind === 'tool' && e.name === tool && e.status === 'running',
              )
            : undefined;
          if (lastRunning) {
            const ok = isOkResult(result);
            // #18: carry a capped output preview (and the error text on
            // failure) into the bubble so the user can expand what the
            // tool actually returned.
            const r = result as { content?: unknown; error?: unknown } | null | undefined;
            const rawPreview =
              typeof r?.content === 'string'
                ? r.content
                : result !== undefined && result !== null
                  ? safeStringify(result)
                  : '';
            completeLiveToolCall(sessionId, lastRunning.id, {
              ok,
              preview: rawPreview ? rawPreview.slice(0, 1500) : undefined,
              error: !ok && typeof r?.error === 'string' ? r.error : undefined,
            });
          }
          updateLiveSession(sessionId, { agentPhase: 'processing', agentTool: null });
          if (isActive()) {
            useChat.getState().setAgentPhase('processing');
            syncToolStrip();
          }
          // Fade-out: the mirror prunes finished bubbles only when it's next
          // touched (pull-based), so a completed bubble lingered forever between
          // tool calls / after the last one. Re-sync once the linger window has
          // passed so the now-expired bubble is pruned from the on-screen strip.
          window.setTimeout(() => syncToolStrip(), TOOL_CALL_LINGER_MS + 100);
        },
        // Memory Peek: which memories this reply was given. Only while the
        // chat is on screen; a background turn keeps its answer, not this.
        onMemoryUsed: (items) => {
          state.memoryUsed = items;
          if (isActive()) useChat.getState().updateLastAssistantMessage({ memoryUsed: items });
        },
        onUsage: (promptTokens, completionTokens) => {
          // Real per-completion token counts from the sidecar router. Mirror
          // them so the context ring rehydrates correctly after a tab switch,
          // and push to the store live when this session is on screen.
          updateLiveSession(sessionId, { promptTokens, completionTokens });
          if (isActive()) {
            useChat.getState().setLiveTokens(promptTokens, completionTokens);
          }
        },
        onDone: async (finalContent?: string, stopped = false) => {
          flushTokens();
          settleTools(stopped ? 'stopped' : 'no result');
          endLiveSession(sessionId);
          if (stopped) markEnded({ kind: 'stopped' });
          if (joinSegments(state.committed, state.answer).trim().length === 0 && finalContent?.trim()) {
            const cleaned = splitThinking(finalContent).answer.trim();
            if (cleaned) {
              state.answer = cleaned;
              if (isActive()) {
                useChat.getState().updateLastAssistantMessage({ content: joinSegments(state.committed, state.answer) });
              }
            }
          }
          if (isActive()) {
            // Attached to the MESSAGE, which persistFinal() writes to disk, so
            // it is still there tomorrow. The bubble strip below is deliberately
            // left ephemeral — it is the "working now" indicator, and this is
            // the record.
            if (state.scratch.edits > 0) {
              useChat.getState().updateLastAssistantMessage({ scratch: { ...state.scratch } });
            }
            useChat.getState().setStreamStatus('done');
            useChat.setState({ lastCompletionStopped: stopped });
            // 5s post-done window before clearing the bubble strip.
            setTimeout(() => useChat.getState().clearToolCallStream(), 5000);
          }
          // A stop before the first word still saves, so the line saying so survives a reload.
          if (stopped || joinSegments(state.committed, state.answer).trim().length > 0) await persistFinal();
          if (state.toolCallCount > 3 && mascotSink) {
            mascotSink.setMascotState('cool');
          }
          useConversations.getState().unmarkStreaming(sessionId);
        },
        onError: (err) => {
          flushTokens();
          settleTools('failed');
          endLiveSession(sessionId);
          markEnded({ kind: 'error', raw: String(err) });
          if (isActive()) useChat.getState().setStreamStatus('error', err);
          if (mascotSink) mascotSink.setMascotState('error');
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
        onStopped: () => {
          flushTokens();
          settleTools('stopped');
          endLiveSession(sessionId);
          markEnded({ kind: 'stopped' });
          if (isActive()) useChat.getState().setStreamStatus('stopped');
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
        onTruncated: (reason) => {
          flushTokens();
          settleTools('truncated');
          endLiveSession(sessionId);
          if (isActive()) {
            useChat.getState().updateLastAssistantMessage({ truncated: true, truncatedReason: reason });
            useChat.getState().setStreamStatus('done');
          }
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
      }, images, opts?.surface);
    },
    [send, mascotSink],
  );
}

export async function checkCinderpawAgentReady(): Promise<boolean> {
  try {
    return await invoke<boolean>('cinderpaw_agent_status');
  } catch {
    return false;
  }
}

export function useCinderpawGlobal() {
  const setReady      = useCinderpawStore((s) => s.setReady);
  const setModelError = useCinderpawStore((s) => s.setModelError);
  const setOffline    = useCinderpawStore((s) => s.setOffline);
  const fetchConfig   = useCinderpawStore((s) => s.fetchModelConfig);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    // listen() resolves asynchronously: StrictMode, navigation or hot reload
    // can clean up before it returns. Retire late registrations too, otherwise
    // each leaked callback appends the same artifact letters again.
    const subscribe = async <T,>(event: Parameters<typeof listen<T>>[0], callback: Parameters<typeof listen<T>>[1]) => {
      if (disposed) return;
      const unlisten = await listen<T>(event, (e) => { if (!disposed) callback(e); });
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    // A document being written arrives one piece per model token, hundreds a
    // part. Drawn one at a time, each piece cost the panel a whole render: it
    // fell seconds behind the model, and the saved version then landed on a
    // part still being shown as written (20 Oct). Pieces wait for the next
    // frame and go in together, one longer piece per document.
    let drafts: DraftEvent[] = [];
    let draftFrame: number | null = null;
    const flushDrafts = () => {
      if (draftFrame !== null) cancelAnimationFrame(draftFrame);
      draftFrame = null;
      const batch: DraftEvent[] = [];
      for (const d of drafts) {
        const last = batch[batch.length - 1];
        const same = last && last.id === d.id && last.draft === d.draft && last.editOf === d.editOf && last.find === d.find;
        if (same) batch[batch.length - 1] = { ...d, append: last.append + d.append };
        else batch.push(d);
      }
      drafts = [];
      for (const d of batch) useArtifacts.getState().onDraft(d);
    };

    let outputSubscribed = false;
    const requestFollowUp = () => {
      if (!outputSubscribed || !useFollowUps.getState().enabled) return;
      void tauri.raw.cinderpawCronOp(crypto.randomUUID(), 'followups').catch(() => {});
    };
    const offFollowUps = useFollowUps.subscribe((state, previous) => {
      if (state.enabled && !previous.enabled) requestFollowUp();
    });
    unlisteners.push(offFollowUps);
    const setup = async () => {
      const offWait = await events.onRateLimited.listen(({ sessionId, waitMs }) => {
        useConversations.getState().setProviderWait(sessionId, waitMs);
      });
      if (disposed) { offWait(); return; }
      unlisteners.push(offWait);
      // The stream listener is where ask_user questions are received, and it
      // used to be installed by the first chat SEND. A person whose first act
      // after launch was a voice call never had one: the agent asked, nothing
      // heard it, and the call waited out the question's timeout (18 Sep).
      void ensureCinderpawListener().catch(() => {});
      await subscribe('cinderpaw://agent-ready', () => {
        setReady(true);
        void fetchConfig();
        requestFollowUp();
      });
      if (disposed) return;

      // The event fires once, and only reaches whoever is already listening.
      // The sidecar announces itself about eleven seconds in; a cold webview
      // can still be mounting then, and the announcement goes out to nobody —
      // which left "Cinderpaw is waking up" on screen for the whole session,
      // waiting for a second occurrence that never comes.
      //
      // Asked AFTER the listener is attached, deliberately: an announcement
      // that lands between the two is caught by the listener rather than
      // falling into the gap the other order would open.
      try {
        const ready = await tauri.raw.agentIsReady();
        if (disposed) return;
        if (ready) {
          setReady(true);
          void fetchConfig();
        }
      } catch {
        // An older host without the command. The event path still works.
      }

      // #11: the Rust supervisor emits this when the sidecar dies. While
      // `restarting` is true it will respawn with backoff and agent-ready
      // will clear the banner; when false, the supervisor gave up.
      await subscribe<{
        code: number | null;
        restarting: boolean;
        error?: string | null;
      }>(
        'cinderpaw://agent-exit',
        (event) => {
          const reason = event.payload.error?.trim() || null;
          setOffline(true, event.payload.restarting, reason);
          failArtifactRequests('The engine stopped.');
          useConversations.setState({ providerWaits: {} });
          if (!event.payload.restarting) {
            // The reason comes from Rust, which is the only side that knows
            // WHICH failure this was: the sidecar was never found, or it was
            // found and died six times. The hardcoded sentence that used to
            // live here said "crashed repeatedly" for both, which is a
            // confident wrong answer in the case the process never started.
            useNotifications.getState().push(
              'error',
              'Cinderpaw Agent stopped',
              reason ??
                'Agent mode stopped and automatic restarts were suspended. ' +
                  'Restart the app to bring Agent mode back.',
            );
          }
        },
      );

      // Faza 3 watchdog: the Rust supervisor auto-reverted a live-applied
      // code patch that was crashing the agent.
      await subscribe<{ patchId: string }>(
        'cinderpaw://rsi-patch-reverted',
        (event) => {
          useNotifications.getState().push(
            'info',
            'Change rolled back',
            `Cinderpaw undid a self-modification that was causing problems (${event.payload.patchId}).`,
          );
        },
      );

      await subscribe<{ data: string }>('cinderpaw://agent-output', (event) => {
        let parsed: CinderpawAgentEvent;
        try {
          parsed = JSON.parse(event.payload.data) as CinderpawAgentEvent;
        } catch {
          return;
        }

        if (parsed.type === 'artifact_draft') {
          // Live writing: the panel shows the document while Cinderpaw writes it.
          drafts.push({ ...parsed, onScreen: parsed.sessionId === useChat.getState().sessionId });
          if (document.hidden) flushDrafts();
          else draftFrame ??= requestAnimationFrame(flushDrafts);
          return;
        }
        // Nothing may overtake a piece of writing that arrived before it.
        if (drafts.length) flushDrafts();

        if (parsed.type === 'model_set') {
          void fetchConfig();
        } else if (parsed.type === 'model_routed') {
          // Only the fallback is worth interrupting for. A successful route
          // is the normal case and must not produce a toast per turn — but
          // a fallback changes which model answered, so it gets said out
          // loud, with the real cause as the "why" underneath.
          if (parsed.reason === 'fallback') {
            useNotifications
              .getState()
              .push('info', t('chat.routed.fallback'), parsed.detail);
          }
        } else if (parsed.type === 'model_error') {
          setModelError(parsed.message);
        } else if (parsed.type === 'artifact') {
          // Unprompted, from any surface: a report written during a voice call
          // or asked for on Telegram reaches the panel without it polling.
          useArtifacts.getState().onEvent({
            id: parsed.id,
            action: parsed.action,
            version: parsed.version,
            title: parsed.title,
            onScreen: typeof parsed.sessionId === 'string' && parsed.sessionId === useChat.getState().sessionId,
          });
        } else if (parsed.type === 'artifact_result') {
          useArtifacts.getState().onResult(parsed);
        } else if (parsed.type === 'tool_done' && parsed.tool === 'artifact_edit') {
          // A part written in place: saved, its new version follows; refused
          // (the placeholder was not found), the document goes back as it was.
          const r = parsed.result as { ok?: boolean; data?: { id?: unknown } } | null;
          useArtifacts.getState().endDraft(parsed.id, r?.ok && typeof r.data?.id === 'string' ? { artifactId: r.data.id } : { reason: 'Not saved.' });
        } else if (parsed.type === 'tool_done' && parsed.tool === 'artifact_create') {
          const r = parsed.result as { ok?: boolean; data?: { id?: unknown }; content?: unknown; error?: unknown } | null;
          const why = typeof r?.content === 'string' ? r.content : typeof r?.error === 'string' ? r.error : '';
          useArtifacts.getState().endDraft(
            parsed.id,
            r?.ok && typeof r.data?.id === 'string'
              ? { artifactId: r.data.id }
              : { reason: `Not saved.${why ? ` ${why.slice(0, 200)}` : ''}` },
          );
        } else if ((parsed.type === 'done' || parsed.type === 'error') && parsed.id) {
          // Every way a turn ends, including a stop or a broken stream: a draft
          // still being written then was never saved, and says so.
          useArtifacts.getState().endDraft(parsed.id, { reason: 'Cinderpaw stopped before saving this.' });
          if (parsed.type === 'done') requestFollowUp();
        } else if (parsed.type === 'proactive' && parsed.followUp) {
          useFollowUps.getState().receive(parsed.followUp);
        } else if (parsed.type === 'cron_fired') {
          // X3: scheduled-job results were previously dropped on the floor.
          // Capped. Both strings are model output — a cron job's answer and the
          // job's own name — so their length is not ours to trust, and a toast
          // rendering a few thousand lines covers the app. (They are rendered as
          // React text, never as HTML, so this is about size, not script.)
          useNotifications.getState().push(
            'success',
            `Scheduled task: ${toastText(parsed.jobName, 80)}`,
            toastText(parsed.content, 2000),
            undefined,
            { sticky: true },
          );
          // A reminder is for the moment it fires, which is rarely a moment the
          // person is looking at this window: the toast alone lasted 5 s inside
          // a window behind others (24 Oct). The OS shows it where they are.
          void notifyIfBackground(toastText(parsed.jobName, 80), preview(parsed.content));
        } else if (parsed.type === 'cron_error') {
          useNotifications.getState().push(
            'error',
            `Scheduled task failed: ${toastText(parsed.jobName, 80)}`,
            toastText(parsed.message, 2000),
            undefined,
            { sticky: true },
          );
          void notifyIfBackground(`Task failed: ${toastText(parsed.jobName, 80)}`, preview(parsed.message));
        }
      });

      outputSubscribed = true;
      if (!disposed) {
        void fetchConfig();
        requestFollowUp();
      }
    };

    void setup();

    return () => {
      disposed = true;
      if (draftFrame !== null) cancelAnimationFrame(draftFrame);
      for (const unlisten of unlisteners) unlisten();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
