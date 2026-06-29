import { describe, it, expect } from 'vitest';
import { layoutTree, type ClusterInput } from '@/lib/tree/layout';

const OPTS = { width: 800, height: 600 };

function clusters(weights: number[]): ClusterInput[] {
  return weights.map((weight) => ({ weight }));
}

describe('layoutTree — deterministic geometry', () => {
  it('is deterministic: same input → identical layout', () => {
    const input = clusters([1, 0.5, 0.2]);
    const a = layoutTree(input, OPTS);
    const b = layoutTree(input, OPTS);
    expect(a).toEqual(b);
  });

  it('produces one branch per cluster plus a trunk', () => {
    const layout = layoutTree(clusters([1, 0.5, 0.2]), OPTS);
    expect(layout.branches).toHaveLength(3);
    expect(layout.trunk).toBeDefined();
  });

  it('a heavier cluster gets a thicker, longer branch with more leaves', () => {
    const layout = layoutTree(clusters([1, 0.1]), OPTS);
    const [heavy, light] = layout.branches;
    expect(heavy.thickness).toBeGreaterThan(light.thickness);
    expect(heavy.length).toBeGreaterThan(light.length);
    expect(heavy.leaves.length).toBeGreaterThan(light.leaves.length);
  });

  it("a cluster's branch angle stays put when other clusters are added", () => {
    // The branch identity is the index; adding a 4th cluster must not move the
    // angles of clusters 0..2 (the tree doesn't reshuffle on every rebuild).
    const before = layoutTree(clusters([1, 0.5, 0.2]), OPTS);
    const after = layoutTree(clusters([1, 0.5, 0.2, 0.3]), OPTS);
    for (let i = 0; i < 3; i++) {
      expect(after.branches[i].angle).toBeCloseTo(before.branches[i].angle, 9);
    }
  });
});

describe('layoutTree — maturity floor', () => {
  it('never renders fewer branches than the maturity floor', () => {
    // Floor 5 reached earlier; a corpus that currently clusters into 2 must
    // still show 5 branches — earned maturity is never visually "unlearned".
    const layout = layoutTree(clusters([1, 0.4]), { ...OPTS, minBranches: 5 });
    expect(layout.branches.length).toBeGreaterThanOrEqual(5);
  });

  it('does not pad branches when the cluster count already exceeds the floor', () => {
    const layout = layoutTree(clusters([1, 0.4, 0.3, 0.2]), { ...OPTS, minBranches: 2 });
    expect(layout.branches).toHaveLength(4);
  });

  it('renders a bare trunk (no branches) for an empty corpus', () => {
    const layout = layoutTree([], OPTS);
    expect(layout.branches).toHaveLength(0);
    expect(layout.trunk).toBeDefined();
  });
});

describe('layoutTree — edge cases', () => {
  it('a single cluster still produces a trunk + one branch (no off-by-one)', () => {
    const layout = layoutTree(clusters([1]), OPTS);
    expect(layout.branches).toHaveLength(1);
    expect(layout.trunk).toBeDefined();
    // The lone branch must still be a valid BranchGeom (index 0, finite numbers).
    const b = layout.branches[0];
    expect(b.index).toBe(0);
    expect(Number.isFinite(b.x1) && Number.isFinite(b.y1)).toBe(true);
    expect(b.thickness).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(b.leaves.length).toBeGreaterThanOrEqual(1);
  });

  it('a weight of exactly 0 still draws the branch (visible in the empty-corpus fallback case)', () => {
    // A cluster with weight 0 is a legit input — e.g. an evicted-then-rebuilt
    // topic. We don't drop the branch; we just render it slim and leafless.
    const layout = layoutTree(clusters([0]), OPTS);
    expect(layout.branches).toHaveLength(1);
    const b = layout.branches[0];
    expect(b.thickness).toBeGreaterThanOrEqual(3); // floor of 3 + w*11
    expect(b.length).toBeGreaterThanOrEqual(0);
  });

  it('a weight of exactly 1 produces the thickest, longest, most-leafy branch (cap respected)', () => {
    const layout = layoutTree(clusters([1]), OPTS);
    const b = layout.branches[0];
    // Bumped for the painterly renderer: max thickness = 3 + 1*11 = 14; max
    // length scales with minSpan (= min(height, width)) as 0.16 + 1*0.30.
    // OPTS sets width=height=800, so length → 0.46*800 = 368.
    expect(b.thickness).toBeCloseTo(14, 5);
    expect(b.length).toBeCloseTo(OPTS.height * 0.46, 5);
    // Max leaves = 14 by default; round(1*14) = 14.
    expect(b.leaves.length).toBeLessThanOrEqual(14);
  });

  it('weight > 1 is clamped to 1 (no runaway branches from a corrupt feed)', () => {
    const layout = layoutTree(clusters([5]), OPTS);
    const b = layout.branches[0];
    // Same shape as weight=1 because Math.min(1, w) clamps.
    expect(b.thickness).toBeCloseTo(14, 5);
    expect(b.leaves.length).toBeLessThanOrEqual(14);
  });

  it('weight < 0 is clamped to 0 (no negative thickness from a corrupt feed)', () => {
    const layout = layoutTree(clusters([-0.5]), OPTS);
    const b = layout.branches[0];
    expect(b.thickness).toBeGreaterThanOrEqual(3);
    expect(b.leaves.length).toBeGreaterThanOrEqual(1);
  });

  it('a very deep corpus (minBranches = 5000) renders all 5000 floor branches without crashing', () => {
    // Stress: layoutTree is O(N) in branch count, but the determinism hash
    // chains use `index * 131` etc. — verify no integer overflow / NaN at
    // large indices. (The visual tree would be a smear; the unit test only
    // cares that the geometry is finite + in-bounds.)
    const layout = layoutTree([], { ...OPTS, minBranches: 5000 });
    expect(layout.branches).toHaveLength(5000);
    for (const b of layout.branches) {
      expect(Number.isFinite(b.x1) && Number.isFinite(b.y1)).toBe(true);
      expect(Number.isFinite(b.length) && Number.isFinite(b.thickness)).toBe(true);
      for (const l of b.leaves) {
        expect(Number.isFinite(l.x) && Number.isFinite(l.y)).toBe(true);
      }
    }
  });

  it('a very wide corpus (1000 clusters) renders 1000 branches with stable angles per index', () => {
    // Stress: many siblings must not perturb each other's angles — the
    // contract is `angle = f(index)`, so any reshuffle on rebuild is a bug.
    const input = Array.from({ length: 1000 }, (_, i) => ({ weight: (i % 10) / 10 }));
    const before = layoutTree(input.slice(0, 500), OPTS);
    const after = layoutTree(input, OPTS);
    for (let i = 0; i < 500; i++) {
      expect(after.branches[i].angle).toBeCloseTo(before.branches[i].angle, 9);
    }
  });

  it('a NaN weight is treated as 0 (defensive — corrupt feeds must not crash the renderer)', () => {
    const layout = layoutTree([{ weight: NaN }], OPTS);
    expect(layout.branches).toHaveLength(1);
    expect(layout.branches[0].thickness).toBeGreaterThanOrEqual(3);
  });
});
