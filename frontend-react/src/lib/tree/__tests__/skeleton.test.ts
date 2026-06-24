import { describe, it, expect } from 'vitest';
import { generateSkeleton } from '../skeleton';
import { deriveTreeState } from '../treeState';
import type { TreeInput } from '../contract';

const input: TreeInput = { clusterCount: 4, eliteNodeCount: 50, rsi: { iteration: 200, boundsVersion: 0 }, persistedFloor: 0, clusters: [] };
const state = deriveTreeState(input).state;

describe('generateSkeleton', () => {
  it('is deterministic for the same state + seed', () => {
    const a = generateSkeleton(state, 42);
    const b = generateSkeleton(state, 42);
    expect(a).toEqual(b);
  });

  it('different seeds produce different skeletons', () => {
    const a = generateSkeleton(state, 1);
    const b = generateSkeleton(state, 2);
    expect(a).not.toEqual(b);
  });

  it('emits the trunk as depth-0 segment(s) plus one branch per primary limb', () => {
    const skel = generateSkeleton(state, 7);
    expect(skel.segments.some((s) => s.depth === 0)).toBe(true);
    const limbRoots = skel.segments.filter((s) => s.depth === 1);
    expect(limbRoots.length).toBe(state.primaryLimbs);
  });

  it('places exactly the requested number of leaves (bounded by capacity)', () => {
    const skel = generateSkeleton(state, 7);
    expect(skel.leaves.length).toBe(state.leafCount);
  });

  it('growth is monotonic: a more mature state keeps the trunk anchored at the same base', () => {
    const young = generateSkeleton(deriveTreeState({ ...input, rsi: { iteration: 50, boundsVersion: 0 } }).state, 7);
    const old = generateSkeleton(deriveTreeState({ ...input, rsi: { iteration: 5000, boundsVersion: 0 } }).state, 7);
    // Trunk base is anchored at canvas bottom-center for both.
    const baseYoung = young.segments.find((s) => s.depth === 0)!;
    const baseOld = old.segments.find((s) => s.depth === 0)!;
    expect(baseOld.x0).toBeCloseTo(baseYoung.x0, 5);
    expect(baseOld.y0).toBeCloseTo(baseYoung.y0, 5);
    // Older trunk reaches at least as high.
    expect(baseOld.y1).toBeGreaterThanOrEqual(baseYoung.y1);
  });

  it('respects recursion depth (no segment deeper than state.depth)', () => {
    const skel = generateSkeleton(state, 7);
    expect(Math.max(...skel.segments.map((s) => s.depth))).toBeLessThanOrEqual(state.depth);
  });

  it('trunk height is non-decreasing across a sweep of RSI iterations (monotonic growth)', () => {
    let prev = -Infinity;
    for (const iter of [0, 10, 100, 500, 2000, 10000]) {
      const s = deriveTreeState({ ...input, rsi: { iteration: iter, boundsVersion: 0 } }).state;
      const trunk = generateSkeleton(s, 7).segments.find((seg) => seg.depth === 0)!;
      expect(trunk.y1).toBeGreaterThanOrEqual(prev);
      prev = trunk.y1;
    }
  });

  it('never emits a segment deeper than state.depth across shallow and deep states', () => {
    for (const iter of [0, 5000]) {
      const s = deriveTreeState({ ...input, rsi: { iteration: iter, boundsVersion: 0 } }).state;
      const skel = generateSkeleton(s, 7);
      expect(Math.max(...skel.segments.map((seg) => seg.depth))).toBeLessThanOrEqual(s.depth);
    }
  });

  it('branch positions are append-only stable across a depth increment (no crown reshuffle)', () => {
    const key = (s: { x0: number; y0: number; x1: number; y1: number; depth: number }) =>
      `${s.depth}:${s.x0.toFixed(6)},${s.y0.toFixed(6)},${s.x1.toFixed(6)},${s.y1.toFixed(6)}`;
    const shallow = generateSkeleton({ ...state, depth: 3 }, 7);
    const deep = generateSkeleton({ ...state, depth: 4 }, 7);
    const deepKeys = new Set(deep.segments.map(key));
    for (const seg of shallow.segments) {
      expect(deepKeys.has(key(seg))).toBe(true); // every shallow segment survives, position-identical, in the deeper tree
    }
  });
});
