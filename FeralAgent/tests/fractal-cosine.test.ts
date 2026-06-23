/**
 * Module B — cosine similarity for L2-normalized vectors.
 *
 * Since every embedding produced by Module A (Phase-0 Rust bridge) and every
 * centroid in the tree is L2-normalized, cosine similarity collapses to a
 * plain dot product. We still call it `cosine` to keep the call sites
 * readable and to leave room for non-normalized inputs later without
 * changing the function name.
 */
import { describe, it, expect } from "bun:test";
import { cosine } from "../src/memory/fractal/cosine.ts";

describe("cosine", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBe(1);
  });

  it("returns 0 for orthogonal unit vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });

  it("returns ~1 for identical non-unit vectors (L2-normalized input)", () => {
    // 0.6² + 0.8² = 1.0 — already on the unit circle.
    expect(
      cosine(new Float32Array([0.6, 0.8]), new Float32Array([0.6, 0.8])),
    ).toBeCloseTo(1, 6);
  });

  it("returns ~-1 for opposite unit vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(
      -1,
      6,
    );
  });

  it("works on higher-dimensional L2-normalized vectors", () => {
    // 4D unit vector at index 2.
    const a = new Float32Array([0, 0, 1, 0]);
    const b = new Float32Array([0, 0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(1, 6);
  });

  it("throws when lengths differ", () => {
    expect(() =>
      cosine(new Float32Array([1, 0]), new Float32Array([1, 0, 0])),
    ).toThrow();
  });

  it("throws on empty vectors (degenerate — caller should never ask)", () => {
    expect(() => cosine(new Float32Array(0), new Float32Array(0))).toThrow();
  });
});
