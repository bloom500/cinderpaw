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
