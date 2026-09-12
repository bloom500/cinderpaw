/**
 * xMemory's partition objective, f(P) = Sparsity(P) + Sem(P).
 *
 * Which split of a level is the good one? Two questions, both answered from
 * vectors we already hold, no model:
 *
 *   Sparsity — are the clusters about the same size? N² / (K · Σ nₖ²) is 1
 *   when every cluster is equal and tends to 1/K as one cluster swallows the
 *   rest. A tree with one giant cluster is a list with extra steps.
 *
 *   Sem — do members sit close to their own centroid, and are the centroids
 *   neither copies of each other nor strangers? Cohesion is the mean cosine
 *   of every point to its centroid. Separation subtracts a Gaussian penalty
 *   on each centroid's nearest-neighbour similarity, centred on the median of
 *   those: two centroids that are nearly the same theme (far above the
 *   median) lose, and one that is far from everything (far below) loses too.
 *
 * The tree builder tries a few cluster counts and keeps the one this scores
 * highest. Pure arithmetic; the knobs are `SIGMA` and `REDUNDANT_ABOVE`.
 */

/** Width of the band around the median neighbour similarity that counts as
 *  "a normal neighbour". Cosines live in [-1, 1]; 0.1 is a tenth of the
 *  positive range. Named so the benchmark can be read against it. */
export const SIGMA = 0.1;

/**
 * Above this centroid-to-centroid cosine two clusters are one theme, whatever
 * the median says. The median term alone cannot see it at k = 2: both
 * neighbours ARE the median, so splitting one tight blob in half scored
 * higher than leaving it whole (cohesion rises a hair, nothing pushes back).
 * Absolute on purpose; 0.9 is well above where distinct topics sit for the
 * sentence embeddings we use (0.3 to 0.7 between unrelated centroids).
 */
export const REDUNDANT_ABOVE = 0.9;

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** L2-normalised mean of the given points. */
function centroidOf(points: Float32Array[], idx: number[]): Float32Array {
  const dim = points[0]?.length ?? 0;
  const out = new Float32Array(dim);
  for (const i of idx) {
    const p = points[i]!;
    for (let d = 0; d < dim; d++) out[d]! += p[d]!;
  }
  let sq = 0;
  for (let d = 0; d < dim; d++) sq += out[d]! * out[d]!;
  if (sq > 0) {
    const inv = 1 / Math.sqrt(sq);
    for (let d = 0; d < dim; d++) out[d]! *= inv;
  }
  return out;
}

export function sparsityScore(sizes: number[]): number {
  if (sizes.length === 0) return 0;
  let n = 0;
  let sq = 0;
  for (const s of sizes) {
    n += s;
    sq += s * s;
  }
  return sq === 0 ? 0 : (n * n) / (sizes.length * sq);
}

export function semScore(points: Float32Array[], assignments: number[], k: number): number {
  if (points.length === 0 || k <= 0) return 0;
  const members: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < assignments.length; i++) members[assignments[i]!]!.push(i);
  const centroids = members.map((m) => centroidOf(points, m));

  // Cohesion: how close each point is to its own theme.
  let coh = 0;
  for (let c = 0; c < k; c++) for (const i of members[c]!) coh += dot(points[i]!, centroids[c]!);
  coh /= points.length;
  if (k < 2) return coh;

  // Separation: each centroid's closest other centroid, and the median of that.
  const nn: number[] = [];
  for (let i = 0; i < k; i++) {
    let best = -1;
    for (let j = 0; j < k; j++) if (j !== i) best = Math.max(best, dot(centroids[i]!, centroids[j]!));
    nn.push(best);
  }
  const med = [...nn].sort((x, y) => x - y)[Math.floor(nn.length / 2)]!;
  let penalty = 0;
  for (const x of nn) {
    penalty += 1 - Math.exp(-((x - med) ** 2) / (2 * SIGMA * SIGMA));
    if (x > REDUNDANT_ABOVE) penalty += Math.min(1, (x - REDUNDANT_ABOVE) / (1 - REDUNDANT_ABOVE));
  }
  return coh - penalty / k;
}

export function partitionScore(points: Float32Array[], assignments: number[], k: number): number {
  const sizes = Array.from({ length: k }, () => 0);
  for (const c of assignments) sizes[c]!++;
  return sparsityScore(sizes) + semScore(points, assignments, k);
}
