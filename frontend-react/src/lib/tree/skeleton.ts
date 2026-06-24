import { mulberry32 } from './rng';
import type { TreeState } from './treeState';

export interface Segment {
  x0: number; y0: number; x1: number; y1: number;
  width0: number; width1: number; depth: number;
}
export interface Leaf { x: number; y: number; size: number; angle: number; clusterId: number }
export interface Skeleton { segments: Segment[]; leaves: Leaf[] }

const TRUNK_X = 0.5;     // anchored bottom-center
const TRUNK_Y = 0.02;    // small offset off the very bottom edge
// Silhouette fractal tuning: shorter per-level length keeps the silhouette
// inside the frame at depth=12; gentler width decay keeps sub-branches
// visible down to the tips instead of tapering to zero.
const LENGTH_DECAY = 0.62;
const WIDTH_DECAY = 0.72;
const SPREAD = 0.5;      // base half-angle (radians) between sibling branches

/** Deterministic per-branch jitter keyed on (seed, limbIndex, localPath) so a
 *  branch's angle depends only on its own path — increasing recursion depth
 *  never perturbs already-existing branches (append-only growth). */
function branchJitter(seed: number, limbIndex: number, localPath: number): number {
  const h = (seed ^ Math.imul(limbIndex + 1, 0x85ebca6b) ^ Math.imul(localPath, 0x9e3779b1)) >>> 0;
  const r = mulberry32(h);
  return (r() - 0.5) * 0.25;
}

export function generateSkeleton(state: TreeState, seed: number): Skeleton {
  const rng = mulberry32(seed);
  const segments: Segment[] = [];
  const terminals: { x: number; y: number; clusterId: number }[] = [];

  // 1. Trunk — a single depth-0 segment straight up.
  const trunkTopX = TRUNK_X;
  const trunkTopY = TRUNK_Y + state.trunkHeight;
  segments.push({
    x0: TRUNK_X, y0: TRUNK_Y, x1: trunkTopX, y1: trunkTopY,
    width0: state.trunkGirth, width1: state.trunkGirth * WIDTH_DECAY, depth: 0,
  });

  // 2. Primary limbs fan out from the trunk top, then recurse.
  const limbLen = state.trunkHeight * 0.55;
  for (let i = 0; i < state.primaryLimbs; i++) {
    // Symmetric fan centered on vertical (angle 0 = straight up), biased.
    const t = state.primaryLimbs === 1 ? 0 : (i / (state.primaryLimbs - 1)) * 2 - 1; // -1..1
    const baseAngle = t * SPREAD * 1.6 + (state.limbBias[i] ?? 0);
    grow(
      segments, terminals, seed, i, 1,
      trunkTopX, trunkTopY, baseAngle, limbLen,
      state.trunkGirth * WIDTH_DECAY, 1, state.depth, i,
    );
  }

  // 3. Leaves on terminals, round-robin until leafCount placed.
  // Silhouette fractal: leaves are tiny pinpricks of light, not ember-oak
  // foliage blobs. They suggest "alive" without competing with the silhouette.
  const leaves: Leaf[] = [];
  if (terminals.length > 0) {
    for (let n = 0; n < state.leafCount; n++) {
      const term = terminals[n % terminals.length];
      const jx = (rng() - 0.5) * 0.03;
      const jy = (rng() - 0.5) * 0.03;
      leaves.push({
        x: term.x + jx, y: term.y + jy,
        size: 0.0035 + rng() * 0.0025,
        angle: rng() * Math.PI * 2,
        clusterId: term.clusterId,
      });
    }
  }

  return { segments, leaves };
}

function grow(
  segments: Segment[], terminals: { x: number; y: number; clusterId: number }[],
  seed: number, limbIndex: number, localPath: number,
  x: number, y: number, angle: number, length: number, width: number,
  depth: number, maxDepth: number, clusterId: number,
): void {
  // angle: 0 = straight up; positive = lean right.
  const jitter = branchJitter(seed, limbIndex, localPath);
  const a = angle + jitter;
  const x1 = x + Math.sin(a) * length;
  const y1 = y + Math.cos(a) * length;
  const w1 = width * WIDTH_DECAY;
  segments.push({ x0: x, y0: y, x1, y1, width0: width, width1: w1, depth });

  if (depth >= maxDepth) {
    terminals.push({ x: x1, y: y1, clusterId });
    return;
  }
  // Two children, splayed.
  const childLen = length * LENGTH_DECAY;
  grow(segments, terminals, seed, limbIndex, localPath * 2, x1, y1, a - SPREAD, childLen, w1, depth + 1, maxDepth, clusterId);
  grow(segments, terminals, seed, limbIndex, localPath * 2 + 1, x1, y1, a + SPREAD, childLen, w1, depth + 1, maxDepth, clusterId);
}
