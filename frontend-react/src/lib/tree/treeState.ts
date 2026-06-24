import type { TreeInput } from './contract';

export const MIN_LIMBS = 2;
export const MAX_LIMBS = 7;
export const MAX_LEAVES = 600;
export const MIN_DEPTH = 2;
export const MAX_DEPTH = 12;     // silhouette fractal: 10–12 subdivisions read as a full tree, 6 looked schematic

const FLOOR_ITER_A = 0.02;     // floor per RSI iteration (lifetime maturity)
const FLOOR_BOUNDS_B = 40;     // floor step per bounds_version (paradigm shift)
const LEAVES_PER_NODE = 1.5;   // foliage volume per surviving node

export interface TreeState {
  /** Trunk height, normalized 0..1 of canvas height. */
  trunkHeight: number;
  /** Trunk base half-width, normalized. */
  trunkGirth: number;
  /** Primary limbs off the trunk = clamped cluster count. */
  primaryLimbs: number;
  /** Branch recursion depth (older ⇒ deeper). */
  depth: number;
  /** Target leaf count ∝ elite node count, capped. */
  leafCount: number;
  /** Per-limb angular bias (radians); 0 when no cluster position. */
  limbBias: number[];
}

export interface DerivedTree { state: TreeState; floor: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Saturating 0..1 growth curve — fast early, asymptotes so a very old
 *  tree never overflows the frame. */
const saturate = (x: number, k: number) => 1 - Math.exp(-x / k);

export function deriveTreeState(input: TreeInput): DerivedTree {
  const iter = input.rsi?.iteration ?? 0;
  const boundsVersion = input.rsi?.boundsVersion ?? 0;

  const floorCandidate = FLOOR_ITER_A * iter + FLOOR_BOUNDS_B * boundsVersion;
  const floor = Math.max(input.persistedFloor, floorCandidate, 0);

  // Maturity drives size via a saturating curve. Sapling baseline 0.18 so
  // genesis still shows something; asymptote ~0.18 + 0.5 = 0.68 of height.
  const m = saturate(floor, 120);
  const trunkHeight = 0.18 + 0.5 * m;
  const trunkGirth = 0.012 + 0.05 * m;
  // Silhouette fractal needs many subdivisions to read as a full tree. Rate
  // floor/40 keeps depth=2 at genesis, ~5 at floor=120, ~12 at floor=400+.
  const depth = Math.round(clamp(2 + floor / 40, MIN_DEPTH, MAX_DEPTH));

  const primaryLimbs = clamp(Math.round(input.clusterCount), MIN_LIMBS, MAX_LIMBS);
  const leafCount = clamp(Math.round(input.eliteNodeCount * LEAVES_PER_NODE), 0, MAX_LEAVES);

  const limbBias: number[] = [];
  for (let i = 0; i < primaryLimbs; i++) {
    const c = input.clusters[i];
    // Lean toward the cluster's horizontal position (x in [-1,1] → bias).
    limbBias.push(c ? clamp(c.x, -1, 1) * 0.4 : 0);
  }

  return { state: { trunkHeight, trunkGirth, primaryLimbs, depth, leafCount, limbBias }, floor };
}
