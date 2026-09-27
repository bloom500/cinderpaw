import { afterEach, describe, expect, test } from "bun:test";
import { buildFlatTree } from "../src/memory/fractal/tree-builder.ts";
import { appendLeaf } from "../src/memory/fractal/tree-append.ts";
import { FractalMemory } from "../src/memory/fractal/fractal-memory.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const unit = (a: number, b: number) => {
  const n = Math.hypot(a, b);
  return new Float32Array([a / n, b / n]);
};
const leaf = (id: number, vec: Float32Array, text = `leaf ${id}`): Leaf => ({ id, text, vec, ts: id, sessionId: "past" });

afterEach(() => delete process.env.CINDERPAW_FMS_TREE);

describe("buildFlatTree", () => {
  test("every leaf is a child of one root, with no summary call", async () => {
    const tree = await buildFlatTree([leaf(1, unit(1, 0)), leaf(2, unit(0, 1))], {});
    expect(tree.children.map((c) => c.leafIds[0])).toEqual([1, 2]);
    expect(tree.children.every((c) => c.level === 0)).toBe(true);
    expect(tree.centroid.length).toBe(2);
  });

  test("embeds only what has no vector, and persists it", async () => {
    const embedded: string[][] = [];
    const persisted: number[] = [];
    await buildFlatTree([leaf(1, unit(1, 0)), leaf(2, new Float32Array(0), "fresh")], {
      embed: async (t) => (embedded.push(t), t.map(() => unit(0, 1))),
      persistEmbeddings: (rows) => void persisted.push(...rows.map((r) => r.id)),
    });
    expect(embedded).toEqual([["fresh"]]);
    expect(persisted).toEqual([2]);
  });

  test("a new leaf can be appended under the root", async () => {
    const tree = await buildFlatTree([leaf(1, unit(1, 0))], {});
    expect(appendLeaf(tree, 9, unit(0, 1)).ok).toBe(true);
    expect(tree.children.map((c) => c.leafIds[0])).toEqual([1, 9]);
  });
});

describe("FractalMemory builds flat by default", () => {
  test("rebuild never summarises; CINDERPAW_FMS_TREE=raptor does", async () => {
    const leaves = Array.from({ length: 40 }, (_, i) => leaf(i + 1, unit(1, i / 40)));
    let summaries = 0;
    const make = () =>
      new FractalMemory({
        loadLeaves: () => leaves,
        embed: async (t) => t.map(() => unit(1, 0)),
        summarize: async () => (summaries++, "s"),
        ftsSearch: () => [],
        fallback: { recall: () => ({ context: "", episodicHits: 0, semanticFacts: 0 }) },
        treePath: join(mkdtempSync(join(tmpdir(), "cp-flat-")), "fractal-tree.json"),
        leafStorePath: ":memory:",
      });
    expect(await make().rebuild()).toBe(true);
    expect(summaries).toBe(0);
    process.env.CINDERPAW_FMS_TREE = "raptor";
    expect(await make().rebuild()).toBe(true);
    expect(summaries).toBeGreaterThan(0);
  });
});
