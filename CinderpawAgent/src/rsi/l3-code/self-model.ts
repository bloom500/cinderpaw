/**
 * The self-model: what the agent has learned about its OWN improvement loop,
 * from the ledger of what it predicted and what then happened.
 *
 * "I think I am unsure" is free to say. This module makes it cost something:
 * before each L3 round the proposer commits to numbers (chance of acceptance,
 * expected effect, expected cost, the failure it expects), the contract
 * decides, and the two are compared here. Over enough rounds that comparison
 * is a fact about the agent, conditioned on where it was looking:
 *
 *   - `observedAccept` vs `predictedAccept`: does it know its own odds?
 *   - `brier`: how far off, on average, were its probabilities? 0 is perfect,
 *     0.25 is a coin it did not bother to look at.
 *   - `dominantFailure`: WHAT usually goes wrong here, in a fixed vocabulary
 *     so it can be counted.
 *
 * And it is an instrument, not a diary: `experimentValue` tells the selector
 * where an experiment is worth the tokens (unsure AND promising) and
 * `nothingLeftToLearn` tells the round when to stop before the budget does.
 *
 * Discipline: pure functions over the ledger. The model never writes its own
 * calibration; the runner writes observations, the model only reads them
 * (spec §5: "BRSI does not score itself by counting its own journal rows",
 * and the same rule holds for its opinion of itself).
 */

import type { Attempt, FailureClass } from "./experiment-selector.ts";

/** Rounds on a file before its accept rate is trusted over "unknown". */
export const MIN_ROUNDS_FOR_ESTIMATE = 3;

/** What the ledger says about one place the loop has looked. */
export interface CompetenceEstimate {
  /** Rounds with both a prediction and an observation. */
  n: number;
  /** Mean predicted chance of acceptance, or null with no predictions. */
  predictedAccept: number | null;
  /** Observed acceptance rate over ALL rounds on this file (verdicts do not
   *  need a prediction to count). */
  observedAccept: number;
  /** Mean squared error of pAccept against the outcome; null below one pair. */
  brier: number | null;
  /** Mean observed effect of the accepted rounds, or null with none. */
  meanEffect: number | null;
  /** The failure class seen most on this file, or null. */
  dominantFailure: FailureClass | null;
  /** How unsure the model is about this file, in [0, 1]. 1 with too few
   *  rounds; otherwise 4p(1-p), largest at p = 0.5 and 0 at either end. */
  uncertainty: number;
}

export interface SelfModel {
  /** Per rsi/-relative file. */
  files: Map<string, CompetenceEstimate>;
  /** Over every round with a prediction. */
  overall: CompetenceEstimate;
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function estimate(rows: Attempt[]): CompetenceEstimate {
  const paired = rows.filter((a) => a.predicted && a.observed);
  const accepted = rows.filter((a) => a.verdict === "accept");
  const observedAccept = rows.length === 0 ? 0 : accepted.length / rows.length;

  const counts = new Map<FailureClass, number>();
  for (const a of rows) {
    const c = a.observed?.failureClass ?? null;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let dominantFailure: FailureClass | null = null;
  let top = 0;
  for (const [c, k] of counts) {
    if (k > top) {
      top = k;
      dominantFailure = c;
    }
  }

  const p = observedAccept;
  return {
    n: paired.length,
    predictedAccept: mean(paired.map((a) => a.predicted!.pAccept)),
    observedAccept,
    brier: mean(paired.map((a) => (a.predicted!.pAccept - (a.observed!.accepted ? 1 : 0)) ** 2)),
    meanEffect: mean(
      accepted.map((a) => a.observed?.effect).filter((e): e is number => typeof e === "number"),
    ),
    dominantFailure,
    uncertainty: rows.length < MIN_ROUNDS_FOR_ESTIMATE ? 1 : 4 * p * (1 - p),
  };
}

export function buildSelfModel(attempts: Attempt[]): SelfModel {
  const byFile = new Map<string, Attempt[]>();
  for (const a of attempts) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  const files = new Map<string, CompetenceEstimate>();
  for (const [file, rows] of byFile) files.set(file, estimate(rows));
  return { files, overall: estimate(attempts) };
}

/** Default expected effect for a place the model knows nothing about: half
 *  a point, so the unknown still ranks above a known dead end (effect 0)
 *  and below a known good vein (effect > 0.5). */
const PRIOR_EFFECT = 0.5;

/**
 * How much an experiment on `file` is worth: uncertainty times expected
 * gain. Unsure and promising ranks first; sure-to-fail and sure-to-pass both
 * rank last, because neither teaches anything. Never-tried files score
 * `1 * PRIOR_EFFECT`.
 */
export function experimentValue(model: SelfModel, file: string): number {
  const e = model.files.get(file);
  if (!e) return PRIOR_EFFECT;
  const gain = e.meanEffect ?? PRIOR_EFFECT;
  return e.uncertainty * gain;
}

/**
 * True when no file in the pool is worth an experiment any more: every one
 * has been tried enough times to trust, and each is either a settled dead
 * end or a settled win. That is the stop the spec asks for (§9.4: a plateau
 * is a result), and it fires before the budget does.
 */
export function nothingLeftToLearn(model: SelfModel, pool: string[], epsilon = 0.05): boolean {
  if (pool.length === 0) return true;
  return pool.every((f) => {
    const e = model.files.get(f);
    return e !== undefined && e.n >= MIN_ROUNDS_FOR_ESTIMATE && experimentValue(model, f) < epsilon;
  });
}
