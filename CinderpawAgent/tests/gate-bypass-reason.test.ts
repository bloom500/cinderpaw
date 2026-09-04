/**
 * The confidence gate's bypass reason must say WHICH bypass happened.
 *
 * `gateForCandidate` skips the gate when it lacks a champion baseline or the
 * candidate's own outcomes, and writes one fixed sentence either way:
 * "no champion baseline yet (bootstrap)". Two different situations, one
 * explanation, and for one of them the explanation is false.
 *
 * A candidate whose eval CRASHED is emitted with `errored: true` and no
 * `outcomes` (eval-worker.ts). It reaches this function with a champion
 * baseline present, so the journal records "no champion baseline yet" for a
 * run that had one — and the reader who later asks "is evolution working"
 * counts a crash as a bootstrap.
 *
 * Nothing about promotion changes: the Rust ratchet is strict-greater on raw
 * score (I1), so a crashed candidate scoring 0 is declined there regardless.
 * This is about the journal telling the truth, which the very same file
 * demands of the fitness vector: "Flag ALL of it."
 */
import { describe, expect, test } from "bun:test";
import { gateForCandidate } from "../src/rsi/infra/contract-leaves.ts";
import type { EvalOutcome } from "../src/rsi/infra/eval-worker.ts";

const outcome = (taskId: string): EvalOutcome =>
  ({
    taskId,
    success: true,
    errored: false,
    tokens: 10,
    latencyMs: 5,
  }) as EvalOutcome;

describe("gateForCandidate bypass reason", () => {
  test("says 'bootstrap' only when there is genuinely no champion baseline", () => {
    const decision = gateForCandidate(
      { evaluateGate: () => ({ accept: false, reason: "gate ran", bootstrap: null as never }) },
      { score: 0.5 } as never,
    )([]);

    expect(decision.accept).toBe(true);
    expect(decision.reason).toContain("no champion baseline");
  });

  test("does NOT claim 'bootstrap' when a champion exists and the eval crashed", () => {
    // Champion baseline present, candidate outcomes absent: the shape
    // eval-worker emits for `errored: true`.
    const decision = gateForCandidate(
      { evaluateGate: () => ({ accept: false, reason: "gate ran", bootstrap: null as never }) },
      { score: 0, championOutcomes: [outcome("t1")] } as never,
    )([]);

    // Still bypassed — behaviour is deliberately unchanged.
    expect(decision.accept).toBe(true);
    // But it must not blame a missing baseline that is right there.
    expect(decision.reason).not.toContain("no champion baseline");
    expect(decision.reason).toContain("outcomes");
  });
});
