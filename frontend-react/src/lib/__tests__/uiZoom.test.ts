import { describe, it, expect, vi, beforeEach } from 'vitest';

const setZoom = vi.fn(async (_z: number) => {});
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ setZoom }) }));

const key = (k: string, extra: Partial<KeyboardEventInit> = {}) =>
  new KeyboardEvent('keydown', { key: k, ctrlKey: true, ...extra });

describe('window size keys', () => {
  beforeEach(async () => {
    setZoom.mockClear();
    const { setUiZoom } = await import('@/lib/uiZoom');
    await setUiZoom(1, false);
    setZoom.mockClear();
  });

  it('Ctrl + grows, Ctrl - shrinks, Ctrl 0 resets, in 10% steps', async () => {
    const { zoomKey, uiZoom } = await import('@/lib/uiZoom');
    expect(zoomKey(key('='))).toBe(true);
    expect(uiZoom()).toBe(1.1);
    zoomKey(key('+', { shiftKey: true }));
    expect(uiZoom()).toBe(1.2);
    zoomKey(key('-'));
    expect(uiZoom()).toBe(1.1);
    zoomKey(key('0'));
    expect(uiZoom()).toBe(1);
    await Promise.resolve();
    expect(setZoom).toHaveBeenLastCalledWith(1);
  });

  it('stops at 160% and 80%, and keeps the choice for the next start', async () => {
    const { zoomKey, uiZoom } = await import('@/lib/uiZoom');
    for (let i = 0; i < 20; i++) zoomKey(key('='));
    expect(uiZoom()).toBe(1.6);
    for (let i = 0; i < 20; i++) zoomKey(key('-'));
    expect(uiZoom()).toBe(0.8);
    await new Promise((r) => setTimeout(r));
    expect(localStorage.getItem('cinderpaw.uiZoom')).toBe('0.8');
  });

  it('saves nothing when the window could not be resized', async () => {
    const { setUiZoom, uiZoom } = await import('@/lib/uiZoom');
    localStorage.setItem('cinderpaw.uiZoom', '1');
    setZoom.mockRejectedValueOnce(new Error('not allowed'));
    await setUiZoom(1.5);
    expect(uiZoom()).toBe(1);
    expect(localStorage.getItem('cinderpaw.uiZoom')).toBe('1');
  });

  it('leaves keys that are not zoom keys alone', async () => {
    const { zoomKey } = await import('@/lib/uiZoom');
    expect(zoomKey(key('n'))).toBe(false);
    expect(zoomKey(new KeyboardEvent('keydown', { key: '=' }))).toBe(false); // no Ctrl
    expect(zoomKey(key('=', { altKey: true }))).toBe(false);
  });
});
