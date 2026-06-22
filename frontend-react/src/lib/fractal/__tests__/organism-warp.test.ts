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
});
