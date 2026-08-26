/**
 * What an ARC-AGI-3 game looks like to the agent.
 *
 * One interface, so the loop that plays a game does not know whether it is
 * talking to the offline maze, a recorded trace, or the real scorecard API.
 * The API client does not exist yet (see OPUS_CHECKPOINT_20260826_ARC_STACK.md);
 * writing the loop against this seam is what lets everything above it be built
 * and tested before that client is written, rather than after.
 *
 * Deliberately small. An environment answers two questions — what does it look
 * like now, and what happens if I press this — and nothing else. Anything the
 * agent wants to KNOW beyond that (what objects are on the grid, what a
 * transform would do) is the agent's own business, done in its head, and must
 * never cost an action.
 *
 * ACTIONS ARE THE CURRENCY. ARC-AGI-3 scores a level as
 * `(human_actions / ai_actions)^2`, capped at 1.15x. Twice a human's actions
 * is not half the score, it is a QUARTER of it. Tokens are free; a keypress is
 * not. Every design choice downstream of this file follows from that one line.
 */

export type ArcGrid = number[][];

/**
 * Where a level stands. Mirrors the scorecard's own vocabulary rather than a
 * boolean, because "not started" and "in progress" are different things to a
 * loop that must not act twice on a finished level.
 */
export type ArcLevelState = "NOT_PLAYED" | "NOT_FINISHED" | "WIN" | "GAME_OVER";

export interface ArcObservation {
  /** The grid as the environment renders it. Text-only, per the benchmark. */
  grid: ArcGrid;
  state: ArcLevelState;
  /** Score as the environment reports it, when it reports one. */
  score?: number;
}

export interface ArcEnvironment {
  /** Every action this game accepts, e.g. ACTION1..ACTION6. */
  readonly actions: readonly string[];
  /** The current view. Must not advance the game. */
  observe(): Promise<ArcObservation> | ArcObservation;
  /**
   * Take one action and return the resulting view. This is the ONLY method
   * that spends from the action budget, which is why it is the only one the
   * loop is allowed to call in a scored run.
   */
  act(action: string): Promise<ArcObservation> | ArcObservation;
}

/** True when a level is over, either way. */
export function isTerminal(state: ArcLevelState): boolean {
  return state === "WIN" || state === "GAME_OVER";
}
