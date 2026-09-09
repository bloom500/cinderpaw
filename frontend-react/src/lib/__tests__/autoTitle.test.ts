import { describe, it, expect } from 'vitest';
import { autoTitle } from '@/lib/autoTitle';
import type { ChatMessage } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { t } from '@/lib/i18n';

const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({
  id: 'x', role, content, createdAt: 0,
});

describe('autoTitle', () => {
  it('returns first user message up to 40 chars, trimmed', () => {
    expect(autoTitle([msg('user', '   Hello world   ')])).toBe('Hello world');
  });

  it('truncates with ellipsis past 40 chars', () => {
    const long = 'A'.repeat(60);
    expect(autoTitle([msg('user', long)])).toBe('A'.repeat(40) + '…');
  });

  it('uses first user message, skipping assistant', () => {
    expect(autoTitle([msg('assistant', 'hi there'), msg('user', 'question')])).toBe('question');
  });

  it('falls back to "New chat" when no user message', () => {
    expect(autoTitle([msg('assistant', 'hi')])).toBe('New chat');
  });

  it('falls back to "New chat" when empty array', () => {
    expect(autoTitle([])).toBe('New chat');
  });

  it('collapses newlines in title', () => {
    expect(autoTitle([msg('user', 'line one\nline two')])).toBe('line one line two');
  });

  // This title is WRITTEN to the conversation record, not rendered, so an
  // English fallback on a machine being used in Romanian is stored and stays
  // stored long after any language switch. The two assertions above only prove
  // the English default; this one is what fails if somebody puts the literal
  // back.
  it('saves the fallback in the language the app is being used in', () => {
    const previous = useUI.getState().language;
    try {
      useUI.setState({ language: 'ro' });
      const title = autoTitle([]);
      expect(title).not.toBe('New chat');
      expect(title).toBe(t('chats.untitled'));
    } finally {
      useUI.setState({ language: previous });
    }
  });
});
