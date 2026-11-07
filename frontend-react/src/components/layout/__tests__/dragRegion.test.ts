import { describe, it, expect } from 'vitest';
// `?raw` rather than node:fs: this package has no Node types, and a test that
// runs under vitest but fails `tsc --noEmit` is a broken build with a green
// test suite. Vite hands the file over as a string and TypeScript knows it.
import shellSource from '../AppShell.tsx?raw';
import callOverlaySource from '@/components/chat/CallOverlay.tsx?raw';
// The stylesheet through node:fs, as palette.test.ts reads it: vitest hands a
// `.css?raw` import back empty.
import { readFileSync } from 'node:fs';
const css = readFileSync('src/styles/globals.css', 'utf8');

/**
 * The window has no decorations, so `data-tauri-drag-region` is the only way to
 * move it. Every page used to bring its own strip, which meant every page could
 * forget — and two had: Connectors and Extensions could not be dragged at all,
 * and Chat lost its handle whenever the agent onboarding replaced the header.
 *
 * These read source rather than rendering, because the failure being guarded
 * against is someone deleting the shared strip — at which point every page
 * silently goes back to depending on its own.
 */
describe('window dragging', () => {
  it('the shell carries a drag region, so no page has to remember', () => {
    expect(shellSource).toContain('data-tauri-drag-region');
  });

  /**
   * A call covers the screen, so the shell's strip is underneath it. Losing this
   * one means a frameless window that cannot be moved for the length of a call.
   */
  it('the call overlay carries its own, because it covers the shell', () => {
    expect(callOverlaySource).toContain('data-tauri-drag-region');
  });

  /**
   * Through the page, a drag started only after a round trip to the app, and
   * from wherever the cursor had got to by then: 155 ms and 124 px behind on a
   * first drag (29 Oct). As an OS caption it starts in ~20 ms like any window.
   * The second half matters as much: a button inside a drag region that loses
   * `no-drag` becomes part of the title bar and stops being clickable.
   */
  it('on Windows the drag regions are a real title bar, and their controls stay clickable', () => {
    expect(css).toMatch(/\[data-tauri-drag-region\]:not\(\[data-tauri-drag-region="false"\]\)\s*\{\s*app-region:\s*drag;/);
    expect(css).toMatch(/\[data-tauri-drag-region\] :is\(button, a, input,[^)]*\)[^{]*\{\s*app-region:\s*no-drag;/);
  });
});
