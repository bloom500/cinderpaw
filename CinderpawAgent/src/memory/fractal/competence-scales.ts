/**
 * Competence at scales (competence plan §3.2), first slice: the two scales
 * above a receipt, each keeping the receipts that support it and the ones
 * that contradict it, so a generalisation can be NARROWED by a
 * counterexample and never quietly becomes a truth by repetition.
 *
 *   action     one receipt: this step, this condition, verified or refused.
 *   procedure  `LearnedProcedure` (skill-library.ts): one step verified for
 *              one condition, with held-out evidence.
 *   strategy   one step verified across SEVERAL conditions: "fix-import-paths
 *              handles these failure signatures". Its `covers` is the exact
 *              list of conditions the procedures under it hold for; it does
 *              not claim the conditions in between.
 *
 * What is deliberately NOT here yet: the `principle` scale (a claim about
 * choosing between strategies), and any wording. Both need a model to
 * summarise, and a summary with no receipts under it is what this file
 * exists to prevent; until the summariser can be given receipts, the
 * scales are structural. The RAPTOR tree (`tree-builder.ts`) is untouched:
 * this is an overlay computed from receipts, and it becomes the tree's
 * `support` field when the summariser is wired (plan §3.2 sketch).
 *
 * The rule, from Astra's text: when a counterexample arrives, find which
 * generalisation must be restricted. `narrow` removes exactly the condition
 * the counterexample came from and records the receipt as `against`. A
 * strategy that covers nothing any more is `retired` with its history,
 * not deleted.
 */

import type { LearnedProcedure } from "./skill-library.ts";
import type { Attempt } from "../../rsi/l3-code/experiment-selector.ts";

const receiptIdOf = (a: Attempt) => `${a.file}@${a.ts}`;

export interface Support {
  /** Receipt ids that verified the claim. */
  for: string[];
  /** Receipt ids that contradicted it. Kept forever. */
  against: string[];
}

export interface Strategy {
  id: string;
  /** The step every procedure under this strategy shares. */
  step: string;
  /** The conditions it holds for, exactly. */
  covers: string[];
  /** Procedure ids under it. */
  procedures: string[];
  support: Support;
  /** Conditions removed by counterexamples, with the receipt that did it. */
  narrowed: Array<{ condition: string; byReceipt: string; at: number }>;
  /** Set when `covers` is empty: nothing left, history kept. */
  retired?: { at: number; reason: string };
}

export interface CompetenceScales {
  /** Every receipt counts as an action; this is how many. */
  actions: number;
  procedures: LearnedProcedure[];
  strategies: Strategy[];
}

/** Two or more conditions are a strategy; one is just a procedure. */
export const MIN_CONDITIONS_FOR_STRATEGY = 2;

/**
 * Build the scales from what exists: the library's live procedures grouped
 * by step, and every receipt read for support. A receipt that REFUSED the
 * step under a covered condition is `against` from the start: the strategy
 * is built already knowing its counterexamples, it does not get to forget
 * them because a procedure was induced later.
 */
export function buildScales(receipts: Attempt[], procedures: LearnedProcedure[]): CompetenceScales {
  const live = procedures.filter((p) => !p.retired);
  const byStep = new Map<string, LearnedProcedure[]>();
  for (const p of live) {
    const step = p.steps[0]?.tool;
    if (step) byStep.set(step, [...(byStep.get(step) ?? []), p]);
  }
  const strategies: Strategy[] = [];
  for (const [step, procs] of byStep) {
    const covers = [...new Set(procs.map((p) => p.conditions.condition))].sort();
    if (covers.length < MIN_CONDITIONS_FOR_STRATEGY) continue;
    const coverSet = new Set(covers);
    const relevant = receipts.filter((a) => a.file === step && a.condition !== undefined && coverSet.has(a.condition));
    strategies.push({
      id: `strat-${step}`,
      step,
      covers,
      procedures: procs.map((p) => p.id),
      support: {
        for: relevant.filter((a) => a.verdict === "accept").map(receiptIdOf),
        against: relevant.filter((a) => a.verdict !== "accept").map(receiptIdOf),
      },
      narrowed: [],
    });
  }
  return { actions: receipts.length, procedures: live, strategies };
}

/**
 * A counterexample: a receipt that refused the strategy's step under one of
 * the conditions it covers. The strategy is narrowed to exclude that
 * condition, the receipt is recorded against it, and the procedure for
 * that condition is returned so the caller can retire it in the library.
 * A receipt that is not a counterexample (different step, uncovered
 * condition, or an accept) changes nothing and says so.
 */
export function narrow(
  strategy: Strategy,
  counterexample: Attempt,
  now = Date.now(),
): { strategy: Strategy; changed: boolean; retireProcedureFor?: string } {
  const cond = counterexample.condition;
  if (
    counterexample.file !== strategy.step ||
    counterexample.verdict === "accept" ||
    cond === undefined ||
    !strategy.covers.includes(cond)
  ) {
    return { strategy, changed: false };
  }
  const id = receiptIdOf(counterexample);
  const covers = strategy.covers.filter((c) => c !== cond);
  const next: Strategy = {
    ...strategy,
    covers,
    support: { for: strategy.support.for, against: [...strategy.support.against, id] },
    narrowed: [...strategy.narrowed, { condition: cond, byReceipt: id, at: now }],
    ...(covers.length === 0 ? { retired: { at: now, reason: `every covered condition was contradicted; last by ${id}` } } : {}),
  };
  return { strategy: next, changed: true, retireProcedureFor: cond };
}
