/**
 * FractalMemory.evict() — Pathway 4 PR-C Task C.2.
 *
 * Applies an EvictionPolicy to the durable LeafStore (C.0/C.1): removes the
 * selected leaves, appends them to `<dir>/fractal-evicted.jsonl` for audit,
 * and emits a `prune` activity pulse so the organism reflects the loss.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FractalMemory, type FractalActivity } from "../src/memory/fractal/fractal-memory.ts";
import { AgeAndHitCountEviction, NoEviction } from "../src/memory/fractal/eviction.ts";
import type { EmbedInvoker } from "../src/memory/fractal/embed.ts";

const silentFts = { search: () => [] };
const noopSummarize = async (_items: string[]) => "summary";
const noopFallback = { recall: () => ({ context: "", facts: [] }) };
const identityEmbed: EmbedInvoker = (texts) =>
  Promise.resolve(texts.map(() => new Float32Array([1, 0, 0])));

function makeFm(leafStorePath: string, onActivity?: (a: FractalActivity) => void) {
  return new FractalMemory({
    loadLeaves: () => [],
    embed: identityEmbed,
    summarize: noopSummarize,
    ftsSearch: silentFts,
    fallback: noopFallback,
    treePath: ":memory:",
    leafStorePath,
    onActivity,
  });
}

/** Insert 3 leaves with orthogonal embeddings (no merge), all stale + cold. */
async function seedThreeStaleLeaves(fm: FractalMemory) {
  const embs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let i = 0; i < 3; i++) {
    await fm.upsertLeaf({
      text: `fact ${i}`,
      embedding: embs[i]!,
      provenance: { source: "react", first_seen_at: 1000, sessionId: "s1", ts: 1000 },
    });
  }
}

describe("FractalMemory.evict", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cinderpaw-evict-")); });
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  const storePath = () => join(dir, "fractal-leaves.jsonl");
  const evictedPath = () => join(dir, "fractal-evicted.jsonl");

  test("removes the leaves the policy selects", async () => {
    const fm = makeFm(storePath());
    await seedThreeStaleLeaves(fm);
    expect(fm.leaves()).toHaveLength(3);

    // ts=1000, hit_count=1; now far in the future ⇒ all stale + cold
    const result = await fm.evict(new AgeAndHitCountEviction(1000, 2), 10_000_000);

    expect(result.evicted.sort((a, b) => a - b)).toHaveLength(3);
    expect(fm.leaves()).toHaveLength(0);
  });

  test("appends evicted leaves to fractal-evicted.jsonl with reason", async () => {
    const fm = makeFm(storePath());
    await seedThreeStaleLeaves(fm);
    await fm.evict(new AgeAndHitCountEviction(1000, 2), 10_000_000);

    expect(existsSync(evictedPath())).toBe(true);
    const lines = readFileSync(evictedPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ reason: "age_and_hit_count" });
    expect(typeof first.leafId).toBe("number");
    expect(typeof first.evictedAt).toBe("number");
  });

  test("emits a prune activity pulse with the evicted ids", async () => {
    const acts: FractalActivity[] = [];
    const fm = makeFm(storePath(), (a) => acts.push(a));
    await seedThreeStaleLeaves(fm);
    acts.length = 0; // ignore the grow pulses from seeding

    await fm.evict(new AgeAndHitCountEviction(1000, 2), 10_000_000);

    const prune = acts.find((a) => a.kind === "prune");
    expect(prune).toBeDefined();
    if (prune && prune.kind === "prune") {
      expect(prune.evictedLeafIds.sort((a, b) => a - b)).toHaveLength(3);
      expect(prune.ts).toBe(10_000_000);
    }
  });

  test("NoEviction removes nothing, writes no file, emits no pulse", async () => {
    const acts: FractalActivity[] = [];
    const fm = makeFm(storePath(), (a) => acts.push(a));
    await seedThreeStaleLeaves(fm);
    acts.length = 0;

    const result = await fm.evict(new NoEviction(), 10_000_000);

    expect(result.evicted).toEqual([]);
    expect(fm.leaves()).toHaveLength(3);
    expect(existsSync(evictedPath())).toBe(false);
    expect(acts.find((a) => a.kind === "prune")).toBeUndefined();
  });
});
