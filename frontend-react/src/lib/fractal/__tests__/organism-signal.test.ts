import { describe, it, expect } from 'vitest';
import { deriveOrganismState, powerForClusters } from '@/lib/fractal/signal';
import type { RsiStatus } from '@/lib/tauri';

const noRsi = null;
const rsiWith = (iteration: number, bounds_version = 0): RsiStatus =>
  ({ engine: { iteration }, bounds_version } as unknown as RsiStatus);

describe('powerForClusters — coarse signal that skips the ugly valley', () => {
  it('genesis: 2 or fewer clusters → exactly power 2', () => {
    for (const n of [0, 1, 2]) expect(powerForClusters(n)).toBe(2);
  });
  it('never rests in the open valley (2, 4.5)', () => {
    for (let n = 0; n <= 100000; n += 137) {
      const p = powerForClusters(n);
      expect(p === 2 || p >= 4.5).toBe(true);
    }
  });
  it('saturates at the cap 5.0', () => {
    expect(powerForClusters(100000)).toBeLessThanOrEqual(5);
    expect(powerForClusters(100000)).toBeGreaterThan(4.5);
  });
  it('more clusters → monotonically non-decreasing power', () => {
    let prev = 0;
    for (const n of [3, 8, 32, 256, 4096]) {
      const p = powerForClusters(n);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe('deriveOrganismState — power from real clusters', () => {
  it('power is 2 for a newborn (0 clusters)', () => {
    const { state } = deriveOrganismState({ clusterCount: 0, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 });
    expect(state.power).toBe(2);
  });
  it('power climbs above the valley with many clusters', () => {
    const { state } = deriveOrganismState({ clusterCount: 64, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 });
    expect(state.power).toBeGreaterThanOrEqual(4.5);
  });
  it('warpSeeds come from provided clusters', () => {
    const { state } = deriveOrganismState({
      clusterCount: 2, eliteNodeCount: 10, rsi: noRsi, persistedFloor: 0,
      clusters: [{ x: -0.5, y: 0.2, weight: 1 }, { x: -1.1, y: -0.3, weight: 0.5 }],
    });
    expect(state.warpSeeds).toHaveLength(2);
    expect(state.warpSeeds[0]).toMatchObject({ x: -0.5, y: 0.2 });
  });
});

describe('deriveOrganismState — floor (monotonic maturity)', () => {
  it('floor never drops below persistedFloor even if signals shrink', () => {
    const { floor } = deriveOrganismState({ clusterCount: 0, eliteNodeCount: 0, rsi: rsiWith(0), persistedFloor: 500 });
    expect(floor).toBeGreaterThanOrEqual(500);
  });
  it('a bounds_version bump raises the floor and it stays raised after a node drop', () => {
    const bumped = deriveOrganismState({ clusterCount: 10, eliteNodeCount: 100, rsi: rsiWith(10, 3), persistedFloor: 0 }).floor;
    const later = deriveOrganismState({ clusterCount: 1, eliteNodeCount: 1, rsi: rsiWith(10, 3), persistedFloor: bumped }).floor;
    expect(later).toBeGreaterThanOrEqual(bumped);
  });
});

describe('deriveOrganismState — depth + extinction', () => {
  it('depthBoost shrinks when eliteNodeCount shrinks but stays >= floor', () => {
    const big = deriveOrganismState({ clusterCount: 5, eliteNodeCount: 500, rsi: rsiWith(50), persistedFloor: 0 });
    const small = deriveOrganismState({ clusterCount: 5, eliteNodeCount: 5, rsi: rsiWith(50), persistedFloor: big.floor });
    expect(small.state.depthBoost).toBeLessThan(big.state.depthBoost);
    expect(small.state.depthBoost).toBeGreaterThanOrEqual(small.floor);
  });
});

describe('deriveOrganismState — graceful null', () => {
  it('rsi null → morph 0 and no crash', () => {
    const { state } = deriveOrganismState({ clusterCount: 3, eliteNodeCount: 10, rsi: noRsi, persistedFloor: 0 });
    expect(state.morph).toBe(0);
  });
  it('morph is clamped to 0.12', () => {
    const { state } = deriveOrganismState({ clusterCount: 3, eliteNodeCount: 10, rsi: rsiWith(1_000_000), persistedFloor: 0 });
    expect(state.morph).toBeLessThanOrEqual(0.12);
  });
  it('warpSeeds empty when no clusters provided', () => {
    const { state } = deriveOrganismState({ clusterCount: 3, eliteNodeCount: 10, rsi: noRsi, persistedFloor: 0 });
    expect(state.warpSeeds).toEqual([]);
  });
});
