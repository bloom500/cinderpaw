import { describe, it, expect } from "bun:test";
import { projectCentroids } from "../src/memory/fractal/project-centroids.ts";

const vec = (xs: number[]) => Float32Array.from(xs);

describe("projectCentroids", () => {
  it("empty input → empty output", () => {
    expect(projectCentroids([])).toEqual([]);
  });

  it("is deterministic for a fixed seed", () => {
    const cs = [vec([1, 0, 0, 2]), vec([0, 1, 3, 0]), vec([2, 2, 1, 1])];
    expect(projectCentroids(cs, 7)).toEqual(projectCentroids(cs, 7));
  });

  it("keeps every point inside the Mandelbrot band", () => {
    const cs = Array.from({ length: 20 }, (_, i) =>
      vec([Math.sin(i), Math.cos(i), i % 3, (i * 7) % 5]));
    for (const p of projectCentroids(cs, 1)) {
      expect(p.x).toBeGreaterThanOrEqual(-2);
      expect(p.x).toBeLessThanOrEqual(0.6);
      expect(p.y).toBeGreaterThanOrEqual(-1.2);
      expect(p.y).toBeLessThanOrEqual(1.2);
    }
  });

  it("maps distinct centroids to distinct positions", () => {
    const cs = [vec([5, 0, 0, 0]), vec([0, 5, 0, 0]), vec([0, 0, 5, 0])];
    const ps = projectCentroids(cs, 1);
    expect(new Set(ps.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`)).size).toBe(3);
  });
});
