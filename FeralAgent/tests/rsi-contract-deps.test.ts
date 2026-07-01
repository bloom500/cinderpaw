/**
 * Evolution Contract composition root (contract-deps.ts) — the seam.
 *
 * Contract under test: `contractDepsFrom` binds the live engine-half
 * (confidence gate, Journal writer, budget assert) to the injectable stage
 * leaves, so `runContract` runs a candidate end-to-end with real IO modules
 * and only the `StageHandlerDeps` leaves faked.
 *   - happy path → accept + exactly one Journal row on disk (real appendJournal)
 *   - assertBudget fail-opens on a null estimate (I5 fail-open contract)
 *   - evaluateConfidence delegates to the real gate (reject on too few samples)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { contractDepsFrom } from "../src/rsi/contract-deps.ts";
import { runContract } from "../src/rsi/contract-runner.ts";
import { makeInitialState } from "../src/rsi/contract.ts";
import type { StageHandlerDeps } from "../src/rsi/contract-stages.ts";
import { DEFAULT_BUDGET_CAPS } from "../src/rsi/budget.ts";
import { readJournal } from "../src/rsi/journal.ts";
import type { PairedSample } from "../src/rsi/confidence.ts";
import { fitnessVector, fitnessVectorAggregate } from "../src/rsi/fitness.ts";

/** Happy-path stage leaves — the injectable half. The benchmark returns paired
 *  samples where the candidate beats the baseline on MOST tasks (not all): the
 *  strict gate needs non-zero variance in the differences — all-identical diffs
 *  are degenerate (Cohen's d = mean/0 → rejected). 11 wins + 1 tie clears
 *  MIN_SAMPLES, direction, significance, and magnitude. */
function fakeStageDeps(over: Partial<StageHandlerDeps> = {}): StageHandlerDeps {
  const fv = fitnessVector({ accuracy: 0.9 });
  const samples: PairedSample[] = Array.from({ length: 12 }, (_, i) => ({
    candidate: i === 0 ? 0 : 1,
    baseline: 0,
  }));
  return {
    validateCandidate: async () => ({ ok: true, findings: [] }),
    applySandbox: async () => ({ ok: true, rollbackTarget: "rb-abc" }),
    runTier0: async () => ({ ok: true }),
    runBenchmark: async () => ({ fitnessVector: fv, aggregate: fitnessVectorAggregate(fv), samples }),
    runSafetyChecks: async () => ({ ok: true }),
    detectRegression: async () => ({ regressed: false }),
    deploy: async () => ({ advanced: true, commitHash: "commit-xyz" }),
    monitor: async () => ({ ok: true }),
    ...over,
  };
}

function freshState() {
  return makeInitialState({ cycleId: "c-1", candidateId: "cand-1", layer: "L1", budgetCaps: DEFAULT_BUDGET_CAPS });
}

const tmpPaths: string[] = [];
function tempJournalPath(): string {
  const p = join(tmpdir(), `rsi-contract-deps-${crypto.randomUUID()}.jsonl`);
  tmpPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    try { rmSync(p, { force: true }); } catch { /* best-effort */ }
  }
});

describe("contractDepsFrom — end-to-end seam", () => {
  test("happy path accepts and writes exactly one real Journal row", async () => {
    const path = tempJournalPath();
    const deps = contractDepsFrom(fakeStageDeps(), { journalPath: () => path });

    const final = await runContract(freshState(), deps);

    expect(final.decided).toEqual({ action: "accept", reason: "all contract stages passed" });
    const rows = readJournal(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decided.action).toBe("accept");
    expect(rows[0]!.experimented.candidateId).toBe("cand-1");
  });

  test("assertBudget fail-opens on a null estimate (I5)", () => {
    const deps = contractDepsFrom(fakeStageDeps());
    const decision = deps.assertBudget("evaluate", null);
    expect(decision.allow).toBe(true);
    expect(decision.reason).toContain("fail-open");
  });

  test("evaluateConfidence delegates to the real gate (rejects too-few samples)", () => {
    const deps = contractDepsFrom(fakeStageDeps());
    const decision = deps.evaluateConfidence([{ candidate: 1, baseline: 0 }]); // 1 < MIN_SAMPLES
    expect(decision.accept).toBe(false);
    expect(decision.reason).toContain("insufficient samples");
  });

  test("a rejecting gate stops before deploy with a reject Journal row", async () => {
    const path = tempJournalPath();
    const deps = contractDepsFrom(fakeStageDeps(), {
      journalPath: () => path,
      evaluateConfidence: () => ({
        accept: false,
        reason: "stubbed reject",
        bootstrap: { mean: 0, ciLower: 0, ciUpper: 0, pValue: 1, effectSize: 0 },
      }),
    });

    const final = await runContract(freshState(), deps);

    expect(final.decided).toMatchObject({ action: "reject", reason: "stubbed reject" });
    const rows = readJournal(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decided.action).toBe("reject");
  });
});
