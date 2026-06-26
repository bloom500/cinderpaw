/**
 * Module C — k-means clustering for L2-normalized vectors.
 *
 * Deterministic: a `seed`-keyed mulberry32 PRNG drives k-means++ initialization
 * and tie-breaks, so the same `(points, k, seed)` triple always yields the same
 * `assignments`. This is what lets PBT replay a lineage exactly and what lets
 * tests assert on concrete cluster ids.
 *
 * Distance is `1 - cosine(...)` from Module B (cosine distance on the unit
 * sphere). Centroids are L2-normalized after each update so they stay on the
 * sphere with the input vectors.
 *
 * Cap at 50 Lloyd iterations; on well-separated input the loop exits in 2–5
 * iterations when no assignment changes. The cap is a safety net, not the
 * expected exit path.
 */
import { cosine } from "./cosine.ts";
import { mulberry32 } from "./prng.ts";

/** Hard cap on Lloyd iterations. The spec calls for 50; do not raise silently. */
const MAX_ITERATIONS = 50;

/** L2-normalize a Float32Array in place. Returns the same array. */
function normalize(v: Float32Array): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += v[i]! * v[i]!;
  if (sq <= 0) return v; // degenerate — keep zeros, downstream cosine will throw
  const inv = 1 / Math.sqrt(sq);
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return v;
}

/** Deep-clone a Float32Array. */
function clone(v: Float32Array): Float32Array {
  return new Float32Array(v);
}

/** Squared cosine distance between two unit-length vectors. */
function sqCosineDist(a: Float32Array, b: Float32Array): number {
  const c = cosine(a, b);
  const d = 1 - c;
  return d * d;
}

/**
 * Cluster `points` into `k` clusters by k-means++ (Lloyd's algorithm) on
 * cosine distance. Returns `assignments[i]` = cluster id of `points[i]`.
 *
 * - `seed` (default 1) makes the result reproducible.
 * - When `points` is empty, returns `[]`.
 * - When `k >= points.length`, every point is its own cluster (id = index).
 * - Iterations are capped at 50; the loop exits early when no point changes
 *   cluster.
 */
export function kmeans(
  points: Float32Array[],
  k: number,
  seed: number = 1,
): number[] {
  const n = points.length;
  if (n === 0) return [];
  const effectiveK = Math.min(k, n);

  // Trivial case: k >= n → each point gets its own id (matches spec).
  if (effectiveK >= n) {
    return Array.from({ length: n }, (_, i) => i);
  }

  const rng = mulberry32(seed);
  const dim = points[0]!.length;
  if (dim === 0) {
    throw new Error("kmeans: cannot cluster zero-dimensional vectors");
  }

  // ── k-means++ initialization ────────────────────────────────────────────
  const centroids: Float32Array[] = [];
  // First centroid: uniform random pick over points.
  centroids.push(clone(points[Math.floor(rng() * n)]!));

  // Distance from each point to its nearest chosen centroid.
  const distSq = new Float64Array(n);
  for (let i = 0; i < n; i++) distSq[i] = sqCosineDist(points[i]!, centroids[0]!);

  while (centroids.length < effectiveK) {
    // Weighted reservoir pick: probability ∝ distSq[i].
    let total = 0;
    for (let i = 0; i < n; i++) total += distSq[i]!;
    if (total <= 0) {
      // All points coincide with an existing centroid — duplicate the last one.
      // Lloyd's loop will spread them out via assignment updates; if not, the
      // remaining slots get the same centroid and the cap on `effectiveK`
      // prevents degenerate empty clusters.
      centroids.push(clone(centroids[centroids.length - 1]!));
      continue;
    }
    let target = rng() * total;
    let picked = 0;
    for (let i = 0; i < n; i++) {
      target -= distSq[i]!;
      if (target <= 0) {
        picked = i;
        break;
      }
    }
    centroids.push(clone(points[picked]!));
    // Update nearest-centroid distances with the new centroid.
    for (let i = 0; i < n; i++) {
      const d = sqCosineDist(points[i]!, centroids[centroids.length - 1]!);
      if (d < distSq[i]!) distSq[i] = d;
    }
  }

  // ── Lloyd's loop ────────────────────────────────────────────────────────
  const assignments = new Array<number>(n).fill(0);
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;

    // Assign each point to its nearest centroid.
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = sqCosineDist(points[i]!, centroids[0]!);
      for (let c = 1; c < effectiveK; c++) {
        const d = sqCosineDist(points[i]!, centroids[c]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }

    // Update centroids: mean of assigned points, then L2-normalize.
    const sums = Array.from({ length: effectiveK }, () => new Float64Array(dim));
    const counts = new Int32Array(effectiveK);
    for (let i = 0; i < n; i++) {
      const c = assignments[i]!;
      counts[c]!++;
      const p = points[i]!;
      const sum = sums[c]!;
      for (let d = 0; d < dim; d++) sum[d]! += p[d]!;
    }
    for (let c = 0; c < effectiveK; c++) {
      const count = counts[c]!;
      const sum = sums[c]!;
      const next = new Float32Array(dim);
      if (count > 0) {
        for (let d = 0; d < dim; d++) next[d] = sum[d]! / count;
      } else {
        // Empty cluster: keep the old centroid (we don't re-seed mid-loop to
        // keep determinism tight — a divergent split would change cluster ids
        // across reruns).
        next.set(centroids[c]!);
      }
      normalize(next);
      centroids[c] = next;
    }

    if (!changed) break;
  }

  return assignments;
}
