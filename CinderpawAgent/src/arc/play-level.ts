/**
 * The loop the checkpoint said was missing: observe → decide → act.
 *
 * This is the machine that turns the parts bin into a harness. Perception, the
 * DSL, MCTS and the verifier are all reachable from a policy running inside
 * this loop; none of them is imported here, on purpose. The loop's whole job is
 * to hand the policy a view, take one action back, count it, and stop when it
 * should — and a loop that also knew how to think would be two things, neither
 * of them checkable.
 *
 * WHY THE COUNTING IS THE POINT. A level scores
 * `(human_actions / ai_actions)^2`, capped at 1.15x human. Spending double is
 * not a half-score, it is a quarter. So the agent's thinking is free and its
 * keypresses are not, and the one thing this loop must never do is let an
 * action slip out unrecorded or un-budgeted. Every action taken is returned in
 * `actions`, and the budget is hard: at zero remaining, the loop stops rather
 * than taking "just one more".
 *
 * BUT EFFICIENCY IS THE SECOND PRIORITY, NOT THE FIRST — and this file used to
 * have that backwards. The squared penalty is a LEVEL score. A GAME score is
 * the weighted average of its level scores, weighted by 1-indexed level number,
 * and a game you did not finish is capped by the levels you never reached:
 * finishing 4 of 5 means the game cannot exceed 66.7% however perfectly levels
 * 1-4 were played. Later levels are worth more than earlier ones, and reaching
 * them at all beats reaching them cheaply.
 *
 * So the ordering is: FINISH the level, then finish it in few actions. An agent
 * that stops early to protect its ratio is optimising the small number and
 * forfeiting the large one. The budget still exists — an agent has to stop
 * somewhere — but it is a wall, not a target.
 *
 * The policy may look at the observation for as long as it likes, and may run
 * anything it wants in its head — that is where the search belongs. Simulating
 * a move is free; pressing a button to find out is not, and that difference is
 * the entire strategy.
 */

import { isTerminal, type ArcEnvironment, type ArcObservation } from "./environment.ts";

/**
 * Chooses the next action, or `null` to stop voluntarily.
 *
 * `null` means "this level cannot be finished from here" — no legal action can
 * change anything, or the level is provably lost. It does NOT mean "I am not
 * sure what to do", and it is not a way to protect the action ratio.
 *
 * That last part is the correction. This used to read "under a squared penalty,
 * wasted actions cost more than an unfinished level", which is the opposite of
 * how the benchmark scores: an unfinished game is capped by the levels never
 * reached, and the levels not reached are the ones worth the most. A guess that
 * might advance the level is worth more than a clean stop — see the scoring
 * note at the top of this file.
 */
export type ArcPolicy = (
  observation: ArcObservation,
  ctx: PolicyContext,
) => Promise<string | null> | (string | null);

export interface PolicyContext {
  /** Actions this environment accepts. */
  readonly actions: readonly string[];
  /** How many actions are left. The policy is told, so it can plan around it. */
  readonly remaining: number;
  /** Every action taken so far, oldest first. */
  readonly taken: readonly string[];
}

export interface PlayResult {
  /** How the level ended. `NOT_FINISHED` means the budget or the policy stopped it. */
  state: ArcObservation["state"];
  /** The actions actually spent, in order. This is the RHAE numerator. */
  actions: string[];
  /** The last view the environment gave. */
  finalObservation: ArcObservation;
  /** Why the loop returned — for the run log, so a short run is explainable. */
  stoppedBecause: "terminal" | "budget" | "policy" | "invalid_action" | "deadline";
}

export interface PlayLevelOptions {
  env: ArcEnvironment;
  policy: ArcPolicy;
  /**
   * Hard ceiling on actions. Required, with no default: a default budget is a
   * number nobody chose, and on this benchmark the budget IS the score.
   */
  maxActions: number;
  /** Called after each action, for live telemetry. Must not throw. */
  onAction?: (action: string, observation: ArcObservation, index: number) => void;
  /**
   * Asked before every action; true means stop now, cleanly.
   *
   * The budget counts presses, and there is a second currency the loop cannot
   * see: a scorecard auto-closes 15 minutes after it is opened, and at one
   * model call per action that arrives long before a 200-action budget does.
   * Actions taken after it closes are not scored — the run keeps playing and
   * the results are already gone.
   *
   * Deliberately a predicate and not a timestamp: the loop should not own a
   * clock, the caller already knows when its card was opened, and a predicate
   * is testable without faking time. Distinct from a policy returning `null` —
   * that says the LEVEL is finished with; this says the SESSION is.
   */
  shouldStop?: () => boolean;
}

export async function playLevel(options: PlayLevelOptions): Promise<PlayResult> {
  const { env, policy, maxActions, onAction, shouldStop } = options;
  // Infinity is allowed and means "no action cap": the run is bounded by money
  // and by the game ending, not by a number we picked. A cap decides the score
  // instead of measuring it.
  if (maxActions !== Infinity && (!Number.isInteger(maxActions) || maxActions < 0)) {
    throw new Error(
      `playLevel: maxActions must be a non-negative integer or Infinity, got ${String(maxActions)}`,
    );
  }

  const taken: string[] = [];
  let observation = await env.observe();

  // A level handed over already finished is not something to act on. Checked
  // before the first action, not after it: acting on a WIN would spend a real
  // action to learn what the first observation already said.
  if (isTerminal(observation.state)) {
    return {
      state: observation.state,
      actions: taken,
      finalObservation: observation,
      stoppedBecause: "terminal",
    };
  }

  while (taken.length < maxActions) {
    // Before the action, never after: an action taken past the deadline is one
    // the scorecard will not count, which is the worst of both — paid for and
    // unscored.
    if (shouldStop?.()) {
      return {
        state: observation.state,
        actions: taken,
        finalObservation: observation,
        stoppedBecause: "deadline",
      };
    }

    const action = await policy(observation, {
      actions: env.actions,
      remaining: maxActions - taken.length,
      taken,
    });

    // Conceding is legitimate but expensive: it forfeits every later level of
    // this game, and those are the ones weighted highest. `stoppedBecause:
    // "policy"` exists so a run log can be read afterwards and this decision
    // audited against what the grid actually looked like. See ArcPolicy.
    if (action === null) {
      return {
        state: observation.state,
        actions: taken,
        finalObservation: observation,
        stoppedBecause: "policy",
      };
    }

    // An action the game does not accept must not be sent. Whether the server
    // would charge for it is not something to find out during a scored run,
    // and a typo'd action silently costing a point is the kind of bug that
    // only shows up in the final number.
    // ACTION6 carries its coordinates in the name ("ACTION6:12,30"), but
    // `available_actions` only ever lists bare names, so the membership test
    // has to compare the name alone. Comparing the whole string rejected every
    // click the model asked for and ended the level with zero presses sent.
    if (!env.actions.includes(action.split(":")[0]!)) {
      return {
        state: observation.state,
        actions: taken,
        finalObservation: observation,
        stoppedBecause: "invalid_action",
      };
    }

    observation = await env.act(action);
    taken.push(action);
    // Telemetry must never be able to end a run. A panel that throws is a
    // panel bug, not a reason to lose the level.
    try {
      onAction?.(action, observation, taken.length);
    } catch {
      /* ignore */
    }

    if (isTerminal(observation.state)) {
      return {
        state: observation.state,
        actions: taken,
        finalObservation: observation,
        stoppedBecause: "terminal",
      };
    }
  }

  return {
    state: observation.state,
    actions: taken,
    finalObservation: observation,
    stoppedBecause: "budget",
  };
}
