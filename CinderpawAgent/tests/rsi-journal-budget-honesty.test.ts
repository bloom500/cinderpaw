/**
 * The Journal must not report a budget it never measured.
 *
 * I5's consumer half is PENDING: `assertBudget` is called with a null estimate
 * and a zero spend, so nothing accumulates and no stage is ever halted for
 * cost. The row still had to carry a `budgetRemaining` object, and it filled it
 * with the DEFAULT CAPS — so every candidate ever written claimed "30 minutes
 * and 100k tokens still available", identically, whatever the cycle had spent.
 * Anyone reading the journal later, including L6 meta-evolution, would take
 * that for an observation.
 *
 * Same discipline the fitness vector already uses with `result.unmeasured`: a
 * placeholder that cannot be told apart from a measurement is worse than an
 * absent field. Wall clock is the exception and is genuinely measured — the
 * contract knows when it started.
 */

import { describe, expect, test } from "bun:test";

import { runContract } from "../src/rsi/infra/contract-runner.ts";
import { makeInitialState, type ContractDeps, type ContractState } from "../src/rsi/infra/contract.ts";
import { DEFAULT_BUDGET_CAPS } from "../src/rsi/infra/budget.ts";
import type { JournalEntry } from "../src/rsi/infra/journal.ts";

/** Deps whose every stage passes, so the contract reaches a terminal row. */
function passingDeps(rows: JournalEntry[]): ContractDeps {
  const ok = async () => ({ ok: true }) as const;
  return {
    staticAnalysis: ok,
    sandboxApply: ok,
    tests: ok,
    benchmark: ok,
    safetyChecks: ok,
    regression: ok,
    deploy: ok,
    monitoring: ok,
    assertBudget: () => ({ allow: true, breaches: [], reason: "" }),
    evaluateConfidence: () => ({
      accept: true,
      reason: "stubbed",
      bootstrap: { mean: 1, ciLow: 1, ciHigh: 1, pValue: 0, effectSize: 1, samples: 30 },
    }),
    writeJournal: (entry: JournalEntry) => {
      rows.push(entry);
    },
  } as unknown as ContractDeps;
}

function initial(): ContractState {
  return makeInitialState({
    cycleId: "c-test",
    candidateId: "g1",
    layer: "L1",
    budgetCaps: DEFAULT_BUDGET_CAPS,
  });
}

describe("Journal budgetRemaining — honesty", () => {
  test("the untracked components are flagged, not presented as remaining", async () => {
    const rows: JournalEntry[] = [];
    await runContract(initial(), passingDeps(rows));

    expect(rows).toHaveLength(1);
    const budget = rows[0]!.budgetRemaining;
    expect(budget.unmeasured).toBeDefined();
    // Everything the contract does not track.
    expect([...budget.unmeasured!].sort()).toEqual(["cpuPct", "diskMb", "ramMb", "tokens"]);
  });

  test("wall clock is NOT flagged, because it really is measured", async () => {
    const rows: JournalEntry[] = [];
    await runContract(initial(), passingDeps(rows));

    const budget = rows[0]!.budgetRemaining;
    expect(budget.unmeasured).not.toContain("wallClockMin");
    // Elapsed time is deducted from the cap, so it can never exceed it.
    expect(budget.wallClockMin).toBeLessThanOrEqual(DEFAULT_BUDGET_CAPS.wallClockMin);
    expect(budget.wallClockMin).toBeGreaterThan(0);
  });
});
