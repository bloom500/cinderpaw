import { describe, it, expect } from 'vitest';
import chatPageSource from '../ChatPage.tsx?raw';

/**
 * The chat column resizes on every frame of the sidebar's slide. When its
 * ResizeObserver set React state with the width, the whole chat re-rendered
 * each frame: 4 frames of ~100 ms on a production build (30 Oct), a visible
 * stutter on one of the most repeated clicks. The width now goes straight to
 * --cards-shove on the element. Reads source, because the regression is a
 * per-frame setState that a render test in jsdom (no layout) cannot see.
 */
describe('ChatPage column width', () => {
  it('the resize observer does not put the width in React state', () => {
    expect(chatPageSource).toContain('new ResizeObserver(() => shoveFor.current())');
    expect(chatPageSource).not.toContain('setColumnWidth');
  });

  it('--cards-shove is written on the element, not through a style prop', () => {
    expect(chatPageSource).toContain("style.setProperty('--cards-shove'");
    expect(chatPageSource).not.toMatch(/'--cards-shove':/);
  });
});
