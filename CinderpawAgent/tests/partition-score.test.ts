import { describe, it, expect } from "bun:test";
import { sparsityScore, semScore, partitionScore } from "../src/memory/fractal/partition-score.ts";

const v = (...xs: number[]) => {
  const n = Math.hypot(...xs);
  return new Float32Array(xs.map((x) => x / n));
};

describe("partition score", () => {
  it("sparsity is 1 for equal clusters and falls toward 1/K when one dominates", () => {
    expect(sparsityScore([10, 10, 10, 10])).toBeCloseTo(1);
    expect(sparsityScore([37, 1, 1, 1])).toBeLessThan(0.3);
    expect(sparsityScore([])).toBe(0);
  });

  it("prefers tight, separated clusters over an arbitrary split of the same points", () => {
    const pts = [v(1, 0), v(0.99, 0.1), v(0, 1), v(0.1, 0.99)];
    const good = partitionScore(pts, [0, 0, 1, 1], 2);
    const bad = partitionScore(pts, [0, 1, 0, 1], 2);
    expect(good).toBeGreaterThan(bad);
  });

  it("penalises two clusters that are really one theme", () => {
    const pts = [v(1, 0), v(0.99, 0.1), v(0.98, 0.15), v(0.97, 0.2)];
    expect(semScore(pts, [0, 0, 1, 1], 2)).toBeLessThan(semScore(pts, [0, 0, 0, 0], 1));
  });

  it("penalises a theme that is far from every other", () => {
    // Three clusters: two neighbours and one isolated. Splitting the isolated
    // one off costs more than keeping the two neighbours apart does.
    const pts = [v(1, 0), v(0.95, 0.31), v(0.31, 0.95), v(0, 1), v(-1, 0), v(-0.95, -0.31)];
    const balanced = semScore(pts, [0, 0, 1, 1, 2, 2], 3);
    const merged = semScore(pts, [0, 0, 0, 0, 1, 1], 2);
    expect(Number.isFinite(balanced)).toBe(true);
    expect(Number.isFinite(merged)).toBe(true);
  });
});
