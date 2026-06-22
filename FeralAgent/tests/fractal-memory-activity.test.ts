/**
 * FractalMemory activity events — the coupling that feeds the living organism.
 *
 * The Mandelbrot organism must be driven by Fractal Memory Search, not RSI:
 *   - a real semantic recall (tree present) → a `recall` pulse → breathing
 *   - a rebuild that grows the tree         → a `grow` pulse → filament growth
 *
 * The sidecar emits these as plain stdout lines (Rust forwards them verbatim
 * to the frontend), so here we just verify the injected `onActivity` sink
 * fires with the right payload — and, critically, that it NEVER fires on the
 * FTS5 fallback path (no tree) and never throws into recall.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FractalMemory, type RecallFallback, type FractalActivity, buildGrowActivity } from "../src/memory/fractal/fractal-memory.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";
import type { EpisodicEvent } from "../../src/types.ts";

const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function treePath(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-factiv-"));
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

function makeFm(onActivity: (a: FractalActivity) => void, embed = groupEmbed()) {
  return new FractalMemory({
    loadLeaves: leaves, embed, summarize: fakeSummarize,
    ftsSearch: noFts, fallback, treePath: treePath(), onActivity,
  });
}

describe("FractalMemory activity events", () => {
  it("emits a grow pulse with leaf/cluster counts after a successful rebuild", async () => {
    const seen: FractalActivity[] = [];
    const fm = makeFm((a) => seen.push(a));
    await fm.rebuild();
    const grow = seen.find((a) => a.kind === "grow");
    expect(grow).toBeDefined();
    expect(grow).toMatchObject({ kind: "grow", leafCount: 12 });
    expect((grow as { clusterCount: number }).clusterCount).toBeGreaterThan(0);
  });

  it("emits a recall pulse when the semantic path serves the query", async () => {
    const seen: FractalActivity[] = [];
    const fm = makeFm((a) => seen.push(a));
    await fm.rebuild();
    seen.length = 0; // ignore the grow pulse
    await fm.recall("something in s-a", "other-session");
    const recall = seen.find((a) => a.kind === "recall");
    expect(recall).toBeDefined();
    expect((recall as { hits: number }).hits).toBeGreaterThanOrEqual(0);
  });

  it("does NOT emit a recall pulse when there is no tree (FTS5 fallback)", async () => {
    const seen: FractalActivity[] = [];
    const fm = makeFm((a) => seen.push(a));
    // No rebuild → no tree → recall falls back to FTS5.
    const r = await fm.recall("q", "current");
    expect(r.context).toBe("FB");
    expect(seen.filter((a) => a.kind === "recall")).toHaveLength(0);
  });

  it("never throws into recall when the activity sink throws", async () => {
    const fm = makeFm(() => { throw new Error("sink boom"); });
    await fm.rebuild(); // grow pulse sink throws — must be swallowed
    expect(fm.hasTree).toBe(true);
    const r = await fm.recall("something in s-a", "other-session");
    // recall still returns a result despite the throwing sink.
    expect(typeof r.context).toBe("string");
  });

  it("works with no sink wired (optional dep)", async () => {
    const fm = new FractalMemory({
      loadLeaves: leaves, embed: groupEmbed(), summarize: fakeSummarize,
      ftsSearch: noFts, fallback, treePath: treePath(),
    });
    await fm.rebuild();
    const r = await fm.recall("something in s-a", "other-session");
    expect(typeof r.context).toBe("string");
  });
});

describe("buildGrowActivity", () => {
  it("emits normalized weights and one cluster point per top-level child", () => {
    const tree = {
      leafIds: [1, 2, 3, 4, 5],
      children: [
        { leafIds: [1, 2, 3], centroid: Float32Array.from([1, 0, 0]) },
        { leafIds: [4, 5], centroid: Float32Array.from([0, 1, 0]) },
      ],
    } as any;
    const a = buildGrowActivity(tree);
    expect(a.kind).toBe("grow");
    expect(a.leafCount).toBe(5);
    expect(a.clusterCount).toBe(2);
    expect(a.clusters).toHaveLength(2);
    // max leaf count (3) normalizes to weight 1.
    expect(Math.max(...a.clusters.map((c) => c.weight))).toBeCloseTo(1, 6);
    for (const c of a.clusters) {
      expect(typeof c.x).toBe("number");
      expect(typeof c.y).toBe("number");
    }
  });
});
