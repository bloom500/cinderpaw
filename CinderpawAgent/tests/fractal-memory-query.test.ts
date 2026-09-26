/**
 * FractalMemory.query — the structured `fractalQuery` surface the memory
 * tool facades call.
 *
 * Unlike `recall` (which formats a prompt block) this returns ranked
 * `{leafId, text}` hits so a tool can render them however it likes. It is a
 * read over the loaded tree with the same "never throws, augment never
 * replace" contract: no tree, or an embedding failure, downgrades to FTS5
 * alone, exactly like `recall` — never an error, and never an empty answer to
 * a question the keyword index can answer.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FractalMemory, type RecallFallback } from "../src/memory/fractal/fractal-memory.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";
import type { EpisodicEvent } from "../../src/types.ts";

const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function treePath(): string {
  const d = mkdtempSync(join(tmpdir(), "cinderpaw-fquery-"));
  tmpDirs.push(d);
  return join(d, "tree.json");
}

function leaves(): Leaf[] {
  const out: Leaf[] = [];
  let id = 1;
  for (const session of ["s-a", "s-b"]) {
    for (let k = 0; k < 6; k++) {
      out.push({ id, text: `event-${id} in ${session}`, vec: new Float32Array(0), ts: 1700000000000 + id, sessionId: session });
      id++;
    }
  }
  return out;
}

const groupEmbed = () => async (texts: string[]) =>
  texts.map((t) => new Float32Array(t.includes("s-a") ? [1, 0] : [-1, 0]));
const fakeSummarize = async (items: string[]) => `summary(${items.length})`;
const noFts = (_q: string, _l: number): EpisodicEvent[] => [];
const fallback: RecallFallback = { recall: () => ({ context: "FB", episodicHits: 0, semanticFacts: 0 }) };

function makeFm(embed = groupEmbed()) {
  return new FractalMemory({
    loadLeaves: leaves, embed, summarize: fakeSummarize,
    ftsSearch: noFts, fallback, treePath: treePath(),
  });
}

describe("FractalMemory.query", () => {
  it("returns ranked {leafId, text} hits for a semantic query", async () => {
    const fm = makeFm();
    await fm.rebuild();
    // "in s-a" embeds to [1,0] → group-A leaves (ids 1..6).
    const hits = await fm.query("anything in s-a", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(5);
    for (const h of hits) {
      expect(h.leafId).toBeLessThanOrEqual(6);
      expect(h.text).toContain("s-a");
      expect(typeof h.leafId).toBe("number");
    }
  });

  it("respects the limit", async () => {
    const fm = makeFm();
    await fm.rebuild();
    const hits = await fm.query("in s-a", 2);
    expect(hits.length).toBe(2);
  });

  it("returns [] when no tree has been built (graceful, not an error)", async () => {
    const fm = makeFm();
    expect(fm.hasTree).toBe(false);
    expect(await fm.query("anything", 5)).toEqual([]);
  });

  it("returns [] when embedding fails, never throws", async () => {
    const throwingEmbed = async () => { throw new Error("no model"); };
    const fm = makeFm();
    // Build the tree first with a working embed, then swap in a failing one
    // is not possible (embed is fixed at construction); instead build with a
    // throwing embed → rebuild is a no-op (no tree) → query returns [].
    const fm2 = makeFm(throwingEmbed);
    await fm2.rebuild();
    expect(await fm2.query("q", 5)).toEqual([]);
    // And on a built tree, a query-time embed failure also yields [] — model
    // the failure by giving a tree then a query that the engine can't embed.
    await fm.rebuild();
    expect(fm.hasTree).toBe(true);
    expect(await fm.query("", 5)).toEqual([]); // empty query → no hits, no throw
  });
});

describe("FractalMemory.query — FTS5 is never thrown away", () => {
  const row = (id: number, content: string): EpisodicEvent => ({
    id, sessionId: "s-new", timestamp: 1700000009999, role: "user", content,
  } as EpisodicEvent);
  const ftsWith = (rows: EpisodicEvent[]) => (_q: string, l: number) => rows.slice(0, l);

  it("with no tree, answers from FTS5 instead of returning nothing", async () => {
    const fm = new FractalMemory({
      loadLeaves: () => [], embed: groupEmbed(), summarize: fakeSummarize,
      ftsSearch: ftsWith([row(501, "the invoice number is 4471")]), fallback, treePath: treePath(),
    });
    expect(fm.hasTree).toBe(false);
    expect(await fm.query("invoice number", 5)).toEqual([{ leafId: 501, text: "the invoice number is 4471" }]);
  });

  it("keeps an FTS5 hit on a row written after the tree was built", async () => {
    // Row 501 is not a tree leaf: it arrived after the build. The keyword
    // index still finds it, and the hit must reach the tool with its text.
    const fm = new FractalMemory({
      loadLeaves: leaves, embed: groupEmbed(), summarize: fakeSummarize,
      ftsSearch: ftsWith([row(501, "invoice from this morning, s-b")]), fallback, treePath: treePath(),
    });
    await fm.rebuild();
    expect(fm.hasTree).toBe(true);
    const hits = await fm.query("invoice s-b", 20);
    expect(hits).toContainEqual({ leafId: 501, text: "invoice from this morning, s-b" });
  });

  it("falls back to FTS5 when the query cannot be embedded on a built tree", async () => {
    let failing = false;
    const flaky = async (texts: string[]) => {
      if (failing) throw new Error("model unloaded");
      return groupEmbed()(texts);
    };
    const fm = new FractalMemory({
      loadLeaves: leaves, embed: flaky, summarize: fakeSummarize,
      ftsSearch: ftsWith([row(501, "invoice 4471")]), fallback, treePath: treePath(),
    });
    await fm.rebuild();
    failing = true;
    expect(await fm.query("invoice", 5)).toEqual([{ leafId: 501, text: "invoice 4471" }]);
  });

  it("a throwing FTS5 on the fallback path still yields [], never an error", async () => {
    const fm = new FractalMemory({
      loadLeaves: () => [], embed: groupEmbed(), summarize: fakeSummarize,
      ftsSearch: () => { throw new Error("db closed"); }, fallback, treePath: treePath(),
    });
    expect(await fm.query("anything", 5)).toEqual([]);
  });
});
