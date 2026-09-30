import { useSyncExternalStore } from 'react';
import { useChat } from '@/stores/chat';
import { chatContext, type ChatContext } from '@/lib/chatContext';

let cache: { messages: readonly unknown[]; ctx: ChatContext; key: string } | null = null;

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
function snapshot(): ChatContext {
  const messages = useChat.getState().messages;
  if (cache?.messages === messages) return cache.ctx;
  const ctx = chatContext(messages);
  const key = JSON.stringify(ctx);
  cache = { messages, ctx: cache?.key === key ? cache.ctx : ctx, key };
  return cache.ctx;
}

export function useChatContext(): ChatContext {
  return useSyncExternalStore(useChat.subscribe, snapshot);
}
