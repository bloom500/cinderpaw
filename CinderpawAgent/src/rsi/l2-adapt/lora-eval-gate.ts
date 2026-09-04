/**
 * Faza 4 Slice 3 — the LoRA eval gate (pure verdict) + human-gate contract.
 * Spec: `docs/superpowers/specs/2026-07-02-faza4-personal-adaptation-design.md` §Slice 3.
 *
 * A candidate adapter is NOT promoted on training loss ↓. It earns
 * promotion through the SAME BRSI ladder the config genomes climb:
 *
 *   Tier 0 floor (safety) → paired confidence gate (candidate vs the
 *   current champion, on the eval suite) → HUMAN review → promote.
 *
 * This module owns only the pure verdict — given the Tier 0 result and
 * the paired eval scores, does the statistics say "recommend promotion"?
 * It reuses `confidence.ts` verbatim (the exact bootstrap gate the config
 * ladder uses), so LoRA promotion and config promotion share one
 * definition of "significantly better".
 *
 * What it deliberately does NOT do:
 *   - it does NOT load or run the adapter — that is the host + trainer
 *     (Slice 4); this module consumes the scores they produce;
 *   - it does NOT promote — it produces a RECOMMENDATION. The human gate
 *     (spec §Human Gate) sits between this verdict and
 *     `LoraRegistry.promote`. At L2 the human is never removed; only
 *     L5/L6 relax that, and this seam is where that relaxation will
 *     later be made configurable.
 */

import {
  DEFAULT_GATE_THRESHOLDS,
  evaluateGate,
  type GateDecision,
  type GateThresholds,
  type PairedSample,
} from "../infra/confidence.ts";

/** The Tier 0 outcome for the candidate adapter — the safety floor. A
 *  candidate that regresses Tier 0 is rejected outright, no statistics. */
export interface Tier0Result {
  passed: boolean;
  /** For the human card / journal: which checks failed, if any. */
  failedSpecIds?: string[];
}

export type LoraGateVerdict =
  /** Stats + safety both say promote — hand to the human for the final call. */
  | "recommend_promote"
  /** Safety or statistics say no — do not surface for promotion. */
  | "reject"
  /** Not enough eval samples to judge — needs more eval tasks, not a reject
   *  of the adapter itself. */
  | "insufficient_evidence";

export interface LoraGateResult {
  verdict: LoraGateVerdict;
  /** Human-readable rationale, safe for the review card + journal. */
  reason: string;
  /** The underlying confidence decision (undefined when Tier 0 blocked
   *  before statistics ran). */
  confidence?: GateDecision;
  /** True while the L2 human gate is in force — the host MUST get an
   *  explicit human approval before calling `LoraRegistry.promote`, even
   *  on `recommend_promote`. Always true at L2 (see module docblock). */
  humanApprovalRequired: boolean;
}

/**
 * Pure verdict for a candidate adapter.
 *
 * @param tier0   the candidate's Tier 0 outcome (safety floor)
 * @param samples paired eval scores: `candidate` = adapter loaded,
 *                `baseline` = current champion (or plain foundation model
 *                when the domain has no champion yet)
 * @param thresholds confidence thresholds (defaults = the locked config-
 *                ladder thresholds; pass a stricter set for LoRA if a
 *                future retune diverges — audited like any threshold)
 */
export function evaluateLoraGate(
  tier0: Tier0Result,
  samples: readonly PairedSample[],
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
): LoraGateResult {
  // Safety floor first — a Tier 0 regression is disqualifying regardless
  // of how much the candidate "improves" the suite average.
  if (!tier0.passed) {
    const which = tier0.failedSpecIds?.length
      ? ` (${tier0.failedSpecIds.join(", ")})`
      : "";
    return {
      verdict: "reject",
      reason: `Tier 0 safety floor failed${which} — candidate cannot be promoted`,
      humanApprovalRequired: true,
    };
  }

  const decision = evaluateGate(samples, thresholds);

  // Distinguish "not enough data" from "judged and rejected": the former
  // is a call to gather more eval tasks, not a verdict on the adapter.
  if (!decision.accept && decision.reason.startsWith("insufficient samples")) {
    return {
      verdict: "insufficient_evidence",
      reason: decision.reason,
      confidence: decision,
      humanApprovalRequired: true,
    };
  }

  if (!decision.accept) {
    return {
      verdict: "reject",
      reason: decision.reason,
      confidence: decision,
      humanApprovalRequired: true,
    };
  }

  return {
    verdict: "recommend_promote",
    reason: `passes Tier 0 and confidence gate — ${decision.reason}`,
    confidence: decision,
    humanApprovalRequired: true,
  };
}
