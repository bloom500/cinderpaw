/**
 * Tree-interpreted signal layer — the reactive-tree counterpart of the
 * Mandelbrot's `lib/fractal/signal.ts`. The Mandelbrot-specific dimensions
 * (power / warpSeeds / Julia morph) retire; what survives is the **monotonic
 * maturity floor** (a tree never unlearns below the structure it has reached)
 * and a crown-density signal derived from the surviving node count.
 */

export interface TreeSignalInput {
  /** Distinct RAPTOR top-level clusters (branch count target). */
  clusterCount: number;
  /** Surviving ("elite") leaf count — drives crown density. */
  eliteNodeCount: number;
  /** Current persisted monotonic floor (from the maturity store). */
  persistedFloor: number;
}

export interface TreeSignal {
  /** Minimum branches the tree always shows (monotonic; never unlearned). */
  minBranches: number;
  /** Crown fullness in 0..1, from the surviving node count. */
  crownDensity: number;
}

export interface DerivedTree {
  signal: TreeSignal;
  /** New monotonic floor to persist (>= persistedFloor and >= clusterCount). */
  floor: number;
}

/** Node count at which the crown reads as visually "full" (density → 1). */
const CROWN_FULL_AT = 256;

export function deriveTreeSignal(input: TreeSignalInput): DerivedTree {
  const { clusterCount, eliteNodeCount, persistedFloor } = input;

  // The floor only ever climbs: the most topics the tree has ever organized
  // into stays as the minimum branch count, even after a prune-heavy rebuild.
  const floor = Math.max(persistedFloor, clusterCount, 0);

  const crownDensity =
    eliteNodeCount <= 0
      ? 0
      : Math.min(1, Math.log2(1 + eliteNodeCount) / Math.log2(1 + CROWN_FULL_AT));

  return { signal: { minBranches: Math.round(floor), crownDensity }, floor };
}

/**
 * Live crown leaf model the reactive pulses mutate. `count` is the visible
 * leaf count; `floor` is the earned minimum a `prune` can never fall below.
 */
export interface CrownModel {
  floor: number;
  count: number;
}

/** `seed` pulse — a memory was written → one new leaf. Pure. */
export function seedLeaf(m: CrownModel): CrownModel {
  return { ...m, count: m.count + 1 };
}

/** `prune` pulse — a leaf fell, but never below the maturity floor. Pure. */
export function pruneLeaf(m: CrownModel): CrownModel {
  return { ...m, count: Math.max(m.floor, m.count - 1) };
}
