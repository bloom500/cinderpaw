import type { ChatMessage } from '@/stores/chat';
import { t } from '@/lib/i18n';

const MAX = 40;

/**
 * The name a conversation is saved under: the first thing the person said,
 * trimmed to fit a sidebar row.
 *
 * The fallback is translated rather than the literal `'New chat'` it used to
 * be. This string is not rendered, it is WRITTEN to the conversation record —
 * so an English title used to be stored on a machine being used in Romanian
 * and stayed English forever after, long past any language switch. Looked up
 * at call time, not at import time, because the language is a setting the
 * person can change while the app is open.
 */
export function autoTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return t('chats.untitled');
  const clean = first.content.replace(/\s+/g, ' ').trim();
  if (!clean) return t('chats.untitled');
  if (clean.length <= MAX) return clean;
  return clean.slice(0, MAX) + '…';
}
