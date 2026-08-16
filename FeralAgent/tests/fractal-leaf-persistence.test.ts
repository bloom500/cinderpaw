/**
 * FractalMemory.upsertLeaf → LeafStore write-through — Pathway 4 PR-C Task C.0.
 *
 * Pins the durability contract that closes step-2's "reactive leaves
 * in-memory only" gap:
 *   - upsertLeaf writes each new leaf through to the durable LeafStore.
 *   - A fresh FractalMemory over the same `leafStorePath`, after `init()`,
 *     exposes the leaf via `leaves()` (survives "restart").
 *   - A near-duplicate merge bumps `hit_count` / `last_seen_at` in the store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FractalMemory } from "../src/memory/fractal/fractal-memory.ts";
import type { EmbedInvoker } from "../src/memory/fractal/embed.ts";
import { LeafStore } from "../src/memory/fractal/leaf-store.ts";

const silentFts = { search: () => [] };
const noopSummarize = async (_items: string[]) => "summary";
const noopFallback = { recall: () => ({ context: "", facts: [] }) };
const identityEmbed: EmbedInvoker = (texts) =>
  Promise.resolve(texts.map(() => new Float32Array([1, 0, 0])));

function makeFm(leafStorePath: string) {
  return new FractalMemory({
    loadLeaves: () => [],
    embed: identityEmbed,
    summarize: noopSummarize,
    ftsSearch: silentFts,
    fallback: noopFallback,
    treePath: ":memory:",
    leafStorePath,
    minLeaves: 1,
  });
}

describe("FractalMemory upsertLeaf → LeafStore write-through", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "feral-leafwt-")); });
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  const storePath = () => join(dir, "fractal-leaves.jsonl");

  test("a fresh FractalMemory.init() over the same path exposes the upserted leaf", async () => {
    const a = makeFm(storePath());
    await a.upsertLeaf({
      text: "language: ro",
      embedding: [1, 0, 0],
      provenance: { source: "react", first_seen_at: 1000, sessionId: "s1", ts: 1000, key: "language", value: "ro" },
    });

    const b = makeFm(storePath());
    b.init();
    const leaves = b.leaves();
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ text: "language: ro", hit_count: 1, first_seen_at: 1000 });
    expect(await b.rebuild()).toBe(true);
    expect(b.treeLeafCount).toBe(1);
    expect(b.treeView().leaves.map((l) => l.summary)).toContain("language: ro");
  });

  test("dedup writes the aggregated survivor back before removing absorbed rows", async () => {
    const old = process.env.FERAL_MERGE_THRESHOLD;
    process.env.FERAL_MERGE_THRESHOLD = "0.92";
    try {
      const fm = makeFm(storePath());
      await fm.upsertLeaf({
        text: "same fact old",
        embedding: [1, 0, 0],
        provenance: { source: "react", first_seen_at: 1, sessionId: "s1", ts: 10 },
      });
      await fm.upsertLeaf({
        text: "same fact new",
        embedding: [0.8, 0.6, 0],
        provenance: { source: "react", first_seen_at: 1000, sessionId: "s2", ts: 2000 },
      });
      expect((await fm.dedup({ mergeThreshold: 0.7, spanThresholdMs: 100 })).groups).toBe(1);
      expect(fm.leaves()).toHaveLength(1);
      expect(fm.leaves()[0]).toMatchObject({ hit_count: 2, last_seen_at: 2000 });
      await fm.upsertLeaf({
        text: "same fact newest",
        embedding: [1, 0, 0],
        provenance: { source: "react", first_seen_at: 3000, sessionId: "s3", ts: 3000 },
      });
      expect(fm.leaves()[0]).toMatchObject({ hit_count: 3, last_seen_at: 3000 });
    } finally {
      if (old === undefined) delete process.env.FERAL_MERGE_THRESHOLD;
      else process.env.FERAL_MERGE_THRESHOLD = old;
    }
  });

  test("owner-aware catalog keeps colliding source ids stable and writes embeddings to each owner", async () => {
    const path = storePath();
    const store = new LeafStore(path);
    store.upsert({
      id: 1,
      text: "reactive fact",
      vec: [],
      ts: 2,
      sessionId: "reactive-session",
      provenance: { source: "react", first_seen_at: 2, last_seen_at: 2, hit_count: 1 },
    });
    const episodic = [{
      id: 1,
      text: "episodic event",
      vec: new Float32Array(0),
      ts: 1,
      sessionId: "episodic-session",
    }];
    const episodicWrites: { id: number; vec: Float32Array }[] = [];
    const fm = new FractalMemory({
      loadLeaves: () => episodic,
      embed: identityEmbed,
      summarize: noopSummarize,
      ftsSearch: silentFts,
      fallback: noopFallback,
      treePath: join(dir, "tree.json"),
      leafStorePath: path,
      minLeaves: 2,
      persistEmbeddings: (rows) => episodicWrites.push(...rows),
    });

    fm.init();
    expect(fm.leaves()[0]?.id).toBe(1);
    expect(await fm.rebuild()).toBe(true);
    expect(fm.treeLeafCount).toBe(2);
    expect(fm.treeView().leaves.map((leaf) => leaf.id).sort()).toEqual([1, 2]);
    const publicLeaves = Array.from({ length: fm.treeLeafCount }, (_unused, index) => fm.clusterLeaves(index)).flat();
    expect(publicLeaves.map(({ leafId, owner }) => ({ leafId, owner })).sort((a, b) => a.owner.localeCompare(b.owner)))
      .toEqual([
        { leafId: 1, owner: "episodic" },
        { leafId: 2, owner: "reactive" },
      ]);
    expect(episodicWrites.map((row) => row.id)).toEqual([1]);

    const reloaded = new LeafStore(path);
    reloaded.load();
    expect(reloaded.all()[0]).toMatchObject({ id: 2 });
    expect(reloaded.all()[0]!.vec).toHaveLength(3);
  });

  test("merge bumps hit_count + last_seen_at in the store", async () => {
    const fm = makeFm(storePath());
    await fm.upsertLeaf({
      text: "language: ro",
      embedding: [1, 0, 0],
      provenance: { source: "react", first_seen_at: 1000, sessionId: "s1", ts: 1000 },
    });
    // near-identical embedding (cosine ≈ 1 >> 0.92) → merge, not insert
    await fm.upsertLeaf({
      text: "language: romanian",
      embedding: [0.9999, 0.01, 0],
      provenance: { source: "react", first_seen_at: 2000, sessionId: "s1", ts: 2000 },
    });

    const leaves = fm.leaves();
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.hit_count).toBe(2);
    expect(leaves[0]?.last_seen_at).toBe(2000);
  });

  test("a reactive match against an episodic leaf never creates a same-id owner record", async () => {
    const fm = new FractalMemory({
      loadLeaves: () => [{
        id: 1,
        text: "episodic fact",
        vec: new Float32Array([1, 0, 0]),
        ts: 1,
        sessionId: "episodic",
      }],
      embed: identityEmbed,
      summarize: noopSummarize,
      ftsSearch: silentFts,
      fallback: noopFallback,
      treePath: join(dir, "tree.json"),
      leafStorePath: storePath(),
      minLeaves: 1,
    });
    const result = await fm.upsertLeaf({
      text: "same semantic fact",
      embedding: [1, 0, 0],
      provenance: { source: "react", first_seen_at: 2, sessionId: "reactive", ts: 2 },
    });
    expect(result).toEqual({ kind: "seed", leafId: 1 });
    expect(fm.leaves()).toHaveLength(0);
  });

  test("a capped catalog always retains reactive membership", async () => {
    const path = storePath();
    new LeafStore(path).upsert({
      id: 1,
      text: "durable reactive fact",
      vec: [0, 1, 0],
      ts: 10,
      sessionId: "reactive",
      provenance: { source: "react", first_seen_at: 10, last_seen_at: 10, hit_count: 1 },
    });
    const fm = new FractalMemory({
      loadLeaves: () => Array.from({ length: 8 }, (_, index) => ({
        id: index + 1,
        text: `episodic-${index + 1}`,
        vec: new Float32Array([1, 0, 0]),
        ts: index + 1,
        sessionId: "episodic",
      })),
      embed: identityEmbed,
      summarize: noopSummarize,
      ftsSearch: silentFts,
      fallback: noopFallback,
      treePath: join(dir, "tree.json"),
      leafStorePath: path,
      minLeaves: 1,
      maxLeaves: 4,
    });
    fm.init();
    expect(await fm.rebuild()).toBe(true);
    expect(fm.treeView().leaves.map((leaf) => leaf.summary)).toContain("durable reactive fact");
  });

  test("eviction invalidates the live tree before deleted leaves can be recalled", async () => {
    const fm = makeFm(storePath());
    await fm.upsertLeaf({
      text: "private transient fact",
      embedding: [1, 0, 0],
      provenance: { source: "react", first_seen_at: 1, sessionId: "s1", ts: 1 },
    });
    expect(await fm.rebuild()).toBe(true);
    expect(fm.hasTree).toBe(true);
    await fm.evict({ name: "test", select: (leaves) => leaves.map((leaf) => leaf.id) }, 2);
    expect(fm.hasTree).toBe(false);
  });

  test("leaves() is empty before any write and reads from the store after", async () => {
    const fm = makeFm(storePath());
    expect(fm.leaves()).toHaveLength(0);
    await fm.upsertLeaf({
      text: "name: Alice",
      embedding: [0, 1, 0],
      provenance: { source: "react", first_seen_at: 5, sessionId: "s1", ts: 5 },
    });
    expect(fm.leaves().map((l) => l.text)).toEqual(["name: Alice"]);
  });
});
