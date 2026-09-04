/**
 * Module F — tree-query.ts (TDD).
 *
 * Verifies the collapsed-tree / beam traversal contract:
 *   - query near one group → only that group's leaves in the hits
 *   - hits sorted by cosine score (descending)
 *   - topK limit honored
 *   - viaSummaryPath is non-empty (every hit records its ancestor summaries)
 *
 * Uses a real `buildTree(...)` fixture so the tree shape matches the
 * production builder (not a hand-rolled mock tree).
 */
import { describe, it, expect } from "bun:test";
import { queryTree } from "../src/memory/fractal/tree-query.ts";
import { buildTree } from "../src/memory/fractal/tree-builder.ts";
import type { Leaf, TreeNode } from "../src/memory/fractal/types.ts";

/** Twelve leaves in two well-separated groups of 6 (same fixture style
 *  as the tree-builder test so we exercise a real `buildTree` output). */
const TWO_GROUPS_OF_SIX: Leaf[] = (() => {
  const groups: Array<Array<[number, number]>> = [
    [[1.0, 0.0], [0.99, 0.14], [0.95, 0.31], [0.9, 0.43], [0.81, 0.59], [0.7, 0.71]],
    [[-1.0, 0.0], [-0.99, 0.14], [-0.95, 0.31], [-0.9, 0.43], [-0.81, 0.59], [-0.7, 0.71]],
  ];
  const leaves: Leaf[] = [];
  let id = 0;
  for (const group of groups) {
    for (const [x, y] of group) {
      const mag = Math.hypot(x, y) || 1;
      leaves.push({
        id: id++,
        text: `leaf-${id}`,
        vec: new Float32Array([x / mag, y / mag]),
        ts: 1000 + id,
        sessionId: "s1",
      });
    }
  }
  return leaves;
})();

function trivialDeps() {
  return {
    kmeans: (points: Float32Array[], k: number) => {
      const n = points.length;
      if (k >= n) return Array.from({ length: n }, (_, i) => i);
      const perCluster = Math.ceil(n / k);
      return Array.from({ length: n }, (_, i) => Math.floor(i / perCluster));
    },
    summarize: async (items: string[]) =>
      `summary of [${items.map((t) => t.split(" ").slice(0, 2).join(" ")).join(", ")}]`,
  };
}

async function buildFixture(): Promise<TreeNode> {
  return buildTree(TWO_GROUPS_OF_SIX, trivialDeps());
}

/** A unit vector pointing into group A (positive-x half). */
const QUERY_NEAR_A = new Float32Array([0.95, 0.31]);

/** A unit vector pointing into group B (negative-x half). */
const QUERY_NEAR_B = new Float32Array([-0.95, -0.31]);

/** A unit vector orthogonal to both groups — should return low scores. */
const QUERY_NEUTRAL = new Float32Array([0, 1]);

describe("queryTree — group targeting", () => {
  it("query near group A returns only group A leaves", async () => {
    const tree = await buildFixture();
    const hits = queryTree(QUERY_NEAR_A, tree, { topK: 10, beam: 4 });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      // Group A leaves are ids 0..5; group B are 6..11.
      expect(hit.leafId).toBeLessThan(6);
    }
  });

  it("query near group B returns only group B leaves", async () => {
    const tree = await buildFixture();
    const hits = queryTree(QUERY_NEAR_B, tree, { topK: 10, beam: 4 });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.leafId).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("queryTree — sort + limit", () => {
  it("hits are sorted by score descending", async () => {
    const tree = await buildFixture();
    const hits = queryTree(QUERY_NEAR_A, tree, { topK: 10, beam: 4 });
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    }
  });

  it("respects topK (never returns more than topK hits)", async () => {
    const tree = await buildFixture();
    const hits = queryTree(QUERY_NEAR_A, tree, { topK: 3, beam: 4 });
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it("returns all leaves when beam allows the whole frontier", async () => {
    const tree = await buildFixture();
    // With beam=100 the descent never prunes — all 12 leaves survive to
    // the leaf-level scoring, and topK=100 returns them all.
    const hits = queryTree(QUERY_NEAR_A, tree, { topK: 100, beam: 100 });
    expect(hits).toHaveLength(12);
  });

  it("respects beam at the leaf level: cannot return more than beam leaves", async () => {
    const tree = await buildFixture();
    const hits = queryTree(QUERY_NEAR_A, tree, { topK: 100, beam: 3 });
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});

describe("queryTree — viaSummaryPath", () => {
  it("every hit has a non-empty viaSummaryPath", async () => {
    const tree = await buildFixture();
    const hits = queryTree(QUERY_NEAR_A, tree, { topK: 5, beam: 4 });
    for (const hit of hits) {
      expect(hit.viaSummaryPath.length).toBeGreaterThan(0);
      for (const s of hit.viaSummaryPath) {
        expect(s.length).toBeGreaterThan(0);
      }
    }
  });

  it("multi-level tree records at least 2 summaries in the path", async () => {
    // The 12-leaf fixture produces: 0 (leaves) → 1 (clusters) → 2 (root).
    // A hit descends through root + level-1 cluster → path length ≥ 2.
    const tree = await buildFixture();
    const hits = queryTree(QUERY_NEAR_A, tree, { topK: 1, beam: 4 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.viaSummaryPath.length).toBeGreaterThanOrEqual(2);
  });
});

describe("queryTree — score semantics", () => {
  it("neutral query still returns hits but with lower scores than a targeted query", async () => {
    const tree = await buildFixture();
    const targeted = queryTree(QUERY_NEAR_A, tree, { topK: 1, beam: 4 });
    const neutral = queryTree(QUERY_NEUTRAL, tree, { topK: 1, beam: 4 });
    expect(targeted[0]!.score).toBeGreaterThan(neutral[0]!.score);
  });

  it("hit scores are in [-1, 1] (cosine range on unit vectors)", async () => {
    const tree = await buildFixture();
    const hits = queryTree(QUERY_NEAR_A, tree, { topK: 12, beam: 4 });
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThanOrEqual(-1);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("queryTree — edge cases", () => {
  it("empty tree (root with no children) returns no hits", () => {
    const emptyRoot: TreeNode = {
      id: "root",
      level: 1,
      centroid: new Float32Array([1, 0]),
      summary: "empty",
      children: [],
      leafIds: [],
    };
    expect(queryTree(QUERY_NEAR_A, emptyRoot, { topK: 5, beam: 4 })).toEqual([]);
  });
});
