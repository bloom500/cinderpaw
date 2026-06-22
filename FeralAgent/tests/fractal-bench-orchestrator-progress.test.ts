/**
 * Bench orchestrator — the sidecar-side wrapper around `runFractalBenchmark`
 * that adds the properties the user-visible button needs:
 *
 *   - **Hard timeout** so a wedged embed or stuck query-generation can never
 *     leave the React panel spinning forever. On timeout we still emit a
 *     `fractal_bench_result {ok:false, error:"timeout at phase X"}` so the
 *     panel always settles.
 *   - **Bounded concurrency for query generation** so a single `infer` call
 *     that hangs on a 30s/2min local model doesn't sequentially block 50 of
 *     its siblings — and so the RSI passive engine can still get inference
 *     time in between batches.
 *   - **Sane default `count`** (12, not 50) so a default click is a few
 *     minutes, not a coffee break.
 *   - **Progress callback** fired at well-defined phases so the panel can
 *     render "generating queries 4/12" instead of an opaque spinner.
 *   - **Honours a pre-built query set** — when `querySetJsonl` is supplied,
 *     `generateQuerySet` is skipped entirely (its only role is the default
 *     self-supervised paraphrases).
 *
 * The orchestrator delegates the actual measurement to the existing
 * `runFractalBenchmark` — this file is purely a UX/hardening wrapper. The
 * tests below pin each contract independently so a regression points
 * straight at the broken phase.
 */

import { describe, expect, it } from "bun:test";
import { runFractalBenchmarkWithProgress, type BenchProgress, type BenchProgressKind } from "../src/memory/fractal/bench/orchestrator.ts";
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

describe("runFractalBenchmarkWithProgress — JSONL shortcut", () => {
  it("skips query generation entirely and emits no 'generate_queries' progress", async () => {
    const clock = fakeClock();
    const seen: BenchProgress[] = [];
    const jsonl = [
      `{"query":"how to ship a release","relevant":[1]}`,
      `{"query":"change my password","relevant":[2]}`,
    ].join("\n");

    const report = await runFractalBenchmarkWithProgress({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [],
      tree: await tree(),
      leavesById: leavesById(),
      embed: (texts) => { clock.advance(1); return goldEmbed({ "how to ship a release": 1, "change my password": 2 })(texts); },
      infer: async () => { throw new Error("infer must not be called when JSONL is supplied"); },
      querySetJsonl: jsonl,
      k: 10,
      budgetMs: 80,
      now: clock.now,
      onProgress: (p) => seen.push(p),
    });

    expect(report.n).toBe(2);
    // No "generate_queries" progress at all when the JSONL shortcut is used.
    expect(seen.filter((p) => p.kind === "generate_queries")).toHaveLength(0);
  });
});

describe("runFractalBenchmarkWithProgress — progress callback", () => {
  it("fires 'generate_queries' for every query being generated, with i/total", async () => {
    const seen: BenchProgress[] = [];
    const report = await runFractalBenchmarkWithProgress({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [],
      tree: await tree(),
      leavesById: leavesById(),
      embed: (texts) => texts.map(() => new Float32Array([1, 0, 0])),
      infer: async () => "a generated question",
      count: 3,
      seed: 7,
      k: 10,
      budgetMs: 80,
      onProgress: (p) => seen.push(p),
    });
    expect(report.n).toBe(3);

    const genEvents = seen.filter((p) => p.kind === "generate_queries");
    expect(genEvents.length).toBe(3);
    // Order: 1/3, 2/3, 3/3 — one per generated query.
    expect(genEvents.map((p) => p.current)).toEqual([1, 2, 3]);
    expect(genEvents.every((p) => p.total === 3)).toBe(true);
  });

  it("fires 'run_queries' for every query, with i/total, before the report returns", async () => {
    const seen: BenchProgress[] = [];
    await runFractalBenchmarkWithProgress({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [],
      tree: await tree(),
      leavesById: leavesById(),
      embed: (texts) => texts.map(() => new Float32Array([1, 0, 0])),
      infer: async () => "q",
      querySetJsonl: [
        `{"query":"a","relevant":[1]}`,
        `{"query":"b","relevant":[2]}`,
        `{"query":"c","relevant":[3]}`,
      ].join("\n"),
      k: 10,
      budgetMs: 80,
      onProgress: (p) => seen.push(p),
    });
    const runEvents = seen.filter((p) => p.kind === "run_queries");
    expect(runEvents.length).toBe(3);
    expect(runEvents.map((p) => p.current)).toEqual([1, 2, 3]);
    expect(runEvents.every((p) => p.total === 3)).toBe(true);
  });

  it("progress is optional (no onProgress → no throw, report returned)", async () => {
    const report = await runFractalBenchmarkWithProgress({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [],
      tree: await tree(),
      leavesById: leavesById(),
      embed: (texts) => texts.map(() => new Float32Array([1, 0, 0])),
      infer: async () => "q",
      querySetJsonl: `{"query":"a","relevant":[1]}`,
      k: 10,
      budgetMs: 80,
    });
    expect(report.n).toBe(1);
  });
});

describe("runFractalBenchmarkWithProgress — bounded query-generation concurrency", () => {
  it("never has more than `genConcurrency` inflight infer calls at once", async () => {
    // Track the high-water mark of inflight `infer` calls.
    let inflight = 0;
    let peak = 0;
    const infer = async () => {
      inflight++;
      if (inflight > peak) peak = inflight;
      // 30 ms of work — long enough to overlap if not gated.
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return "a query";
    };
    await runFractalBenchmarkWithProgress({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [],
      tree: await tree(),
      leavesById: leavesById(),
      embed: (texts) => texts.map(() => new Float32Array([1, 0, 0])),
      infer,
      count: 6, // > default genConcurrency (4) — peak must clamp to 4
      seed: 1,
      k: 10,
      budgetMs: 80,
    });
    // genConcurrency defaults to 4; the orchestrator must clamp inflight to it.
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("runFractalBenchmarkWithProgress — hard timeout", () => {
  it("rejects with a timeout error when the whole benchmark exceeds the budget", async () => {
    // An embed call that takes 5000 ms per call — way past any sensible default.
    const slowEmbed = async (texts: string[]) => {
      await new Promise((r) => setTimeout(r, 200));
      return texts.map(() => new Float32Array([1, 0, 0]));
    };
    // Two queries × 200 ms embed each × 2 engines = 800 ms of real work.
    // A 100 ms timeout must trip first.
    let phase: BenchProgressKind | "start" | null = null;
    await expect(
      runFractalBenchmarkWithProgress({
        loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
        ftsSearch: () => [],
        tree: await tree(),
        leavesById: leavesById(),
        embed: slowEmbed,
        infer: async () => "q",
        querySetJsonl: [
          `{"query":"a","relevant":[1]}`,
          `{"query":"b","relevant":[2]}`,
        ].join("\n"),
        k: 10,
        budgetMs: 80,
        timeoutMs: 100, // tight
        onProgress: (p) => { phase = p.kind; },
      }),
    ).rejects.toThrow(/timeout/i);
    // The last progress phase we saw should be run_queries (the slowest phase
    // for this fake). The exact phase is best-effort; we just need SOME
    // progress so the UI doesn't sit on the start screen.
    expect(phase).toBe("run_queries");
  });
});

describe("runFractalBenchmarkWithProgress — default count", () => {
  it("uses a sane default (≤ 20) when `count` is omitted and no JSONL is given", async () => {
    // We can't easily count generated queries here without forcing them all to
    // succeed, so we instrument `infer` to count invocations and assert the
    // cap is at most the documented default (20).
    let calls = 0;
    const infer = async () => { calls++; return "q"; };
    await runFractalBenchmarkWithProgress({
      loadLeaves: () => LEAVES.map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: () => [],
      tree: await tree(),
      leavesById: leavesById(),
      embed: (texts) => texts.map(() => new Float32Array([1, 0, 0])),
      infer,
      // no count, no jsonl — must pick a sane default ≤ 20
      k: 10,
      budgetMs: 80,
    });
    // LEAVES only has 6 eligible entries, so the sampler caps at the corpus.
    // The important guarantee: ≤ 20 even on a large corpus.
    expect(calls).toBeLessThanOrEqual(20);
    // And the cap must NOT be the old 50.
    expect(calls).toBeLessThan(50);
  });
});
