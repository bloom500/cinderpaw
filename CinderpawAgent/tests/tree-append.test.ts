/**
 * Incremental append: a new memory has to be routable now, without paying for
 * a re-cluster and a round of summaries.
 *
 * The load-bearing claim is that skipping the summaries is free for
 * RETRIEVAL, because `tree-query.ts` routes on centroids alone. These tests
 * check the append against the real `queryTree`, not against the tree's shape:
 * asserting "the node landed under cluster B" would pass while the leaf stayed
 * unreachable.
 */

import { describe, expect, test } from "bun:test";
import { appendLeaf } from "../src/memory/fractal/tree-append.ts";
import { queryTree } from "../src/memory/fractal/tree-query.ts";
import type { TreeNode } from "../src/memory/fractal/types.ts";

/** Unit vector in `dim` dimensions pointing along one axis. */
function axis(i: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  v[i] = 1;
  return v;
}

function rawLeaf(id: number, vec: Float32Array): TreeNode {
  return { id: `L0-${id}`, level: 0, centroid: vec, summary: "", children: [], leafIds: [id] };
}

/**
 * Two clusters pointing at right angles, so "which branch" has an obviously
 * correct answer and a wrong descent cannot pass by luck.
 */
function twoClusterTree(): TreeNode {
  const east = rawLeaf(1, axis(0));
  const north = rawLeaf(2, axis(1));
  const clusterEast: TreeNode = {
    id: "C-east", level: 1, centroid: axis(0), summary: "eastern things",
    children: [east], leafIds: [1],
  };
  const clusterNorth: TreeNode = {
    id: "C-north", level: 1, centroid: axis(1), summary: "northern things",
    children: [north], leafIds: [2],
  };
  return {
    id: "ROOT", level: 2, centroid: normalized([1, 1, 0, 0]), summary: "everything",
    children: [clusterEast, clusterNorth], leafIds: [1, 2],
  };
}

function normalized(xs: number[]): Float32Array {
  const v = new Float32Array(xs);
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

describe("appendLeaf makes a new memory findable immediately", () => {
  test("the appended leaf is returned by a query aimed at it", () => {
    const tree = twoClusterTree();
    // Before: the tree has never heard of leaf 3.
    expect(queryTree(axis(1), tree, { topK: 5, beam: 5 }).map((h) => h.leafId)).not.toContain(3);

    const result = appendLeaf(tree, 3, axis(1));
    expect(result.ok).toBe(true);

    const hits = queryTree(axis(1), tree, { topK: 5, beam: 5 }).map((h) => h.leafId);
    expect(hits).toContain(3);
  });

  test("it descends to the nearer cluster, not merely to the first one", () => {
    const tree = twoClusterTree();
    appendLeaf(tree, 3, axis(1));
    const north = tree.children.find((c) => c.id === "C-north")!;
    const east = tree.children.find((c) => c.id === "C-east")!;
    expect(north.leafIds).toContain(3);
    expect(east.leafIds).not.toContain(3);
  });

  test("every ancestor learns the leaf, root included", () => {
    const tree = twoClusterTree();
    const result = appendLeaf(tree, 3, axis(1));
    expect(result.touched).toEqual(["ROOT", "C-north"]);
    expect(tree.leafIds).toContain(3);
  });

  test("the summary is left stale on purpose and routing does not care", () => {
    const tree = twoClusterTree();
    appendLeaf(tree, 3, axis(1));
    const north = tree.children.find((c) => c.id === "C-north")!;
    // Untouched — re-summarising is the expensive half of a rebuild, and
    // `queryTree` scores centroids, never summaries.
    expect(north.summary).toBe("northern things");
    expect(queryTree(axis(1), tree, { topK: 5, beam: 5 }).map((h) => h.leafId)).toContain(3);
  });

  test("the centroid moves toward the new leaf and stays unit length", () => {
    const tree = twoClusterTree();
    appendLeaf(tree, 3, normalized([0, 1, 1, 0]));
    const north = tree.children.find((c) => c.id === "C-north")!;
    let sum = 0;
    for (const x of north.centroid) sum += x * x;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 5);
    // It picked up the new third dimension it had none of before.
    expect(north.centroid[2]!).toBeGreaterThan(0);
  });

  test("many appends in a row all stay findable", () => {
    const tree = twoClusterTree();
    for (let id = 10; id < 30; id++) {
      expect(appendLeaf(tree, id, axis(1)).ok).toBe(true);
    }
    const hits = queryTree(axis(1), tree, { topK: 30, beam: 30 }).map((h) => h.leafId);
    for (let id = 10; id < 30; id++) expect(hits).toContain(id);
  });
});

describe("appendLeaf refuses instead of corrupting the index", () => {
  test("a tree with no clusters is refused, not guessed at", () => {
    const bare: TreeNode = {
      id: "ROOT", level: 0, centroid: axis(0), summary: "", children: [], leafIds: [],
    };
    const result = appendLeaf(bare, 1, axis(0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no clusters");
  });

  test("a vector from a different embedding model is refused", () => {
    // Routing across two models is meaningless; a rebuild is the right answer.
    const result = appendLeaf(twoClusterTree(), 3, new Float32Array(8));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("embedding model changed");
  });

  test("appending the same leaf twice is refused, so counts stay honest", () => {
    const tree = twoClusterTree();
    expect(appendLeaf(tree, 3, axis(1)).ok).toBe(true);
    const again = appendLeaf(tree, 3, axis(1));
    expect(again.ok).toBe(false);
    expect(tree.leafIds.filter((id) => id === 3)).toHaveLength(1);
  });

  test("a refusal changes nothing at all", () => {
    const tree = twoClusterTree();
    const before = JSON.stringify(tree.leafIds);
    appendLeaf(tree, 3, new Float32Array(8));
    expect(JSON.stringify(tree.leafIds)).toBe(before);
  });
});
