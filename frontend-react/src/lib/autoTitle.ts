import type { ChatMessage } from '@/stores/chat';

const MAX = 40;

export function autoTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New chat';
  const clean = first.content.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  if (clean.length <= MAX) return clean;
  return clean.slice(0, MAX) + '…';
}
