/**
 * useFeral — React integration for the Feral Agent sidecar.
 *
 * Wraps `feral_send_message` + `feral://agent-output` events into the same
 * callback interface that useChatStream uses, so useSendMessage can drop it in
 * as a third inference path without changing the streaming logic.
 */

import { useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { autoTitle } from '@/lib/autoTitle';
import type { FeralAgentEvent } from '@/lib/tauri';

interface StreamCallbacks {
  onToken:   (chunk: string) => void;
  onDone:    () => void;
  onError:   (err: string) => void;
  onStopped: () => void;
}

/** Returns the Feral Agent session ID for the current chat session. */
export function useFeralStream(chatSessionId: string) {
  // Track the unlisten function so we can clean up on component unmount.
  const unlistenRef = useRef<(() => void) | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  const send = useCallback(
    async (content: string, callbacks: StreamCallbacks) => {
      // Clean up any previous listener.
      unlistenRef.current?.();

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

      activeIdRef.current = messageId;

      // Subscribe to all feral-agent output; filter to our messageId.
      const unlisten = await listen<{ data: string }>('feral://agent-output', (event) => {
        let parsed: FeralAgentEvent;
        try {
          parsed = JSON.parse(event.payload.data) as FeralAgentEvent;
        } catch {
          return;
        }

        switch (parsed.type) {
          case 'chunk':
            if (parsed.id === messageId) callbacks.onToken(parsed.content);
            break;

          case 'done':
            if (parsed.id === messageId) {
              callbacks.onDone();
              unlisten();
              unlistenRef.current = null;
              activeIdRef.current = null;
            }
            break;

          case 'error':
            if (!parsed.id || parsed.id === messageId) {
              callbacks.onError(parsed.message);
              unlisten();
              unlistenRef.current = null;
              activeIdRef.current = null;
            }
            break;

          // tool_start / tool_done / proactive / pong — not handled here yet.
          default:
            break;
        }
      });

      unlistenRef.current = unlisten;
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

      await send(content, {
        onToken: (token) => {
          chat.appendToStreamingAssistant(token);
        },
        onDone: () => {
          chat.setStreamStatus('done');
          // Auto-save conversation after a completed Feral Agent turn.
          const state = useChat.getState();
          const hasUser = state.messages.some((m) => m.role === 'user');
          const hasAnswer = state.messages.some(
            (m) => m.role === 'assistant' && m.content.trim().length > 0,
          );
          if (hasUser && hasAnswer) {
            void useConversations.getState().saveCurrent(autoTitle(state.messages));
          }
        },
        onError: (err) => {
          chat.setStreamStatus('error', err);
        },
        onStopped: () => {
          chat.setStreamStatus('stopped');
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
