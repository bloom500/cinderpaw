/**
 * FractalRecallEngine.rankedLeafIds — the ranked-id accessor the benchmark
 * gate needs.
 *
 * `recall()` returns a formatted block, but recall@k can only be measured
 * against the ranked *leaf ids* behind that block. `rankedLeafIds` exposes
 * exactly the merge+re-rank that `recall()` already does internally (same
 * session exclusion, same dedup, same FTS-boost ordering), so the benchmark
 * scores the live retrieval path rather than a re-implementation of it.
 */
import { describe, it, expect } from "bun:test";
import { FractalRecallEngine } from "../src/memory/fractal/fractal-recall.ts";
import { buildTree } from "../src/memory/fractal/tree-builder.ts";
import type { Leaf, TreeNode } from "../src/memory/fractal/types.ts";
import type { EpisodicEvent } from "../../src/types.ts";

const LEAVES: Leaf[] = (() => {
  const groups = [
    { session: "s-a", pts: [[1, 0], [0.99, 0.14], [0.95, 0.31], [0.9, 0.43], [0.81, 0.59], [0.7, 0.71]] },
    { session: "s-b", pts: [[-1, 0], [-0.99, 0.14], [-0.95, 0.31], [-0.9, 0.43], [-0.81, 0.59], [-0.7, 0.71]] },
  ];
  const leaves: Leaf[] = [];
  let id = 1;
  for (const g of groups) {
    for (const [x, y] of g.pts) {
      const mag = Math.hypot(x, y) || 1;
      leaves.push({ id: id++, text: `event-${id}`, vec: new Float32Array([x / mag, y / mag]), ts: 1700000000000 + id, sessionId: g.session });
    }
  }
  return leaves;
})();

function fixtureTree(): Promise<TreeNode> {
  return buildTree(LEAVES, {
    kmeans: (points: Float32Array[], k: number) => {
      const n = points.length;
      if (k >= n) return Array.from({ length: n }, (_, i) => i);
      const perCluster = Math.ceil(n / k);
      return Array.from({ length: n }, (_, i) => Math.floor(i / perCluster));
    },
    summarize: async (items: string[]) => `summary [${items.length}]`,
  });
}

const leavesById = () => new Map(LEAVES.map((l) => [l.id, l]));
const QVEC_NEAR_A = new Float32Array([0.95, 0.31]);
const fixedEmbed = (vec: Float32Array) => async (texts: string[]) => texts.map(() => new Float32Array(vec));
const ev = (id: number, sessionId: string, content: string): EpisodicEvent => ({ id, sessionId, timestamp: 1700000000000, role: "user", content });

describe("FractalRecallEngine.rankedLeafIds", () => {
  it("returns leaf ids near the query, all from the non-current session", async () => {
    const tree = await fixtureTree();
    const engine = new FractalRecallEngine({
      tree, embed: fixedEmbed(QVEC_NEAR_A), ftsSearch: () => [], leavesById: leavesById(),
    });
    const ids = await engine.rankedLeafIds("q", "current-session");
    expect(ids.length).toBeGreaterThan(0);
    // Query points at group A (ids 1..6, session s-a); none from s-b (7..12).
    for (const id of ids) expect(id).toBeLessThanOrEqual(6);
  });

  it("ranks an FTS-boosted overlap ahead of a weaker semantic-only hit", async () => {
    const tree = await fixtureTree();
    // id=6 is the *weakest* group-A leaf for a query at [0.95,0.31] (it's the
    // [0.7,0.71] point). FTS also matches id=6 → its +FTS_BOOST should lift it
    // to the front of the ranking.
    const engine = new FractalRecallEngine({
      tree, embed: fixedEmbed(QVEC_NEAR_A), ftsSearch: () => [ev(6, "s-a", "exact")], leavesById: leavesById(),
    });
    const ids = await engine.rankedLeafIds("q", "current-session");
    expect(ids[0]).toBe(6);
  });

  it("excludes hits from the current session", async () => {
    const tree = await fixtureTree();
    const engine = new FractalRecallEngine({
      tree, embed: fixedEmbed(QVEC_NEAR_A), ftsSearch: () => [], leavesById: leavesById(),
    });
    // Pretend we're in s-a → every group-A semantic hit is dropped.
    const ids = await engine.rankedLeafIds("q", "s-a");
    expect(ids).toEqual([]);
  });

  it("dedups an id present in both backends to a single entry", async () => {
    const tree = await fixtureTree();
    const engine = new FractalRecallEngine({
      tree, embed: fixedEmbed(QVEC_NEAR_A), ftsSearch: () => [ev(1, "s-a", "overlap")], leavesById: leavesById(),
    });
    const ids = await engine.rankedLeafIds("q", "current-session");
    expect(ids.filter((id) => id === 1).length).toBe(1);
  });

  it("honours the limit argument", async () => {
    const tree = await fixtureTree();
    const engine = new FractalRecallEngine({
      tree, embed: fixedEmbed(QVEC_NEAR_A), ftsSearch: () => [], leavesById: leavesById(),
    });
    const ids = await engine.rankedLeafIds("q", "other-session", 2);
    expect(ids.length).toBe(2);
  });

  it("returns [] for an empty query without embedding", async () => {
    let embedCalled = false;
    const tree = await fixtureTree();
    const engine = new FractalRecallEngine({
      tree,
      embed: async (t: string[]) => { embedCalled = true; return t.map(() => new Float32Array([1, 0])); },
      ftsSearch: () => [], leavesById: leavesById(),
    });
    const ids = await engine.rankedLeafIds("   ", "current-session");
    expect(ids).toEqual([]);
    expect(embedCalled).toBe(false);
  });

  it("agrees with recall(): the ids it returns are the ones recall surfaces", async () => {
    const tree = await fixtureTree();
    const engine = new FractalRecallEngine({
      tree, embed: fixedEmbed(QVEC_NEAR_A),
      ftsSearch: () => [ev(99, "s-b", "fts-only-payload")], leavesById: leavesById(),
    });
    const ids = await engine.rankedLeafIds("q", "current-session");
    const result = await engine.recall("q", "current-session");
    // The fts-only hit id=99 is in the ranked ids AND its text is in the block.
    expect(ids).toContain(99);
    expect(result.context).toContain("fts-only-payload");
    // recall surfaces at most MAX_CONTEXT_HITS (10); ranked ids (default limit)
    // mirror that count.
    expect(ids.length).toBe(result.semanticFacts);
  });
});
