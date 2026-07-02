/**
 * useFeral — React integration for the Feral Agent sidecar.
 *
 * Wraps `feral_send_message` + `feral://agent-output` events into the same
 * callback interface that useChatStream uses, so useSendMessage can drop it in
 * as a third inference path without changing the streaming logic.
 */

import { useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChat, type ChatMessage, TOOL_CALL_LINGER_MS } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useAgent } from '@/stores/agent';
import { useModel } from '@/stores/model';
import { useFeralStore } from '@/stores/feral';
import { useNotifications } from '@/stores/notifications';
import { autoTitle } from '@/lib/autoTitle';
import { voiceToPersisted } from '@/lib/messageMapping';
import { splitThinking, stripStreamingToolCalls } from '@/lib/parseThink';
import { tauri, type FeralAgentEvent, type PersistedMessage } from '@/lib/tauri';
import {
  ensureFeralListener,
  registerFeralStream,
  requestFeralStop,
  isFeralStreaming,
} from '@/lib/feralAgentStream';
import {
  beginLiveSession,
  updateLiveSession,
  pushLiveToolCall,
  completeLiveToolCall,
  endLiveSession,
  getLiveSession,
  getLiveToolStrip,
} from '@/lib/feralLiveSession';
import { extractMainArg } from '@/components/chat/mascot/extractMainArg';
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

export function useFeralStream(chatSessionId: string) {
  const send = useCallback(
    async (content: string, callbacks: StreamCallbacks, images?: string[]) => {
      await ensureFeralListener();

      // Parity with `startChatStream`: a fresh send is an implicit interrupt
      // of any stream still in flight for this session. Without this, the
      // previous generation's chunks keep racing the new one into the same
      // chat (stop/retry semantics must match across both paths — audit A2).
      if (isFeralStreaming(chatSessionId)) {
        await requestFeralStop(chatSessionId);
      }

      let messageId: string;
      try {
        // Controls-panel params (temperature / max tokens) now reach the
        // agent too — previously they only applied to the plain chat tab.
        const { temperature, max_tokens } = useModel.getState().inferParams;
        messageId = await invoke<string>('feral_send_message', {
          content,
          sessionId: chatSessionId,
          images: images && images.length > 0 ? images : null,
          inferParams: { temperature, max_tokens: max_tokens },
        });
      } catch (err) {
        callbacks.onError(String(err));
        return;
      }

      registerFeralStream(messageId, {
        onChunk: (c) => callbacks.onToken(c),
        onDone: (fc, stopped) => callbacks.onDone(fc, stopped),
        onError: (m) => callbacks.onError(m),
        onStopped: () => callbacks.onStopped(),
        onToolStart: callbacks.onToolStart ? (cid, t, a) => callbacks.onToolStart!(cid, t, a) : undefined,
        onToolDone: callbacks.onToolDone ? (cid, t, r) => callbacks.onToolDone!(cid, t, r) : undefined,
        onUsage: callbacks.onUsage ? (p, c) => callbacks.onUsage!(p, c) : undefined,
        // Ask_user events carry the sidecar's requestId, not a stream
        // messageId — so the stream manager can't tie the question to a
        // specific message on its own. Pass the React-side asstId so the
        // ask_user flow can patch the right message with `askUser` (which
        // is what makes AskUserCard actually appear in the chat list).
        chatMessageId: callbacks.chatMessageId,
        // Lets requestFeralStop(sessionId) stop only this session's streams.
        sessionId: chatSessionId,
      });
    },
    [chatSessionId],
  );

  return { send };
}

export function useFeralSendMessage(chatSessionId: string, mascotSink?: MascotStateSink) {
  const { send } = useFeralStream(chatSessionId);

  return useCallback(
    async (
      content: string,
      images?: string[],
      opts?: { voice?: ChatMessage['voice']; existingUserId?: string },
    ) => {
      const chat = useChat.getState();

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
        console.error('[feral] failed initial save to Recent:', err);
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
      };

      const persistFinal = async () => {
        const persisted: PersistedMessage[] = snapshot.map((m) => ({
          role: m.role,
          content: m.id === asstId ? joinSegments(state.committed, state.answer) : m.content,
          thinking: m.thinking || undefined,
          voice: voiceToPersisted(m.voice),
        }));
        try {
          await tauri.conversations.save(sessionId, autoTitle(snapshot), persisted, agentId);
          await useConversations.getState().refresh();
        } catch (err) {
          console.error('[feral] failed final save to Recent:', err);
        }
      };

      await send(content, {
        // Pass the React-side asst message id so the ask_user flow can
        // attach the question card to the right message (the card reads
        // off `message.askUser`; without this the card never renders).
        chatMessageId: asstId,
        onToken: (token) => {
          state.buffer += token;
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
        },
        onToolStart: (_callId, tool, args) => {
          state.toolCallCount += 1;
          // Commit the prose emitted before this tool call so it survives the
          // buffer reset; otherwise only the segment after the LAST tool call
          // reached the bubble (the "only the last sentence" bug).
          if (state.answer.trim()) state.committed = joinSegments(state.committed, state.answer);
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
                  ? JSON.stringify(result, null, 2)
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
          endLiveSession(sessionId);
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
            useChat.getState().setStreamStatus('done');
            useChat.setState({ lastCompletionStopped: stopped });
            // 5s post-done window before clearing the bubble strip.
            setTimeout(() => useChat.getState().clearToolCallStream(), 5000);
          }
          if (joinSegments(state.committed, state.answer).trim().length > 0) await persistFinal();
          if (state.toolCallCount > 3 && mascotSink) {
            mascotSink.setMascotState('cool');
          }
          useConversations.getState().unmarkStreaming(sessionId);
        },
        onError: (err) => {
          endLiveSession(sessionId);
          if (isActive()) useChat.getState().setStreamStatus('error', err);
          if (mascotSink) mascotSink.setMascotState('error');
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
        onStopped: () => {
          endLiveSession(sessionId);
          if (isActive()) useChat.getState().setStreamStatus('stopped');
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
        onTruncated: (reason) => {
          endLiveSession(sessionId);
          if (isActive()) {
            useChat.getState().updateLastAssistantMessage({ truncated: true, truncatedReason: reason });
            useChat.getState().setStreamStatus('done');
          }
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
      }, images);
    },
    [send, mascotSink],
  );
}

export async function checkFeralAgentReady(): Promise<boolean> {
  try {
    return await invoke<boolean>('feral_agent_status');
  } catch {
    return false;
  }
}

export function useFeralGlobal() {
  const setReady      = useFeralStore((s) => s.setReady);
  const setModelError = useFeralStore((s) => s.setModelError);
  const setOffline    = useFeralStore((s) => s.setOffline);
  const fetchConfig   = useFeralStore((s) => s.fetchModelConfig);

  useEffect(() => {
    let unlistenReady:  (() => void) | null = null;
    let unlistenExit:   (() => void) | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenRevert: (() => void) | null = null;

    const setup = async () => {
      unlistenReady = await listen('feral://agent-ready', () => {
        setReady(true);
        void fetchConfig();
      });

      // #11: the Rust supervisor emits this when the sidecar dies. While
      // `restarting` is true it will respawn with backoff and agent-ready
      // will clear the banner; when false, the supervisor gave up.
      unlistenExit = await listen<{ code: number | null; restarting: boolean }>(
        'feral://agent-exit',
        (event) => {
          setOffline(true, event.payload.restarting);
          if (!event.payload.restarting) {
            useNotifications.getState().push(
              'error',
              'Feral Agent stopped',
              'The agent process crashed repeatedly and automatic restarts were ' +
                'suspended. Restart the app to bring Agent mode back.',
            );
          }
        },
      );

      // Faza 3 watchdog: the Rust supervisor auto-reverted a live-applied
      // code patch that was crashing the agent.
      unlistenRevert = await listen<{ patchId: string }>(
        'feral://rsi-patch-reverted',
        (event) => {
          useNotifications.getState().push(
            'info',
            'Change rolled back',
            `Feral undid a self-modification that was causing problems (${event.payload.patchId}).`,
          );
        },
      );

      unlistenOutput = await listen<{ data: string }>('feral://agent-output', (event) => {
        let parsed: FeralAgentEvent;
        try {
          parsed = JSON.parse(event.payload.data) as FeralAgentEvent;
        } catch {
          return;
        }

        if (parsed.type === 'model_set') {
          void fetchConfig();
        } else if (parsed.type === 'model_error') {
          setModelError(parsed.message);
        } else if (parsed.type === 'cron_fired') {
          // X3: scheduled-job results were previously dropped on the floor.
          useNotifications.getState().push('success', `Scheduled task: ${parsed.jobName}`, parsed.content);
        } else if (parsed.type === 'cron_error') {
          useNotifications.getState().push('error', `Scheduled task failed: ${parsed.jobName}`, parsed.message);
        }
      });

      void fetchConfig();
    };

    void setup();

    return () => {
      unlistenReady?.();
      unlistenExit?.();
      unlistenOutput?.();
      unlistenRevert?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
