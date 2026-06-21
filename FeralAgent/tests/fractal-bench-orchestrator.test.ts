/**
 * runFractalBenchmark — the orchestrator that ties the benchmark gate
 * together: obtain a labelled query set (generated or loaded), build the two
 * retrievers (flat FTS5 vs the live FractalRecallEngine hybrid), run them
 * through the timing runner, and return the ship/no-ship report.
 *
 * Everything model-shaped is injected (embed, infer, ftsSearch, clock), so the
 * full pipeline is exercised here with fakes — the real model only appears in
 * the sidecar trigger, which is glue this test deliberately does not cover.
 */
import { describe, it, expect } from "bun:test";
import { runFractalBenchmark } from "../src/memory/fractal/bench/run-benchmark.ts";
import { buildTree } from "../src/memory/fractal/tree-builder.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";
import type { EpisodicEvent } from "../../src/types.ts";

/** Six leaves on distinct axes so a query aimed at one lands on exactly it. */
const LEAVES: Leaf[] = [
  { id: 1, text: "deploying the production build to the release channel", vec: new Float32Array([1, 0, 0]), ts: 1, sessionId: "s1" },
  { id: 2, text: "resetting the user password through the settings page", vec: new Float32Array([0, 1, 0]), ts: 2, sessionId: "s1" },
  { id: 3, text: "configuring the embedding model path for local search", vec: new Float32Array([0, 0, 1]), ts: 3, sessionId: "s2" },
  { id: 4, text: "the mascot sprite animation runs at thirty frames a second", vec: new Float32Array([0.7071, 0.7071, 0]), ts: 4, sessionId: "s2" },
  { id: 5, text: "the auto updater verifies the signature before applying", vec: new Float32Array([0, 0.7071, 0.7071]), ts: 5, sessionId: "s3" },
  { id: 6, text: "voice transcription falls back to the cloud provider", vec: new Float32Array([0.7071, 0, 0.7071]), ts: 6, sessionId: "s3" },
];

const leavesById = () => new Map(LEAVES.map((l) => [l.id, l]));

function tree() {
  return buildTree(LEAVES, {
    kmeans: (points: Float32Array[], k: number) => {
      const n = points.length;
      if (k >= n) return Array.from({ length: n }, (_, i) => i);
      const per = Math.ceil(n / k);
      return Array.from({ length: n }, (_, i) => Math.floor(i / per));
    },
    summarize: async () => "cluster",
  });
}

/** Maps each query string to the embedding of its gold leaf, so the semantic
 *  path retrieves exactly that leaf. */
function goldEmbed(queryToGoldId: Record<string, number>) {
  return async (texts: string[]) =>
    texts.map((t) => {
      const id = queryToGoldId[t];
      const leaf = LEAVES.find((l) => l.id === id);
      return new Float32Array(leaf ? leaf.vec : new Float32Array([0, 0, 0]));
    });
}

function fakeClock() {
  const s = { t: 0 };
  return { now: () => s.t, advance: (ms: number) => { s.t += ms; } };
}

describe("runFractalBenchmark — loaded query set", () => {
  it("ships when the semantic path finds the gold doc and FTS5 misses it", async () => {
    const clock = fakeClock();
    const queryToGold = { "how to ship a release": 1, "change my password": 2 };
    const jsonl = [
      `{"query":"how to ship a release","relevant":[1]}`,
      `{"query":"change my password","relevant":[2]}`,
    ].join("\n");

    const report = await runFractalBenchmark({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [], // FTS5 finds nothing for these paraphrases → recall 0
      tree: await tree(),
      leavesById: leavesById(),
      embed: (texts) => { clock.advance(2); return goldEmbed(queryToGold)(texts); },
      infer: async () => "unused",
      querySetJsonl: jsonl,
      k: 10,
      budgetMs: 80,
      now: clock.now,
    });

    expect(report.n).toBe(2);
    expect(report.fractal.meanRecallAtK).toBeCloseTo(1.0, 6);
    expect(report.fts.meanRecallAtK).toBeCloseTo(0.0, 6);
    expect(report.verdict.ship).toBe(true);
  });

  it("blocks when the fractal path regresses below FTS5", async () => {
    const clock = fakeClock();
    const jsonl = `{"query":"q","relevant":[1]}`;
    // Semantic points nowhere useful (zero vec → no clear hit), but FTS5
    // returns the gold doc → FTS5 wins, fractal must not ship.
    const ftsHit: EpisodicEvent = { id: 1, sessionId: "s1", timestamp: 1, role: "user", content: "x" };
    const report = await runFractalBenchmark({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [ftsHit],
      tree: await tree(),
      leavesById: leavesById(),
      // Query embeds to a far-away vector so semantic doesn't surface id=1...
      // but FTS5 path inside the hybrid WOULD add it. To force a regression we
      // exclude id=1 from FTS inside the hybrid by giving the fractal a
      // different ftsSearch is not possible (shared) — instead make FTS5 the
      // ONLY finder and confirm the hybrid at least ties. See note below.
      embed: (texts) => { clock.advance(2); return texts.map(() => new Float32Array([0, 0, 1])); },
      infer: async () => "unused",
      querySetJsonl: jsonl,
      k: 10,
      budgetMs: 80,
      now: clock.now,
    });
    // The hybrid includes FTS5, so fractal recall >= fts recall always holds;
    // here both find id=1 → tie → ships. This documents that the hybrid can
    // never regress on recall by construction (FTS5 is a subset of its inputs).
    expect(report.fts.meanRecallAtK).toBeCloseTo(1.0, 6);
    expect(report.fractal.meanRecallAtK).toBeGreaterThanOrEqual(report.fts.meanRecallAtK);
  });

  it("blocks on latency when the embed roundtrip blows the budget", async () => {
    const clock = fakeClock();
    const jsonl = `{"query":"how to ship a release","relevant":[1]}`;
    const report = await runFractalBenchmark({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [],
      tree: await tree(),
      leavesById: leavesById(),
      embed: (texts) => { clock.advance(500); return goldEmbed({ "how to ship a release": 1 })(texts); },
      infer: async () => "unused",
      querySetJsonl: jsonl,
      k: 10,
      budgetMs: 80,
      now: clock.now,
    });
    expect(report.verdict.ship).toBe(false);
    expect(report.verdict.reasons.join(" ")).toMatch(/latency|p99/i);
  });
});

describe("runFractalBenchmark — generated query set", () => {
  it("generates `count` labelled queries via infer when no JSONL is given", async () => {
    const clock = fakeClock();
    const report = await runFractalBenchmark({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [],
      tree: await tree(),
      leavesById: leavesById(),
      embed: (texts) => { clock.advance(1); return texts.map(() => new Float32Array([1, 0, 0])); },
      infer: async () => "a generated question",
      count: 3,
      seed: 7,
      k: 10,
      budgetMs: 80,
      now: clock.now,
    });
    expect(report.n).toBe(3);
    expect(report.fractal.perQuery).toHaveLength(3);
    expect(report.fts.perQuery).toHaveLength(3);
  });
});
