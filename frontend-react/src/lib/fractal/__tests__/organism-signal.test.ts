import { describe, it, expect } from 'vitest';
import { deriveOrganismState } from '@/lib/fractal/signal';
import type { RsiStatus } from '@/lib/tauri';

const noRsi = null;
const rsiWith = (iteration: number, bounds_version = 0): RsiStatus =>
  ({ engine: { iteration }, bounds_version } as unknown as RsiStatus);

describe('deriveOrganismState — power (arms from diversity)', () => {
  it('newborn (no clusters) → power 2', () => {
    const { state } = deriveOrganismState({ clusterCount: 0, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 });
    expect(state.power).toBe(2);
  });
  it('power rises with clusterCount', () => {
    const a = deriveOrganismState({ clusterCount: 2, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 }).state.power;
    const b = deriveOrganismState({ clusterCount: 32, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 }).state.power;
    expect(b).toBeGreaterThan(a);
  });
  it('power is clamped to 8', () => {
    const { state } = deriveOrganismState({ clusterCount: 100000, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 });
    expect(state.power).toBeLessThanOrEqual(8);
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
