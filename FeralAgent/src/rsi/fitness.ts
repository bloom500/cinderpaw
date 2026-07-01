/**
 * Fitness Vector — the canonical 6-component shape for ranking candidates (BRSI §2.2).
 *
 * Why this exists separate from `ScoreResult`:
 *   The TS-side `ScoreResult` (`eval-worker.ts:32-35`) is a scalar
 *   `{score: number}`. The Rust scorer already returns a 4-component
 *   `ScoreBreakdown` (success / cost / error / latency, see
 *   `src-tauri/src/rsi/scorer.rs:34-68`) but does not surface it over
 *   the bridge. The BRSI fitness vector extends this to 6 components:
 *
 *     Accuracy · Latency · Cost · ToolSuccess · Hallucination · UserSatisfaction
 *
 *   Two new components (Hallucination, UserSatisfaction) are not yet
 *   measured by the scorer; the TS adapter marks them as unmeasured
 *   and supplies neutral defaults (0.5) so the weighted aggregate
 *   stays well-defined while the missing signals arrive (Personal
 *   Fitness module for UserSatisfaction; a future eval spec for
 *   Hallucination).
 *
 * Discipline: pure types + pure functions. No IO. The "fitness vector"
 *   is a shape that downstream consumers (Journal, Gate, Contract)
 *   reason over; the actual measurement comes from the engine and the
 *   Rust scorer. When Rust is extended to compute all 6 components,
 *   the bridge returns a `FitnessVector` directly and this adapter
 *   becomes a no-op for the measured fields.
 *
 * Locked defaults (BRSI §9 #1, D4): ship with §2.2 weights, learn from
 * Journal after 30 cycles. The "ship defaults" path means the BRSI
 * weights below are live until the meta-evolution layer takes over.
 */

import type { FitnessVector } from "./journal.ts";

/** Re-export the journal's `FitnessVector` shape as the canonical
 *  engine type. Single source of truth lives in `journal.ts` because
 *  that's where the journal schema is owned. */
export type { FitnessVector };

/** Resource keys in the order BRSI §2.2 lists them. The aggregate
 *  function iterates this to apply the locked weights. */
const VECTOR_KEYS: ReadonlyArray<keyof FitnessVector> = [
  "accuracy",
  "latency",
  "cost",
  "toolSuccess",
  "hallucination",
  "userSatisfaction",
];

/** Which components contribute positively (higher better) vs
 *  negatively (lower better) to the weighted aggregate. The Rust
 *  scorer uses the same convention: success/cost/error/latency are
 *  +/-/-/- respectively (`scorer.rs:53-55`). The aggregate uses
 *  `HIGHER_BETTER` as the explicit allow-list; everything else is
 *  implicitly "lower better" — keeping a single allow-list makes the
 *  sign convention a one-line invariant. */
const HIGHER_BETTER: ReadonlyArray<keyof FitnessVector> = [
  "accuracy",
  "toolSuccess",
  "userSatisfaction",
];

/** Weights for the 6 components, summing to 1.0 (BRSI §2.2, locked D4).
 *  The aggregate uses these by default; SandboxBounds should own the
 *  live values so the agent cannot reweight its own scoring. */
export const DEFAULT_FITNESS_WEIGHTS: Record<keyof FitnessVector, number> = {
  accuracy: 0.30,
  latency: 0.20,
  cost: 0.15,
  toolSuccess: 0.15,
  hallucination: 0.10,
  userSatisfaction: 0.10,
};

/** Neutral default for an unmeasured component (0.5 = "no signal").
 *  Picked so the weighted contribution of an unmeasured component is
 *  exactly half of its weight — the agent's aggregate is well-defined
 *  but visibly biased toward "we don't know", which the journal can
 *  surface via the `unmeasured` field. */
export const NEUTRAL_COMPONENT = 0.5;

/** Lift a scalar Rust score into the canonical 6-component shape.
 *  Called by the eval-worker adapter path when the Rust bridge returns
 *  only the aggregate (today's shape).
 *
 *  - `accuracy` is set to the score (coarse proxy; real per-component
 *    values arrive when Rust is extended).
 *  - `latency` and `cost` are mapped inversely — high score implies
 *    low latency/cost — but the mapping is intentionally symmetric
 *    (`1 - score`) so it stays in [0, 1].
 *  - `toolSuccess` mirrors accuracy (the scorer weights it equally in
 *    the 4-component breakdown).
 *  - `hallucination` and `userSatisfaction` are NOT measured yet —
 *    they get the neutral 0.5 default and are recorded in
 *    `unmeasured`. */
export function scoreToFitnessVector(
  score: number,
  opts: { maxScore?: number; unmeasured?: ReadonlyArray<keyof FitnessVector> } = {},
): FitnessVector {
  const max = opts.maxScore ?? 100;
  const normalised = clamp01(score / max);

  // Components the Rust 4-component formula measures (proxies).
  const measured: FitnessVector = {
    accuracy: normalised,
    latency: 1 - normalised,
    cost: 1 - normalised,
    toolSuccess: normalised,
    hallucination: NEUTRAL_COMPONENT,
    userSatisfaction: NEUTRAL_COMPONENT,
  };

  // Caller can override which fields are flagged unmeasured.
  const unmeasured = new Set<keyof FitnessVector>(
    opts.unmeasured ?? ["hallucination", "userSatisfaction"],
  );

  // Apply neutral default to anything flagged unmeasured; this is
  // mostly defensive — the default `measured` already sets the two
  // known-unmeasured fields to neutral, but a future caller may add
  // new ones.
  for (const k of VECTOR_KEYS) {
    if (unmeasured.has(k)) measured[k] = NEUTRAL_COMPONENT;
  }

  return measured;
}

/** Build a FitnessVector from explicit per-component values. Use this
 *  when an upstream signal IS available (e.g., the Personal Fitness
 *  module computed a real userSatisfaction). */
export function fitnessVector(parts: Partial<FitnessVector>): FitnessVector {
  const filled: FitnessVector = {
    accuracy: NEUTRAL_COMPONENT,
    latency: NEUTRAL_COMPONENT,
    cost: NEUTRAL_COMPONENT,
    toolSuccess: NEUTRAL_COMPONENT,
    hallucination: NEUTRAL_COMPONENT,
    userSatisfaction: NEUTRAL_COMPONENT,
  };
  for (const k of VECTOR_KEYS) {
    const v = parts[k];
    if (v !== undefined) filled[k] = clamp01(v);
  }
  return filled;
}

/** Weighted aggregate, in [0, 1]. Mirrors the Rust formula's +/- sign
 *  convention: HIGHER_BETTER components add weight × value, LOWER_BETTER
 *  components subtract weight × value. The result is clamped so a
 *  pathological input cannot push it negative.
 *
 *  This is what the `JournalEntry.result.aggregate` carries — the
 *  single number that downstream gates (Confidence, Goodhart, the
 *  ratchet's strict-greater invariant) compare against. */
export function fitnessVectorAggregate(
  v: FitnessVector,
  weights: Record<keyof FitnessVector, number> = DEFAULT_FITNESS_WEIGHTS,
): number {
  let total = 0;
  for (const k of VECTOR_KEYS) {
    const w = weights[k];
    const x = v[k];
    const sign = HIGHER_BETTER.includes(k) ? 1 : -1;
    total += sign * w * x;
  }
  // The "minus" path can produce negative totals; clamp so the
  // aggregate is interpretable as a score in [0, 1].
  return clamp01(total);
}

/** List the components currently flagged unmeasured by `scoreToFitnessVector`.
 *  Useful for the journal to annotate "this candidate's aggregate is
 *  partial because Hallucination + UserSatisfaction were not measured". */
export function defaultUnmeasured(): ReadonlyArray<keyof FitnessVector> {
  return ["hallucination", "userSatisfaction"];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}