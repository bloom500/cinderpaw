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
  });
}

describe("FractalMemory upsertLeaf → LeafStore write-through", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cinderpaw-leafwt-")); });
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
