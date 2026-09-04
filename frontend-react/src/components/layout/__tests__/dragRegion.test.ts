import { describe, it, expect } from 'vitest';
// `?raw` rather than node:fs: this package has no Node types, and a test that
// runs under vitest but fails `tsc --noEmit` is a broken build with a green
// test suite. Vite hands the file over as a string and TypeScript knows it.
import shellSource from '../AppShell.tsx?raw';
import callOverlaySource from '@/components/chat/CallOverlay.tsx?raw';

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
});
