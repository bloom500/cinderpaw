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

/**
 * The principle scale, structural: a claim about CHOOSING between two
 * steps. "Prefer A over B on these conditions" holds on a condition when
 * some receipt verified A there and some receipt refused B there. It is
 * built from receipts alone, so it never says more than was observed: a
 * condition where only A was tried is not on the list, and a condition
 * where both verified is not a preference. Wording, and any principle that
 * is not a pairwise preference, wait for the summariser (file header).
 */
export interface Principle {
  id: string;
  prefer: string;
  over: string;
  /** The conditions the preference was observed on, exactly. */
  on: string[];
  support: Support;
  narrowed: Array<{ condition: string; byReceipt: string; at: number }>;
  retired?: { at: number; reason: string };
}

export function buildPrinciples(receipts: Attempt[]): Principle[] {
  // condition -> step -> {accepted ids, refused ids}
  const table = new Map<string, Map<string, { ok: string[]; no: string[] }>>();
  for (const a of receipts) {
    if (a.condition === undefined) continue;
    const row = table.get(a.condition) ?? new Map();
    const cell = row.get(a.file) ?? { ok: [], no: [] };
    (a.verdict === "accept" ? cell.ok : cell.no).push(receiptIdOf(a));
    row.set(a.file, cell);
    table.set(a.condition, row);
  }
  const out = new Map<string, Principle>();
  for (const [condition, row] of [...table].sort()) {
    for (const [a, ca] of row) {
      for (const [b, cb] of row) {
        // A verified here, B refused here, and never the reverse on this
        // condition: a preference, not a coin flip.
        if (a === b || ca.ok.length === 0 || cb.no.length === 0 || ca.no.length > 0 || cb.ok.length > 0) continue;
        const id = `prin-${a}-over-${b}`;
        const p = out.get(id) ?? { id, prefer: a, over: b, on: [], support: { for: [], against: [] }, narrowed: [] };
        p.on.push(condition);
        p.support.for.push(...ca.ok, ...cb.no);
        out.set(id, p);
      }
    }
  }
  return [...out.values()];
}

/**
 * A counterexample to a principle: on a condition it ranges over, the
 * preferred step was refused, or the other step verified. That condition
 * leaves the list; the receipt is recorded against; a principle left with
 * nothing is retired with its history. A strategy narrowed on a condition
 * the principle never claimed leaves the principle untouched.
 */
export function narrowPrinciple(
  principle: Principle,
  counterexample: Attempt,
  now = Date.now(),
): { principle: Principle; changed: boolean } {
  const cond = counterexample.condition;
  if (cond === undefined || !principle.on.includes(cond)) return { principle, changed: false };
  const contradicts =
    (counterexample.file === principle.prefer && counterexample.verdict !== "accept") ||
    (counterexample.file === principle.over && counterexample.verdict === "accept");
  if (!contradicts) return { principle, changed: false };
  const id = receiptIdOf(counterexample);
  const on = principle.on.filter((c) => c !== cond);
  return {
    changed: true,
    principle: {
      ...principle,
      on,
      support: { for: principle.support.for, against: [...principle.support.against, id] },
      narrowed: [...principle.narrowed, { condition: cond, byReceipt: id, at: now }],
      ...(on.length === 0 ? { retired: { at: now, reason: `every condition was contradicted; last by ${id}` } } : {}),
    },
  };
}
