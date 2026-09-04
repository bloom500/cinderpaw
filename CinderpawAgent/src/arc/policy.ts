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
 * IMAGINATION IS NOW WIRED IN, on exactly the terms that note set out.
 * `imagination.ts` learns a DSL program per action by MCTS over the
 * before/after pairs this table is already collecting, which lets the agent
 * predict what an action would do in a state it has never stood in. The rules
 * of engagement, unchanged from the note:
 *
 *   - Observation outranks imagination, always. A prediction is consulted ONLY
 *     for a state+action the table has no entry for. Where the table has seen
 *     it, the table is the answer.
 *   - An imagined verdict DEMOTES, it never vetoes. A predicted no-op drops an
 *     action out of the promising tier and no further; the hard override that
 *     replaces a chosen action stays observation-only. An imagined veto can be
 *     wrong; an observed one cannot.
 *   - A rule is trusted only when it reproduces EVERY pair it was learned from
 *     and was learned from more than one. A rule from a single pair that
 *     matches that pair is 1.0 confidence and worth almost nothing.
 *
 * AND THE SEARCH IS NOT FREE, which the original plan got half right. It costs
 * no keypresses, so it is free against the SCORE. It costs wall-clock, and the
 * scorecard closes 15 minutes after it opens — so it is not free against the
 * RUN. `learnBudgetMs` is a hard total: when the search has spent it, learning
 * stops for the rest of the level and play continues on the table alone.
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
import { recordOutcome, type ActionHistory } from "./imagination.ts";
// The MCTS learner in `imagination.ts` is not imported any more, and the
// measurement is why: on 59 real presses of ls20 the best programs it found
// were rotate(rotate(g,270),90) — the identity in two steps — at confidence
// 0.44, so no rule ever passed the 1.0 threshold and nothing it did changed a
// single decision in any game. It searches whole-grid transforms; a press here
// moves one sprite. See imagination-move.ts.
import {
  learnMoveRules,
  imagineMove,
  type MoveRule,
} from "./imagination-move.ts";

/**
 * How many distinct states an action must do nothing in before it is presumed
 * inert everywhere. Three, not two: two is a coincidence in a small grid, and
 * the price of the threshold is paid once per action per level (four actions =
 * at most twelve exploratory presses) while the price of getting it wrong is
 * paid on a level we might otherwise have won.
 */
const INERT_AFTER = 3;

/**
 * How many press outcomes to carry forward. Matches the inner policy's default
 * history length, so the outcome lines line up with the presses it is already
 * being shown rather than adding a second, longer history.
 */
const OUTCOME_HISTORY = 8;

/** Rehearsal settings. Absent = table only, exactly as before. */
export interface ImaginationOptions {
  /**
   * Kept for callers that still pass it; the move learner reads the change
   * between two boards directly and has no search to give iterations to.
   */
  iterations?: number;
  /**
   * Pairs a rule must be learned from before it is believed. Two, because a
   * rule fitted to one example reproduces that example by construction.
   */
  minPairs?: number;
  /** Re-run the search once this many new pairs have arrived since the last one. */
  relearnEvery?: number;
  /**
   * Total wall-clock the search may spend on this level, ever. Not a per-pass
   * timeout: the scorecard's 15-minute window is a total, so this is too.
   */
  learnBudgetMs?: number;
}

export interface FrugalPolicyOptions {
  /** The policy that actually decides. Told which actions are worth deciding between. */
  inner: ArcPolicy;
  /**
   * Called when a confirmed no-op is overridden, for the run log. A veto that
   * happens silently is a veto nobody can audit after a bad score.
   */
  onVeto?: (rejected: string, chosen: string) => void;
  /** Turn on MCTS rehearsal. Omit and nothing about this module changes. */
  imagination?: ImaginationOptions;
  /**
   * Every learning pass, for the run log: what was learned, what it cost, and
   * whether the budget ran out. Without this, "did imagination help" is not a
   * question the run can answer afterwards — which is the whole reason to
   * wire it in.
   */
  onLearn?: (info: {
    rules: readonly MoveRule[];
    trusted: number;
    elapsedMs: number;
    budgetSpent: boolean;
  }) => void;
  /** A prediction actually changed the ranking. The delta, made countable. */
  onImagined?: (action: string, verdict: "noop" | "revisit") => void;
  /**
   * What each press DID, as it is learned — the same judgement the inner policy
   * is handed as `ctx.outcomes`, published so something outside the press loop
   * can read it too. Absent by default; nothing here changes when it is.
   *
   * This is the only place in the run that knows whether a press mattered, and
   * knowing that is what a supervisor reviews and what one game can tell the
   * next. Passing it out beats recomputing it: a second implementation of
   * "did the board move" would have to rediscover the HUD, and the two would
   * disagree the first time one of them was wrong.
   */
  onOutcome?: (info: { action: string; changed: boolean; presses: number }) => void;
}

/**
 * Wrap a policy so it stops paying for actions it has already proven inert.
 *
 * ONE INSTANCE PER GAME, not per level — the runner builds it before the attempt
 * loop and it lives across every level and every retry. That is deliberate and
 * it is the cheapest thing in this file: what an action does is a property of
 * the GAME, so relearning it at each level boundary means paying real presses
 * to rediscover that the same button still does the same thing. NVIDIA's AVO
 * writeup names persistent memory across attempts as its main lever for exactly
 * this reason.
 *
 * Two halves age differently, which is why keeping both is safe:
 *
 *  - The transition table is keyed by the exact grid, so a new level's grids
 *    simply never match the old entries. Stale rows are inert, not wrong.
 *  - The learned RULES are re-scored against every pair they came from on each
 *    pass, so a rule that held in level 1 and fails in level 2 drops below full
 *    confidence and stops being believed. Self-correcting, by measurement.
 *
 * ponytail: the inertness INFERENCE (`likelyInert`) is the one part that
 * generalises across a boundary it cannot see — an action that did nothing all
 * through level 1 stays demoted into level 2, and since demotion keeps it out
 * of the promising tier it may not get retried for a while. It fails open, so
 * the ceiling is a few wasted presses rather than a stuck agent. If a run shows
 * that costing levels, clear `perAction` on a level change and keep the rest.
 */
export function createFrugalPolicy(options: FrugalPolicyOptions): ArcPolicy {
  const { inner, onVeto, imagination, onLearn, onImagined, onOutcome } = options;
  const imagineMinPairs = Math.max(2, imagination?.minPairs ?? 2);
  const relearnEvery = Math.max(1, imagination?.relearnEvery ?? 4);
  const learnBudgetMs = imagination?.learnBudgetMs ?? 20_000;

  /** Before/after pairs per action — the training set the search runs on. */
  let history: ActionHistory[] = [];
  /** Rules currently believed. Replaced wholesale by each learning pass. */
  let rules: MoveRule[] = [];
  let pairsSinceLearn = 0;
  let learnMsSpent = 0;

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
  /**
   * The action in flight: its result is whatever grid the next call shows us.
   * The grid itself is kept, not just its key, because the search learns from
   * the grid and a key cannot be turned back into one.
   */
  let pending: { action: string; grid: readonly (readonly number[])[] } | null = null;
  const hud = createHudDetector();
  /** Identity of a grid, with the HUD cut out. See `createHudDetector`. */
  const keyOf = (grid: readonly (readonly number[])[]): string => hud.key(grid);
  /**
   * One line per press, oldest first: what was pressed and whether the grid
   * moved. The table below has always known this and thrown it away, using it
   * only to filter the offered list. Telling the inner policy is free — tens of
   * prompt tokens — and it removes the question it otherwise re-answers every
   * turn at thousands of completion tokens a press.
   */
  const outcomes: string[] = [];
  /** Presses whose result has been seen. Not `taken.length`: the last press is still in flight. */
  let pressCount = 0;

  return async (observation: ArcObservation, ctx: PolicyContext): Promise<string | null> => {
    // Learn what the environment repaints regardless of what we press, BEFORE
    // anything is keyed. When that set changes, everything keyed under the old
    // one is answering a different question and is thrown away — it was noise,
    // not knowledge.
    if (pending && hud.observe(pending.grid, observation.grid)) {
      transitions.clear();
      visited.clear();
      perAction.clear();
      outcomes.length = 0;
    }
    const here = keyOf(observation.grid);

    // The previous call's action landed us here. This is the only place the
    // table learns, and it learns from what happened rather than from what was
    // predicted.
    if (pending) {
      const from = keyOf(pending.grid);
      transitions.set(edge(from, pending.action), here);
      const stat = perAction.get(pending.action) ?? { inertIn: new Set<string>(), everMoved: false };
      if (here === from) stat.inertIn.add(from);
      else stat.everMoved = true;
      perAction.set(pending.action, stat);
      // The same observation, kept in the shape the search wants: the grid
      // before the action and the grid after it ARE a supervised pair, which
      // is why `imagination.ts` needs no data the table was not collecting.
      if (imagination) {
        history = recordOutcome(history, pending.action, cloneGrid(pending.grid), cloneGrid(observation.grid));
        pairsSinceLearn++;
      }
      const changed = here !== from;
      outcomes.push(`${pending.action} -> ${changed ? "the grid changed" : "nothing changed"}`);
      if (outcomes.length > OUTCOME_HISTORY) outcomes.shift();
      pressCount++;
      onOutcome?.({ action: pending.action, changed, presses: pressCount });
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

    // Re-learn, on a schedule and inside a total time budget. Every pass
    // replaces the rule set wholesale: a rule that no longer reproduces its
    // pairs must not survive on the strength of having once been true.
    if (imagination && pairsSinceLearn >= relearnEvery && learnMsSpent < learnBudgetMs) {
      const startedAt = Date.now();
      rules = learnMoveRules(history);
      const elapsedMs = Date.now() - startedAt;
      learnMsSpent += elapsedMs;
      pairsSinceLearn = 0;
      onLearn?.({
        rules,
        trusted: rules.filter((r) => r.pairsSeen >= imagineMinPairs).length,
        elapsedMs,
        budgetSpent: learnMsSpent >= learnBudgetMs,
      });
    }

    /**
     * What the rules say this action would do HERE — consulted only where the
     * table is silent, because an observation is worth more than a prediction
     * and the table already answers everywhere it has been.
     */
    const predicted = (action: string): string | null => {
      if (rules.length === 0) return null;
      if (known(action) !== undefined) return null; // observed: not our business
      const rule = rules.find((r) => r.action === action);
      if (!rule || rule.pairsSeen < imagineMinPairs) return null;
      // `imagineMove` answers null when it cannot pick the sprite out of the
      // board or has never watched what is ahead of it. Null is not "nothing
      // happens" — it is no belief, and it must not reach the caller as one.
      const after = imagineMove(rules, action, cloneGrid(observation.grid));
      return after ? keyOf(after) : null;
    };
    const imaginedNoop = (action: string): boolean => predicted(action) === here;
    const imaginedRevisit = (action: string): boolean => {
      const next = predicted(action);
      return next !== null && next !== here && visited.has(next);
    };

    // Three tiers, best first. Untried actions count as promising: unknown is
    // not the same as bad, and on this benchmark the alternative to an unknown
    // action is usually a known-useless one.
    //
    // Imagination only ever removes from the TOP tier. `moving` — the fallback
    // when nothing is promising — is filtered by observation alone, so a wrong
    // prediction costs a reordering and can never narrow the choice to nothing.
    const doubted = (action: string): boolean => {
      if (!imagination) return false;
      if (imaginedNoop(action)) {
        onImagined?.(action, "noop");
        return true;
      }
      if (imaginedRevisit(action)) {
        onImagined?.(action, "revisit");
        return true;
      }
      return false;
    };
    const promising = ctx.actions.filter((a) => !useless(a) && !isRevisit(a) && !doubted(a));
    const moving = ctx.actions.filter((a) => !useless(a));
    // Fail open, always. Narrowing the choice to nothing would strand the
    // agent, which is worse than any wasted action — see play-level.ts, where
    // an empty answer ends the level.
    const offered = promising.length > 0 ? promising : moving.length > 0 ? moving : [...ctx.actions];

    const choice = await inner(observation, { ...ctx, actions: offered, outcomes });
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

    pending = { action: final, grid: observation.grid };
    return final;
  };
}

function edge(gridKey: string, action: string): string {
  return `${gridKey}|${action}`;
}

/**
 * A rule worth acting on: reproduces every pair it was learned from, and was
 * learned from more than one of them. `imagination.ts` reports both numbers
 * precisely because confidence alone cannot tell those two cases apart.
 */
/**
 * A mutable copy. The search's DSL takes `number[][]` and compiled programs are
 * free to write into what they are given; the observation belongs to the
 * environment and must come back unchanged.
 */
function cloneGrid(grid: readonly (readonly number[])[]): number[][] {
  return grid.map((row) => [...row]);
}

/**
 * A grid's identity as a string. JSON rather than a hash: grids here are small,
 * a collision would silently veto a legitimate action, and there is no budget
 * pressure on memory — only on keypresses.
 */
function gridKey(grid: readonly (readonly number[])[]): string {
  return JSON.stringify(grid);
}

/**
 * How many presses to watch before believing anything. Below this a row that
 * happens to change twice looks identical to a counter, and condemning a real
 * row costs us the state it encodes.
 */
const HUD_WARMUP = 6;
/**
 * The most of the board that may be written off as decoration. A game whose
 * every row genuinely repaints is not a game with a HUD, it is an animated
 * board, and blanking it would make every state identical — which is worse
 * than the problem this solves. Past this share we conclude there is no HUD.
 */
const HUD_MAX_SHARE = 0.25;
/**
 * How many presses a strip may fail to repaint and still count as a counter.
 * It was `n === comparisons` - every press, no exceptions - and one exception
 * is all it takes. Measured on the Luna canary (`arc-1787929749503`, ls20,
 * 100 presses): rows 61 and 62 repainted in 98 of 99 comparisons and the next
 * busiest real row in 9. Exact equality disqualified them forever on that one
 * miss, so no HUD was ever found, every grid stayed unique, no action was ever
 * seen as inert, and the run pressed ACTION2 87 times for 0 levels while the
 * outcome feed reported "the grid changed" on every one of them.
 *
 * An ABSOLUTE budget, not a share. A share loosens as the run grows - 0.9 over
 * 99 comparisons forgives nine misses - and that is how it starts eating real
 * rows: measured on the 100-game stress, which has no counter in it by design,
 * a 0.9 share invented 11 vetoes and cost 228 extra actions for the same 84
 * wins. A counter misses rarely in absolute terms however long the game runs.
 *
 * ponytail: two is the smallest budget that covers the canary's one miss with
 * room for a second. If a game ever ticks its counter more raggedly than this,
 * the budget is the knob - raise it here, and re-run the stress to see what it
 * costs on boards that have no counter at all.
 */
const HUD_MISS_BUDGET = 2;

/**
 * Finds the parts of the grid the environment repaints on EVERY press, no
 * matter what was pressed: a move counter, a timer, a progress bar.
 *
 * This is not cosmetic. Such a region makes every grid unique forever, and the
 * whole module above is built on recognising a grid it has seen before. With a
 * counter in the key nothing is ever a repeat, so no action is ever observed to
 * be a no-op, no state is ever a revisit, and the transition table, the inert
 * detector and the move learner all collect entries that can never match. That
 * is not a theory: on ARC game `bp35-0a0ad940` row 63 is a 64-press move bar
 * and changed on 31 of 31 presses, while the busiest real row changed on 5. The
 * run reported 0 vetoes, 0 trusted rules and 0 demotions over 32 presses, and
 * 17 of those presses did nothing to the board at all.
 *
 * ponytail: whole rows and columns, not arbitrary regions. A counter has to
 * tick every press to be a counter, and a strip is the shape they come in.
 * If a game ever hides one in a corner box, this becomes a per-cell tally.
 */
function createHudDetector() {
  let comparisons = 0;
  const rowChanges = new Map<number, number>();
  const colChanges = new Map<number, number>();
  let rows = new Set<number>();
  let cols = new Set<number>();

  const settled = (changes: Map<number, number>, limit: number): Set<number> => {
    if (comparisons < HUD_WARMUP) return new Set<number>();
    const always = [...changes].filter(([, n]) => comparisons - n <= HUD_MISS_BUDGET).map(([i]) => i);
    // All of it "always changes" means none of it is a HUD — see HUD_MAX_SHARE.
    return always.length > limit * HUD_MAX_SHARE ? new Set<number>() : new Set(always);
  };

  return {
    /** Records one before/after pair. True when the HUD set moved, so the caller can forget what it keyed under the old one. */
    observe(before: readonly (readonly number[])[], after: readonly (readonly number[])[]): boolean {
      // A resize is a different board; nothing learned about the old one holds.
      if (before.length !== after.length) return false;
      comparisons++;
      const width = after[0]?.length ?? 0;
      const changedCols = new Set<number>();
      for (let y = 0; y < after.length; y++) {
        const a = before[y] ?? [];
        const b = after[y] ?? [];
        let rowMoved = false;
        for (let x = 0; x < b.length; x++) {
          if (a[x] !== b[x]) {
            rowMoved = true;
            changedCols.add(x);
          }
        }
        if (rowMoved) rowChanges.set(y, (rowChanges.get(y) ?? 0) + 1);
      }
      for (const x of changedCols) colChanges.set(x, (colChanges.get(x) ?? 0) + 1);

      const nextRows = settled(rowChanges, after.length);
      const nextCols = settled(colChanges, width);
      const moved = !sameSet(rows, nextRows) || !sameSet(cols, nextCols);
      rows = nextRows;
      cols = nextCols;
      return moved;
    },
    /** The grid's identity with the HUD cut out. Identical to `gridKey` until a HUD is found. */
    key(grid: readonly (readonly number[])[]): string {
      if (rows.size === 0 && cols.size === 0) return gridKey(grid);
      return JSON.stringify(
        grid.map((row, y) => (rows.has(y) ? null : row.filter((_, x) => !cols.has(x)))),
      );
    },
  };
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
