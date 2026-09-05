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
import { hallucinationFromOutcomes, scoreToFitnessVector, toolSuccessFromOutcomes, VECTOR_KEYS, type FitnessVector } from "../l1-config/fitness.ts";
import {
  auditEntriesToUserSignals,
  computePersonalFitness,
  type AuditEntryLike,
} from "../l2-adapt/personal-fitness.ts";

/**
 * Tier 0 specs that measure the MACHINE, not the candidate.
 *
 * `latency` asks for an answer inside a fixed millisecond budget and
 * `token_budget` for one inside a fixed token count. Neither is a property of
 * the genome being judged: a cloud route answers in 2–5 s because that is what
 * the round trip costs, and no mutation of `temperature` or `retrievalStrategy`
 * will make the network faster.
 */
const ENVIRONMENT_KINDS: ReadonlySet<string> = new Set(["latency", "token_budget"]);

/** Tier 0 is the frozen sanity floor (INVARIANT I8, BRSI §2.7 accept
 *  criterion "Tier 0 floor intact"). The Rust scorer folds every task into
 *  one aggregate success rate, so a candidate can fail a Tier 0 task yet
 *  still out-score the champion on cost/latency — exactly the gaming the
 *  spec forbids. This is the absolute check the aggregate can't express.
 *
 *  A CAPABILITY task that failed or errored breaks the floor, always. That is
 *  the anti-gaming rule and it is unchanged: a candidate that answers wrong is
 *  never promoted, however fast or cheap it got.
 *
 *  An ENVIRONMENT task breaks the floor only when the champion passed it on
 *  this same machine — a real regression — rather than whenever the wall clock
 *  disagrees with a number frozen for different hardware. Measured 2026-08-14
 *  on two installs: `tier0/latency_short` wants a reply inside 1500 ms, the
 *  configured cloud route answers in 2051–5087 ms, so the floor was breached by
 *  physics on EVERY candidate and nothing had been promoted since 10 July. The
 *  champion on disk was still `seed-conservative`, the seed it started from.
 *
 *  This narrows nothing that protects quality and matches how L4 already judges
 *  speed (`module-eval.ts` compares candidate latency to the incumbent's as a
 *  ratio, not to a constant). Without a champion to compare against — the first
 *  candidate ever — an environment failure cannot be told from a slow machine,
 *  so it does not veto; correctness still does.
 *
 *  Returns a human-readable reason, or null if the floor holds. Pure +
 *  deterministic; exported for testing. */
export function tier0FloorBreach(
  outcomes: readonly EvalOutcome[],
  champion?: readonly EvalOutcome[],
): string | null {
  const championPassed = new Map<string, boolean>();
  for (const o of champion ?? []) {
    if (o.tier === 0) championPassed.set(o.taskId, o.success && !o.errored);
  }

  let failed = 0;
  let excused = 0;
  for (const o of outcomes) {
    if (o.tier !== 0) continue;
    if (o.success && !o.errored) continue;
    // An outcome with no `kind` is treated as capability: unknown means strict,
    // so a spec shape this file has not been taught about still vetoes.
    if (o.kind !== undefined && ENVIRONMENT_KINDS.has(o.kind) && !o.errored) {
      if (championPassed.get(o.taskId) === true) failed += 1;
      else excused += 1;
      continue;
    }
    failed += 1;
  }
  if (failed === 0) return null;
  const note = excused > 0 ? ` (${excused} environment task(s) the champion also fails)` : "";
  return `Tier 0 floor breached: ${failed} frozen sanity task(s) failed${note}`;
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
      const breach = ctx.outcomes ? tier0FloorBreach(ctx.outcomes, ctx.championOutcomes) : null;
      return breach ? { ok: false, reason: breach } : { ok: true };
    },

    // The payoff stage: the FitnessVector + paired samples for the I6 gate.
    // With an audit reader, `userSatisfaction` is REAL — the §2.10 personal
    // fitness over the user's recent tool-call outcomes. With outcomes,
    // `hallucination` is REAL — the confident-wrong rate on fact tasks
    // (fitness.ts `hallucinationFromOutcomes`). Absent either signal the
    // component stays the neutral unmeasured 0.5.
    runBenchmark: async () => {
      // Hallucination: measured deterministically from this candidate's own
      // eval batch (confident-wrong rate on fact tasks). Null → unmeasured.
      const hallucination = ctx.outcomes ? hallucinationFromOutcomes(ctx.outcomes) : null;
      // toolSuccess: measured from the tool_call slice of the suite when
      // present — otherwise the accuracy proxy from scoreToFitnessVector.
      const toolSuccess = ctx.outcomes ? toolSuccessFromOutcomes(ctx.outcomes) : null;
      const unmeasured: (keyof FitnessVector)[] = [];
      // No eval batch behind this candidate: `ctx.score` is a number with
      // nothing under it, and `scoreToFitnessVector` would spread it across
      // accuracy/latency/cost/toolSuccess as if they had been observed. Two
      // thirds of the rows in a real journal are this shape, and until now
      // they were written indistinguishably from a measured run — so anyone
      // reading the journal later (a person, the UI, an agent asked "is
      // evolution working") counted them as evidence. Flag ALL of it.
      if (!ctx.outcomes || ctx.outcomes.length === 0) {
        unmeasured.push(...VECTOR_KEYS);
      } else {
        if (hallucination === null) unmeasured.push("hallucination");
        if (!ctx.readRecentAudit) unmeasured.push("userSatisfaction");
      }
      const base = scoreToFitnessVector(ctx.score, { unmeasured });
      const fitnessVector = {
        ...base,
        ...(hallucination !== null ? { hallucination } : {}),
        ...(toolSuccess !== null ? { toolSuccess } : {}),
        ...(ctx.readRecentAudit
          ? {
              userSatisfaction: computePersonalFitness({
                signals: auditEntriesToUserSignals(ctx.readRecentAudit()),
              }),
            }
          : {}),
      };
      return {
        fitnessVector,
        // Which components are a neutral 0.5 placeholder rather than an
        // observation. Carried to the Journal row so a 0.5 can never be read
        // back as "we measured 0.5".
        unmeasured: [...unmeasured],
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
      const breach = ctx.outcomes ? tier0FloorBreach(ctx.outcomes, ctx.championOutcomes) : null;
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
          : {
              // Both numbers come from the ratchet itself. The candidate's is
              // read out of its commit metadata, which is what the comparison
              // uses — not the sidecar's own `ctx.score`, which is what this
              // message used to print and which can differ.
              reason: r.hadPrior
                ? `ratchet declined: candidate scored ${r.candidateScore}, main already scores ${r.previousBest} (strictly greater required)`
                : `ratchet declined: candidate scored ${r.candidateScore} and main carries no parseable score to beat`,
            }),
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
      reason: `confidence gate bypassed: ${bypassCause(deps, ctx)}`,
      bootstrap: { mean: 0, ciLower: 0, ciUpper: 0, pValue: 0, effectSize: 0 },
    });
  }
  return (samples) => deps.evaluateGate!(samples);
}

/**
 * Which bypass this is. All three used to be reported as "no champion baseline
 * yet (bootstrap)", including the one where a champion is right there and it is
 * the CANDIDATE that has nothing under it — the shape `eval-worker` emits for a
 * crashed eval (`errored: true`, no outcomes). A reader asking the journal "is
 * evolution working" then counts a crash as a first run.
 *
 * The bypass itself is unchanged on purpose: promotion is not at stake here,
 * because the Rust ratchet is strict-greater on the raw score (I1) and a
 * crashed candidate scores 0. What was at stake is the same thing this file
 * already refuses to fudge for the fitness vector — saying measured when
 * nothing was measured.
 */
function bypassCause(
  deps: Pick<RatchetDeps, "evaluateGate">,
  ctx: CandidateContext,
): string {
  if (!deps.evaluateGate) return "no gate configured";
  if (!ctx.championOutcomes) return "no champion baseline yet (bootstrap)";
  return "candidate has no per-task outcomes (eval crashed or legacy event)";
}
