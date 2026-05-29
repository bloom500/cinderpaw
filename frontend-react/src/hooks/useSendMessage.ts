import { useCallback } from 'react';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { useUI } from '@/stores/ui';
import { useChatStream } from './useChatStream';
import { toIpcMessage } from '@/lib/messageMapping';
import { currentInferParams } from '@/lib/inferParams';
import { autoTitle } from '@/lib/autoTitle';
import { splitThinking } from '@/lib/parseThink';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

function buildUserContent(text: string, files: AttachedFile[]): string {
  const validFiles = files.filter((f) => f.content !== null);
  if (validFiles.length === 0) return text;
  const fileBlocks = validFiles
    .map((f) => `[File: ${f.name}]\n${f.content}`)
    .join('\n\n');
  return `${fileBlocks}\n\n${text}`;
}

function autoSaveIfEligible() {
  const chat = useChat.getState();
  const hasUser      = chat.messages.some((m) => m.role === 'user');
  const hasCompleteA = chat.messages.some((m) => m.role === 'assistant' && m.content.trim().length > 0);
  if (chat.streamStatus !== 'done' || !hasUser || !hasCompleteA) return;
  void useConversations.getState().saveCurrent(autoTitle(chat.messages));
}

export function useSendMessage() {
  const stream = useChatStream(useChat.getState().sessionId);

  return useCallback(
    async (text: string, files: AttachedFile[] = []) => {
      const chat = useChat.getState();
      const { reasoningMode } = useUI.getState();
      const loaded = useModel.getState().loaded;
      const modelName = loaded?.name ?? '';

      const content = buildUserContent(text, files);

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

      const messages = useChat.getState().messages.slice(0, -1).map(toIpcMessage);
      const params = await currentInferParams({ reasoningMode, modelName });

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
