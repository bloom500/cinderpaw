import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emberAvailability, hasWebGL2, resetEmberAvailability } from '../emberAvailability';

const fakeGl = { getExtension: () => ({ loseContext: () => {} }) };

describe('emberAvailability', () => {
  beforeEach(() => resetEmberAvailability());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('reads WebGL 2 from a canvas', () => {
    const doc = (gl: unknown) => ({ createElement: () => ({ getContext: () => gl }) }) as unknown as Document;
    expect(hasWebGL2(doc(fakeGl))).toBe(true);
    expect(hasWebGL2(doc(null))).toBe(false);
  });

  it('is off, with a reason on screen, without WebGL 2', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(await emberAvailability()).toEqual({ ok: false, reason: expect.stringMatching(/WebGL 2/) });
  });

  it('is off, with a reason on screen, when this build has no game', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeGl as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await emberAvailability()).toEqual({ ok: false, reason: expect.stringMatching(/without the game/) });
  });

  it('is on with WebGL 2 and the export present, and asks only once', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeGl as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    expect(await emberAvailability()).toEqual({ ok: true });
    await emberAvailability();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
