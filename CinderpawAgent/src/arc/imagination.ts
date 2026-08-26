/**
 * The agent's imagination: what it believes each action DOES, learned from
 * actions it has already spent, so it can rehearse the next one for free.
 *
 * This is where the second half of the plan lives. The loop
 * (`play-level.ts`) is Darius's "Variant 1" — the agent looks, thinks, presses
 * one button. This module is "Variant 2" folded inside it: MCTS searches for a
 * grid transform that explains what an action did, and once found, the agent
 * can predict that action's effect without pressing anything.
 *
 * WHY IT IS SHAPED THIS WAY. `runMCTSVerification` searches for a program
 * mapping example pairs `{input, output}` — the ARC-AGI-1/2 shape, which is
 * why the checkpoint called the stack cut for a different benchmark. But an
 * action IS an example pair: the grid before, and the grid after. So each
 * action the agent spends produces one training pair for that action, and the
 * existing search applies unmodified. Nothing here re-implements the solver;
 * it feeds it the pairs the game was already producing.
 *
 * WHAT IT DOES NOT DO. It never touches the environment. Learning happens from
 * history, prediction happens from a compiled transform, and both are free.
 * The moment this module could spend an action, the squared penalty would make
 * it a liability rather than an advantage — an agent that presses buttons to
 * learn the rules can understand a game perfectly and still score 30.
 *
 * HONEST LIMIT, stated because the whole idea rests on it: this assumes an
 * action behaves like a deterministic grid→grid transform. Real ARC-AGI-3
 * games may not be that — an action can depend on hidden state, or on where
 * the agent is, or be non-deterministic. `confidence` exists precisely so a
 * policy can find out cheaply that the assumption does not hold here, and fall
 * back to reasoning about the grid directly. A rule that has not reproduced
 * every pair it was learned from is reported as low confidence, never hidden.
 */

import { compileProgram, runMCTSVerification, type Grid, type TaskPair } from "../core/mcts-verifier.ts";

/** One action, and the before/after pairs observed for it. */
export interface ActionHistory {
  action: string;
  pairs: TaskPair[];
}

export interface LearnedRule {
  action: string;
  /** The program body found, in DSL scope. */
  programCode: string;
  /**
   * Share of observed pairs this rule reproduces exactly, 0..1. A rule learned
   * from one pair that reproduces that one pair is 1.0 and still worth almost
   * nothing — `pairsSeen` is reported next to it so a policy can weigh both
   * rather than trusting a number that cannot distinguish them.
   */
  confidence: number;
  pairsSeen: number;
}

export interface LearnOptions {
  /** Search budget per action. Free in benchmark terms — this is CPU, not keypresses. */
  iterations?: number;
}

/**
 * Turn the actions taken so far into a rule per action.
 *
 * An action with no pairs yields no rule: there is nothing to generalise from,
 * and inventing one would be the panel-of-telemetry mistake in another costume.
 */
export async function learnActionRules(
  history: readonly ActionHistory[],
  options: LearnOptions = {},
): Promise<LearnedRule[]> {
  const rules: LearnedRule[] = [];
  for (const entry of history) {
    if (!entry || !Array.isArray(entry.pairs) || entry.pairs.length === 0) continue;
    let report;
    try {
      report = await runMCTSVerification(entry.pairs, { iterations: options.iterations ?? 200 });
    } catch {
      // A search that cannot run on this action's pairs is a "no rule", not a
      // crashed turn: the agent must keep playing with whatever else it knows.
      continue;
    }
    // The winning program lives on the best node; the root's is null
    // (identity), which is not a rule worth recording.
    const code = report?.bestNode?.programCode;
    if (typeof code !== "string" || code.trim() === "") continue;

    // Score the rule against every pair it was learned from, rather than
    // trusting the search's own verdict — the two can disagree when the search
    // stops early, and the honest number is the one measured here.
    let matched = 0;
    let transform: (g: Grid) => Grid;
    try {
      transform = compileProgram(code);
    } catch {
      continue;
    }
    for (const pair of entry.pairs) {
      let out: Grid;
      try {
        out = transform(pair.input);
      } catch {
        continue;
      }
      if (gridsEqual(out, pair.output)) matched++;
    }
    rules.push({
      action: entry.action,
      programCode: code,
      confidence: matched / entry.pairs.length,
      pairsSeen: entry.pairs.length,
    });
  }
  return rules;
}

/**
 * What the agent believes this action would do to this grid, or null when it
 * has no belief worth acting on.
 *
 * Free: no environment call. This is the whole point — rehearsing is what the
 * budget does not charge for.
 */
export function imagine(rules: readonly LearnedRule[], action: string, grid: Grid): Grid | null {
  const rule = rules.find((r) => r.action === action);
  if (!rule) return null;
  try {
    return compileProgram(rule.programCode)(grid);
  } catch {
    return null;
  }
}

/**
 * Record one action's outcome. Returns a NEW history — the caller keeps the
 * old one, because a policy that mutates its own memory mid-turn is a policy
 * nobody can replay.
 */
export function recordOutcome(
  history: readonly ActionHistory[],
  action: string,
  before: Grid,
  after: Grid,
): ActionHistory[] {
  const next = history.map((h) => ({ action: h.action, pairs: [...h.pairs] }));
  const entry = next.find((h) => h.action === action);
  const pair: TaskPair = { input: before, output: after };
  if (entry) entry.pairs.push(pair);
  else next.push({ action, pairs: [pair] });
  return next;
}

function gridsEqual(a: Grid, b: Grid): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    const ra = a[r];
    const rb = b[r];
    if (!Array.isArray(ra) || !Array.isArray(rb) || ra.length !== rb.length) return false;
    for (let c = 0; c < ra.length; c++) if (ra[c] !== rb[c]) return false;
  }
  return true;
}
