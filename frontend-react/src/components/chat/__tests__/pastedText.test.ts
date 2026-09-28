import { describe, it, expect, vi } from 'vitest';
import { isLongPaste, pastedText } from '../AttachedFileChip';
import { buildUserContent } from '@/hooks/useSendMessage';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

describe('pasted text', () => {
  it('is long past 1,200 characters or 20 lines', () => {
    expect(isLongPaste('x'.repeat(1200))).toBe(false);
    expect(isLongPaste('x'.repeat(1201))).toBe(true);
    expect(isLongPaste(Array(20).fill('a').join('\n'))).toBe(false);
    expect(isLongPaste(Array(21).fill('a').join('\n'))).toBe(true);
  });

  it('goes with the message in full', () => {
    const text = Array.from({ length: 25 }, (_, i) => `row ${i}`).join('\n');
    const content = buildUserContent('what is wrong here?', [pastedText(text)]);
    expect(content).toContain('[File: Pasted text, 25 lines]');
    expect(content).toContain(text);
    expect(content.endsWith('what is wrong here?')).toBe(true);
  });
});
