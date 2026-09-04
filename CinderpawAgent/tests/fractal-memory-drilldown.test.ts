/**
 * FractalMemory drill-down — `clusterLeaves(clusterIndex)`.
 *
 * Feeds the reactive tree's zoom-reveal + leaf card: given a top-level cluster
 * index, return its real member memories `{ leafId, text, ts }`. Same facade
 * contract as the rest: never throws, returns `[]` when there is no tree or the
 * index is out of range.
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
  const d = mkdtempSync(join(tmpdir(), "cinderpaw-drill-"));
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

function makeFm() {
  return new FractalMemory({
    loadLeaves: leaves, embed: groupEmbed(), summarize: fakeSummarize,
    ftsSearch: noFts, fallback, treePath: treePath(),
  });
}

describe("FractalMemory.clusterLeaves", () => {
  it("returns the member memories of a top-level cluster with text + ts", async () => {
    const fm = makeFm();
    await fm.rebuild();
    const all: { leafId: number; text: string; ts: number }[] = [];
    let idx = 0;
    let got = fm.clusterLeaves(idx);
    while (got.length > 0 || idx === 0) {
      if (got.length === 0) break;
      all.push(...got);
      idx++;
      got = fm.clusterLeaves(idx);
    }
    // Every memory shows up exactly once across the clusters, with text + ts.
    expect(all.map((l) => l.leafId).sort((a, b) => a - b)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
    for (const l of all) {
      expect(typeof l.text).toBe("string");
      expect(l.text.length).toBeGreaterThan(0);
      expect(typeof l.ts).toBe("number");
    }
  });

  it("returns [] when there is no tree", () => {
    const fm = makeFm();
    expect(fm.clusterLeaves(0)).toEqual([]);
  });

  it("returns [] for an out-of-range cluster index", async () => {
    const fm = makeFm();
    await fm.rebuild();
    expect(fm.clusterLeaves(9999)).toEqual([]);
  });
});
