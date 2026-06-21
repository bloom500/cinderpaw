/**
 * Benchmark metrics core — the pure measurement layer of the Fractal Memory
 * Search benchmark gate. These functions decide whether the RAPTOR hybrid is
 * allowed to ship: `recallAtK` measures retrieval quality, `percentile`
 * measures tail latency, and `verdict` encodes the spec's ship rule
 * (fractal recall@10 >= FTS5 recall@10 AND p99 < 80 ms).
 *
 * Everything here is pure with fixed inputs and exact expected outputs — no
 * model, no DB, no clock. The integration entrypoint runs on Darius's machine;
 * the *correctness of the measurement* is pinned here.
 */
import { describe, it, expect } from "bun:test";
import { recallAtK, percentile, verdict } from "../src/memory/fractal/bench/metrics.ts";

describe("recallAtK", () => {
  it("is 1 when the single relevant id is in the top-k", () => {
    expect(recallAtK([7, 3, 9], new Set([3]), 3)).toBe(1);
  });

  it("is 0 when the relevant id is absent from the top-k", () => {
    expect(recallAtK([7, 3, 9], new Set([42]), 3)).toBe(0);
  });

  it("only counts hits within the first k of the ranked list", () => {
    // relevant id 9 sits at rank 3 (index 2); k=2 must not see it.
    expect(recallAtK([7, 3, 9], new Set([9]), 2)).toBe(0);
    expect(recallAtK([7, 3, 9], new Set([9]), 3)).toBe(1);
  });

  it("returns the fraction of relevant ids found when there are several", () => {
    // relevant {3, 9, 99}; top-4 contains 3 and 9 → 2/3.
    expect(recallAtK([7, 3, 1, 9], new Set([3, 9, 99]), 4)).toBeCloseTo(2 / 3, 6);
  });

  it("does not double-count a relevant id that appears twice", () => {
    expect(recallAtK([3, 3, 7], new Set([3]), 3)).toBe(1);
  });

  it("is 0 (not NaN) when there are no relevant ids", () => {
    expect(recallAtK([7, 3, 9], new Set<number>(), 3)).toBe(0);
  });
});

describe("percentile", () => {
  it("returns the max at p100 and min at p0", () => {
    const s = [5, 1, 3, 2, 4];
    expect(percentile(s, 100)).toBe(5);
    expect(percentile(s, 0)).toBe(1);
  });

  it("returns the median at p50 (nearest-rank, odd count)", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });

  it("computes p99 over a 100-sample ramp", () => {
    // values 1..100; nearest-rank p99 → the 99th value = 99.
    const ramp = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(ramp, 99)).toBe(99);
  });

  it("is order-independent", () => {
    expect(percentile([40, 10, 50, 30, 20], 50)).toBe(
      percentile([10, 20, 30, 40, 50], 50),
    );
  });

  it("throws on an empty sample set (a percentile of nothing is undefined)", () => {
    expect(() => percentile([], 50)).toThrow();
  });
});

describe("verdict", () => {
  it("ships when fractal recall ties FTS5 and p99 is under the budget", () => {
    const v = verdict({ fractalRecall: 0.8, ftsRecall: 0.8, fractalP99Ms: 50, budgetMs: 80 });
    expect(v.ship).toBe(true);
    expect(v.reasons.length).toBe(0);
  });

  it("ships when fractal recall beats FTS5 within budget", () => {
    const v = verdict({ fractalRecall: 0.9, ftsRecall: 0.8, fractalP99Ms: 79, budgetMs: 80 });
    expect(v.ship).toBe(true);
  });

  it("blocks when fractal recall regresses below FTS5", () => {
    const v = verdict({ fractalRecall: 0.7, ftsRecall: 0.8, fractalP99Ms: 40, budgetMs: 80 });
    expect(v.ship).toBe(false);
    expect(v.reasons.some((r) => /recall/i.test(r))).toBe(true);
  });

  it("blocks when p99 latency exceeds the budget even if recall wins", () => {
    const v = verdict({ fractalRecall: 0.95, ftsRecall: 0.8, fractalP99Ms: 120, budgetMs: 80 });
    expect(v.ship).toBe(false);
    expect(v.reasons.some((r) => /latency|p99/i.test(r))).toBe(true);
  });

  it("reports both failures when recall regresses AND latency blows the budget", () => {
    const v = verdict({ fractalRecall: 0.5, ftsRecall: 0.8, fractalP99Ms: 200, budgetMs: 80 });
    expect(v.ship).toBe(false);
    expect(v.reasons.length).toBe(2);
  });
});
