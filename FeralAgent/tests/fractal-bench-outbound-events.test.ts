/**
 * Type-level + runtime contract for the PROVISIONAL `fractal_bench_*`
 * outbound events the sidecar emits in response to a `fractal_benchmark`
 * inbound message.
 *
 * Two event types exist:
 *   - `fractal_bench_progress` — periodic status while the bench is
 *     running. The panel reads `message` to show "generating queries 4/12"
 *     and `kind` to know which phase is active.
 *   - `fractal_bench_result` — exactly ONE of these per click, with
 *     `ok:false` on any error path (timeout, throw, missing tree) and
 *     `ok:true` on a normal report.
 *
 * The runtime test here pins the `kind` enum and the `message` field, so
 * the FE listener can rely on the contract. The type-level checks below
 * are enforced by `OutboundEvent` in `src/types.ts` — drift there is a
 * compile error, not a silent FE hang.
 */

import { describe, expect, it } from "bun:test";
import type { OutboundEvent } from "../src/types.ts";

/** Local mirror of the event shape — kept narrow so the FE can import
 *  these without a circular dep on the sidecar internals. */
type BenchProgressEvent = Extract<OutboundEvent, { type: "fractal_bench_progress" }>;
type BenchResultEvent = Extract<OutboundEvent, { type: "fractal_bench_result" }>;

describe("fractal_bench_progress event shape", () => {
  it("carries kind, current, total, message", () => {
    const ev: BenchProgressEvent = {
      type: "fractal_bench_progress",
      kind: "generate_queries",
      current: 4,
      total: 12,
      message: "Generating queries 4/12",
    };
    expect(ev.kind === "generate_queries" || ev.kind === "run_queries").toBe(true);
    expect(ev.current).toBe(4);
    expect(ev.total).toBe(12);
    expect(typeof ev.message).toBe("string");
  });
});

describe("fractal_bench_result event shape", () => {
  it("ok:false carries an error string", () => {
    const ev: BenchResultEvent = {
      type: "fractal_bench_result",
      ok: false,
      error: "no tree built yet",
    };
    expect(ev.ok).toBe(false);
    expect(typeof ev.error).toBe("string");
  });

  it("ok:true carries the full report payload", () => {
    const ev: BenchResultEvent = {
      type: "fractal_bench_result",
      ok: true,
      ship: true,
      reasons: [],
      n: 12,
      k: 10,
      fractalRecall: 0.85,
      ftsRecall: 0.80,
      fractalP99Ms: 42.0,
      ftsP99Ms: 5.0,
      path: "/tmp/fractal-bench-report.json",
    };
    expect(ev.ok).toBe(true);
    expect(ev.ship).toBe(true);
    expect(ev.n).toBe(12);
  });
});

describe("OutboundEvent union — fractal bench variants are accepted", () => {
  it("accepts fractal_bench_progress", () => {
    // Compile-time check: the literal event below must be assignable to
    // OutboundEvent. The runtime cast is a no-op once the type is in the
    // union — but the test pins the literal shape too.
    const ev: OutboundEvent = {
      type: "fractal_bench_progress",
      kind: "run_queries",
      current: 1,
      total: 12,
      message: "Running queries 1/12",
    };
    expect(ev.type).toBe("fractal_bench_progress");
  });

  it("accepts fractal_bench_result ok:true", () => {
    const ev: OutboundEvent = {
      type: "fractal_bench_result",
      ok: true,
      ship: false,
      reasons: ["p99 latency over budget: 120.0ms >= 80ms"],
      n: 12,
      k: 10,
      fractalRecall: 0.9,
      ftsRecall: 0.85,
      fractalP99Ms: 120,
      ftsP99Ms: 6,
      path: "/tmp/report.json",
    };
    expect(ev.type).toBe("fractal_bench_result");
  });

  it("accepts fractal_bench_result ok:false (timeout / no tree / throw)", () => {
    const ev: OutboundEvent = {
      type: "fractal_bench_result",
      ok: false,
      error: "bench timeout after 600000ms at queries",
    };
    expect(ev.type).toBe("fractal_bench_result");
  });
});
