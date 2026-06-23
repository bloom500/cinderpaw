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
 */
import { describe, it, expect } from "bun:test";
import { kmeans } from "../src/memory/fractal/kmeans.ts";

/**
 * Six 2D unit vectors clearly separable into two groups along (1,0) and (0,1).
 * Group A: 3 points near (1,0). Group B: 3 points near (0,1).
 */
const TWO_GROUPS: Float32Array[] = [
  new Float32Array([1.0, 0.0]),
  new Float32Array([0.99, 0.14]),
  new Float32Array([0.95, 0.31]),
  new Float32Array([0.0, 1.0]),
  new Float32Array([0.14, 0.99]),
  new Float32Array([0.31, 0.95]),
];

/** Map every point to its cluster id; returns Map<pointIndex, clusterId>. */
function clusters(assignments: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < assignments.length; i++) m.set(i, assignments[i]!);
  return m;
}

describe("kmeans", () => {
  it("splits six 2D unit vectors into two distinct groups (k=2)", () => {
    const a = kmeans(TWO_GROUPS, 2, 1);
    expect(a).toHaveLength(6);
    expect(new Set(a).size).toBe(2);

    // Members of group A {0,1,2} share one cluster id; group B {3,4,5} share the other.
    const m = clusters(a);
    expect(m.get(0)).toBe(m.get(1));
    expect(m.get(1)).toBe(m.get(2));
    expect(m.get(3)).toBe(m.get(4));
    expect(m.get(4)).toBe(m.get(5));
    // And the two groups must NOT share an id.
    expect(m.get(0)).not.toBe(m.get(3));
  });

  it("is deterministic: same seed → identical assignments", () => {
    const a = kmeans(TWO_GROUPS, 2, 42);
    const b = kmeans(TWO_GROUPS, 2, 42);
    expect(a).toEqual(b);
  });

  it("reproducibility holds across many seeds (sanity sweep)", () => {
    for (const seed of [1, 7, 123, 9_999]) {
      const a = kmeans(TWO_GROUPS, 2, seed);
      const b = kmeans(TWO_GROUPS, 2, seed);
      expect(a).toEqual(b);
    }
  });

  it("k=1 puts every point in cluster 0", () => {
    const a = kmeans(TWO_GROUPS, 1, 1);
    expect(a.every((c) => c === 0)).toBe(true);
  });

  it("k >= points.length makes every point its own cluster", () => {
    const pts = TWO_GROUPS.slice(0, 3);
    const a = kmeans(pts, 10, 1);
    expect(new Set(a).size).toBe(3);
    // The k cap is honored — no cluster id >= points.length is emitted.
    expect(Math.max(...a)).toBeLessThan(pts.length);
  });

  it("empty input yields an empty assignment array", () => {
    expect(kmeans([], 3, 1)).toEqual([]);
  });

  it("single point with k>1 lands in cluster 0 (trivially one cluster)", () => {
    const a = kmeans([new Float32Array([1, 0])], 4, 1);
    expect(a).toEqual([0]);
  });

  it("converges quickly on well-separated input (no 50-iter blow-up)", () => {
    // Sanity: the spec caps iterations at 50; the function must return long
    // before then on clearly separable data. We don't time it — we just check
    // it returns a sensible split, which it cannot do if it never converges.
    const a = kmeans(TWO_GROUPS, 2, 1);
    const m = clusters(a);
    const groupA = [m.get(0)!, m.get(1)!, m.get(2)!];
    const groupB = [m.get(3)!, m.get(4)!, m.get(5)!];
    expect(groupA[0]).toBe(groupA[1]);
    expect(groupA[1]).toBe(groupA[2]);
    expect(groupB[0]).toBe(groupB[1]);
    expect(groupB[1]).toBe(groupB[2]);
  });
});
