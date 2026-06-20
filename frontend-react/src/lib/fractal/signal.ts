import type { RsiStatus } from '@/lib/tauri';

/** Rendering parameters derived from memory + RSI state. */
export interface FractalState {
  /** Added to the zoom-driven iteration count (deeper structure). */
  depthBoost: number;
  /** Julia interpolation factor in [0, 0.12]. */
  morph: number;
}

export interface FractalSignalInput {
  /** Survivors in the current graph snapshot (already post-prune / "elite"). */
  nodeCount: number;
  /** RSI status; `null` (or `engine === null`) when the engine isn't wired. */
  rsi: RsiStatus | null;
  /** Current persisted monotonic floor (from the maturity store). */
  persistedFloor: number;
}

export interface DerivedFractal {
  state: FractalState;
  /** New monotonic floor to persist (>= persistedFloor). */
  floor: number;
}

// Tuning constants (see spec §Signal Mapping).
const MORPH_MAX = 0.12;
const REACTIVE_K = 18;        // depthBoost per log2 unit of living nodes
const FLOOR_ITER_A = 0.02;    // floor per RSI engine iteration (lifetime maturity)
const FLOOR_BOUNDS_B = 40;    // floor step per bounds_version (paradigm shift)
const MORPH_ITER_G = 0.0008;  // morph per RSI iteration (then clamped)

export function deriveFractalState(input: FractalSignalInput): DerivedFractal {
  const { nodeCount, rsi, persistedFloor } = input;
  const engine = rsi?.engine ?? null;
  const iter = engine?.iteration ?? 0;
  const boundsVersion = rsi?.bounds_version ?? 0;

  // Monotonic floor: max of what we've ever reached and this snapshot's candidate.
  const floorCandidate = FLOOR_ITER_A * iter + FLOOR_BOUNDS_B * boundsVersion;
  const floor = Math.max(persistedFloor, floorCandidate, 0);

  // Reactive "living volume": grows with nodes, retracts on prune. 0 for empty DB.
  const reactive = nodeCount <= 0 ? 0 : REACTIVE_K * Math.log2(1 + nodeCount);

  const depthBoost = Math.max(0, floor + reactive);
  const morph = engine === null ? 0 : Math.min(MORPH_MAX, Math.max(0, MORPH_ITER_G * iter));

  return { state: { depthBoost, morph }, floor };
}
