import type { RsiStatus } from '@/lib/tauri';

/** A Gaussian domain-warp seed at a cluster's complex-plane position (Phase 3b). */
export interface WarpSeed { x: number; y: number; sigma: number; amp: number }

/** Organism rendering parameters derived from memory + RSI state. */
export interface OrganismState {
  /** Fractional multibrot power (2 = disc/two-lobe, higher = more arms). */
  power: number;
  /** Added to the zoom-driven iteration count (deeper structure). */
  depthBoost: number;
  /** Julia interpolation factor in [0, 0.12]; 0 at rest, eased up on impulse. */
  morph: number;
  /** Cluster-positioned warp seeds (Phase 3b); empty in 3a / pre-tree. */
  warpSeeds: WarpSeed[];
}

export interface OrganismInput {
  /** Distinct memory clusters (RAPTOR top level; a node-type-count proxy in 3a). */
  clusterCount: number;
  /** Surviving (post-prune / "elite") node count — the reactive volume. */
  eliteNodeCount: number;
  /** RSI status; null (or engine === null) when not wired. */
  rsi: RsiStatus | null;
  /** Current persisted monotonic floor (from the maturity store). */
  persistedFloor: number;
  /** Cluster positions for warp seeds (Phase 3b); omitted/empty in 3a. */
  clusters?: { x: number; y: number; weight: number }[];
}

export interface DerivedOrganism {
  state: OrganismState;
  /** New monotonic floor to persist (>= persistedFloor). */
  floor: number;
}

// Tuning constants (see spec §Signal Mapping).
const MORPH_MAX = 0.12;
const REACTIVE_K = 40;        // depthBoost per log2 unit of living nodes (was 18)
const FLOOR_ITER_A = 0.02;    // floor per RSI engine iteration (lifetime maturity)
const FLOOR_BOUNDS_B = 40;    // floor step per bounds_version (paradigm shift)
const MORPH_ITER_G = 0.0008;  // morph per RSI iteration (then clamped)

// Power is a COARSE shape signal: classic cardioid (2) at genesis, easing into
// the 4.5..5 "several macro arms" band as real RAPTOR topics accumulate. It
// NEVER rests in the ugly doubled-blob valley (2, 4.5) — transitions sweep it
// only in motion (handled by the impulse easing layer).
export const POWER_GENESIS = 2;
export const POWER_VALLEY_HI = 4.5;
export const POWER_CAP = 5;
const GENESIS_CLUSTERS = 2;

export function powerForClusters(n: number): number {
  if (!Number.isFinite(n) || n <= GENESIS_CLUSTERS) return POWER_GENESIS;
  const frac = Math.min(1, Math.max(0, Math.log2(n) / Math.log2(64)));
  return POWER_VALLEY_HI + (POWER_CAP - POWER_VALLEY_HI) * frac;
}

const WARP_SIGMA = 0.12;      // base Gaussian width per warp seed (Phase 3b)

export function deriveOrganismState(input: OrganismInput): DerivedOrganism {
  const { clusterCount, eliteNodeCount, rsi, persistedFloor, clusters } = input;
  const engine = rsi?.engine ?? null;
  const iter = engine?.iteration ?? 0;
  const boundsVersion = rsi?.bounds_version ?? 0;

  const power = powerForClusters(clusterCount);

  const floorCandidate = FLOOR_ITER_A * iter + FLOOR_BOUNDS_B * boundsVersion;
  const floor = Math.max(persistedFloor, floorCandidate, 0);

  const reactive = eliteNodeCount <= 0 ? 0 : REACTIVE_K * Math.log2(1 + eliteNodeCount);
  const depthBoost = Math.max(floor, floor + reactive);

  const morph = engine === null ? 0 : Math.min(MORPH_MAX, Math.max(0, MORPH_ITER_G * iter));

  const warpSeeds: WarpSeed[] = (clusters ?? []).map((c) => ({
    x: c.x,
    y: c.y,
    sigma: WARP_SIGMA,
    amp: Math.max(0, c.weight),
  }));

  return { state: { power, depthBoost, morph, warpSeeds }, floor };
}
