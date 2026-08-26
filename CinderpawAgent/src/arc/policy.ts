/**
 * The policy layer — and specifically the half that decides the score: what
 * NOT to press.
 *
 * A level scores `(human_actions / ai_actions)^2`. Nothing else is measured.
 * So there are two ways to score well, and only one of them is cheap: be
 * cleverer than a human, or stop wasting keypresses. This module is the second
 * one. It does not know how to play any game — that is `inner`'s job, and
 * `inner` may be a model, a search, or a hand-written heuristic. This wraps it
 * and refuses to let it spend an action that is already known to buy nothing.
 *
 * WHY A TABLE AND NOT THE SEARCH. `imagination.ts` learns a DSL program per
 * action so the agent can rehearse in unseen states. That is the more general
 * mechanism and it stays. But it cannot express the case that matters most
 * here: `learnActionRules` reads `bestNode.programCode`, and the identity
 * program lives on the ROOT, whose `programCode` is null. An action that does
 * nothing therefore produces no rule at all, and `imagine()` answers "no
 * belief" for the single clearest waste in the benchmark. What this module
 * needs is not generalisation, it is memory: the agent already pressed that
 * button in that exact position and saw the grid not move.
 *
 * So: a transition table built from actions actually taken. Exact, free, no
 * search, no model call, and correct by observation rather than by inference.
 *
 * ponytail: the table only knows states it has already stood in. Generalising
 * to unseen states is exactly what `imagination.ts` is for — wire `imagine()`
 * in as a SECOND opinion (predict, then check the prediction against the table
 * when the table has an entry) when the table's coverage measurably stops
 * being enough. Not before: an imagined veto can be wrong, an observed one
 * cannot.
 *
 * HONEST LIMIT, the same one imagination.ts states: this assumes an action is
 * a deterministic function of the visible grid. If a game carries hidden state
 * — a counter, a timer, an off-screen position — then "this did nothing last
 * time" is not a promise it will do nothing again. That is why a veto only
 * ever redirects to another action that is available anyway, and never stops
 * the run: the worst case of a wrong veto is a different button, not a
 * stranded agent.
 */

import type { ArcObservation } from "./environment.ts";
import type { ArcPolicy, PolicyContext } from "./play-level.ts";

/**
 * How many distinct states an action must do nothing in before it is presumed
 * inert everywhere. Three, not two: two is a coincidence in a small grid, and
 * the price of the threshold is paid once per action per level (four actions =
 * at most twelve exploratory presses) while the price of getting it wrong is
 * paid on a level we might otherwise have won.
 */
const INERT_AFTER = 3;

export interface FrugalPolicyOptions {
  /** The policy that actually decides. Told which actions are worth deciding between. */
  inner: ArcPolicy;
  /**
   * Called when a confirmed no-op is overridden, for the run log. A veto that
   * happens silently is a veto nobody can audit after a bad score.
   */
  onVeto?: (rejected: string, chosen: string) => void;
}

/**
 * Wrap a policy so it stops paying for actions it has already proven inert.
 *
 * One instance per level. The table is the level's own history and means
 * nothing in another game.
 */
export function createFrugalPolicy(options: FrugalPolicyOptions): ArcPolicy {
  const { inner, onVeto } = options;

  /** `${gridKey}|${action}` -> the grid key that action produced from there. */
  const transitions = new Map<string, string>();
  /** Every grid seen this level, so "leads somewhere I have already been" is answerable. */
  const visited = new Set<string>();
  /**
   * Per action: the distinct states it did nothing from, and whether it has
   * EVER moved anything. This is what makes the table worth more than its
   * entries — a wall is inert in every cell, and learning that once per cell
   * is 256 wasted presses on a 16x16 grid.
   */
  const perAction = new Map<string, { inertIn: Set<string>; everMoved: boolean }>();
  /** The action in flight: its result is whatever grid the next call shows us. */
  let pending: { from: string; action: string } | null = null;

  return async (observation: ArcObservation, ctx: PolicyContext): Promise<string | null> => {
    const here = gridKey(observation.grid);

    // The previous call's action landed us here. This is the only place the
    // table learns, and it learns from what happened rather than from what was
    // predicted.
    if (pending) {
      transitions.set(edge(pending.from, pending.action), here);
      const stat = perAction.get(pending.action) ?? { inertIn: new Set<string>(), everMoved: false };
      if (here === pending.from) stat.inertIn.add(pending.from);
      else stat.everMoved = true;
      perAction.set(pending.action, stat);
      pending = null;
    }
    visited.add(here);

    const known = (action: string): string | undefined => transitions.get(edge(here, action));
    const isNoop = (action: string): boolean => known(action) === here;
    const isRevisit = (action: string): boolean => {
      const next = known(action);
      return next !== undefined && visited.has(next);
    };
    /**
     * Inert everywhere it has been tried, and never once seen to move
     * anything. Unlike the rest of this module this is an INFERENCE, so it is
     * held to a threshold and it is never the last word: a wrongly-condemned
     * action comes back the moment nothing better is on the table, and the
     * only cost of being wrong is that a different button gets pressed.
     */
    const likelyInert = (action: string): boolean => {
      const stat = perAction.get(action);
      return !!stat && !stat.everMoved && stat.inertIn.size >= INERT_AFTER;
    };
    const useless = (action: string): boolean => isNoop(action) || likelyInert(action);

    // Three tiers, best first. Untried actions count as promising: unknown is
    // not the same as bad, and on this benchmark the alternative to an unknown
    // action is usually a known-useless one.
    const promising = ctx.actions.filter((a) => !useless(a) && !isRevisit(a));
    const moving = ctx.actions.filter((a) => !useless(a));
    // Fail open, always. Narrowing the choice to nothing would strand the
    // agent, which is worse than any wasted action — see play-level.ts, where
    // an empty answer ends the level.
    const offered = promising.length > 0 ? promising : moving.length > 0 ? moving : [...ctx.actions];

    const choice = await inner(observation, { ...ctx, actions: offered });
    if (choice === null) return null;

    // The one override. A confirmed no-op costs a full action and returns the
    // agent to the state it is already in, so any other available action beats
    // it — including one we know nothing about. `inner` is told what is worth
    // choosing between; this is what happens when it chooses otherwise anyway.
    let final = choice;
    if (useless(choice)) {
      const alternative = offered.find((a) => !useless(a));
      if (alternative !== undefined) {
        onVeto?.(choice, alternative);
        final = alternative;
      }
    }

    pending = { from: here, action: final };
    return final;
  };
}

function edge(gridKey: string, action: string): string {
  return `${gridKey}|${action}`;
}

/**
 * A grid's identity as a string. JSON rather than a hash: grids here are small,
 * a collision would silently veto a legitimate action, and there is no budget
 * pressure on memory — only on keypresses.
 */
function gridKey(grid: readonly (readonly number[])[]): string {
  return JSON.stringify(grid);
}
