import { useCallback } from 'react';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useChatStream } from './useChatStream';
import { toIpcMessage } from '@/lib/messageMapping';
import { currentInferParams } from '@/lib/inferParams';
import { autoTitle } from '@/lib/autoTitle';
import { splitThinking } from '@/lib/parseThink';

function autoSaveIfEligible() {
  const chat = useChat.getState();
  const hasUser      = chat.messages.some((m) => m.role === 'user');
  const hasCompleteA = chat.messages.some((m) => m.role === 'assistant' && m.content.trim().length > 0);
  // Only auto-save on clean done — not on error or user-stopped (spec §4.12)
  if (chat.streamStatus !== 'done' || !hasUser || !hasCompleteA) return;
  void useConversations.getState().saveCurrent(autoTitle(chat.messages));
}

export function useSendMessage() {
  const stream = useChatStream(useChat.getState().sessionId);

  return useCallback(
    async (text: string) => {
      const chat = useChat.getState();
      const userMsg = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: text,
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

      // Include all messages except the empty assistant placeholder
      const messages = useChat.getState().messages.slice(0, -1).map(toIpcMessage);
      const params = await currentInferParams();

      let buffer = '';
      let thinkingStartAt: number | null = null;

      await stream.start(messages, params, {
        onToken: (chunk) => {
          buffer += chunk;
          const split = splitThinking(buffer);
          const patch: Partial<ChatMessage> = { content: split.answer };
          if (split.thinking !== null) {
            patch.thinking = split.thinking;
            patch.thinkingComplete = split.thinkingComplete;
            if (thinkingStartAt === null) thinkingStartAt = Date.now();
            if (split.thinkingComplete && thinkingStartAt !== null) {
              patch.thinkingDurationMs = Date.now() - thinkingStartAt;
            }
          }
          useChat.getState().updateLastAssistantMessage(patch);
        },
        onDone: () => {
          useChat.getState().setStreamStatus('done');
          autoSaveIfEligible();
        },
        onError: (err) => useChat.getState().setStreamStatus('error', err),
        onStopped: () => useChat.getState().setStreamStatus('stopped'),
      });
    },
    [stream],
  );
}
