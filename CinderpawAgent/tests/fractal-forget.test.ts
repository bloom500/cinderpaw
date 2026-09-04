/**
 * Deleting a memory has to actually delete it.
 *
 * Eviction and cross-session dedup removed leaves from the durable store and
 * left the SEARCH INDEX untouched, and the tree is only rebuilt on 1.2x
 * growth — so a memory the user had cleaned up stayed perfectly retrievable
 * until enough new ones accumulated to trigger a rebuild, which on a large
 * corpus is hundreds of memories away. Worse, `rebuildIfStale` checked growth
 * only: once the corpus SHRANK, `corpus < covered * 1.2` was satisfied
 * forever and the tree was never rebuilt again at all.
 *
 * These tests hold both halves: a stale id is not served, and a shrinking
 * corpus is recognised as stale.
 */
import { describe, it, expect } from "bun:test";
import { FractalRecallEngine } from "../src/memory/fractal/fractal-recall.ts";
import { buildTree } from "../src/memory/fractal/tree-builder.ts";
import type { Leaf, TreeNode } from "../src/memory/fractal/types.ts";
import type { EpisodicEvent } from "../../src/types.ts";

/** Eight leaves on one arc, one session, so any query hits several. */
const LEAVES: Leaf[] = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * (Math.PI / 4);
  return {
    id: i + 1,
    text: `remembered thing ${i + 1}`,
    vec: new Float32Array([Math.cos(angle), Math.sin(angle)]),
    ts: 1700000000000 + i,
    sessionId: "s-old",
  };
});

function trivialTreeDeps() {
  return {
    kmeans: (points: Float32Array[], k: number) => {
      const n = points.length;
      if (k >= n) return Array.from({ length: n }, (_, i) => i);
      const perCluster = Math.ceil(n / k);
      return Array.from({ length: n }, (_, i) => Math.floor(i / perCluster));
    },
    summarize: async (items: string[]) => `summary of ${items.length}`,
  };
}

async function fixtureTree(): Promise<TreeNode> {
  return buildTree(LEAVES, trivialTreeDeps());
}

function fixedEmbed(vec: Float32Array) {
  return async (texts: string[]) => texts.map(() => new Float32Array(vec));
}

const noFts = (_q: string, _limit: number): EpisodicEvent[] => [];

describe("FractalRecallEngine — a removed leaf is not recalled", () => {
  it("serves a leaf that is still in the index", async () => {
    const tree = await fixtureTree();
    const engine = new FractalRecallEngine({
      tree,
      embed: fixedEmbed(new Float32Array([1, 0])),
      ftsSearch: noFts,
      leavesById: new Map(LEAVES.map((l) => [l.id, l])),
    });

    const res = await engine.recall("anything", "s-new");
    expect(res.context).toContain("remembered thing 1");
  });

  it("does NOT serve one that has been forgotten since the last rebuild", async () => {
    const tree = await fixtureTree();
    // The tree still names every id; the index no longer knows leaf 1, which
    // is exactly the state eviction and dedup leave behind.
    const index = new Map(LEAVES.map((l) => [l.id, l]));
    index.delete(1);

    const engine = new FractalRecallEngine({
      tree,
      embed: fixedEmbed(new Float32Array([1, 0])),
      ftsSearch: noFts,
      leavesById: index,
    });

    const res = await engine.recall("anything", "s-new");
    expect(res.context).not.toContain("remembered thing 1");
    // And it is gone, not replaced by a placeholder row: `event-1` with an
    // empty session and a zero timestamp used to be rendered as `????-??-??`,
    // costing tokens to tell the model nothing.
    expect(res.context).not.toContain("event-1");
    expect(res.context).not.toContain("????");
  });
});
