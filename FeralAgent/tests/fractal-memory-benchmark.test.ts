/**
 * FractalMemory.benchmark — the one-call entrypoint the sidecar trigger uses.
 *
 * The facade already owns everything the gate needs (the built tree, the leaf
 * map, the embed bridge, the FTS5 search), so `benchmark` just assembles those
 * into `runFractalBenchmark`. These tests pin the two contracts the trigger
 * relies on: it refuses to run without a tree, and once a tree is built it
 * returns a full report.
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
  const d = mkdtempSync(join(tmpdir(), "feral-fbench-"));
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

const fakeEmbed = () => async (texts: string[]) =>
  texts.map((t) => new Float32Array(t.includes("s-a") ? [1, 0] : [-1, 0]));
const fakeSummarize = async (items: string[]) => `summary(${items.length})`;
const noFts = (_q: string, _l: number): EpisodicEvent[] => [];
const fallback: RecallFallback = { recall: () => ({ context: "FB", episodicHits: 0, semanticFacts: 0 }) };

function makeFm() {
  return new FractalMemory({
    loadLeaves: leaves, embed: fakeEmbed(), summarize: fakeSummarize,
    ftsSearch: noFts, fallback, treePath: treePath(),
  });
}

describe("FractalMemory.benchmark", () => {
  it("rejects when no tree has been built", async () => {
    const fm = makeFm();
    await expect(fm.benchmark({ infer: async () => "q" })).rejects.toThrow();
  });

  it("returns a full report once a tree is built", async () => {
    const fm = makeFm();
    await fm.rebuild();
    expect(fm.hasTree).toBe(true);

    // A group-A query (text carries "s-a" so fakeEmbed aims it at ids 1..6),
    // labelled with a group-A gold id → the semantic path should find it.
    const jsonl = `{"query":"recall something in s-a","relevant":[1]}`;
    const report = await fm.benchmark({ infer: async () => "unused", querySetJsonl: jsonl, k: 10, budgetMs: 80 });

    expect(report.n).toBe(1);
    expect(report.fractal.perQuery).toHaveLength(1);
    expect(report.fts.perQuery).toHaveLength(1);
    // Hybrid recall can never be below FTS5 (FTS5 hits are a subset of inputs).
    expect(report.fractal.meanRecallAtK).toBeGreaterThanOrEqual(report.fts.meanRecallAtK);
    expect(typeof report.verdict.ship).toBe("boolean");
  });
});
