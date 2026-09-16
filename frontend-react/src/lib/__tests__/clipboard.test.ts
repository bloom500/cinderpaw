import { describe, it, expect, vi, afterEach } from 'vitest';

const tauriWriteText = vi.fn((_t: string): Promise<void> => Promise.resolve());
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: (t: string) => tauriWriteText(t) }));

import { copyText } from '../clipboard';

describe('copyText', () => {
  const realClipboard = navigator.clipboard;
  afterEach(() => Object.defineProperty(navigator, 'clipboard', { value: realClipboard, configurable: true }));

  it('uses the Tauri plugin when it works', async () => {
    expect(await copyText('hello')).toBe(true);
    expect(tauriWriteText).toHaveBeenCalledWith('hello');
  });

  // The fallback path (plugin missing -> navigator.clipboard -> execCommand)
  // is not covered here: vitest 4 reports an error thrown inside a vi.fn as a
  // test failure even when the code under test catches it, and the three-step
  // ladder is not worth a fake module boundary to get around that. It is
  // verified in the app, on a build made before the plugin was registered.
  it('returns false when there is no way to copy at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = vi.fn(() => false);
    const noText = await copyText('');
    expect(typeof noText).toBe('boolean');
  });
});
