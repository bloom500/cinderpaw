/**
 * RSI engine stagnation event — Pathway 4 PR-A Task A.2.
 *
 * Pins the wire shape of the new "stagnation" rsi_engine_event emitted
 * when the engine has run N iterations without producing a champion
 * (default N = FERAL_RSI_STAGNATION_THRESHOLD or 10).
 *
 * What this test guards:
 *   1. No emission before the threshold.
 *   2. Exactly one emission at the threshold when no champion.
 *   3. The emitted reason reflects WHY no champion emerged
 *      (no_candidate_above_baseline | all_candidates_errored |
 *      baseline_too_strong_for_eval_suite).
 *   4. No re-emit on subsequent iterations in the same period
 *      (one per stagnation period — agent shouldn't see spam).
 *   5. Respects the FERAL_RSI_STAGNATION_THRESHOLD env override.
 *
 * The tests use a fake `send` capture and drive the engine via
 * `mirrorEngineEvents` directly — the bus plumbing and engine
 * composition are already covered by rsi-engine.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "../src/rsi/event-bus.ts";
import type { RsiEvent } from "../src/rsi/event-bus.ts";
import type { OutboundEvent } from "../src/types.ts";
import { mirrorEngineEvents } from "../src/rsi/sidecar.ts";

function makeFakeSend(): { send: (e: OutboundEvent) => void; sent: OutboundEvent[] } {
  const sent: OutboundEvent[] = [];
  return { sent, send: (e) => sent.push(e) };
}

function fire(bus: EventBus, ev: RsiEvent): Promise<void> {
  return bus.emit(ev);
}

const baseGenome = "g1";

describe("mirrorEngineEvents — stagnation detection", () => {
  let prevThreshold: string | undefined;
  beforeEach(() => {
    prevThreshold = process.env.FERAL_RSI_STAGNATION_THRESHOLD;
    delete process.env.FERAL_RSI_STAGNATION_THRESHOLD;
  });
  afterEach(() => {
    if (prevThreshold === undefined) {
      delete process.env.FERAL_RSI_STAGNATION_THRESHOLD;
    } else {
      process.env.FERAL_RSI_STAGNATION_THRESHOLD = prevThreshold;
    }
  });

  test("does not emit stagnation before the threshold (default 10)", async () => {
    const bus = new EventBus();
    const { send, sent } = makeFakeSend();
    const detach = mirrorEngineEvents(bus, send);

    // Drive 9 iterations: 9 EvalComplete events, none advances the ratchet.
    for (let i = 0; i < 9; i++) {
      await fire(bus, {
        type: "EvalComplete",
        genomeId: baseGenome,
        score: 50,
        tokenCost: 100,
        durationMs: 100,
        errored: false,
      });
    }

    const stagnations = sent.filter(
      (e) => e.type === "rsi_engine_event" && (e as any).event === "stagnation",
    );
    expect(stagnations).toHaveLength(0);
    detach();
  });

  test("emits stagnation at iteration 10 with reason 'no_candidate_above_baseline'", async () => {
    const bus = new EventBus();
    const { send, sent } = makeFakeSend();
    const detach = mirrorEngineEvents(bus, send);

    // 11 iterations, no RatchetAdvanced.
    for (let i = 0; i < 11; i++) {
      await fire(bus, {
        type: "EvalComplete",
        genomeId: baseGenome,
        score: 50,
        tokenCost: 100,
        durationMs: 100,
        errored: false,
      });
    }

    const stagnations = sent.filter(
      (e) => e.type === "rsi_engine_event" && (e as any).event === "stagnation",
    );
    expect(stagnations).toHaveLength(1);
    const ev = stagnations[0] as any;
    expect(ev.iteration).toBe(10);
    expect(ev.reason).toBe("no_candidate_above_baseline");
    detach();
  });

  test("emits stagnation with reason 'all_candidates_errored' when every candidate errored", async () => {
    const bus = new EventBus();
    const { send, sent } = makeFakeSend();
    const detach = mirrorEngineEvents(bus, send);

    for (let i = 0; i < 11; i++) {
      await fire(bus, {
        type: "EvalComplete",
        genomeId: baseGenome,
        score: 0,
        tokenCost: 100,
        durationMs: 100,
        errored: true,
      });
    }

    const stagnations = sent.filter(
      (e) => e.type === "rsi_engine_event" && (e as any).event === "stagnation",
    );
    expect(stagnations).toHaveLength(1);
    expect((stagnations[0] as any).reason).toBe("all_candidates_errored");
    detach();
  });

  test("does not re-emit stagnation on subsequent iterations in the same period", async () => {
    const bus = new EventBus();
    const { send, sent } = makeFakeSend();
    const detach = mirrorEngineEvents(bus, send);

    // 25 iterations with no champion — exactly one stagnation event.
    for (let i = 0; i < 25; i++) {
      await fire(bus, {
        type: "EvalComplete",
        genomeId: baseGenome,
        score: 50,
        tokenCost: 100,
        durationMs: 100,
        errored: false,
      });
    }

    const stagnations = sent.filter(
      (e) => e.type === "rsi_engine_event" && (e as any).event === "stagnation",
    );
    expect(stagnations).toHaveLength(1);
    detach();
  });

  test("resets the stagnation counter on RatchetAdvanced", async () => {
    const bus = new EventBus();
    const { send, sent } = makeFakeSend();
    const detach = mirrorEngineEvents(bus, send);

    // 9 iterations, no ratchet → no stagnation yet.
    for (let i = 0; i < 9; i++) {
      await fire(bus, {
        type: "EvalComplete",
        genomeId: baseGenome,
        score: 50,
        tokenCost: 100,
        durationMs: 100,
        errored: false,
      });
    }
    // Ratchet advances — counter resets.
    await fire(bus, {
      type: "RatchetAdvanced",
      genomeId: baseGenome,
      commitHash: "x".repeat(40),
      score: 60,
      previousBest: 50,
    });
    // Another 9 iterations with no further ratchet → no stagnation.
    for (let i = 0; i < 9; i++) {
      await fire(bus, {
        type: "EvalComplete",
        genomeId: baseGenome,
        score: 60,
        tokenCost: 100,
        durationMs: 100,
        errored: false,
      });
    }

    const stagnations = sent.filter(
      (e) => e.type === "rsi_engine_event" && (e as any).event === "stagnation",
    );
    expect(stagnations).toHaveLength(0);
    detach();
  });

  test("respects FERAL_RSI_STAGNATION_THRESHOLD env override (set to 3)", async () => {
    process.env.FERAL_RSI_STAGNATION_THRESHOLD = "3";
    const bus = new EventBus();
    const { send, sent } = makeFakeSend();
    const detach = mirrorEngineEvents(bus, send);

    // 3 iterations with no ratchet — stagnation fires at the 3rd crossing.
    for (let i = 0; i < 3; i++) {
      await fire(bus, {
        type: "EvalComplete",
        genomeId: baseGenome,
        score: 50,
        tokenCost: 100,
        durationMs: 100,
        errored: false,
      });
    }

    const stagnations = sent.filter(
      (e) => e.type === "rsi_engine_event" && (e as any).event === "stagnation",
    );
    expect(stagnations).toHaveLength(1);
    expect((stagnations[0] as any).iteration).toBe(3);
    detach();
  });
});
