/**
 * Evolution Contract runner (BRSI §2.1) — the orchestration for the 8-stage
 * pipeline whose TYPES live in `contract.ts`. This file is the engine's half of
 * the division of labor: it sequences the stages, enforces the runtime
 * invariants, and writes exactly one Journal row per candidate. It owns NO
 * business logic — every stage's actual work is a `StageFn` handler supplied
 * through `ContractDeps` (those handlers are the leaves written against the
 * frozen contract below).
 *
 * ── What the runner guarantees ──────────────────────────────────────────────
 *   I5  Budget precheck BEFORE each stage. Missing estimates fail closed;
 *       explicit estimates are checked against accumulated measured spend.
 *   I6  Confidence gate AFTER regression, BEFORE deploy. If the gate rejects,
 *       the pipeline stops before deploy and the decision is `reject` (the
 *       candidate WAS evaluated, just not promoted).
 *   I3/I4 One Journal row on every terminal — accept, reject, or halt — via
 *       the append-only `writeJournal` dep.
 *
 * ── The handler contract (what each `StageFn` leaf MUST return) ──────────────
 * A handler returns `{ok:true, ...}` to advance, or `{ok:false, halt, ...}` to
 * stop. On success it MAY attach an `artifact` whose `data` the runner reads by
 * stage name. The runner depends on these artifact shapes — a handler that
 * omits them degrades the Journal row / gate, it does not crash the runner:
 *
 *   sandbox_apply → { rollbackTarget?: string }         // where to roll back to
 *   benchmark     → { fitnessVector: FitnessVector,      // → Journal result
 *                     aggregate: number,                 // → the ratchet scalar
 *                     samples: PairedSample[] }          // → the I6 gate input
 *   deploy        → { commitHash?: string }              // the promoted commit
 *
 * `tests` and `regression` need no artifact: passing them (`ok:true`) is what
 * marks tier0 = passed / tier1 = no_regression in the Journal. All other stages
 * are pass/fail only.
 */
import {
  STAGE_ORDER,
  type ContractDeps,
  type ContractStage,
  type ContractState,
  type RunContract,
  type StageFn,
  type StageResult,
} from "./contract.ts";
import { applySpend, remaining, type BudgetSpend, type CyclePhase } from "./budget.ts";
import type { PairedSample } from "./confidence.ts";
import type {
  BudgetRemaining,
  ExperimentLayer,
  FitnessVector,
  JournalDecision,
  JournalEntry,
} from "./journal.ts";

/** The 8 executable stages (STAGE_ORDER minus the `candidate_proposed` entry
 *  state, which has no handler). */
type RunStage = Exclude<ContractStage, "candidate_proposed">;

/** Which dream-cycle phase a contract stage bills its budget against. The
 *  candidate pipeline lives inside the Dream Cycle's Evaluate/Remember phases. */
const STAGE_TO_PHASE: Record<ContractStage, CyclePhase> = {
  candidate_proposed: "dream",
  static_analysis: "evaluate",
  sandbox_apply: "mutate",
  tests: "evaluate",
  benchmark: "evaluate",
  safety_checks: "evaluate",
  regression: "evaluate",
  deploy: "remember",
  monitoring: "remember",
};

/** Map each executable stage to its handler in `ContractDeps`. */
function handlerFor(deps: ContractDeps, stage: RunStage): StageFn {
  switch (stage) {
    case "static_analysis": return deps.staticAnalysis;
    case "sandbox_apply": return deps.sandboxApply;
    case "tests": return deps.tests;
    case "benchmark": return deps.benchmark;
    case "safety_checks": return deps.safetyChecks;
    case "regression": return deps.regression;
    case "deploy": return deps.deploy;
    case "monitoring": return deps.monitoring;
  }
}

/**
 * Run the 8-stage contract for one candidate. Sequences stages in order,
 * halting on the first failure; enforces I5 (budget) and I6 (confidence);
 * writes one Journal row on the terminal. Always resolves — a throwing handler
 * is NOT caught here (a stage that throws is a programming error in the leaf,
 * distinct from an `ok:false` verdict, which is the handler's normal way to
 * fail a candidate).
 */
export const runContract: RunContract = async (initial, deps) => {
  let state = initial;

  for (const stage of STAGE_ORDER) {
    if (stage === "candidate_proposed") continue; // entry state, no handler
    const phase = STAGE_TO_PHASE[stage];

    // I5 — a stage without an explicit estimate is not authorized to start.
    const estimate = deps.estimateBudget(stage, state);
    if (estimate === null) {
      return terminal(state, deps, stage, {
        action: "halt",
        reason: `stage ${stage}: missing budget estimate (fail-closed)`,
        stage: phase,
      });
    }
    const budget = deps.assertBudget(phase, state.budgetSpent, estimate);
    if (!budget.allow) {
      return terminal(state, deps, stage, {
        action: "halt",
        reason: budget.reason,
        stage: phase,
      });
    }

    // I6 — confidence gate AFTER regression, BEFORE deploy. Rejection here is a
    // `reject` (evaluated, not promoted), not a `halt`.
    if (stage === "deploy") {
      const gate = deps.evaluateConfidence(benchmarkSamples(state));
      state = { ...state, confidence: gate, bootstrap: gate.bootstrap };
      if (!gate.accept) {
        return terminal(state, deps, stage, {
          action: "reject",
          reason: gate.reason,
          nextStep: "re-run with more paired samples or a lower mutation rate",
        });
      }
    }

    const stageStartedAt = Date.now();
    const result = await handlerFor(deps, stage)(state);
    const measured = deps.measureSpend(stage, state, result, Date.now() - stageStartedAt);
    state = withHistory(state, stage, result);
    state = { ...state, budgetSpent: applySpend(state.budgetSpent, measured) };

    if (!result.ok) {
      return terminal(state, deps, stage, verdictFor(result, phase));
    }
    state = foldArtifact(state, stage, result);
  }

  // Every stage passed → the candidate is promotable.
  return terminal(state, deps, "monitoring", {
    action: "accept",
    reason: "all contract stages passed",
  });
};

/** A failed stage becomes a `halt` (system-wide stop) or a `reject` (try a
 *  different candidate), per the handler's `halt` flag. */
function verdictFor(
  result: Extract<StageResult, { ok: false }>,
  phase: CyclePhase,
): JournalDecision {
  if (result.halt) {
    return { action: "halt", reason: result.reason, stage: phase };
  }
  return {
    action: "reject",
    reason: result.reason,
    nextStep: result.recoverable ? "try a different candidate" : "needs manual intervention",
  };
}

/** Append a stage's result to history (immutably). */
function withHistory(state: ContractState, stage: ContractStage, result: StageResult): ContractState {
  return {
    ...state,
    currentStage: stage,
    history: [...state.history, { stage, result, at: Date.now() }],
  };
}

/** Fold a successful stage's artifact into the state the Journal reads. */
function foldArtifact(
  state: ContractState,
  stage: ContractStage,
  result: Extract<StageResult, { ok: true }>,
): ContractState {
  const data = result.artifact?.data;
  if (!data) return state;
  if (stage === "benchmark") {
    const next = { ...state };
    if (isFitnessVector(data.fitnessVector)) next.fitnessVector = data.fitnessVector;
    if (typeof data.aggregate === "number") next.fitnessAggregate = data.aggregate;
    return next;
  }
  if (stage === "sandbox_apply" && typeof data.rollbackTarget === "string") {
    return { ...state, rollbackTarget: data.rollbackTarget };
  }
  return state;
}

/** Set the decision, write the Journal row, return the final state. Every exit
 *  from `runContract` goes through here so I3/I4 (one row per terminal) holds. */
function terminal(
  state: ContractState,
  deps: ContractDeps,
  at: ContractStage,
  decided: JournalDecision,
): ContractState {
  const finalState: ContractState = { ...state, currentStage: at, decided };
  deps.writeJournal(toJournalEntry(finalState));
  return finalState;
}

/** The paired samples the benchmark handler recorded, for the I6 gate. Missing
 *  or malformed → empty (the gate then rejects for "insufficient samples"). */
function benchmarkSamples(state: ContractState): PairedSample[] {
  const samples = artifactData(state, "benchmark")?.samples;
  return Array.isArray(samples) ? (samples as PairedSample[]) : [];
}

/** Most-recent successful artifact `data` for a stage, if any. */
function artifactData(state: ContractState, stage: ContractStage): Record<string, unknown> | undefined {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const h = state.history[i]!;
    if (h.stage === stage && h.result.ok) return h.result.artifact?.data;
  }
  return undefined;
}

/** Did a stage complete successfully? Drives tier0 / tier1 in the Journal. */
function stagePassed(state: ContractState, stage: ContractStage): boolean {
  return state.history.some((h) => h.stage === stage && h.result.ok);
}

/** Compose the per-candidate Journal row from the final contract state. */
function toJournalEntry(state: ContractState): JournalEntry {
  const now = Date.now();
  return {
    cycleId: state.cycleId,
    timestamp: now,
    durationMin: (now - state.startedAt) / 60_000,
    // observed/hypothesized are cycle-level (owned by the Dream Cycle FSM),
    // not candidate-level — empty for a per-candidate contract row.
    observed: [],
    hypothesized: [],
    experimented: {
      candidateId: state.candidateId,
      change: "", // the diff isn't carried on the contract state
      layer: toExperimentLayer(state.layer),
    },
    result: state.fitnessVector
      ? {
          fitnessVector: state.fitnessVector,
          aggregate: state.fitnessAggregate ?? 0,
          confidence: state.confidence ? 1 - state.confidence.bootstrap.pValue : 0,
          tier0: stagePassed(state, "tests") ? "passed" : "failed",
          tier1: stagePassed(state, "regression") ? "no_regression" : "regression",
        }
      : null,
    decided: state.decided ?? { action: "halt", reason: "no decision recorded", stage: "evaluate" },
    budgetRemaining: budgetRemaining(state.budgetCaps, state.budgetSpent),
  };
}

/** The Journal's `ExperimentLayer` is L0..L5; `ContractState` allows L6.
 *  ponytail: clamp L6→L5 (meta-evolution) until the Journal schema adds L6. */
function toExperimentLayer(layer: ContractState["layer"]): ExperimentLayer {
  return layer === "L6" ? "L5" : layer;
}

/** Remaining budget for the Journal row (drops energyKwh — never a hard cap). */
function budgetRemaining(caps: ContractState["budgetCaps"], spent: BudgetSpend): BudgetRemaining {
  const r = remaining(caps, spent);
  return {
    wallClockMin: r.wallClockMin,
    tokens: r.tokens,
    cpuPct: r.cpuPct,
    ramMb: r.ramMb,
    diskMb: r.diskMb,
  };
}

/** Light structural check — a benchmark artifact carries a 6-number vector. */
function isFitnessVector(v: unknown): v is FitnessVector {
  return !!v && typeof v === "object" && typeof (v as FitnessVector).accuracy === "number";
}
