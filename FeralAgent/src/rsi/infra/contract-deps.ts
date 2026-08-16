/**
 * Evolution Contract composition root (BRSI §2.1, wiring-spec §8) — the seam
 * between the pure Contract layer and the live primitives. `contractDepsFrom`
 * assembles the `ContractDeps` the runner needs from:
 *   - the 8 stage FACTORIES (contract-stages.ts), closed over the injectable
 *     `StageHandlerDeps` (eval / bridge / ratchet leaves the caller supplies);
 *   - the already-live engine-half primitives — the confidence gate
 *     (`evaluateGate`), the Evolution Journal writer (`appendJournal`), and the
 *     stateful per-phase budget ledger (`assertCanSpend` + measurement).
 *
 * This is the ONE place that couples the Contract to IO. The runner
 * (contract-runner.ts) and the handlers (contract-stages.ts) stay pure and
 * fake-testable; this file wires them to production modules so a host can run
 * a candidate through `runContract` with a single call.
 *
 * What is NOT wired here (deliberately): the `StageHandlerDeps` leaves
 * (validateCandidate / applySandbox / runBenchmark / deploy / …). Five of them
 * have no Faza-1 primitive (they are code-candidate / sandbox concepts); they
 * stay injectable so this seam can land without inventing Rust bridge methods.
 * The caller supplies real or fake leaves; the engine-half is bound here.
 */
import type { ContractDeps } from "./contract.ts";
import {
  stageBenchmark,
  stageDeploy,
  stageMonitoring,
  stageRegression,
  stageSafetyChecks,
  stageSandboxApply,
  stageStaticAnalysis,
  stageTests,
  type StageHandlerDeps,
} from "./contract-stages.ts";
import { evaluateGate, type GateDecision, type PairedSample } from "./confidence.ts";
import { appendJournal, defaultJournalPath } from "./journal.ts";
import {
  assertCanSpend,
  zeroSpend,
  DEFAULT_BUDGET_CAPS,
  type BudgetCaps,
  type CycleBudgetLedger,
  type BudgetSpend,
  type PhaseEstimate,
} from "./budget.ts";
import type { ContractStage, ContractState, StageResult } from "./contract.ts";

/** Host-tunable knobs for the engine-half deps. All optional — the defaults
 *  are the production wiring (strict gate, per-UTC-day journal, §2.5 caps). */
export interface ContractDepsOptions {
  /** Where the Evolution Journal row lands. A function because the file rotates
   *  per UTC day (resolved at each write), mirroring `dream-cycle.ts`.
   *  Default: `() => defaultJournalPath()`. */
  journalPath?: () => string;
  /** Per-cycle resource caps (BRSI §2.5). The host derives these from the live
   *  SandboxBounds; default is §2.5. */
  budgetCaps?: BudgetCaps;
  /** Confidence gate override — inject a stub in tests. Default: the strict
   *  locked `evaluateGate`. */
  evaluateConfidence?: (samples: readonly PairedSample[]) => GateDecision;
  /** Explicit per-stage estimate. Missing/null fails closed in the runner. */
  estimateStage?: (stage: ContractStage, state: ContractState) => PhaseEstimate | null;
  /** Actual resource measurement. Default records measured wall-clock only. */
  measureStage?: (
    stage: ContractStage,
    state: ContractState,
    result: StageResult,
    elapsedMs: number,
  ) => BudgetSpend;
  /** Cycle-owned ledger shared by all candidate contracts in that cycle. */
  budgetLedger?: CycleBudgetLedger;
}

/**
 * Build the `ContractDeps` for `runContract` from the injectable stage leaves
 * plus the live engine-half primitives. The 8 handlers are the stage factories
 * closed over `stage`; the gate / journal / budget are bound from the modules.
 */
export function contractDepsFrom(
  stage: StageHandlerDeps,
  opts: ContractDepsOptions = {},
): ContractDeps {
  const journalPath = opts.journalPath ?? (() => defaultJournalPath());
  const caps = opts.budgetCaps ?? opts.budgetLedger?.caps ?? DEFAULT_BUDGET_CAPS;
  const evaluateConfidence = opts.evaluateConfidence ?? ((samples) => evaluateGate(samples));

  return {
    staticAnalysis: stageStaticAnalysis(stage),
    sandboxApply: stageSandboxApply(stage),
    tests: stageTests(stage),
    benchmark: stageBenchmark(stage),
    safetyChecks: stageSafetyChecks(stage),
    regression: stageRegression(stage),
    deploy: stageDeploy(stage),
    monitoring: stageMonitoring(stage),

    estimateBudget: opts.estimateStage ?? (() => null),
    ...(opts.budgetLedger ? { budgetLedger: opts.budgetLedger } : {}),

    // I5 — per-phase precheck against the runner's accumulated ledger.
    assertBudget: (phase, spent, estimate) => assertCanSpend(caps, spent, phase, estimate),
    measureSpend: opts.measureStage ?? ((_stage, _state, _result, elapsedMs) => ({
      ...zeroSpend(),
      wallClockMin: elapsedMs / 60_000,
    })),
    // I6 — confidence gate the runner calls after regression, before deploy.
    evaluateConfidence,
    // I3/I4 — one append-only Journal row per terminal (best-effort; the writer
    // soft-fails internally so a disk error never crashes the runner).
    writeJournal: (entry) => appendJournal(journalPath(), entry),
  };
}
