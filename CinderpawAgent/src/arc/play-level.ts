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
 * The policy may look at the observation for as long as it likes, and may run
 * anything it wants in its head — that is where the search belongs. Simulating
 * a move is free; pressing a button to find out is not, and that difference is
 * the entire strategy.
 */

import { isTerminal, type ArcEnvironment, type ArcObservation } from "./environment.ts";

/**
 * Chooses the next action, or `null` to stop voluntarily.
 *
 * Returning null is a real answer: an agent that knows it is stuck should stop
 * rather than burn the remaining budget discovering that again. Under a
 * squared penalty, wasted actions cost more than an unfinished level.
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
  stoppedBecause: "terminal" | "budget" | "policy" | "invalid_action";
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
}

export async function playLevel(options: PlayLevelOptions): Promise<PlayResult> {
  const { env, policy, maxActions, onAction } = options;
  if (!Number.isInteger(maxActions) || maxActions < 0) {
    throw new Error(
      `playLevel: maxActions must be a non-negative integer, got ${String(maxActions)}`,
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
    const action = await policy(observation, {
      actions: env.actions,
      remaining: maxActions - taken.length,
      taken,
    });

    // The policy conceding is a legitimate outcome, not a failure. See ArcPolicy.
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
    if (!env.actions.includes(action)) {
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
