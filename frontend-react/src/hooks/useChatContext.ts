import { useMemo, useSyncExternalStore } from 'react';
import { useChatApi, type ChatApi } from '@/stores/chatScope';
import { createChatContextReader, type ChatContext } from '@/lib/chatContext';
/**
 * The context of the chat on screen, as one snapshot that keeps its identity
 * until what it lists changes.
 *
 * The Context tab and the Artifacts list each subscribed to `messages`, which
 * is a new array on every streamed frame, so with the panel open the whole tab
 * (search, tool switches, scroll area) rendered again for every few words of a
 * reply that added no file, link or memory. The derived value is compared as
 * data instead, and a subscriber only hears about a real change.
 */
function contextSnapshot(chat: ChatApi) {
  let cache: { messages: readonly unknown[]; ctx: ChatContext; key: string } | null = null;
  const readContext = createChatContextReader();
  return (): ChatContext => {
    const messages = chat.getState().messages;
    if (cache?.messages === messages) return cache.ctx;
    const ctx = readContext(messages);
    const key = JSON.stringify(ctx);
    cache = { messages, ctx: cache?.key === key ? cache.ctx : ctx, key };
    return cache.ctx;
  };
}

export function useChatContext(): ChatContext {
  const chat = useChatApi();
  const snapshot = useMemo(() => contextSnapshot(chat), [chat]);
  return useSyncExternalStore(chat.subscribe, snapshot);
}
