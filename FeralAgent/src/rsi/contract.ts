/**
 * Evolution Contract — the 8-stage pipeline every candidate traverses (BRSI §2.1).
 *
 * Scope of THIS module — TYPE LAYER ONLY:
 *   This file defines the SHAPE of the Contract FSM: stages, state
 *   transitions, stage result types, runner signature. It does NOT
 *   implement the stage handlers — those are composed from existing
 *   primitives (eval-worker, confidence, budget, journal, fitness)
 *   and are written by Opus (the engine composition root is Opus's
 *   territory, per the division of labor in
 *   `docs/agents-memory/project_brsi_evolution.md`).
 *
 * Why types-only here:
 *   1. Forces the integration shape to be coherent before any
 *      handler code lands.
 *   2. Lets Opus write stage handlers against a stable contract —
 *      no rework when a field name changes.
 *   3. Lets tests assert the state machine transitions without
 *      booting any actual evaluation / confidence / journal
 *      machinery. TDD scaffold for the implementation.
 *
 * The contract is RUNTIME-ENFORCED — see `docs/invariants.md`:
 *   - I1, I2: only the ratchet advances main lineage.
 *   - I3, I4: journal append-only; corruption observable.
 *   - I5: budget halt on breach (explicit estimate + breach → HALT).
 *   - I6: confidence gate precedence enforced before deploy.
 *
 * A candidate that bypasses a stage is rejected, not negotiated.
 * The four-pillar check (Documentation, Test, Runtime Assert, Audit)
 * must hold for every stage before it ships.
 */

import type {
  BudgetDecision,
  BudgetSpend,
  CyclePhase,
  PhaseEstimate,
} from "./budget.ts";
import type {
  BootstrapResult,
  GateDecision,
  PairedSample,
} from "./confidence.ts";
import type { FitnessVector } from "./fitness.ts";
import type { JournalDecision, JournalEntry } from "./journal.ts";

/** The 8 stages from BRSI §2.1, plus a pre-pipeline entry state
 *  ("candidate_proposed") so the runner has a starting point
 *  before any stage fires. */
export type ContractStage =
  | "candidate_proposed"
  | "static_analysis"
  | "sandbox_apply"
  | "tests"
  | "benchmark"
  | "safety_checks"
  | "regression"
  | "deploy"
  | "monitoring";

/** The 9-stage ordered pipeline. The runner iterates this in order;
 *  a stage's failure halts the pipeline. */
export const STAGE_ORDER: ReadonlyArray<ContractStage> = [
  "candidate_proposed",
  "static_analysis",
  "sandbox_apply",
  "tests",
  "benchmark",
  "safety_checks",
  "regression",
  "deploy",
  "monitoring",
];

/** One stage's verdict.
 *
 *  - `ok: true`: stage passed; the runner advances to the next stage.
 *    `artifact` carries stage-specific data (the deploy stage records
 *    the new commit hash; benchmark records the fitness vector;
 *    others may be empty).
 *  - `ok: false`: stage failed. `halt` says whether the cycle should
 *    stop entirely. `recoverable` distinguishes "try a different
 *    candidate" from "this is a system-wide halt — surface to UI". */
export type StageResult =
  | {
      ok: true;
      stage: ContractStage;
      durationMs: number;
      artifact?: ArtifactRecord;
    }
  | {
      ok: false;
      stage: ContractStage;
      reason: string;
      halt: boolean;
      recoverable: boolean;
    };

/** What a stage produced. Kept small — only stage-specific outputs
 *  that downstream stages or the runner need. */
export interface ArtifactRecord {
  stage: ContractStage;
  /** Stage-specific data. The runner inspects this by stage name. */
  data: Record<string, unknown>;
  /** Wall-clock duration of this stage. */
  durationMs: number;
}

/** The state object that flows through the pipeline. Pure data;
 *  the runner reads/writes it as stages complete. Immutable per
 *  stage transition — a stage receives a state, returns a stage
 *  result; the runner composes the next state. */
export interface ContractState {
  /** Dream cycle this candidate belongs to. */
  cycleId: string;
  /** Candidate id (commit hash for code, envelope id for non-code). */
  candidateId: string;
  /** Which layer emitted the candidate (BRSI §5 / ADR-0002). */
  layer: "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6";
  /** Where in the pipeline we are. The runner advances this. */
  currentStage: ContractStage;
  /** History of completed stages (most recent last). */
  history: Array<{
    stage: ContractStage;
    result: StageResult;
    at: number;
  }>;
  /** Wall-clock ms when the contract started. */
  startedAt: number;
  /** Budget accumulated across all stages so far (BRSI §2.5). */
  budgetSpent: BudgetSpend;
  /** Benchmark stage output: the 6-component fitness vector. */
  fitnessVector?: FitnessVector;
  /** Aggregate of the fitness vector (the scalar the ratchet compares). */
  fitnessAggregate?: number;
  /** Confidence gate verdict (computed at end of regression stage). */
  confidence?: GateDecision;
  /** The bootstrap result underlying the confidence decision. */
  bootstrap?: BootstrapResult;
  /** Final decision written to the Journal. */
  decided?: JournalDecision;
  /** Where to roll back to if a later stage fails. */
  rollbackTarget?: string;
}

/** Stage handler signature. Pure async function over state. The
 *  handler may do IO (call eval, call Rust, write to journal) but
 *  receives and returns the ContractState. */
export type StageFn = (state: ContractState) => Promise<StageResult>;

/** What the contract runner needs from the engine. Each stage
 *  handler is supplied by the engine composition root (Opus).
 *  The runner does not own any business logic — it sequences
 *  stages and surfaces their verdicts. */
export interface ContractDeps {
  /** Stage handlers in STAGE_ORDER. The runner calls them in order. */
  staticAnalysis: StageFn;
  sandboxApply: StageFn;
  tests: StageFn;
  benchmark: StageFn;
  safetyChecks: StageFn;
  regression: StageFn;
  deploy: StageFn;
  monitoring: StageFn;
  /** Budget assertion, called BEFORE each stage. Fail-open on null
   *  estimate (per `budget.ts` fail-open contract); explicit-estimate
   *  breach → HALT (INVARIANT I5). */
  assertBudget: (phase: CyclePhase, estimate: PhaseEstimate | null) => BudgetDecision;
  /** Confidence gate, called AFTER regression, BEFORE deploy. If the
   *  gate rejects, the cycle halts (INVARIANT I6). */
  evaluateConfidence: (samples: readonly PairedSample[]) => GateDecision;
  /** Where the cycle summary lands (BRSI §2.9 schema). */
  writeJournal: (entry: JournalEntry) => void;
}

/** The runner signature — given an initial state + deps, run all
 *  stages in order; halt on first failure. Returns the final state
 *  (which the journal entry uses). */
export type RunContract = (
  initial: ContractState,
  deps: ContractDeps,
) => Promise<ContractState>;

/** Build the initial state from a candidate's identity. Convenience
 *  for callers (handlers); does no IO. */
export function makeInitialState(args: {
  cycleId: string;
  candidateId: string;
  layer: ContractState["layer"];
  budgetCaps: import("./budget.ts").BudgetCaps;
  rollbackTarget?: string;
  now?: number;
}): ContractState {
  return {
    cycleId: args.cycleId,
    candidateId: args.candidateId,
    layer: args.layer,
    currentStage: "candidate_proposed",
    history: [],
    startedAt: args.now ?? Date.now(),
    budgetSpent: {
      wallClockMin: 0,
      cpuPct: 0,
      ramMb: 0,
      tokens: 0,
      energyKwh: 0,
      diskMb: 0,
    },
    ...(args.rollbackTarget !== undefined && { rollbackTarget: args.rollbackTarget }),
  };
}