/**
 * Project L2-normalized RAPTOR cluster centroids (384-dim) down to 2D points
 * laid out across the Mandelbrot boundary band, for use as domain-warp seeds.
 *
 * Random projection (Johnson–Lindenstrauss): two fixed seeded Gaussian vectors
 * give a stable, O(n·dim) layout that keeps distinct topics at distinct, stable
 * positions. Not a metric embedding — a believable organic layout is the goal.
 */
import { mulberry32 } from "./prng.ts";

export interface Point2D { x: number; y: number }

/** Standard-normal sample via Box–Muller from a uniform PRNG. */
function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const X_LO = -2, X_HI = 0.6, Y_LO = -1.2, Y_HI = 1.2;

function rescale(vals: number[], lo: number, hi: number): number[] {
  let min = Infinity, max = -Infinity;
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min;
  if (!Number.isFinite(span) || span < 1e-9) {
    const mid = (lo + hi) / 2;
    return vals.map(() => mid);
  }
  return vals.map((v) => {
    const scaled = lo + ((v - min) / span) * (hi - lo);
    return Math.max(lo, Math.min(scaled, hi));
  });
}

export function projectCentroids(centroids: Float32Array[], seed = 1): Point2D[] {
  if (centroids.length === 0) return [];
  const dim = centroids[0]!.length;
  const rand = mulberry32(seed);
  const ax = Array.from({ length: dim }, () => gaussian(rand));
  const ay = Array.from({ length: dim }, () => gaussian(rand));
  const rawX: number[] = [];
  const rawY: number[] = [];
  for (const c of centroids) {
    if (c.length !== dim) {
      throw new Error(
        `projectCentroids: jagged input — expected all centroids of length ${dim}, got ${c.length}`,
      );
    }
    let x = 0, y = 0;
    for (let i = 0; i < dim; i++) { x += c[i]! * ax[i]!; y += c[i]! * ay[i]!; }
    rawX.push(x); rawY.push(y);
  }
  const sx = rescale(rawX, X_LO, X_HI);
  const sy = rescale(rawY, Y_LO, Y_HI);
  return sx.map((x, i) => ({ x, y: sy[i]! }));
}
