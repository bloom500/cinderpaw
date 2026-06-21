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
const REACTIVE_K = 18;        // depthBoost per log2 unit of living nodes
const FLOOR_ITER_A = 0.02;    // floor per RSI engine iteration (lifetime maturity)
const FLOOR_BOUNDS_B = 40;    // floor step per bounds_version (paradigm shift)
const MORPH_ITER_G = 0.0008;  // morph per RSI iteration (then clamped)

// Tuning (see spec §Signal Mapping).
// Exponent is locked to 2: the organism must read as THE Mandelbrot, not a
// doubled/mirrored multibrot. Memory diversity drives depth/colour, not power.
const MANDELBROT_POWER = 2;
const WARP_SIGMA = 0.12;      // base Gaussian width per warp seed (Phase 3b)

export function deriveOrganismState(input: OrganismInput): DerivedOrganism {
  const { eliteNodeCount, rsi, persistedFloor, clusters } = input;
  const engine = rsi?.engine ?? null;
  const iter = engine?.iteration ?? 0;
  const boundsVersion = rsi?.bounds_version ?? 0;

  const power = MANDELBROT_POWER;

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
