/**
 * Module E — tree-builder.ts (TDD).
 *
 * Builds a RAPTOR-like hierarchical index bottom-up:
 *   - leaves wrap raw episodic events (level 0)
 *   - each round clusters the current level's centroids with kmeans
 *   - each cluster becomes a parent node (centroid = normalized mean,
 *     summary from `summarize`, leafIds = union of children)
 *   - the loop exits when the current level fits in BRANCH (8); that
 *     level's nodes become the root's direct children.
 *
 * Tests inject `{embed, kmeans, summarize}` as `Deps` so we never hit
 * Rust or the router here.
 */
import { describe, it, expect } from "bun:test";
import { buildTree } from "../src/memory/fractal/tree-builder.ts";
import type { Leaf, TreeNode } from "../src/memory/fractal/types.ts";

/**
 * Twelve 2D unit-vector leaves split into two well-separated groups of 6.
 * With BRANCH=8 and 12 leaves, the builder's kmeans step runs at
 * k = ceil(12/8) = 2 — exactly two clusters at level 1, one root above.
 */
const TWO_GROUPS_OF_SIX: Leaf[] = (() => {
  const groups: Array<Array<[number, number]>> = [
    // Group A near (1,0): six points fanning into the right half-plane.
    [[1.0, 0.0], [0.99, 0.14], [0.95, 0.31], [0.9, 0.43], [0.81, 0.59], [0.7, 0.71]],
    // Group B near (-1,0): mirror into the left half-plane.
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

/** Three groups of 4 — exercises a smaller BRANCH (k=3 at level 0). */
const THREE_GROUPS_OF_FOUR: Leaf[] = (() => {
  const groups: Array<Array<[number, number]>> = [
    [[1.0, 0.0], [0.99, 0.14], [0.95, 0.31], [0.9, 0.43]],
    [[0.0, 1.0], [0.14, 0.99], [0.31, 0.95], [0.43, 0.9]],
    [[-1.0, 0.0], [-0.99, 0.14], [-0.95, 0.31], [-0.9, 0.43]],
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

/** Deterministic deps: kmeans clusters by spatial block so the test
 *  doesn't depend on Module C's tie-breaking behaviour. */
function trivialDeps(): {
  embed: (texts: string[]) => Promise<Float32Array[]>;
  kmeans: (points: Float32Array[], k: number, seed?: number) => number[];
  summarize: (items: string[]) => Promise<string>;
} {
  return {
    embed: async (texts) => texts.map(() => new Float32Array([1, 0])),
    kmeans: (points, k) => {
      // Stable spatial split: points[i] → cluster id = floor(i / perCluster).
      const n = points.length;
      if (k >= n) return Array.from({ length: n }, (_, i) => i);
      const perCluster = Math.ceil(n / k);
      return Array.from({ length: n }, (_, i) => Math.floor(i / perCluster));
    },
    summarize: async (items) =>
      `summary of [${items.map((t) => t.split(" ").slice(0, 2).join(" ")).join(", ")}]`,
  };
}

/** Walk the tree and collect every node in BFS order. */
function flatten(root: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  const queue: TreeNode[] = [root];
  while (queue.length > 0) {
    const n = queue.shift()!;
    out.push(n);
    for (const c of n.children) queue.push(c);
  }
  return out;
}

/** Distinct levels present in the tree, sorted ascending. */
function levels(root: TreeNode): number[] {
  return [...new Set(flatten(root).map((n) => n.level))].sort((a, b) => a - b);
}

/** Distinct leaf ids that appear anywhere in the tree. */
function allLeafIds(root: TreeNode): number[] {
  return [...new Set(flatten(root).flatMap((n) => n.leafIds))].sort(
    (a, b) => a - b,
  );
}

describe("buildTree — single root", () => {
  it("produces a single root node", () => {
    return buildTree(TWO_GROUPS_OF_SIX, trivialDeps()).then((root) => {
      expect(root.level).toBeGreaterThan(0);
      expect(root.children.length).toBeGreaterThan(0);
    });
  });
});

describe("buildTree — leaf coverage", () => {
  it("root.leafIds covers every input leaf id exactly once", () => {
    return buildTree(TWO_GROUPS_OF_SIX, trivialDeps()).then((root) => {
      expect(root.leafIds).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });
  });

  it("the set of leaf ids across the whole tree equals the input ids", () => {
    return buildTree(TWO_GROUPS_OF_SIX, trivialDeps()).then((root) => {
      expect(allLeafIds(root)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });
  });
});

describe("buildTree — multi-level", () => {
  it("levels increase strictly from 0 (leaves) toward the root", () => {
    return buildTree(TWO_GROUPS_OF_SIX, trivialDeps()).then((root) => {
      const lv = levels(root);
      expect(lv[0]).toBe(0);
      for (let i = 1; i < lv.length; i++) {
        expect(lv[i]!).toBeGreaterThan(lv[i - 1]!);
      }
      // 12 leaves → at least 2 levels (0 + root).
      expect(lv.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("buildTree — cluster separation", () => {
  it("two well-separated groups end up under different intermediate parents", () => {
    return buildTree(TWO_GROUPS_OF_SIX, trivialDeps()).then((root) => {
      // k = ceil(12/8) = 2 → 2 level-1 children.
      expect(root.children).toHaveLength(2);
      for (const child of root.children) {
        // Each child owns exactly half the leaves (6 each, with the
        // trivial spatial kmeans).
        expect(child.leafIds).toHaveLength(6);
      }
      // And the two children's leaf-id sets are disjoint.
      const allIds = root.children.flatMap((c) => c.leafIds);
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  });

  it("three groups with a smaller BRANCH collapse to three intermediate parents", () => {
    // With THREE_GROUPS_OF_FOUR and branch=4, k = ceil(12/4) = 3.
    const deps = { ...trivialDeps(), branch: 4 };
    return buildTree(THREE_GROUPS_OF_FOUR, deps).then((root) => {
      expect(root.children).toHaveLength(3);
      for (const child of root.children) {
        expect(child.leafIds).toHaveLength(4);
      }
    });
  });
});

describe("buildTree — summary propagation", () => {
  it("every non-leaf node has a non-empty summary; raw leaves have summary = ''", () => {
    return buildTree(TWO_GROUPS_OF_SIX, trivialDeps()).then((root) => {
      for (const node of flatten(root)) {
        if (node.children.length > 0) {
          expect(node.summary.length).toBeGreaterThan(0);
        } else {
          expect(node.summary).toBe("");
        }
      }
    });
  });

  it("summarize receives the raw leaf texts for the first level-up", () => {
    const calls: string[][] = [];
    const deps = {
      ...trivialDeps(),
      summarize: async (items: string[]) => {
        calls.push([...items]);
        return `(${items.length})`;
      },
    };
    return buildTree(TWO_GROUPS_OF_SIX, deps).then(() => {
      // 2 level-1 summarize calls + 1 root summarize call = 3 total.
      expect(calls.length).toBe(3);
      // First two calls correspond to the two clusters at level 1 —
      // each receives the 6 raw leaf texts from its cluster.
      const first = calls[0]!;
      const second = calls[1]!;
      expect(first.length).toBe(6);
      expect(second.length).toBe(6);
      for (const text of [...first, ...second]) {
        expect(text.startsWith("leaf-")).toBe(true);
      }
    });
  });
});

describe("buildTree — small input", () => {
  it("a single leaf produces a root with that leaf as its only child", () => {
    const one: Leaf[] = [
      { id: 42, text: "lonely", vec: new Float32Array([1, 0]), ts: 1, sessionId: "s" },
    ];
    return buildTree(one, trivialDeps()).then((root) => {
      expect(root.children).toHaveLength(1);
      expect(root.leafIds).toEqual([42]);
      expect(root.children[0]!.leafIds).toEqual([42]);
    });
  });

  it("fewer than BRANCH leaves collapse directly under the root (no intermediates)", () => {
    const few: Leaf[] = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      text: `f${i}`,
      vec: new Float32Array([1, 0]),
      ts: i,
      sessionId: "s",
    }));
    return buildTree(few, trivialDeps()).then((root) => {
      expect(root.children).toHaveLength(5);
      // Two levels only: 0 (raw leaves) and 1 (root).
      expect(levels(root)).toEqual([0, 1]);
    });
  });
});

describe("buildTree — centroid normalization", () => {
  it("every parent centroid is a unit vector (L2 length = 1)", () => {
    return buildTree(TWO_GROUPS_OF_SIX, trivialDeps()).then((root) => {
      for (const node of flatten(root)) {
        const c = node.centroid;
        let mag = 0;
        for (let i = 0; i < c.length; i++) mag += c[i]! * c[i]!;
        expect(Math.sqrt(mag)).toBeCloseTo(1, 5);
      }
    });
  });
});

describe("buildTree — batched embedding", () => {
  it("embeds missing-vector leaves in batches, not one call per leaf", () => {
    const leaves: Leaf[] = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      text: `leaf-${i}`,
      vec: new Float32Array(0), // force the embed path
      ts: 1000 + i,
      sessionId: "s1",
    }));
    let calls = 0;
    let totalTexts = 0;
    const deps = {
      ...trivialDeps(),
      embed: async (texts: string[]) => {
        calls++;
        totalTexts += texts.length;
        return texts.map(() => new Float32Array([1, 0]));
      },
    };
    return buildTree(leaves, deps).then((root) => {
      expect(totalTexts).toBe(20); // every leaf still embedded
      expect(calls).toBeLessThanOrEqual(2); // batched — NOT 20 serial calls
      expect(root.leafIds.length).toBe(20); // all leaves present in the tree
    });
  });
});

describe("buildTree — error handling", () => {
  it("throws on empty input (caller error)", () => {
    return expect(buildTree([], trivialDeps())).rejects.toThrow(/empty/i);
  });

  it("throws if a leaf lacks an embedding and no embed() was provided", () => {
    const bad: Leaf[] = [
      { id: 0, text: "x", vec: new Float32Array(0), ts: 0, sessionId: "s" },
    ];
    // Strip `embed` so the fallback path runs.
    const noEmbed = {
      kmeans: trivialDeps().kmeans,
      summarize: trivialDeps().summarize,
    };
    return expect(buildTree(bad, noEmbed)).rejects.toThrow(/embedding/i);
  });
});
