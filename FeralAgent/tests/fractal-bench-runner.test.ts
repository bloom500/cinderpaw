/**
 * Benchmark runner — drives a query set through both retrieval engines, times
 * each call against an injected clock, and aggregates recall@k + latency
 * percentiles into the ship/no-ship report.
 *
 * Both retrievers and the clock are injected, so the runner is tested with
 * fakes — no model, no DB, no wall-clock flakiness. A fake retriever advances
 * the shared clock by a fixed amount to model "this call took N ms".
 */
import { describe, it, expect } from "bun:test";
import { runBenchmark, type BenchQuery } from "../src/memory/fractal/bench/runner.ts";

/** A clock whose `now` reads a mutable counter; retrievers bump it to model
 *  elapsed time deterministically. */
function fakeClock() {
  const state = { t: 0 };
  return {
    now: () => state.t,
    advance: (ms: number) => { state.t += ms; },
  };
}

const Q = (query: string, relevant: number[]): BenchQuery => ({ query, relevant: new Set(relevant) });

describe("runBenchmark", () => {
  it("computes mean recall@k per engine over the query set", async () => {
    const clock = fakeClock();
    // Two queries. FTS finds the gold doc for q1 but not q2 (0.5 mean).
    // Fractal finds it for both (1.0 mean).
    const queries = [Q("q1", [10]), Q("q2", [20])];
    const fts = async (q: string) => { clock.advance(1); return q === "q1" ? [10, 1, 2] : [99, 98, 97]; };
    const fractal = async (q: string) => { clock.advance(1); return q === "q1" ? [10] : [20]; };

    const report = await runBenchmark({ queries, fts, fractal, k: 10, budgetMs: 80, now: clock.now });

    expect(report.fts.meanRecallAtK).toBeCloseTo(0.5, 6);
    expect(report.fractal.meanRecallAtK).toBeCloseTo(1.0, 6);
    expect(report.n).toBe(2);
    expect(report.k).toBe(10);
  });

  it("times each engine call against the injected clock", async () => {
    const clock = fakeClock();
    const queries = [Q("a", [1]), Q("b", [2]), Q("c", [3])];
    // FTS takes 5ms/call, fractal takes 20ms/call.
    const fts = async () => { clock.advance(5); return [1, 2, 3]; };
    const fractal = async () => { clock.advance(20); return [1, 2, 3]; };

    const report = await runBenchmark({ queries, fts, fractal, k: 10, budgetMs: 80, now: clock.now });

    // Every fts sample is 5ms → p50 = p99 = 5; fractal → 20.
    expect(report.fts.p50Ms).toBe(5);
    expect(report.fts.p99Ms).toBe(5);
    expect(report.fractal.p50Ms).toBe(20);
    expect(report.fractal.p99Ms).toBe(20);
  });

  it("ships when fractal recall ties/wins and fractal p99 is under budget", async () => {
    const clock = fakeClock();
    const queries = [Q("a", [1]), Q("b", [2])];
    const fts = async () => { clock.advance(2); return [1, 2]; };       // recall 1.0
    const fractal = async () => { clock.advance(10); return [1, 2]; };  // recall 1.0, p99 10 < 80

    const report = await runBenchmark({ queries, fts, fractal, k: 10, budgetMs: 80, now: clock.now });

    expect(report.verdict.ship).toBe(true);
  });

  it("blocks (and explains) when fractal p99 blows the budget", async () => {
    const clock = fakeClock();
    const queries = [Q("a", [1])];
    const fts = async () => { clock.advance(2); return [1]; };
    const fractal = async () => { clock.advance(200); return [1]; };  // p99 = 200 >= 80

    const report = await runBenchmark({ queries, fts, fractal, k: 10, budgetMs: 80, now: clock.now });

    expect(report.verdict.ship).toBe(false);
    expect(report.verdict.reasons.join(" ")).toMatch(/latency|p99/i);
  });

  it("retains per-query records for drill-down (recall + ms per query)", async () => {
    const clock = fakeClock();
    const queries = [Q("hit", [1]), Q("miss", [42])];
    const fractal = async (q: string) => { clock.advance(3); return q === "hit" ? [1] : [7]; };
    const fts = async () => { clock.advance(1); return [1]; };

    const report = await runBenchmark({ queries, fts, fractal, k: 10, budgetMs: 80, now: clock.now });

    expect(report.fractal.perQuery).toHaveLength(2);
    expect(report.fractal.perQuery[0]).toMatchObject({ query: "hit", recall: 1, ms: 3 });
    expect(report.fractal.perQuery[1]).toMatchObject({ query: "miss", recall: 0, ms: 3 });
  });

  it("throws on an empty query set (nothing to measure)", async () => {
    const clock = fakeClock();
    await expect(
      runBenchmark({ queries: [], fts: async () => [], fractal: async () => [], k: 10, budgetMs: 80, now: clock.now }),
    ).rejects.toThrow();
  });
});
