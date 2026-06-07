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
import { splitThinking, looksLikeToolCall } from '@/lib/parseThink';
import { tauri, type FeralAgentEvent, type PersistedMessage } from '@/lib/tauri';
import { ensureFeralListener, registerFeralStream } from '@/lib/feralAgentStream';
import type { MascotState } from '@/components/chat/mascot/frames';

interface StreamCallbacks {
  onToken:      (chunk: string) => void;
  onDone:       (finalContent?: string) => void;
  onError:      (err: string) => void;
  onStopped:    () => void;
  onTruncated?: (reason: string) => void;
  onToolStart?: (tool: string, args: Record<string, unknown>) => void;
  onToolDone?:  (tool: string) => void;
}

interface MascotStateSink {
  setMascotState(state: MascotState): void;
}

export { type MascotStateSink };

export function useFeralStream(chatSessionId: string) {
  const send = useCallback(
    async (content: string, callbacks: StreamCallbacks) => {
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

      registerFeralStream(messageId, {
        onChunk: (c) => callbacks.onToken(c),
        onDone: (fc) => callbacks.onDone(fc),
        onError: (m) => callbacks.onError(m),
        onStopped: () => callbacks.onStopped(),
        onToolStart: callbacks.onToolStart ? (t, a) => callbacks.onToolStart!(t, a) : undefined,
        onToolDone: callbacks.onToolDone ? (t) => callbacks.onToolDone!(t) : undefined,
      });
    },
    [chatSessionId],
  );

  return { send };
}

export function useFeralSendMessage(chatSessionId: string, mascotSink?: MascotStateSink) {
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

      const sessionId = useChat.getState().sessionId;
      const snapshot  = [...useChat.getState().messages];
      const asstId    = asstMsg.id;
      const agentId   = useAgent.getState().current?.id ?? null;
      const isActive  = () => useChat.getState().sessionId === sessionId;

      useConversations.getState().markStreaming(sessionId);
      try {
        await useConversations.getState().saveCurrent(autoTitle(useChat.getState().messages), agentId);
      } catch (err) {
        console.error('[feral] failed initial save to Recent:', err);
      }

      const state = {
        buffer: '',
        answer: '',
        thinkingStartMs: 0,
        thinkingDurationRecorded: false,
        toolCallCount: 0,
      };

      const persistFinal = async () => {
        const persisted: PersistedMessage[] = snapshot.map((m) => ({
          role: m.role,
          content: m.id === asstId ? state.answer : m.content,
          thinking: m.thinking || undefined,
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
          state.buffer += token;
          const split = splitThinking(state.buffer);
          const visibleAnswer = looksLikeToolCall(split.answer) ? '' : split.answer;
          state.answer = visibleAnswer;
          if (isActive()) {
            const chat = useChat.getState();
            const patch: Partial<ChatMessage> = { content: visibleAnswer };
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
        onToolStart: (tool, _args) => {
          state.toolCallCount += 1;
          state.buffer = '';
          state.answer = '';
          state.thinkingStartMs = 0;
          state.thinkingDurationRecorded = false;
          if (isActive()) {
            useChat.getState().clearStreamingContent();
            useChat.getState().setAgentPhase('calling', tool);
          }
        },
        onToolDone: (_tool) => {
          if (isActive()) useChat.getState().setAgentPhase('processing');
        },
        onDone: async (finalContent?: string) => {
          if (state.answer.trim().length === 0 && finalContent?.trim()) {
            const cleaned = splitThinking(finalContent).answer.trim();
            if (cleaned) {
              state.answer = cleaned;
              if (isActive()) {
                useChat.getState().updateLastAssistantMessage({ content: state.answer });
              }
            }
          }
          if (isActive()) useChat.getState().setStreamStatus('done');
          if (state.answer.trim().length > 0) await persistFinal();
          if (state.toolCallCount > 3 && mascotSink) {
            mascotSink.setMascotState('cool');
          }
          useConversations.getState().unmarkStreaming(sessionId);
        },
        onError: (err) => {
          if (isActive()) useChat.getState().setStreamStatus('error', err);
          if (mascotSink) mascotSink.setMascotState('error');
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
        onStopped: () => {
          if (isActive()) useChat.getState().setStreamStatus('stopped');
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
        onTruncated: (reason) => {
          if (isActive()) {
            useChat.getState().updateLastAssistantMessage({ truncated: true, truncatedReason: reason });
            useChat.getState().setStreamStatus('done');
          }
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
      });
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
  const fetchConfig   = useFeralStore((s) => s.fetchModelConfig);

  useEffect(() => {
    let unlistenReady:  (() => void) | null = null;
    let unlistenOutput: (() => void) | null = null;

    const setup = async () => {
      unlistenReady = await listen('feral://agent-ready', () => {
        setReady(true);
        void fetchConfig();
      });

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
        }
      });

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
