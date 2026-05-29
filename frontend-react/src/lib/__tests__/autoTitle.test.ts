import { describe, it, expect } from 'vitest';
import { autoTitle } from '@/lib/autoTitle';
import type { ChatMessage } from '@/stores/chat';

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
});
