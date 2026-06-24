import type { Skeleton } from './skeleton';

export interface TreeBuffers {
  branchPositions: Float32Array;
  branchShade: Float32Array;
  leafInstances: Float32Array;
  branchVertexCount: number;
  leafInstanceCount: number;
}

const MAX_SHADE_DEPTH = 6;

/** Convert each tapered segment into a 2-triangle ribbon quad and each
 *  leaf into a [x,y,size,angle] instance. Pure — no GL context needed. */
export function skeletonToBuffers(skel: Skeleton): TreeBuffers {
  const nSeg = skel.segments.length;
  const positions = new Float32Array(nSeg * 6 * 2);
  const shade = new Float32Array(nSeg * 6);

  for (let i = 0; i < nSeg; i++) {
    const s = skel.segments[i];
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const len = Math.hypot(dx, dy) || 1e-6;
    // Perpendicular unit vector for ribbon width.
    const nx = -dy / len;
    const ny = dx / len;
    const w0 = s.width0, w1 = s.width1;

    // Four corners of the ribbon quad.
    const ax = s.x0 + nx * w0, ay = s.y0 + ny * w0; // base-left
    const bx = s.x0 - nx * w0, by = s.y0 - ny * w0; // base-right
    const cx = s.x1 + nx * w1, cy = s.y1 + ny * w1; // tip-left
    const ex = s.x1 - nx * w1, ey = s.y1 - ny * w1; // tip-right

    const o = i * 12;
    // Triangle 1: a, b, c ; Triangle 2: b, e, c
    positions.set([ax, ay, bx, by, cx, cy, bx, by, ex, ey, cx, cy], o);

    const sh = Math.min(s.depth / MAX_SHADE_DEPTH, 1);
    for (let v = 0; v < 6; v++) shade[i * 6 + v] = sh;
  }

  const nLeaf = skel.leaves.length;
  const leafInstances = new Float32Array(nLeaf * 4);
  for (let i = 0; i < nLeaf; i++) {
    const l = skel.leaves[i];
    leafInstances.set([l.x, l.y, l.size, l.angle], i * 4);
  }

  return {
    branchPositions: positions,
    branchShade: shade,
    leafInstances,
    branchVertexCount: nSeg * 6,
    leafInstanceCount: nLeaf,
  };
}
