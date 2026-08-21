import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The window has no decorations, so `data-tauri-drag-region` is the only way to
 * move it. Every page used to bring its own strip, which meant every page could
 * forget — and two had: Connectors and Extensions could not be dragged at all,
 * and Chat lost its handle whenever the agent onboarding replaced the header.
 *
 * A rendering test would need the whole shell (router, Tauri, stores) mounted to
 * assert one attribute. This reads the source instead, which is enough for the
 * thing that actually goes wrong: somebody deletes the shared strip and every
 * page silently goes back to depending on its own.
 */

// vitest runs with the frontend package as cwd; `import.meta.url` needs
// unpicking on Windows and this does not.
const FRONTEND = process.cwd();
const SRC = join(FRONTEND, 'src');
const REPO = join(FRONTEND, '..');

describe('window dragging', () => {
  it('the shell carries a drag region, so no page has to remember', () => {
    const shell = readFileSync(join(SRC, 'components/layout/AppShell.tsx'), 'utf8');
    expect(shell).toContain('data-tauri-drag-region');
  });

  /**
   * A call covers the screen, so the shell's strip is underneath it. Losing this
   * one means a frameless window that cannot be moved for the length of a call.
   */
  it('the call overlay carries its own, because it covers the shell', () => {
    const overlay = readFileSync(join(SRC, 'components/chat/CallOverlay.tsx'), 'utf8');
    expect(overlay).toContain('data-tauri-drag-region');
  });

  /**
   * The permission is what makes the attribute do anything. Without it the
   * markup is correct, the window is immovable, and nothing reports a fault.
   */
  it('start-dragging is actually granted to the window', () => {
    const caps = join(REPO, 'src-tauri', 'capabilities');
    const granted = readdirSync(caps)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readFileSync(join(caps, f), 'utf8'))
      .join('\n');
    expect(granted).toContain('core:window:allow-start-dragging');
  });
});
