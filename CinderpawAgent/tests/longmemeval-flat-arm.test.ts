/**
 * The no-tree control in scripts/longmemeval.ts. `flatTree` hangs every leaf
 * off the root, so the engine's descent has nothing to prune and scores all
 * of them. If it ever pruned, the tree-vs-flat gap would stop measuring the
 * tree.
 */
import { describe, expect, it } from "bun:test";
import { flatTree, turnRecall } from "../../scripts/longmemeval.ts";
import { FractalRecallEngine } from "../src/memory/fractal/fractal-recall.ts";
import { buildTree } from "../src/memory/fractal/tree-builder.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";

function unit(angle: number): Float32Array {
  return new Float32Array([Math.cos(angle), Math.sin(angle)]);
}

// 60 leaves spread around the circle: a beam of 20 over a built tree has
// clusters to discard, the flat tree has none.
const LEAVES: Leaf[] = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1,
  text: `turn ${i + 1}`,
  vec: unit((i / 60) * 2 * Math.PI),
  ts: 1,
  sessionId: `s${i % 7}`,
}));

function engine(tree: Awaited<ReturnType<typeof buildTree>>) {
  return new FractalRecallEngine({
    tree,
    embed: async (t) => t.map(() => unit(0.3)),
    ftsSearch: () => [],
    leavesById: new Map(LEAVES.map((l) => [l.id, l])),
  });
}

describe("longmemeval flat arm", () => {
  it("holds every leaf directly under the root", () => {
    const t = flatTree(LEAVES);
    expect(t.children).toHaveLength(60);
    expect(t.children.every((c) => c.children.length === 0 && c.leafIds.length === 1)).toBe(true);
    expect(t.leafIds).toEqual(LEAVES.map((l) => l.id));
  });

  it("ranks exactly like exhaustive cosine over all leaves", async () => {
    const q = unit(0.3);
    const byCosine = [...LEAVES]
      .map((l) => ({ id: l.id, s: l.vec[0]! * q[0]! + l.vec[1]! * q[1]! }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => x.id);
    expect(await engine(flatTree(LEAVES)).rankedLeafIds("q", "", 10)).toEqual(byCosine);
  });

  it("returns a full candidate set where a built tree may prune", async () => {
    const built = await buildTree(LEAVES, { summarize: async () => "s", branch: 4 });
    const flat = await engine(flatTree(LEAVES)).rankedLeafIds("q", "", 10);
    const tree = await engine(built).rankedLeafIds("q", "", 10);
    expect(flat).toHaveLength(10);
    expect(tree.length).toBeLessThanOrEqual(10);
  });
});

describe("longmemeval turn recall", () => {
  const solo = (id: number) => [id];
  it("any/all over the labelled turns", () => {
    expect(turnRecall([5, 9, 2], new Set([9, 40]), solo)).toEqual({ any: 1, all: 0 });
    expect(turnRecall([40, 9], new Set([9, 40]), solo)).toEqual({ any: 1, all: 1 });
    expect(turnRecall([1, 2, 3], new Set([9]), solo)).toEqual({ any: 0, all: 0 });
  });
  it("a ranked survivor counts for the evidence turn collapsed into it", () => {
    const members = (id: number) => (id === 3 ? [3, 9] : [id]);
    expect(turnRecall([3], new Set([9]), members)).toEqual({ any: 1, all: 1 });
  });
  it("no labelled turn scores nothing", () => {
    expect(turnRecall([1], new Set(), solo)).toEqual({ any: 0, all: 0 });
  });
});
