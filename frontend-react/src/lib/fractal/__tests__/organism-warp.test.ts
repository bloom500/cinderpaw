import { describe, it, expect } from 'vitest';
import { packWarpUniforms, MAX_WARP } from '@/lib/fractal/organism';
import type { WarpSeed } from '@/lib/fractal/signal';

const seed = (x: number, y: number, sigma = 0.12, amp = 1): WarpSeed => ({ x, y, sigma, amp });

describe('packWarpUniforms', () => {
  it('packs count, xy and sa interleaved', () => {
    const { count, xy, sa } = packWarpUniforms([seed(-0.5, 0.2, 0.1, 0.8)]);
    expect(count).toBe(1);
    expect(xy.length).toBe(MAX_WARP * 2);
    expect(sa.length).toBe(MAX_WARP * 2);
    expect([xy[0], xy[1]]).toEqual([-0.5, 0.2].map((v) => Math.fround(v)));
    expect([sa[0], sa[1]]).toEqual([0.1, 0.8].map((v) => Math.fround(v)));
  });
  it('clamps to MAX_WARP seeds', () => {
    const many = Array.from({ length: MAX_WARP + 10 }, (_, i) => seed(i, i));
    expect(packWarpUniforms(many).count).toBe(MAX_WARP);
  });
  it('empty seeds → count 0', () => {
    expect(packWarpUniforms([]).count).toBe(0);
  });
  it('keeps the highest-amp seeds when clamping past MAX_WARP', () => {
    // MAX_WARP low-amp seeds first, then one unmistakable high-amp seed at the end.
    const low = Array.from({ length: MAX_WARP }, (_, i) => seed(i, i, 0.12, 0.01));
    const hot = seed(-1.5, 0.5, 0.2, 99);
    const { count, xy, sa } = packWarpUniforms([...low, hot]);
    expect(count).toBe(MAX_WARP);
    // The hot seed (amp 99) must be packed (it would be dropped under naive first-N clamping).
    let found = false;
    for (let i = 0; i < MAX_WARP; i++) {
      if (sa[i * 2 + 1] === Math.fround(99)) { found = true; expect([xy[i * 2], xy[i * 2 + 1]]).toEqual([Math.fround(-1.5), Math.fround(0.5)]); }
    }
    expect(found).toBe(true);
  });
});
