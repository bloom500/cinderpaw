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
import { useChat, type ChatMessage } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useAgent } from '@/stores/agent';
import { useFeralStore } from '@/stores/feral';
import { autoTitle } from '@/lib/autoTitle';
import { splitThinking } from '@/lib/parseThink';
import { tauri, type FeralAgentEvent, type PersistedMessage } from '@/lib/tauri';
import { ensureFeralListener, registerFeralStream } from '@/lib/feralAgentStream';

interface StreamCallbacks {
  onToken:     (chunk: string) => void;
  onDone:      () => void;
  onError:     (err: string) => void;
  onStopped:   () => void;
  /** Optional: backend hit max_tokens before natural stop (Gemma server cap, etc.) */
  onTruncated?: (reason: string) => void;
}

/**
 * Kick off a Feral Agent turn and route its stream through the global manager.
 *
 * The streaming listener is NOT tied to this hook's component — it lives in
 * `feralAgentStream`, so a generation started on the Agents tab keeps applying
 * and completes even after the user navigates away (which unmounts AgentChat).
 */
export function useFeralStream(chatSessionId: string) {
  const send = useCallback(
    async (content: string, callbacks: StreamCallbacks) => {
      // Arm the persistent listener before invoking so the first chunk (which
      // can arrive immediately) is never missed.
      await ensureFeralListener();

      let messageId: string;
      try {
        messageId = await invoke<string>('feral_send_message', {
          content,
          sessionId: chatSessionId,
        });
      } catch (err) {
        callbacks.onError(String(err));
        return;
      }

      // Hand the callbacks to the global registry; they outlive this component.
      registerFeralStream(messageId, {
        onChunk: (c) => callbacks.onToken(c),
        onDone: () => callbacks.onDone(),
        onError: (m) => callbacks.onError(m),
      });
    },
    [chatSessionId],
  );

  return { send };
}

/**
 * useFeralSendMessage — purpose-built send hook for the Agents tab.
 *
 * Always routes through the Feral Agent sidecar regardless of whether a
 * local model or cloud key is configured. Returns a stable callback
 * compatible with the `sendFn` prop of ChatInput.
 */
export function useFeralSendMessage(chatSessionId: string) {
  const { send } = useFeralStream(chatSessionId);

  return useCallback(
    async (content: string) => {
      const chat = useChat.getState();

      const userMsg = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content,
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

      // Capture the session + a snapshot of its messages NOW. Generation may
      // finish after the user navigates away — which changes the *active* chat
      // session — so all completion work keys off these captured values, not
      // "whatever session is current".
      const sessionId = useChat.getState().sessionId;
      const snapshot  = [...useChat.getState().messages];
      const asstId    = asstMsg.id;
      const agentId   = useAgent.getState().current?.id ?? null;
      const isActive  = () => useChat.getState().sessionId === sessionId;

      // Save immediately so the chat appears in the sidebar's Recent section
      // while the model is still generating (with a spinner next to it).
      // Tag it with the agent id so a Recents click routes back to the Agents tab.
      useConversations.getState().markStreaming(sessionId);
      try {
        await useConversations.getState().saveCurrent(autoTitle(useChat.getState().messages), agentId);
      } catch (err) {
        // Non-fatal — the final save in onDone will retry.
        console.error('[feral] failed initial save to Recent:', err);
      }

      // Local buffers — `answer` is the clean (think-stripped) text we persist.
      let buffer = '';
      let answer = '';

      // Persist the finished turn to THIS conversation by id — correct even
      // when it is no longer the active session (user switched tabs).
      const persistFinal = async () => {
        const persisted: PersistedMessage[] = snapshot.map((m) => ({
          role: m.role,
          content: m.id === asstId ? answer : m.content,
        }));
        try {
          await tauri.conversations.save(sessionId, autoTitle(snapshot), persisted, agentId);
          await useConversations.getState().refresh();
        } catch (err) {
          console.error('[feral] failed final save to Recent:', err);
        }
      };

      await send(content, {
        onToken: (token) => {
          // Buffer tokens, split <think>…</think> out of the visible answer.
          buffer += token;
          const split = splitThinking(buffer);
          answer = split.answer;
          // Only mutate the live chat view while this session is on screen,
          // otherwise tokens would leak into whatever conversation the user
          // opened after switching tabs.
          if (isActive()) {
            const patch: Partial<ChatMessage> = { content: split.answer };
            if (split.thinking !== null) {
              patch.thinking = split.thinking;
              patch.thinkingComplete = split.thinkingComplete;
            }
            useChat.getState().updateLastAssistantMessage(patch);
          }
        },
        onDone: async () => {
          if (isActive()) useChat.getState().setStreamStatus('done');
          // Persist BEFORE unmarking so that if the user navigates away and
          // back while the disk-write is in flight, open() still sees
          // streamingIds[id]=true and won't load the incomplete disk snapshot.
          if (answer.trim().length > 0) await persistFinal();
          useConversations.getState().unmarkStreaming(sessionId);
        },
        onError: (err) => {
          if (isActive()) useChat.getState().setStreamStatus('error', err);
          useConversations.getState().unmarkStreaming(sessionId);
        },
        onStopped: () => {
          if (isActive()) useChat.getState().setStreamStatus('stopped');
          // Persist before unmark so navigating away and back during a stop
          // doesn't show an empty response.
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
        onTruncated: (reason) => {
          if (isActive()) {
            useChat.getState().updateLastAssistantMessage({ truncated: true, truncatedReason: reason });
            useChat.getState().setStreamStatus('done');
          }
          useConversations.getState().unmarkStreaming(sessionId);
        },
      });
    },
    [send],
  );
}

/** Returns true if the Feral Agent sidecar is running and ready. */
export async function checkFeralAgentReady(): Promise<boolean> {
  try {
    return await invoke<boolean>('feral_agent_status');
  } catch {
    return false;
  }
}

/**
 * useFeralGlobal — mount once per session (in AgentChat) to handle sidecar
 * lifecycle events that are not tied to a specific message:
 *
 *  - feral://agent-ready   → mark sidecar ready, fetch model config
 *  - feral://agent-output  → route model_set / model_error to feralStore
 *
 * Per-message routing (chunk / done / error) is handled by useFeralStream.
 */
export function useFeralGlobal() {
  const setReady      = useFeralStore((s) => s.setReady);
  const setModelError = useFeralStore((s) => s.setModelError);
  const fetchConfig   = useFeralStore((s) => s.fetchModelConfig);

  useEffect(() => {
    let unlistenReady:  (() => void) | null = null;
    let unlistenOutput: (() => void) | null = null;

    const setup = async () => {
      // feral://agent-ready — emitted by Rust when sidecar writes "ready" to stderr.
      unlistenReady = await listen('feral://agent-ready', () => {
        setReady(true);
        void fetchConfig();
      });

      // feral://agent-output — global sidecar events (model_set, model_error).
      // Per-message events are handled by useFeralStream's own listener.
      unlistenOutput = await listen<{ data: string }>('feral://agent-output', (event) => {
        let parsed: FeralAgentEvent;
        try {
          parsed = JSON.parse(event.payload.data) as FeralAgentEvent;
        } catch {
          return;
        }

        if (parsed.type === 'model_set') {
          // Sidecar confirmed the hot-swap; sync display config.
          void fetchConfig();
        } else if (parsed.type === 'model_error') {
          setModelError(parsed.message);
        }
      });

      // Also try to fetch the config immediately (sidecar may already be up).
      void fetchConfig();
    };

    void setup();

    return () => {
      unlistenReady?.();
      unlistenOutput?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
