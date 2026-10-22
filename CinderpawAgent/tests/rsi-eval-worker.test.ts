/**
 * Faza 1 — Async RSI Engine: the eval worker.
 *
 * An independent async task: given a genome, it emits EvalStarted, runs
 * the eval suite (injected — later the real agent loop over Tier 0/1/2),
 * scores the outcomes via the Rust scorer (injected — later protocol (a)
 * to rsi_score), and emits EvalComplete carrying the composite score,
 * the behavioral fingerprint (per-task scores), and the resource cost.
 *
 * The scorer lives in Rust and is never trusted to the sidecar; here it
 * is a dependency so the worker is unit-testable before the bridge
 * (Faza 1 piece 7) exists.
 */

import { describe, expect, test } from "bun:test";
import { EventBus, type RsiEvent } from "../src/rsi/infra/event-bus.ts";
import { EvalWorker, type EvalOutcome } from "../src/rsi/infra/eval-worker.ts";
import { RsiRunAbortedError } from "../src/rsi/infra/run-eval.ts";

const GENOME = { id: "g1", generation: 0, lineage: [] };

describe("RSI eval worker", () => {
  test("run() emits EvalStarted then EvalComplete with the scored result", async () => {
    const bus = new EventBus();
    const events: RsiEvent[] = [];
    bus.on("EvalStarted", async (e) => events.push(e));
    bus.on("EvalComplete", async (e) => events.push(e));

    const outcomes: EvalOutcome[] = [
      { taskId: "tier0/json", tier: 0, success: true, latencyMs: 100, tokens: 50, errored: false },
      { taskId: "tier0/paris", tier: 0, success: false, latencyMs: 200, tokens: 60, errored: false },
    ];
    const worker = new EvalWorker(bus, {
      runEval: async () => outcomes,
      scoreGenome: async () => ({ score: 73.4 }),
    });

    await worker.run(GENOME);

    expect(events.map((e) => e.type)).toEqual(["EvalStarted", "EvalComplete"]);
    const done = events[1] as RsiEvent & {
      genomeId: string;
      score: number;
      behavioralFingerprint: number[];
      tokenCost: number;
    };
    expect(done.genomeId).toBe("g1");
    expect(done.score).toBe(73.4);
    // Per-task fingerprint: success → 1, failure → 0.
    expect(done.behavioralFingerprint).toEqual([1, 0]);
    expect(done.tokenCost).toBe(110); // 50 + 60
  });

  test("a failing eval still emits EvalComplete so the engine never hangs", async () => {
    const bus = new EventBus();
    const events: RsiEvent[] = [];
    bus.on("EvalStarted", async (e) => events.push(e));
    bus.on("EvalComplete", async (e) => events.push(e));

    const worker = new EvalWorker(bus, {
      runEval: async () => {
        throw new Error("agent crashed mid-eval");
      },
      scoreGenome: async () => ({ score: 99 }),
    });

    // Must not throw — the worker absorbs the failure.
    await worker.run(GENOME);

    expect(events.map((e) => e.type)).toEqual(["EvalStarted", "EvalComplete"]);
    const done = events[1] as RsiEvent & {
      errored: boolean;
      score: number;
      error: string;
      behavioralFingerprint: number[];
    };
    expect(done.errored).toBe(true);
    expect(done.score).toBe(0); // a crashed eval scores 0, never the scorer's value
    expect(done.error).toContain("agent crashed");
    expect(done.behavioralFingerprint).toEqual([]);
  });

  test("a deliberately aborted run does not emit a fake zero-score EvalComplete", async () => {
    const bus = new EventBus();
    const events: RsiEvent[] = [];
    bus.on("EvalStarted", (e) => events.push(e));
    bus.on("EvalComplete", (e) => events.push(e));
    const worker = new EvalWorker(bus, {
      runEval: async () => { throw new RsiRunAbortedError("UserStopped"); },
      scoreGenome: async () => ({ score: 99 }),
    });

    await expect(worker.run(GENOME)).rejects.toBeInstanceOf(RsiRunAbortedError);
    expect(events.map((e) => e.type)).toEqual(["EvalStarted"]);
  });
});
