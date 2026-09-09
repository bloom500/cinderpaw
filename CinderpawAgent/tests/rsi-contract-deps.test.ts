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
import { readFileSync, rmSync } from "node:fs";
import { budgetDep, contractDepsFrom } from "../src/rsi/infra/contract-deps.ts";
import { runContract } from "../src/rsi/infra/contract-runner.ts";
import { makeInitialState } from "../src/rsi/infra/contract.ts";
import type { StageHandlerDeps } from "../src/rsi/infra/contract-stages.ts";
import { DEFAULT_BUDGET_CAPS } from "../src/rsi/infra/budget.ts";
import { readJournal } from "../src/rsi/infra/journal.ts";
import type { PairedSample } from "../src/rsi/infra/confidence.ts";
import { fitnessVector, fitnessVectorAggregate } from "../src/rsi/l1-config/fitness.ts";

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

/**
 * INVARIANT I5 — every `runContract` consumer asks the budget, none answers for it.
 *
 * The first test is behaviour: `budgetDep` denies an explicit breach, which is
 * what the runner's HALT branch needs in order to ever fire.
 *
 * The second is the one that matters, and it is a source check on purpose.
 * L4's `module-lifecycle.ts` assembled `ContractDeps` by hand and wrote
 * `assertBudget: () => ({ allow: true, ... })` — a constant. Nothing caught it:
 * the invariant id does not appear in that line, so `check-invariant-coverage`
 * still credited I5's Runtime pillar from the other two consumers, and the
 * runner passes a `null` estimate today so the stub and the real assert return
 * the same `true`. The two would only diverge on the day a per-stage estimator
 * lands, in a path nobody would think to re-read.
 *
 * So the guard is on the wiring rather than on behaviour: every `assertBudget:`
 * in the RSI source must hand over `budgetDep`. A future consumer that
 * hand-rolls a constant fails here instead of silently opting out of I5.
 */
describe("I5 — the budget dep is asked, never answered for", () => {
  test("budgetDep denies an explicit breach (the runner's HALT branch)", () => {
    const caps = { ...DEFAULT_BUDGET_CAPS, tokens: 1_000 };
    const decision = budgetDep(caps)("evaluate", { tokens: 5_000 });
    expect(decision.allow).toBe(false);
    expect(decision.breaches.map((b) => b.resource)).toContain("tokens");
  });

  test("every assertBudget in src/rsi delegates to budgetDep", () => {
    const root = join(import.meta.dir, "..", "src", "rsi");
    const offenders: string[] = [];

    for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
      const full = join(root, file);
      const src = readFileSync(full, "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        if (!/^\s*assertBudget:/.test(line)) continue;
        // `contract.ts`'s interface declares the field with the same prefix.
        // A type member ends in `;`, an object property in `,` — that is the
        // whole difference between declaring the dep and wiring one.
        if (/;\s*$/.test(line)) continue;
        if (line.includes("budgetDep")) continue;
        offenders.push(`${file}:${i + 1} — ${line.trim()}`);
      }
    }

    expect(
      offenders,
      `these wire I5's budget assert themselves instead of using budgetDep():\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
