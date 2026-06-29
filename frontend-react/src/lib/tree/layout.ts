/**
 * Deterministic tree geometry from the RAPTOR cluster set.
 *
 * The projected centroids (`clusters[].x/y`) look random for a tree, so instead
 * we lay out a central trunk with branches fanning out at angles seeded purely
 * by each cluster's **index** — so a cluster's branch stays put across rebuilds
 * even as siblings appear. `weight` (= normalized leaf count) drives a branch's
 * thickness, length, and how many leaves it carries.
 *
 * Pure + side-effect-free so the layout is unit-testable without a canvas: same
 * input → identical geometry.
 */

export interface ClusterInput {
  /** Normalized leaf-count weight in 0..1 (drives thickness / length / leaves). */
  weight: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /**
   * Maturity floor: the minimum number of branches the tree always shows. When
   * the live cluster count is below it, slim "earned" branches pad the crown so
   * the tree never visually unlearns the maturity it has reached.
   */
  minBranches?: number;
  /** Leaves carried by a full-weight (1.0) branch. */
  maxLeavesPerBranch?: number;
}

export interface LeafGeom {
  x: number;
  y: number;
  size: number;
}

export interface BranchGeom {
  index: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Radians from vertical (negative = left), deterministic from `index`. */
  angle: number;
  length: number;
  thickness: number;
  leaves: LeafGeom[];
}

export interface TreeLayout {
  trunk: { x0: number; y0: number; x1: number; y1: number; thickness: number };
  branches: BranchGeom[];
}

/** Maximum branch fan half-angle (radians) either side of vertical. ~72° lets
 *  the canopy splay outward enough that the crown looks like a tree silhouette
 *  and not a stick figure with a topknot. */
const MAX_SPREAD = 1.25;
/** Weight assigned to a floor-padded ("earned but currently empty") branch. */
const FLOOR_BRANCH_WEIGHT = 0.12;
const DEFAULT_MAX_LEAVES = 14;

/** Deterministic integer hash → [0, 1). Stable per input across runs. */
function hash01(n: number): number {
  let x = ((n + 1) * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = (x * 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

/** Branch fan angle for a cluster index — depends ONLY on the index. */
function angleForIndex(index: number): number {
  return (hash01(index) * 2 - 1) * MAX_SPREAD;
}

/** Fork height ratio along the trunk (0 = at base, 1 = at top). Index-driven
 *  so each branch stays in its lane across rebuilds, but staggered so the
 *  canopy opens naturally instead of crowding one fork point. */
function forkHeightRatioForIndex(index: number): number {
  // Two rings of forks — alternating high/low by index parity — give us
  // branches from 4 distinct heights on the trunk instead of 1.
  const ring = (index >> 1) % 4;
  return 0.55 + ring * 0.085;
}

function buildBranch(
  index: number,
  weight: number,
  forkX: number,
  trunkBaseY: number,
  trunkTopY: number,
  height: number,
  width: number,
  maxLeaves: number,
): BranchGeom {
  // Defensive: a corrupt feed could ship NaN / non-finite weights. Clamp
  // non-finite to 0 so the tree still renders SOMETHING.
  const safeWeight = Number.isFinite(weight) ? weight : 0;
  const w = Math.max(0, Math.min(1, safeWeight));
  const angle = angleForIndex(index);
  // Branches fork at staggered heights along the trunk so the crown isn't
  // a single tuft on top.
  const ratio = forkHeightRatioForIndex(index);
  const forkY = trunkBaseY + (trunkTopY - trunkBaseY) * ratio;
  // Length scales with the *smaller* of the two canvas dimensions so the
  // tree fills its container whether the sidebar is open or not.
  const baseSpan = Math.min(height, width);
  const length = baseSpan * 0.16 + w * baseSpan * 0.30;
  const thickness = 3 + w * 11;
  const x1 = forkX + Math.sin(angle) * length;
  const y1 = forkY - Math.cos(angle) * length;

  const leafCount = Math.max(1, Math.round(w * maxLeaves));
  const leaves: LeafGeom[] = [];
  for (let k = 0; k < leafCount; k++) {
    // Cluster the crown around the branch tip with deterministic offsets so
    // the same branch always draws the same crown.
    const spread = thickness * 1.6 + 16;
    const ox = (hash01(index * 131 + k * 7 + 1) * 2 - 1) * spread;
    const oy = (hash01(index * 911 + k * 13 + 3) * 2 - 1) * spread;
    const size = 4 + Math.round(hash01(index * 17 + k) * 2);
    leaves.push({ x: x1 + ox, y: y1 + oy, size });
  }

  return { index, x0: forkX, y0: forkY, x1, y1, angle, length, thickness, leaves };
}

export function layoutTree(clusters: ClusterInput[], opts: LayoutOptions): TreeLayout {
  const { width, height } = opts;
  const maxLeaves = opts.maxLeavesPerBranch ?? DEFAULT_MAX_LEAVES;
  const minBranches = Math.max(0, opts.minBranches ?? 0);

  const cx = width / 2;
  // Trunk goes from the ground (5% from bottom) up to ~12% from the top so the
  // canopy has room above and a clean base below. The thickness is bumped to
  // ~32 so the trunk carries visual weight against a wide canopy.
  const baseY = height * 0.95;
  const trunkTopY = height * 0.12;
  const trunkThickness = Math.max(28, Math.min(width, height) * 0.05);
  const trunk = { x0: cx, y0: baseY, x1: cx, y1: trunkTopY, thickness: trunkThickness };

  const branches: BranchGeom[] = clusters.map((c, i) =>
    buildBranch(i, c.weight, cx, baseY, trunkTopY, height, width, maxLeaves),
  );

  // Pad up to the maturity floor with slim "earned" branches so the tree never
  // shows fewer branches than the maturity it has reached.
  for (let i = clusters.length; i < minBranches; i++) {
    branches.push(buildBranch(i, FLOOR_BRANCH_WEIGHT, cx, baseY, trunkTopY, height, width, maxLeaves));
  }

  return { trunk, branches };
}
