import { describe, expect, it } from 'vitest';
import { CONTEXT_SPAN, contextShove } from '../ContextColumn';

describe('contextShove: how far the chat steps aside for the Context cards', () => {
  it('does not move the chat at all when the reading column and the cards fit', () => {
    expect(contextShove(1600)).toBe(0);
  });

  it('moves it only as far as needed so the cards never cover the text', () => {
    // 748 reading + 2 * 368 span = 1484: at 1380 the chat steps 104px, not 368.
    expect(contextShove(1380)).toBe(104);
  });

  it('never moves it further than the cards are wide', () => {
    expect(contextShove(900)).toBe(CONTEXT_SPAN);
  });

  it('keeps the cards away from a chat too narrow to share', () => {
    expect(contextShove(700)).toBeNull();
  });
});
