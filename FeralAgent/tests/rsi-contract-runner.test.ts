/**
 * Evolution Contract runner (BRSI §2.1) — orchestration behaviour.
 *
 * Contract under test (the runner's guarantees, not the leaf handlers):
 *   1. Happy path: all 8 stages run in STAGE_ORDER; decision = accept; one
 *      journal row written.
 *   2. I5 budget: a denying `assertBudget` halts BEFORE the stage runs; the
 *      halted stage's handler is never called; journal decision = halt.
 *   3. I6 confidence: the gate runs AFTER regression and BEFORE deploy; a
 *      rejecting gate stops the pipeline (deploy never runs) with decision =
 *      reject.
 *   4. A handler returning {ok:false, halt:true} stops the pipeline; later
 *      handlers never run; decision = halt.
 *   5. A handler returning {ok:false, halt:false} → decision = reject.
 *   6. Every terminal writes exactly one journal row.
 */
import { describe, expect, test } from "bun:test";
import { runContract } from "../src/rsi/infra/contract-runner.ts";
import {
  makeInitialState,
  type ContractDeps,
  type ContractStage,
  type StageResult,
} from "../src/rsi/infra/contract.ts";
import { assertCanSpend, DEFAULT_BUDGET_CAPS, zeroSpend } from "../src/rsi/infra/budget.ts";
import type { GateDecision, PairedSample } from "../src/rsi/infra/confidence.ts";
import type { JournalEntry } from "../src/rsi/infra/journal.ts";
import { fitnessVector, fitnessVectorAggregate } from "../src/rsi/l1-config/fitness.ts";

const CALLS: ContractStage[] = [];

function pass(stage: ContractStage): StageResult {
  return { ok: true, stage, durationMs: 1 };
}

/** A deps object where every handler passes, recording its call. Override
 *  individual fields per test. */
function makeDeps(over: Partial<ContractDeps> = {}): { deps: ContractDeps; journal: JournalEntry[] } {
  const journal: JournalEntry[] = [];
  const stageFn = (stage: ContractStage) => async () => {
    CALLS.push(stage);
    return pass(stage);
  };
  const okGate: GateDecision = {
    accept: true,
    reason: "accepted (test)",
    bootstrap: { mean: 1, ciLower: 0.5, ciUpper: 1.5, pValue: 0.01, effectSize: 0.8 },
  };
  const deps: ContractDeps = {
    staticAnalysis: stageFn("static_analysis"),
    sandboxApply: stageFn("sandbox_apply"),
    tests: stageFn("tests"),
    // benchmark supplies the artifact the runner + gate depend on.
    benchmark: async () => {
      CALLS.push("benchmark");
      const fv = fitnessVector({ accuracy: 0.9 });
      const samples: PairedSample[] = Array.from({ length: 12 }, () => ({ candidate: 0.9, baseline: 0.5 }));
      return { ok: true, stage: "benchmark", durationMs: 1, artifact: { stage: "benchmark", durationMs: 1, data: { fitnessVector: fv, aggregate: fitnessVectorAggregate(fv), samples } } };
    },
    safetyChecks: stageFn("safety_checks"),
    regression: stageFn("regression"),
    deploy: stageFn("deploy"),
    monitoring: stageFn("monitoring"),
    estimateBudget: () => ({}),
    assertBudget: () => ({ allow: true, breaches: [], reason: "within budget" }),
    measureSpend: () => zeroSpend(),
    evaluateConfidence: () => okGate,
    writeJournal: (e) => journal.push(e),
    ...over,
  };
  return { deps, journal };
}

function freshState() {
  return makeInitialState({ cycleId: "c-1", candidateId: "cand-1", layer: "L1", budgetCaps: DEFAULT_BUDGET_CAPS });
}

describe("runContract — happy path", () => {
  test("runs all 8 stages in order, accepts, writes one journal row", async () => {
    CALLS.length = 0;
    const { deps, journal } = makeDeps();
    const final = await runContract(freshState(), deps);

    expect(CALLS).toEqual([
      "static_analysis", "sandbox_apply", "tests", "benchmark",
      "safety_checks", "regression", "deploy", "monitoring",
    ]);
    expect(final.decided).toEqual({ action: "accept", reason: "all contract stages passed" });
    expect(journal).toHaveLength(1);
    expect(journal[0]!.decided.action).toBe("accept");
    expect(journal[0]!.result?.tier0).toBe("passed");
    expect(journal[0]!.result?.tier1).toBe("no_regression");
  });
});

describe("runContract — I5 budget precheck", () => {
  test("a denying assertBudget halts before the first stage runs", async () => {
    CALLS.length = 0;
    const { deps, journal } = makeDeps({
      assertBudget: () => ({ allow: false, breaches: [], reason: "phase evaluate: tokens breach" }),
    });
    const final = await runContract(freshState(), deps);

    expect(CALLS).toEqual([]); // no handler ran
    expect(final.decided).toMatchObject({ action: "halt", reason: "phase evaluate: tokens breach" });
    expect(journal).toHaveLength(1);
    expect(journal[0]!.decided.action).toBe("halt");
  });

  test("accumulates measured spend and refuses a later stage before it starts", async () => {
    CALLS.length = 0;
    const caps = { ...DEFAULT_BUDGET_CAPS, tokens: 15 };
    const { deps } = makeDeps({
      estimateBudget: () => ({ tokens: 10 }),
      assertBudget: (phase, spent, estimate) => assertCanSpend(caps, spent, phase, estimate),
      measureSpend: () => ({ ...zeroSpend(), tokens: 10 }),
    });
    const final = await runContract(
      makeInitialState({ cycleId: "c-1", candidateId: "cand-1", layer: "L1", budgetCaps: caps }),
      deps,
    );
    expect(CALLS).toEqual(["static_analysis"]);
    expect(final.budgetSpent.tokens).toBe(10);
    expect(final.decided).toMatchObject({ action: "halt" });
  });

  test("missing stage estimate fails closed before the handler", async () => {
    CALLS.length = 0;
    const { deps } = makeDeps({ estimateBudget: () => null });
    const final = await runContract(freshState(), deps);
    expect(CALLS).toEqual([]);
    expect(final.decided).toMatchObject({ action: "halt" });
    expect(final.decided?.reason).toContain("missing budget estimate");
  });
});

describe("runContract — I6 confidence gate", () => {
  test("a rejecting gate stops before deploy with decision=reject", async () => {
    CALLS.length = 0;
    const rejectGate: GateDecision = {
      accept: false,
      reason: "insufficient samples",
      bootstrap: { mean: 0, ciLower: 0, ciUpper: 0, pValue: 1, effectSize: 0 },
    };
    const { deps, journal } = makeDeps({ evaluateConfidence: () => rejectGate });
    const final = await runContract(freshState(), deps);

    expect(CALLS).not.toContain("deploy"); // gate blocked deploy
    expect(CALLS).toContain("regression"); // gate runs AFTER regression
    expect(final.decided).toMatchObject({ action: "reject", reason: "insufficient samples" });
    expect(journal).toHaveLength(1);
  });
});

describe("runContract — handler failures", () => {
  test("ok:false halt:true stops the pipeline (halt)", async () => {
    CALLS.length = 0;
    const { deps, journal } = makeDeps({
      tests: async () => ({ ok: false, stage: "tests", reason: "tier0 failed", halt: true, recoverable: false }),
    });
    const final = await runContract(freshState(), deps);

    expect(CALLS).toEqual(["static_analysis", "sandbox_apply"]); // stopped at tests
    expect(final.decided).toMatchObject({ action: "halt", reason: "tier0 failed" });
    expect(journal).toHaveLength(1);
  });

  test("ok:false halt:false → reject", async () => {
    CALLS.length = 0;
    const { deps, journal } = makeDeps({
      safetyChecks: async () => ({ ok: false, stage: "safety_checks", reason: "flaky", halt: false, recoverable: true }),
    });
    const final = await runContract(freshState(), deps);

    expect(final.decided).toMatchObject({ action: "reject", reason: "flaky", nextStep: "try a different candidate" });
    expect(journal).toHaveLength(1);
  });
});
