/**
 * BRSI §2.7 — the confidence gate wired into the ratchet handler.
 *
 * INVARIANT I6 (confidence gate precedence): a candidate is only offered
 * to `ratchetAttempt` if it clears the gate against the current champion.
 * A noisy +ε that Rust's strict-greater would accept must be blocked here
 * when the paired evidence is not significant.
 *
 * These tests exercise the wiring, not the bootstrap math (that lives in
 * `rsi-confidence.test.ts`): the gate is stubbed so the accept/reject
 * decision is explicit, and we assert whether `ratchetAttempt` fires.
 */

import { describe, expect, test } from "bun:test";
import { EventBus, type RsiEvent } from "../src/rsi/event-bus.ts";
import type { EvalOutcome } from "../src/rsi/eval-worker.ts";
import {
  RatchetHandler,
  buildPairedSamples,
} from "../src/rsi/ratchet-handler.ts";
import type { GateDecision } from "../src/rsi/confidence.ts";

function outcome(taskId: string, success: boolean): EvalOutcome {
  return { taskId, tier: 0, success, latencyMs: 1, tokens: 1, errored: false };
}

/** A fixed set of per-task outcomes; every eval in these tests uses the
 *  same task ids so the pairing lines up. */
function outcomes(successes: boolean[]): EvalOutcome[] {
  return successes.map((s, i) => outcome(`t${i}`, s));
}

const ACCEPT: GateDecision = {
  accept: true,
  reason: "stub accept",
  bootstrap: { mean: 1, ciLower: 0, ciUpper: 1, pValue: 0, effectSize: 1 },
};
const REJECT: GateDecision = {
  accept: false,
  reason: "stub reject",
  bootstrap: { mean: 0, ciLower: 0, ciUpper: 0, pValue: 1, effectSize: 0 },
};

describe("RSI ratchet handler + confidence gate", () => {
  test("first candidate bypasses the gate (no champion baseline yet)", async () => {
    const bus = new EventBus();
    let gateCalls = 0;
    let attempts = 0;

    new RatchetHandler(bus, {
      commitGenome: async () => ({ commitHash: "a".repeat(40) }),
      ratchetAttempt: async () => {
        attempts += 1;
        return { advanced: true, previousBest: 0 };
      },
      evaluateGate: () => {
        gateCalls += 1;
        return REJECT; // even a reject stub must not be consulted here
      },
    });

    await bus.emit({
      type: "EvalComplete",
      genomeId: "g1",
      score: 70,
      outcomes: outcomes([true, true, true]),
      errored: false,
    });

    expect(gateCalls).toBe(0); // no baseline → gate skipped
    expect(attempts).toBe(1); // Rust strict-greater decides the first one
  });

  test("a candidate that fails the gate is committed but never ratcheted", async () => {
    const bus = new EventBus();
    const advanced: RsiEvent[] = [];
    bus.on("RatchetAdvanced", async (e) => advanced.push(e));

    let commits = 0;
    let attempts = 0;

    new RatchetHandler(bus, {
      commitGenome: async () => {
        commits += 1;
        return { commitHash: "b".repeat(40) };
      },
      ratchetAttempt: async () => {
        attempts += 1;
        return { advanced: true, previousBest: 0 };
      },
      evaluateGate: () => (commits <= 1 ? ACCEPT : REJECT),
    });

    // First candidate: no baseline → bypasses gate → advances, becomes champion.
    await bus.emit({
      type: "EvalComplete",
      genomeId: "champ",
      score: 60,
      outcomes: outcomes([true, false, true, true]),
      errored: false,
    });
    // Second candidate: gate stub now returns REJECT.
    await bus.emit({
      type: "EvalComplete",
      genomeId: "noisy",
      score: 61,
      outcomes: outcomes([true, true, true, true]),
      errored: false,
    });

    expect(commits).toBe(2); // both candidates recorded on their branches
    expect(attempts).toBe(1); // only the champion reached ratchetAttempt
    expect(advanced.length).toBe(1);
    expect((advanced[0] as { genomeId: string }).genomeId).toBe("champ");
  });

  test("a gate rejection emits ConfidenceFailed with a reason (ADR-0012)", async () => {
    const bus = new EventBus();
    const failed: RsiEvent[] = [];
    bus.on("ConfidenceFailed", async (e) => failed.push(e));

    let commits = 0;
    new RatchetHandler(bus, {
      commitGenome: async () => {
        commits += 1;
        return { commitHash: "e".repeat(40) };
      },
      ratchetAttempt: async () => ({ advanced: true, previousBest: 0 }),
      evaluateGate: () => (commits <= 1 ? ACCEPT : REJECT),
    });

    await bus.emit({
      type: "EvalComplete",
      genomeId: "champ",
      score: 60,
      outcomes: outcomes([true, true, true]),
      errored: false,
    });
    await bus.emit({
      type: "EvalComplete",
      genomeId: "noisy",
      score: 61,
      outcomes: outcomes([true, true, true]),
      errored: false,
    });

    expect(failed.length).toBe(1);
    expect((failed[0] as { genomeId: string }).genomeId).toBe("noisy");
    expect((failed[0] as { reason: string }).reason).toBe("stub reject");
  });

  test("a candidate that clears the gate is ratcheted", async () => {
    const bus = new EventBus();
    const advanced: RsiEvent[] = [];
    bus.on("RatchetAdvanced", async (e) => advanced.push(e));

    let attempts = 0;
    new RatchetHandler(bus, {
      commitGenome: async () => ({ commitHash: "c".repeat(40) }),
      ratchetAttempt: async () => {
        attempts += 1;
        return { advanced: true, previousBest: 0 };
      },
      evaluateGate: () => ACCEPT,
    });

    await bus.emit({
      type: "EvalComplete",
      genomeId: "champ",
      score: 60,
      outcomes: outcomes([true, true, true]),
      errored: false,
    });
    await bus.emit({
      type: "EvalComplete",
      genomeId: "better",
      score: 80,
      outcomes: outcomes([true, true, true]),
      errored: false,
    });

    expect(attempts).toBe(2); // both cleared: bootstrap + gate-accepted
    expect(advanced.length).toBe(2);
  });

  test("without a gate dep the handler behaves exactly as Faza 1", async () => {
    const bus = new EventBus();
    const advanced: RsiEvent[] = [];
    bus.on("RatchetAdvanced", async (e) => advanced.push(e));

    let attempts = 0;
    new RatchetHandler(bus, {
      commitGenome: async () => ({ commitHash: "d".repeat(40) }),
      ratchetAttempt: async () => {
        attempts += 1;
        return { advanced: true, previousBest: 0 };
      },
    });

    for (const id of ["g1", "g2", "g3"]) {
      await bus.emit({
        type: "EvalComplete",
        genomeId: id,
        score: 70,
        outcomes: outcomes([true, false]),
        errored: false,
      });
    }

    expect(attempts).toBe(3); // no gate → every candidate reaches ratchet
    expect(advanced.length).toBe(3);
  });
});

describe("buildPairedSamples", () => {
  test("pairs by taskId with per-task binary scores", () => {
    const cand = [outcome("a", true), outcome("b", false), outcome("c", true)];
    const base = [outcome("a", false), outcome("b", false), outcome("c", true)];
    expect(buildPairedSamples(cand, base)).toEqual([
      { candidate: 1, baseline: 0 },
      { candidate: 0, baseline: 0 },
      { candidate: 1, baseline: 1 },
    ]);
  });

  test("drops tasks that are not present in both sets", () => {
    const cand = [outcome("a", true), outcome("only-cand", true)];
    const base = [outcome("a", false), outcome("only-base", true)];
    expect(buildPairedSamples(cand, base)).toEqual([{ candidate: 1, baseline: 0 }]);
  });
});
