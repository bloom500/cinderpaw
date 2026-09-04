/**
 * Deterministic PRNG + seeded sampling, shared across the fractal code.
 *
 * `mulberry32` was copy-pasted into five files (kmeans, project-centroids, and
 * the three bench modules) with two cosmetically different but bit-identical
 * bodies. This is the one copy; the variants were verified to emit the same
 * sequence for every seed before consolidating.
 */

/** Small, fast, deterministic 32-bit PRNG. Same `(seed)` → same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded partial Fisher–Yates: the first `count` of a shuffled copy of `items`.
 * Same seed → same selection. Used by the benchmark query sampler and the
 * synthetic-corpus generator.
 */
export function sample<T>(items: T[], count: number, seed: number): T[] {
  const rand = mulberry32(seed);
  const arr = [...items];
  const n = Math.min(count, arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
}
