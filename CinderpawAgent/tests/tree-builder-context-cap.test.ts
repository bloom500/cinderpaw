/**
 * Tree-builder context-window cap (TDD).
 *
 * The 2700-leaf corpus has long conversation memories (some 10k+ chars).
 * When k-means aggregates several of those into one cluster, the
 * `summarize(items)` prompt can exceed the chat provider's context
 * window and MiniMax rejects with `invalid params, context window
 * exceeds limit (2013)` — leaving the whole tree build failed and the
 * bench verdict at 0%.
 *
 * Cap is two-layered:
 *   - `MAX_ITEM_CHARS` truncates each leaf's text before it joins a
 *     cluster summary prompt (so a 10k-char leaf contributes at most
 *     MAX_ITEM_CHARS chars, even if every cluster aggregated it).
 *   - `MAX_CLUSTER_ITEMS_CHARS` truncates the whole `items` array so
 *     even the densest cluster's prompt stays within budget.
 *
 * Both are env-configurable via `FERAL_TREE_ITEM_MAX_CHARS` and
 * `FERAL_TREE_CLUSTER_MAX_CHARS`. Defaults: 800 chars/item,
 * 12 000 chars/cluster — well inside any reasonable provider window
 * even with a non-trivial system prompt.
 */
import { describe, it, expect } from "bun:test";
import { buildTree } from "../src/memory/fractal/tree-builder.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";

/** Eight leaves, each text a single "x" repeated N times so we can assert char counts. */
function longLeaves(n: number, perLeafChars: number): Leaf[] {
  const out: Leaf[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1,
      text: "x".repeat(perLeafChars),
      vec: new Float32Array(0), // force the embed path during build
      ts: 1700000000000 + i,
      sessionId: `s-${i}`,
    });
  }
  return out;
}

describe("buildTree — context-window cap on cluster summaries", () => {
  it("truncates each leaf text to FERAL_TREE_ITEM_MAX_CHARS before joining a cluster", async () => {
    process.env.FERAL_TREE_ITEM_MAX_CHARS = "500";
    process.env.FERAL_TREE_CLUSTER_MAX_CHARS = "12000";

    // Spy on summarize: capture the items array per call.
    const calls: string[][] = [];
    const summarize = async (items: string[]) => {
      calls.push([...items]);
      return "summary";
    };

    // 8 leaves × 5000 chars each = 40 000 chars total; per-item cap is 500,
    // so each leaf's contribution to the cluster prompt is 500 chars max.
    const leaves = longLeaves(8, 5000);

    await buildTree(leaves, {
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0])),
      kmeans: (points) => points.map(() => 0), // all in one cluster
      summarize,
      branch: 8,
    });

    // With one cluster, summarize is called once with the items list.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = calls[0]!;
    // Each item must be at or under the cap (with "…" if truncated).
    for (const item of firstCall) {
      expect(item.length).toBeLessThanOrEqual(500);
    }

    delete process.env.FERAL_TREE_ITEM_MAX_CHARS;
    delete process.env.FERAL_TREE_CLUSTER_MAX_CHARS;
  });

  it("stops adding items to a cluster summary once FERAL_TREE_CLUSTER_MAX_CHARS is hit", async () => {
    process.env.FERAL_TREE_ITEM_MAX_CHARS = "1000";
    process.env.FERAL_TREE_CLUSTER_MAX_CHARS = "2000";

    const calls: string[][] = [];
    const summarize = async (items: string[]) => {
      calls.push([...items]);
      return "summary";
    };

    // 8 leaves × 1000 chars each = 8000 chars; cluster cap is 2000,
    // so at most 2 items should make it into the summary call (the
    // second item is truncated to fit).
    const leaves = longLeaves(8, 1000);

    await buildTree(leaves, {
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0])),
      kmeans: (points) => points.map(() => 0),
      summarize,
      branch: 8,
    });

    const firstCall = calls[0]!;
    // Total chars passed in must be ≤ cap. (With "…" trailing mark on the
    // boundary-cut item, it's exactly the cap.)
    const totalChars = firstCall.reduce((s, it) => s + it.length, 0);
    expect(totalChars).toBeLessThanOrEqual(2000);
    // And at least one item must have been included (the cap is a guard,
    // not a "send nothing").
    expect(firstCall.length).toBeGreaterThanOrEqual(1);

    delete process.env.FERAL_TREE_ITEM_MAX_CHARS;
    delete process.env.FERAL_TREE_CLUSTER_MAX_CHARS;
  });

  it("default caps (no env vars) still keep cluster summary input bounded", async () => {
    // No env vars set — must use the safe defaults.
    delete process.env.FERAL_TREE_ITEM_MAX_CHARS;
    delete process.env.FERAL_TREE_CLUSTER_MAX_CHARS;

    const calls: string[][] = [];
    const summarize = async (items: string[]) => {
      calls.push([...items]);
      return "summary";
    };

    // 8 leaves × 50 000 chars — way over any reasonable default.
    const leaves = longLeaves(8, 50_000);

    await buildTree(leaves, {
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0])),
      kmeans: (points) => points.map(() => 0),
      summarize,
      branch: 8,
    });

    const firstCall = calls[0]!;
    const totalChars = firstCall.reduce((s, it) => s + it.length, 0);
    // Default per-cluster cap is 12 000 chars — well under the 400 000 we
    // started with, and under any plausible provider context window.
    expect(totalChars).toBeLessThanOrEqual(12_000);
  });
});
