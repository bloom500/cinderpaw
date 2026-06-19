import { describe, it, expect } from 'vitest';
import { layoutNodes } from '@/lib/fractal/layout';
import type { MemoryGraphSnapshot } from '@/lib/tauri';

const snap: MemoryGraphSnapshot = {
  nodes: [
    { id: 'a', label: 'A', type: 'entity', touched_at: 1 },
    { id: 'b', label: 'B', type: 'concept', touched_at: 2 },
    { id: 'c', label: 'C', type: 'fact', touched_at: 3 },
  ],
  edges: [
    { from: 'a', to: 'b', relation: 'rel' },
    { from: 'a', to: 'c', relation: 'rel' },
  ],
};

describe('layoutNodes', () => {
  it('is deterministic for the same snapshot', () => {
    const a = layoutNodes(snap);
    const b = layoutNodes(snap);
    expect(a).toEqual(b);
  });
  it('positions every node and computes degree', () => {
    const out = layoutNodes(snap);
    expect(out).toHaveLength(3);
    expect(out.find((n) => n.id === 'a')!.degree).toBe(2);
    expect(out.find((n) => n.id === 'b')!.degree).toBe(1);
    for (const n of out) {
      expect(Number.isFinite(n.wx)).toBe(true);
      expect(Number.isFinite(n.wy)).toBe(true);
    }
  });

  it('lays out 100,000 nodes quickly and deterministically', () => {
    // Pure perf + determinism check at the spec's stress scale. No UI, no
    // backend — this just exercises layoutNodes() directly.
    const N = 100_000;
    const big: MemoryGraphSnapshot = {
      nodes: Array.from({ length: N }, (_, i) => ({
        id: `n${i}`, label: `N${i}`, type: 'fact', touched_at: i,
      })),
      edges: [],
    };
    const t0 = performance.now();
    const a = layoutNodes(big);
    const ms = performance.now() - t0;
    expect(a).toHaveLength(N);
    expect(ms).toBeLessThan(500);            // pure layout is O(n), no physics
    // determinism still holds at scale (spot-check a few, full compare is heavy)
    const b = layoutNodes(big);
    expect(b[0]).toEqual(a[0]);
    expect(b[N - 1]).toEqual(a[N - 1]);
    expect(b[50_000]).toEqual(a[50_000]);
  });
});
