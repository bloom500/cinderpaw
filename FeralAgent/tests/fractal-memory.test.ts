/**
 * FractalMemory (TDD) — the live facade with FTS5 fallback.
 *
 * Verifies the "augment, never replace / never throws" contract:
 *   - no tree → falls back to the legacy engine
 *   - rebuild builds + serves the semantic path
 *   - embeddings unavailable (embed throws) → rebuild is a no-op, recall falls back
 *   - a recall-time fractal error still yields the fallback (never throws)
 *   - corpus below minLeaves → no tree, fallback only
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FractalMemory, type RecallFallback } from "../src/memory/fractal/fractal-memory.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";
import type { EpisodicEvent } from "../../src/types.ts";
import { InferenceSpendAuthority } from "../src/egress/inference-spend-authority.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function treePath(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-fmem-"));
  tmpDirs.push(d);
  return join(d, "tree.json");
}

/** 12 leaves in two groups, distinct sessions — no vectors (rebuild embeds). */
function leaves(): Leaf[] {
  const groups: Array<{ session: string; sign: number }> = [
    { session: "s-a", sign: 1 },
    { session: "s-b", sign: -1 },
  ];
  const out: Leaf[] = [];
  let id = 1;
  for (const g of groups) {
    for (let k = 0; k < 6; k++) {
      out.push({
        id: id,
        text: `event-${id} in ${g.session}`,
        vec: new Float32Array(0), // force the embed path during build
        ts: 1700000000000 + id,
        sessionId: g.session,
      });
      id++;
    }
  }
  return out;
}

/** Deterministic 2D embedder keyed on a leaf's group sign (text contains it). */
function fakeEmbed() {
  return async (texts: string[]) =>
    texts.map((t) => {
      const a = t.includes("s-a");
      return new Float32Array(a ? [1, 0] : [-1, 0]);
    });
}

const fakeSummarize = async (items: string[]) => `summary(${items.length})`;
const noFts = (_q: string, _l: number): EpisodicEvent[] => [];

/** A fallback engine that returns a unique marker so we can detect its use. */
const FALLBACK_MARK = "<<FTS5-FALLBACK>>";
const fallback: RecallFallback = {
  recall: () => ({ context: FALLBACK_MARK, episodicHits: 1, semanticFacts: 0 }),
};

describe("FractalMemory — fallback when no tree", () => {
  it("recall uses the legacy engine before any tree is built", async () => {
    const fm = new FractalMemory({
      loadLeaves: leaves,
      embed: fakeEmbed(),
      summarize: fakeSummarize,
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
    });
    expect(fm.hasTree).toBe(false);
    const r = await fm.recall("q", "current");
    expect(r.context).toBe(FALLBACK_MARK);
  });
});

describe("FractalMemory — rebuild + semantic serve", () => {
  it("threads one autonomous spend scope through every cluster summary", async () => {
    const authority = new InferenceSpendAuthority({ maxCostUsd: 0, allowCloud: false, price: () => null });
    const controller = new AbortController();
    const scopes: unknown[] = [];
    const fm = new FractalMemory({
      loadLeaves: leaves,
      embed: fakeEmbed(),
      summarize: async (items, scope) => {
        scopes.push(scope);
        return `summary(${items.length})`;
      },
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
    });
    expect(await fm.rebuild({ spendAuthority: authority, signal: controller.signal })).toBe(true);
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((scope) => (
      (scope as { spendAuthority?: unknown }).spendAuthority === authority &&
      (scope as { signal?: unknown }).signal === controller.signal
    ))).toBe(true);
  });

  it("rebuild builds a tree and recall then uses the semantic path", async () => {
    const fm = new FractalMemory({
      loadLeaves: leaves,
      embed: fakeEmbed(),
      summarize: fakeSummarize,
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
    });
    expect(await fm.rebuild()).toBe(true);
    expect(fm.hasTree).toBe(true);
    // Query near group A; current session is neither group → hits surface.
    const r = await fm.recall("anything s-a", "other");
    expect(r.context).not.toBe(FALLBACK_MARK);
    expect(r.context).toContain("[Memory context]");
  });

  it("rebuildIfStale builds when no tree exists yet", async () => {
    const fm = new FractalMemory({
      loadLeaves: leaves, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: treePath(),
    });
    expect(fm.hasTree).toBe(false);
    expect(await fm.rebuildIfStale()).toBe(true);
    expect(fm.hasTree).toBe(true);
  });

  it("rebuildIfStale skips (no re-embed) when the tree already covers the corpus", async () => {
    let embedCalls = 0;
    const embed = async (texts: string[]) => {
      embedCalls++;
      return texts.map((t) => new Float32Array(t.includes("s-a") ? [1, 0] : [-1, 0]));
    };
    const fm = new FractalMemory({
      loadLeaves: leaves, embed, summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: treePath(),
    });
    expect(await fm.rebuild()).toBe(true);
    const callsAfterBuild = embedCalls;
    expect(await fm.rebuildIfStale()).toBe(false); // fresh → skip
    expect(embedCalls).toBe(callsAfterBuild); // never re-embedded
  });

  it("rebuildIfStale rebuilds once the corpus grows past the ratio", async () => {
    let extra = 0;
    const dynLeaves = (): Leaf[] => {
      const base = leaves();
      for (let i = 0; i < extra; i++) {
        base.push({ id: 100 + i, text: `new-${i} s-a`, vec: new Float32Array(0), ts: 1700000001000 + i, sessionId: "s-a" });
      }
      return base;
    };
    const fm = new FractalMemory({
      loadLeaves: dynLeaves, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: treePath(),
    });
    expect(await fm.rebuild()).toBe(true); // covers 12
    expect(await fm.rebuildIfStale()).toBe(false); // still 12 → skip
    extra = 12; // corpus now 24 (> 1.2 × 12)
    expect(await fm.rebuildIfStale()).toBe(true); // grown → rebuild
  });

  it("rebuildIfStale rebuilds after a live corpus shrink", async () => {
    let current = leaves();
    const fm = new FractalMemory({
      loadLeaves: () => current, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: treePath(), minLeaves: 1,
    });
    expect(await fm.rebuild()).toBe(true);
    current = current.slice(0, 8);
    expect(await fm.rebuildIfStale()).toBe(true);
    expect(fm.treeLeafCount).toBe(8);
  });

  it("a persisted tree is adopted by a fresh instance via init()", async () => {
    const path = treePath();
    const a = new FractalMemory({
      loadLeaves: leaves, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: path,
    });
    expect(await a.rebuild()).toBe(true);
    // New instance, same path — should load the tree from disk.
    const b = new FractalMemory({
      loadLeaves: leaves, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: path,
    });
    expect(b.init()).toBe(true);
    expect(b.hasTree).toBe(true);
  });

  it("rejects a persisted tree when the canonical corpus shrank", async () => {
    const path = treePath();
    const a = new FractalMemory({
      loadLeaves: leaves, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: path,
    });
    expect(await a.rebuild()).toBe(true);
    const b = new FractalMemory({
      loadLeaves: () => leaves().slice(0, 8), embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: path,
    });
    expect(b.init()).toBe(false);
    expect(b.hasTree).toBe(false);
  });

  it("rejects a persisted tree when corpus membership changes at the same count", async () => {
    const path = treePath();
    const a = new FractalMemory({
      loadLeaves: leaves, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: path,
    });
    expect(await a.rebuild()).toBe(true);
    const changed = leaves().map((l, i) => i === 0 ? { ...l, text: "replacement s-a" } : l);
    const b = new FractalMemory({
      loadLeaves: () => changed, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: path,
    });
    expect(b.init()).toBe(false);
  });
});

describe("FractalMemory — embeddings unavailable", () => {
  it("rebuild is a no-op when embedding throws (no model on disk)", async () => {
    const throwingEmbed = async () => {
      throw new Error("no embedding model");
    };
    const fm = new FractalMemory({
      loadLeaves: leaves,
      embed: throwingEmbed,
      summarize: fakeSummarize,
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
    });
    expect(await fm.rebuild()).toBe(false);
    expect(fm.hasTree).toBe(false);
    // recall still works — via fallback.
    expect((await fm.recall("q", "s")).context).toBe(FALLBACK_MARK);
  });

  it("recall falls back (never throws) if the query embed fails after a tree exists", async () => {
    // buildTree embeds leaves one at a time, so we can't tell build-embed from
    // query-embed by batch size; flip a flag after the build instead.
    let failNow = false;
    const flaky = async (texts: string[]) => {
      if (failNow) throw new Error("query embed failed");
      return texts.map((t) => new Float32Array(t.includes("s-a") ? [1, 0] : [-1, 0]));
    };
    const fm = new FractalMemory({
      loadLeaves: leaves,
      embed: flaky,
      summarize: fakeSummarize,
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
    });
    expect(await fm.rebuild()).toBe(true);
    failNow = true;
    const r = await fm.recall("q", "s"); // query embed throws → fallback
    expect(r.context).toBe(FALLBACK_MARK);
  });
});

describe("FractalMemory — concurrent rebuild dedupe", () => {
  it("two concurrent rebuild() calls share one build (no thrashing)", async () => {
    const logs: string[] = [];
    const fm = new FractalMemory({
      loadLeaves: leaves, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: treePath(),
      log: (m) => logs.push(m),
    });
    // Fire both before awaiting: the guard is set synchronously at method
    // entry, so the second call must join the first instead of starting a
    // second buildTree (the "3× rebuild started" thrashing we hit live).
    const [a, b] = await Promise.all([fm.rebuild(), fm.rebuild()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(logs.filter((m) => m.includes("rebuild started")).length).toBe(1);
    // The inflight latch is released, so a later legitimate rebuild still runs.
    logs.length = 0;
    expect(await fm.rebuild()).toBe(true);
    expect(logs.filter((m) => m.includes("rebuild started")).length).toBe(1);
  });
});

describe("FractalMemory — maxLeaves cap (dev bench subset)", () => {
  it("rebuild builds a tree over at most maxLeaves rows", async () => {
    const fm = new FractalMemory({
      loadLeaves: leaves, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: treePath(),
      maxLeaves: 8, // corpus is 12; cap to 8
    });
    expect(await fm.rebuild()).toBe(true);
    expect(fm.treeLeafCount).toBe(8);
  });

  it("rebuildIfStale treats the capped count as the corpus size (stays fresh)", async () => {
    const fm = new FractalMemory({
      loadLeaves: leaves, embed: fakeEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: treePath(),
      maxLeaves: 8,
    });
    expect(await fm.rebuild()).toBe(true); // covers 8
    // Without capping the corpus comparison, 12 > 1.2×8 would force a rebuild
    // on every call; the cap must make this a no-op.
    expect(await fm.rebuildIfStale()).toBe(false);
  });
});

describe("FractalMemory — embedding-model migration guard", () => {
  it("clears stale vectors + re-embeds from scratch when the dimension changed", async () => {
    // Stored vecs are 3-dim (a previous model). The current model embeds in
    // 2-dim (fakeEmbed). The dim mismatch would crash cosine, so the guard must
    // clear + reload + rebuild fresh — not throw.
    let cleared = false;
    const clearEmbeddings = () => { cleared = true; return 12; };
    const staleLeaves = (): Leaf[] =>
      leaves().map((l) => ({
        ...l,
        vec: cleared ? new Float32Array(0) : new Float32Array([1, 0, 0]), // 3d → empty after clear
      }));
    const fm = new FractalMemory({
      loadLeaves: staleLeaves,
      embed: fakeEmbed(), // 2d
      summarize: fakeSummarize,
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
      clearEmbeddings,
    });
    expect(await fm.rebuild()).toBe(true);
    expect(cleared).toBe(true);
    expect(fm.hasTree).toBe(true);
  });

  it("does NOT clear when the stored dimension already matches the model", async () => {
    let cleared = false;
    const clearEmbeddings = () => { cleared = true; return 0; };
    const matchedLeaves = (): Leaf[] =>
      leaves().map((l) => ({
        ...l,
        vec: new Float32Array(l.text.includes("s-a") ? [1, 0] : [-1, 0]), // 2d, matches fakeEmbed
      }));
    const fm = new FractalMemory({
      loadLeaves: matchedLeaves,
      embed: fakeEmbed(), // 2d
      summarize: fakeSummarize,
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
      clearEmbeddings,
    });
    expect(await fm.rebuild()).toBe(true);
    expect(cleared).toBe(false);
  });
});

describe("FractalMemory — tiny corpus", () => {
  it("rebuild skips when fewer than minLeaves rows exist", async () => {
    const fm = new FractalMemory({
      loadLeaves: () => leaves().slice(0, 3),
      embed: fakeEmbed(),
      summarize: fakeSummarize,
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
      minLeaves: 8,
    });
    expect(await fm.rebuild()).toBe(false);
    expect(fm.hasTree).toBe(false);
  });
});
