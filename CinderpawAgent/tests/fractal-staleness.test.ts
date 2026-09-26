/**
 * A fractal tree must follow the memory it indexes.
 *
 * Three defects, one symptom — semantic recall frozen on old memories:
 *
 *   1. `init()` measured the loaded tree's coverage against the CURRENT
 *      corpus (it collapsed today's leaves and counted them all as covered),
 *      so `rebuildIfStale()` — which only runs at boot — always read "fresh".
 *      After the first build the tree was never rebuilt again, however much
 *      the user talked.
 *   2. The rebuild cap kept the OLDEST `maxLeaves` rows. On a cloud primary
 *      the cap is applied by default (200), so the tree was the first 200
 *      memories the user ever wrote, forever.
 *   3. `EpisodicMemory.all(limit)` returned the oldest `limit` rows, so the
 *      uncapped (local) tree stopped learning at 50 000 rows the same way.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FractalMemory, type RecallFallback } from "../src/memory/fractal/fractal-memory.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function treePath(): string {
  const d = mkdtempSync(join(tmpdir(), "cinderpaw-fms-stale-"));
  dirs.push(d);
  return join(d, "tree.json");
}

/** `n` distinct leaves, oldest first — the order `episodic.all()` returns. */
function corpus(n: number): Leaf[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    text: `memory number ${i + 1} about topic ${i % 3}`,
    vec: new Float32Array(0),
    ts: 1_700_000_000_000 + i * 1000,
    sessionId: `s-${i % 4}`,
  }));
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  return texts.map((t) => {
    const v = new Float32Array(4);
    for (let i = 0; i < t.length; i++) v[i % 4]! += t.charCodeAt(i) % 11;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
}

const fallback: RecallFallback = { recall: () => ({ context: "", episodicHits: 0, semanticFacts: 0 }) };

function memory(leaves: () => Leaf[], path: string, maxLeaves?: number): FractalMemory {
  return new FractalMemory({
    loadLeaves: leaves,
    embed,
    summarize: async (items) => `s${items.length}`,
    ftsSearch: () => [],
    fallback,
    treePath: path,
    ...(maxLeaves ? { maxLeaves } : {}),
  });
}

/** Every leaf id the built tree answers for, via the per-cluster drill-down. */
function treeIds(fm: FractalMemory): number[] {
  const ids: number[] = [];
  for (let c = 0; c < 64; c++) ids.push(...fm.clusterLeaves(c).map((l) => l.leafId));
  return ids.sort((a, b) => a - b);
}

describe("a tree loaded from disk still notices growth", () => {
  it("rebuildIfStale rebuilds after init when the corpus grew past the ratio", async () => {
    const path = treePath();
    let current = corpus(10);
    const first = memory(() => current, path);
    expect(await first.rebuild()).toBe(true);

    // Next boot: twice as many memories as the persisted tree covers.
    current = corpus(20);
    const next = memory(() => current, path);
    expect(next.init()).toBe(true);
    expect(await next.rebuildIfStale()).toBe(true);
    expect(treeIds(next)).toContain(20);
  });

  it("rebuilds after init when memories the tree indexes were deleted", async () => {
    const path = treePath();
    let current = corpus(12);
    expect(await memory(() => current, path).rebuild()).toBe(true);
    // Next boot: two memories forgotten, and three new ones — the new ones
    // must not hide the deletions.
    current = [...corpus(12).filter((l) => l.id !== 3 && l.id !== 4), ...corpus(15).slice(12)];
    const next = memory(() => current, path);
    next.init();
    expect(await next.rebuildIfStale()).toBe(true);
    expect(treeIds(next)).not.toContain(3);
  });

  it("still skips when the loaded tree already covers the corpus", async () => {
    const path = treePath();
    const current = corpus(12);
    expect(await memory(() => current, path).rebuild()).toBe(true);
    const next = memory(() => current, path);
    next.init();
    expect(await next.rebuildIfStale()).toBe(false);
  });
});

describe("a capped tree covers the NEWEST memories", () => {
  it("builds over the last maxLeaves rows, not the first", async () => {
    const fm = memory(() => corpus(30), treePath(), 10);
    expect(await fm.rebuild()).toBe(true);
    expect(treeIds(fm)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });

  it("rebuilds when the capped window slides onto new memories", async () => {
    const path = treePath();
    let current = corpus(10);
    const first = memory(() => current, path, 10);
    expect(await first.rebuild()).toBe(true);

    current = corpus(15); // five newer memories push five old ones out of the window
    const next = memory(() => current, path, 10);
    next.init();
    expect(await next.rebuildIfStale()).toBe(true);
    expect(treeIds(next)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe("EpisodicMemory.all(limit)", () => {
  it("returns the newest `limit` rows, oldest first", () => {
    const db = openDatabase(":memory:");
    const episodic = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger);
    for (let i = 1; i <= 5; i++) episodic.record("s", "user", `row ${i}`);
    expect(episodic.all(3).map((e) => e.content)).toEqual(["row 3", "row 4", "row 5"]);
  });
});
