/**
 * Module B — cosine similarity for L2-normalized vectors.
 *
 * Since every embedding produced by Module A (Phase-0 Rust bridge) and every
 * centroid in the tree is L2-normalized, cosine similarity collapses to a
 * plain dot product. We still call it `cosine` to keep the call sites
 * readable and to leave room for non-normalized inputs later without
 * changing the function name.
 *
 * Inputs must be the same length and non-empty. We throw on mismatch instead
 * of returning a sentinel because every mismatch is a programmer error
 * (vectors that flow through the tree share their dimensionality by
 * construction — embedding dim is fixed at model load) and silent zero would
 * hide bugs in the clustering loop.
 */

/**
 * Cosine similarity between two equal-length, non-empty `Float32Array`s.
 * Assumes both inputs are L2-normalized so the answer is a plain dot product.
 * Throws on length mismatch or empty input.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosine: length mismatch (${a.length} vs ${b.length}); vectors must share dimensionality`,
    );
  }
  if (a.length === 0) {
    throw new Error("cosine: empty vector");
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}
