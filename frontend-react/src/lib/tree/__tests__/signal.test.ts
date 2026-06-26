import { describe, it, expect } from 'vitest';
import { deriveTreeSignal, seedLeaf, pruneLeaf, type CrownModel } from '@/lib/tree/signal';

describe('deriveTreeSignal — monotonic maturity floor', () => {
  it('floor never drops below the persisted value', () => {
    const a = deriveTreeSignal({ clusterCount: 5, eliteNodeCount: 100, persistedFloor: 0 });
    expect(a.floor).toBeGreaterThanOrEqual(5);
    // A later rebuild that clusters into only 2 must NOT lower the floor.
    const b = deriveTreeSignal({ clusterCount: 2, eliteNodeCount: 40, persistedFloor: a.floor });
    expect(b.floor).toBe(a.floor);
    expect(b.signal.minBranches).toBe(a.signal.minBranches);
  });

  it('minBranches grows as the corpus clusters into more topics', () => {
    const small = deriveTreeSignal({ clusterCount: 3, eliteNodeCount: 50, persistedFloor: 0 });
    const big = deriveTreeSignal({ clusterCount: 9, eliteNodeCount: 300, persistedFloor: small.floor });
    expect(big.signal.minBranches).toBeGreaterThan(small.signal.minBranches);
  });

  it('crown density is 0 for an empty corpus and rises with surviving nodes', () => {
    const empty = deriveTreeSignal({ clusterCount: 0, eliteNodeCount: 0, persistedFloor: 0 });
    expect(empty.signal.crownDensity).toBe(0);
    const populated = deriveTreeSignal({ clusterCount: 4, eliteNodeCount: 200, persistedFloor: 0 });
    expect(populated.signal.crownDensity).toBeGreaterThan(0);
    expect(populated.signal.crownDensity).toBeLessThanOrEqual(1);
  });
});

describe('crown pulse reducers', () => {
  const base: CrownModel = { floor: 3, count: 5 };

  it('seedLeaf adds exactly one leaf', () => {
    expect(seedLeaf(base).count).toBe(6);
  });

  it('pruneLeaf removes one leaf', () => {
    expect(pruneLeaf(base).count).toBe(4);
  });

  it('pruneLeaf never drops the crown below the maturity floor', () => {
    const atFloor: CrownModel = { floor: 3, count: 3 };
    expect(pruneLeaf(atFloor).count).toBe(3);
    expect(pruneLeaf(pruneLeaf(atFloor)).count).toBe(3);
  });

  it('reducers are pure — they do not mutate the input', () => {
    const m: CrownModel = { floor: 1, count: 2 };
    seedLeaf(m);
    pruneLeaf(m);
    expect(m).toEqual({ floor: 1, count: 2 });
  });
});

describe('deriveTreeSignal — edge cases', () => {
  it('a negative clusterCount never produces a negative floor (clamped to 0)', () => {
    // Defensive: a corrupt feed with -1 must not push minBranches below 0
    // (the floor store assumes a non-negative integer).
    const { floor } = deriveTreeSignal({ clusterCount: -1, eliteNodeCount: 0, persistedFloor: 0 });
    expect(floor).toBe(0);
  });

  it('a persistedFloor much larger than the live clusterCount is honoured (maturity is sticky)', () => {
    // The whole point of the floor: prune-heavy rebuilds must not visually
    // unlearn what was already earned. persistedFloor=42 wins.
    const { floor, signal } = deriveTreeSignal({ clusterCount: 2, eliteNodeCount: 5, persistedFloor: 42 });
    expect(floor).toBe(42);
    expect(signal.minBranches).toBe(42);
  });

  it('a very deep corpus (eliteNodeCount = 1e6) saturates the crown density at 1', () => {
    // Density is log-scaled, so 1e6 is way past CROWN_FULL_AT (256).
    const { signal } = deriveTreeSignal({ clusterCount: 4, eliteNodeCount: 1_000_000, persistedFloor: 0 });
    expect(signal.crownDensity).toBe(1);
  });

  it('crownDensity is monotonic non-decreasing in eliteNodeCount', () => {
    // Pin the log-scaling: every step up in node count must NOT decrease
    // the rendered density (the tree never looks less full than it did).
    const densities: number[] = [];
    for (const n of [0, 1, 10, 100, 1_000, 10_000, 100_000]) {
      const { signal } = deriveTreeSignal({ clusterCount: 4, eliteNodeCount: n, persistedFloor: 0 });
      densities.push(signal.crownDensity);
    }
    for (let i = 1; i < densities.length; i++) {
      expect(densities[i]).toBeGreaterThanOrEqual(densities[i - 1]);
    }
  });

  it('round-trip: deriveTreeSignal → persisted floor → next derive is stable', () => {
    // The persistence loop: take the floor, feed it back in as persistedFloor.
    // A monotonic floor must NEVER decrease on round-trip.
    const a = deriveTreeSignal({ clusterCount: 7, eliteNodeCount: 80, persistedFloor: 0 });
    const b = deriveTreeSignal({ clusterCount: 3, eliteNodeCount: 10, persistedFloor: a.floor });
    expect(b.floor).toBe(a.floor);
  });
});

describe('crown pulse reducers — edge cases', () => {
  it('seedLeaf at count=0 still produces count=1 (the first leaf)', () => {
    const m: CrownModel = { floor: 0, count: 0 };
    expect(seedLeaf(m).count).toBe(1);
  });

  it('pruneLeaf at floor=count=0 stays at 0 (negative-count guard)', () => {
    const m: CrownModel = { floor: 0, count: 0 };
    expect(pruneLeaf(m).count).toBe(0);
    // Even after many prune calls, never below the floor.
    let cur = m;
    for (let i = 0; i < 10; i++) cur = pruneLeaf(cur);
    expect(cur.count).toBe(0);
  });

  it('1000 seed pulses on a fresh crown still produce a finite count', () => {
    let cur: CrownModel = { floor: 0, count: 0 };
    for (let i = 0; i < 1000; i++) cur = seedLeaf(cur);
    expect(cur.count).toBe(1000);
    expect(cur.floor).toBe(0);
  });

  it('floor=count, then 1000 prune pulses: count never goes below floor', () => {
    let cur: CrownModel = { floor: 50, count: 50 };
    for (let i = 0; i < 1000; i++) cur = pruneLeaf(cur);
    expect(cur.count).toBe(50);
  });
});
