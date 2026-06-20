import { describe, it, expect } from 'vitest';
import { deriveFractalState } from '@/lib/fractal/signal';
import type { RsiStatus } from '@/lib/tauri';

const rsi = (iteration: number | null, boundsVersion: number | null): RsiStatus => ({
  initialized: true,
  bounds_sha256: null,
  bounds_version: boundsVersion,
  max_total_cost_usd: null,
  cost_warning_ratio: null,
  main_tip: null,
  main_tip_score: null,
  engine: iteration === null ? null : {
    running: true, iteration, best_score: null, cost_so_far_usd: 0,
    concurrency: 1, stop_reason: null,
  },
});

describe('deriveFractalState', () => {
  it('empty DB with zero floor → depthBoost 0, morph 0', () => {
    const { state } = deriveFractalState({ nodeCount: 0, rsi: null, persistedFloor: 0 });
    expect(state.depthBoost).toBe(0);
    expect(state.morph).toBe(0);
  });

  it('null engine → morph 0 (no crash)', () => {
    const { state } = deriveFractalState({ nodeCount: 100, rsi: rsi(null, 3), persistedFloor: 0 });
    expect(state.morph).toBe(0);
  });

  it('morph is clamped at 0.12', () => {
    const { state } = deriveFractalState({ nodeCount: 100, rsi: rsi(1_000_000, 0), persistedFloor: 0 });
    expect(state.morph).toBeLessThanOrEqual(0.12);
    expect(state.morph).toBeGreaterThan(0);
  });

  it('floor never decreases below persistedFloor', () => {
    const { floor } = deriveFractalState({ nodeCount: 0, rsi: rsi(0, 0), persistedFloor: 250 });
    expect(floor).toBeGreaterThanOrEqual(250);
  });

  it('a bounds_version bump raises the floor and it stays after a node drop', () => {
    const bumped = deriveFractalState({ nodeCount: 500, rsi: rsi(10, 5), persistedFloor: 0 });
    expect(bumped.floor).toBeGreaterThan(0);
    // later: nodes pruned to 0, engine reset to null — floor must persist via caller
    const after = deriveFractalState({ nodeCount: 0, rsi: null, persistedFloor: bumped.floor });
    expect(after.floor).toBe(bumped.floor);
    expect(after.state.depthBoost).toBeGreaterThanOrEqual(bumped.floor); // reactive=0, floor holds
  });

  it('reactive shrinks when nodeCount shrinks but total stays >= floor', () => {
    const many = deriveFractalState({ nodeCount: 10_000, rsi: null, persistedFloor: 100 });
    const few  = deriveFractalState({ nodeCount: 10,     rsi: null, persistedFloor: 100 });
    expect(few.state.depthBoost).toBeLessThan(many.state.depthBoost);
    expect(few.state.depthBoost).toBeGreaterThanOrEqual(100);
  });
});
