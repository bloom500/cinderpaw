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

/** Fork height ratio along the trunk. The trunk only goes up to ~62% of the
 *  canvas; branches fork in the upper half so the canopy reads as the upper
 *  third of the picture (reference 002 has crown occupying ~30% of the
 *  height starting at ~62% from the bottom, trunk 65-70%). */
function forkHeightRatioForIndex(index: number): number {
  // Stagger fork heights in the upper trunk band so the canopy opens from
  // multiple points, not one tuft.
  const ring = (index >> 1) % 4;
  return 0.32 + ring * 0.06;
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
  const safeWeight = Number.isFinite(weight) ? weight : 0;
  const w = Math.max(0, Math.min(1, safeWeight));
  const angle = angleForIndex(index);
  // Branches fork in the upper ~38% of the trunk so the canopy sits above
  // the trunk, not on top of a single fork point.
  const ratio = forkHeightRatioForIndex(index);
  const forkY = trunkBaseY + (trunkTopY - trunkBaseY) * ratio;
  // Length scales with the smaller canvas dimension; bumped harder so the
  // canopy can spread wider than the trunk (3-4×) like reference 002.
  const baseSpan = Math.min(height, width);
  const length = baseSpan * 0.22 + w * baseSpan * 0.42;
  // Thinner branches — the trunk is the visual anchor, branches are
  // connectors to the foliage bulbs.
  const thickness = 2 + w * 6;
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
  // Trunk: 95% (base) → 62% (top) — the top is INSIDE where the canopy
  // starts so no bare trunk pokes out above the foliage. Thickness scales
  // at ~2% of minSpan so it's clearly subordinate to the canopy.
  const baseY = height * 0.95;
  const trunkTopY = height * 0.62;
  const minSpan = Math.min(width, height);
  const trunkThickness = Math.max(14, minSpan * 0.022);
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
