/**
 * Contract leaves over the live ratchet deps (BRSI §2.1 threading spec,
 * `docs/superpowers/specs/2026-07-01-contract-fsm-live-design.md` §2).
 *
 * `contractLeavesFromRatchet` builds the `StageHandlerDeps` the Contract FSM
 * sequences for ONE candidate, by wrapping the same `RatchetDeps` primitives
 * the hand-rolled `RatchetHandler.onEvalComplete` used to call directly. The
 * FSM adds sequencing + one per-candidate Journal row; the leaves do exactly
 * the work the handler did — same commits, same tier-0 floor, same ratchet
 * attempt — so promotions are identical by construction.
 *
 * The system is config-RSI (a candidate is a mutated GenomeConfig, not a code
 * diff), so the code-candidate stages collapse to pass-throughs:
 *   static_analysis / regression / monitoring → ok:true (nothing to lint /
 *   no tier-1 regression suite / no post-deploy probe yet).
 *
 * Goodhart gate (spec §1): `userSatisfaction` is observed + journaled only.
 * The deploy leaf feeds `ratchetAttempt` the RAW score — never the fitness
 * aggregate — so promotion semantics cannot drift when the vector changes.
 */

import type { EvalOutcome } from "./eval-worker.ts";
import type { GateDecision, PairedSample } from "./confidence.ts";
import type { StageHandlerDeps } from "./contract-stages.ts";
import type { CommitRequest, RatchetDeps } from "../l1-config/ratchet-handler.ts";
import { scoreToFitnessVector } from "../l1-config/fitness.ts";
import {
  auditEntriesToUserSignals,
  computePersonalFitness,
  type AuditEntryLike,
} from "../l2-adapt/personal-fitness.ts";

/** Tier 0 is the frozen sanity floor (INVARIANT I8, BRSI §2.7 accept
 *  criterion "Tier 0 floor intact"). The Rust scorer folds every task into
 *  one aggregate success rate, so a candidate can fail a Tier 0 task yet
 *  still out-score the champion on cost/latency — exactly the gaming the
 *  spec forbids. This is the absolute check the aggregate can't express:
 *  ANY tier-0 task that failed or errored breaks the floor. Returns a
 *  human-readable reason, or null if the floor holds. Pure + deterministic;
 *  exported for testing. */
export function tier0FloorBreach(outcomes: readonly EvalOutcome[]): string | null {
  let failed = 0;
  for (const o of outcomes) {
    if (o.tier === 0 && (!o.success || o.errored)) failed += 1;
  }
  if (failed === 0) return null;
  return `Tier 0 floor breached: ${failed} frozen sanity task(s) failed`;
}

/** Pair the current candidate's per-task outcomes against the champion's,
 *  matched by `taskId`. Each task contributes a paired sample with the
 *  per-task binary score (1 on success, 0 otherwise) — the same scalar
 *  the behavioral fingerprint uses. Tasks present in only one set are
 *  dropped: a paired test needs both measurements. Pure + deterministic.
 *
 *  Exported for `tests/rsi-ratchet-with-confidence.test.ts`. */
export function buildPairedSamples(
  candidate: readonly EvalOutcome[],
  baseline: readonly EvalOutcome[],
): PairedSample[] {
  const baseById = new Map<string, EvalOutcome>();
  for (const o of baseline) baseById.set(o.taskId, o);

  const samples: PairedSample[] = [];
  for (const c of candidate) {
    const b = baseById.get(c.taskId);
    if (b === undefined) continue;
    samples.push({
      candidate: c.success ? 1 : 0,
      baseline: b.success ? 1 : 0,
    });
  }
  return samples;
}

/** Everything from one EvalComplete the leaves close over. */
export interface CandidateContext {
  genomeId: string;
  score: number;
  tokenCost: number;
  durationMs: number;
  /** Per-task outcomes of THIS candidate (absent on legacy events). */
  outcomes?: readonly EvalOutcome[];
  /** Per-task outcomes of the current champion — the gate baseline.
   *  Absent before the first ratchet (the gate then bypasses). */
  championOutcomes?: readonly EvalOutcome[];
  /** Fired as soon as `commitGenome` returns, with the new hash — the
   *  handler records it on the population regardless of later verdicts. */
  onCommitted?: (commitHash: string) => void;
  /** Recent tool-call audit rows (BRSI §2.10) — when supplied, the benchmark
   *  leaf computes a REAL `userSatisfaction` from them instead of the neutral
   *  0.5. Observed + journaled only; never an input to promotion (spec §1). */
  readRecentAudit?: () => AuditEntryLike[];
}

/** What the leaves learned while running — the handler reads this after
 *  `runContract` returns to emit RatchetAdvanced with the same payload the
 *  hand-rolled path produced. Mutated in place by the leaf closures. */
export interface CandidateRun {
  commitHash?: string;
  previousBest?: number;
  advanced?: boolean;
}

/** Build the per-candidate `StageHandlerDeps` from the live ratchet deps.
 *  See the module docblock for the stage→behaviour table. */
export function contractLeavesFromRatchet(
  deps: Pick<RatchetDeps, "commitGenome" | "ratchetAttempt">,
  ctx: CandidateContext,
  run: CandidateRun,
): StageHandlerDeps {
  return {
    // Config-RSI: the mutation grammar already bounded the genome at birth.
    validateCandidate: async () => ({ ok: true, findings: [] }),

    // "Materialize in the sandbox" = commit the genome to its candidate
    // branch. main hasn't moved, so there is nothing to roll back —
    // rollbackTarget records the candidate's own commit for the journal.
    applySandbox: async () => {
      const req: CommitRequest = {
        genomeId: ctx.genomeId,
        score: ctx.score,
        tokenCost: ctx.tokenCost,
        durationMs: ctx.durationMs,
      };
      const { commitHash } = await deps.commitGenome(req);
      run.commitHash = commitHash;
      ctx.onCommitted?.(commitHash);
      return { ok: true, rollbackTarget: commitHash };
    },

    // The tier-0 subset already ran inside the eval; pass iff no breach.
    runTier0: async () => {
      const breach = ctx.outcomes ? tier0FloorBreach(ctx.outcomes) : null;
      return breach ? { ok: false, reason: breach } : { ok: true };
    },

    // The payoff stage: the FitnessVector + paired samples for the I6 gate.
    // With an audit reader, `userSatisfaction` is REAL — the §2.10 personal
    // fitness over the user's recent tool-call outcomes. Without one (legacy
    // wiring, tests), it stays the neutral unmeasured 0.5.
    runBenchmark: async () => {
      const base = scoreToFitnessVector(
        ctx.score,
        ctx.readRecentAudit ? { unmeasured: ["hallucination"] } : {},
      );
      const fitnessVector = ctx.readRecentAudit
        ? {
            ...base,
            userSatisfaction: computePersonalFitness({
              signals: auditEntriesToUserSignals(ctx.readRecentAudit()),
            }),
          }
        : base;
      return {
        fitnessVector,
        // Journal scalar only — the deploy leaf hands the RAW score to the
        // ratchet (spec §1), never this normalised aggregate. Uses the score
        // proxy (accuracy), NOT the satisfaction-coloured vector.
        aggregate: base.accuracy,
        samples:
          ctx.outcomes && ctx.championOutcomes
            ? buildPairedSamples(ctx.outcomes, ctx.championOutcomes)
            : [],
      };
    },

    // Same tier-0 floor as `tests`, per the spec's stage table: `tests`
    // marks tier0 in the Journal; this is the safety re-assert. Redundant
    // by design and free — it only runs when `tests` already passed.
    runSafetyChecks: async () => {
      const breach = ctx.outcomes ? tier0FloorBreach(ctx.outcomes) : null;
      return breach ? { ok: false, reason: breach } : { ok: true };
    },

    // ponytail: no tier-1 regression suite for config candidates yet.
    detectRegression: async () => ({ regressed: false }),

    // Rust strict-greater is the source of truth (I1). Raw score, per §1.
    deploy: async (_candidateId, _aggregate) => {
      const commitHash = run.commitHash;
      if (!commitHash) throw new Error("deploy reached without a sandbox_apply commit");
      const r = await deps.ratchetAttempt(commitHash, ctx.score);
      run.previousBest = r.previousBest;
      run.advanced = r.advanced;
      return {
        advanced: r.advanced,
        commitHash,
        ...(r.advanced
          ? {}
          : { reason: `ratchet declined: previous best ${r.previousBest} >= ${ctx.score}` }),
      };
    },

    // ponytail: no post-deploy health probe for a config swap yet.
    monitor: async () => ({ ok: true }),
  };
}

/** The runner calls `evaluateConfidence` unconditionally before deploy; the
 *  hand-rolled handler gated only when it had BOTH a gate dep and a champion
 *  baseline (the first candidate bootstraps the baseline). This preserves
 *  that bypass so Slice 1 promotions are identical to the legacy path. */
export function gateForCandidate(
  deps: Pick<RatchetDeps, "evaluateGate">,
  ctx: CandidateContext,
): (samples: readonly PairedSample[]) => GateDecision {
  const shouldGate = Boolean(deps.evaluateGate && ctx.championOutcomes && ctx.outcomes);
  if (!shouldGate) {
    return () => ({
      accept: true,
      reason: "confidence gate bypassed: no champion baseline yet (bootstrap)",
      bootstrap: { mean: 0, ciLower: 0, ciUpper: 0, pValue: 0, effectSize: 0 },
    });
  }
  return (samples) => deps.evaluateGate!(samples);
}
