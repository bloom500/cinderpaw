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
});
