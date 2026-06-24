import { describe, it, expect } from 'vitest';
import { deriveTreeState, MIN_LIMBS, MAX_LIMBS, MAX_LEAVES } from '../treeState';
import type { TreeInput } from '../contract';

const base: TreeInput = { clusterCount: 3, eliteNodeCount: 40, rsi: { iteration: 100, boundsVersion: 0 }, persistedFloor: 0, clusters: [] };

describe('deriveTreeState', () => {
  it('maps cluster count to primary limbs, clamped', () => {
    expect(deriveTreeState({ ...base, clusterCount: 4 }).state.primaryLimbs).toBe(4);
    expect(deriveTreeState({ ...base, clusterCount: 1 }).state.primaryLimbs).toBe(MIN_LIMBS);
    expect(deriveTreeState({ ...base, clusterCount: 99 }).state.primaryLimbs).toBe(MAX_LIMBS);
  });

  it('leaf count grows with elite node count and is capped', () => {
    const few = deriveTreeState({ ...base, eliteNodeCount: 10 }).state.leafCount;
    const many = deriveTreeState({ ...base, eliteNodeCount: 200 }).state.leafCount;
    expect(many).toBeGreaterThan(few);
    expect(deriveTreeState({ ...base, eliteNodeCount: 100000 }).state.leafCount).toBe(MAX_LEAVES);
  });

  it('floor is monotonic — never below the persisted floor', () => {
    const d = deriveTreeState({ ...base, persistedFloor: 999, rsi: { iteration: 1, boundsVersion: 0 } });
    expect(d.floor).toBe(999);
  });

  it('higher RSI iteration never yields a shorter trunk', () => {
    const young = deriveTreeState({ ...base, rsi: { iteration: 10, boundsVersion: 0 } }).state.trunkHeight;
    const old = deriveTreeState({ ...base, rsi: { iteration: 1000, boundsVersion: 0 } }).state.trunkHeight;
    expect(old).toBeGreaterThanOrEqual(young);
  });

  it('empty clusters give a symmetric (all-zero) limb bias of the right length', () => {
    const s = deriveTreeState({ ...base, clusterCount: 5, clusters: [] }).state;
    expect(s.limbBias).toHaveLength(5);
    expect(s.limbBias.every((b) => b === 0)).toBe(true);
  });

  it('genesis (no rsi, zero nodes) is a small sapling with no leaves', () => {
    const s = deriveTreeState({ clusterCount: 0, eliteNodeCount: 0, rsi: null, persistedFloor: 0, clusters: [] }).state;
    expect(s.leafCount).toBe(0);
    expect(s.primaryLimbs).toBe(MIN_LIMBS);
    expect(s.trunkHeight).toBeGreaterThan(0);
  });

  it('limbBias length equals clamped primaryLimbs even when clusterCount exceeds MAX_LIMBS', () => {
    const s = deriveTreeState({ ...base, clusterCount: 99 }).state;
    expect(s.primaryLimbs).toBe(MAX_LIMBS);
    expect(s.limbBias).toHaveLength(MAX_LIMBS);
  });
});
