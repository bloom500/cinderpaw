/**
 * Unattended execution — running a task when nobody is watching.
 *
 * An attended turn can end half-done and it costs nothing: the user reads
 * "I ran out of time", types "continue", and the work resumes. Every mechanism
 * for stopping a turn was built around that assumption.
 *
 * Nothing about it holds for a cron job or a message answered while its author
 * is at work. There, the turn budget expiring produced a partial result that
 * `handle()` flattened into a string, which the scheduler could only read as
 * success — retry streak reset, partial delivered, job moved on. The task was
 * never finished and nothing in the system knew that.
 *
 * This module is the missing half: run the turn, look at HOW it ended, and
 * continue it if there is more to do. The session already carries everything a
 * continuation needs — transcript, durable todo list, checkpoint — so a
 * continuation is a normal turn on the same session, not a replay.
 *
 * It also records what happened per turn, which is what the walk-away digest
 * (`digest.ts`) reports and what makes an unattended run auditable rather than
 * a single opaque string.
 */

import { cfgInt } from "../config.ts";
import { isContinuable, type TurnOutcome, type TurnResult } from "./agent-loop.ts";

/**
 * Runs one turn. A function rather than an agent object so each caller can
 * close over whatever else its surface needs — a connector passes images and
 * an event sink, dispatch passes the skill roster and Controls overrides, cron
 * passes neither — without this module knowing about any of them.
 */
export type RunTurn = (userText: string, messageId: string) => Promise<TurnResult>;

/** One turn inside an unattended run. */
export interface TurnRecord {
  outcome: TurnOutcome;
  toolCalls: number;
  durationMs: number;
  /** True for every turn after the first — i.e. an automatic continuation. */
  continuation: boolean;
}

export interface UnattendedResult {
  /** What to deliver. The last turn's text, prefixed when work was left over. */
  text: string;
  /** How the final turn ended. */
  outcome: TurnOutcome;
  /**
   * The task reached a natural end. False means the run stopped with work
   * outstanding — a caller must NOT record this as a success.
   */
  finished: boolean;
  /** Every turn, in order. */
  turns: TurnRecord[];
  /** Why the run stopped continuing, when it did not finish. */
  stoppedBecause: "completed" | "continuation_budget" | "deadline" | "not_continuable";
}

/**
 * What a continuation turn says to the model.
 *
 * Deliberately not "continue". The failure mode of a bare nudge is a model that
 * restarts the task from the top, redoing side effects it already performed —
 * which on an unattended run with file writes is worse than stopping. Naming
 * the durable task list and forbidding a restart is what makes the continuation
 * additive.
 */
const CONTINUE_PROMPT =
  "(system: your previous turn hit the time limit before the task was finished. " +
  "This is an automatic continuation — no human is watching, so do not ask questions " +
  "and do not wait for approval.\n" +
  "Pick up exactly where you stopped. Do NOT start over and do NOT repeat steps you " +
  "have already completed — check your task list and the work already in this session " +
  "first, and verify current state before any write that might already have happened.\n" +
  "If the task is in fact complete, say so plainly and stop.)";

/** Continuations allowed after the first turn. */
function maxContinuations(): number {
  return Math.max(0, cfgInt("FERAL_UNATTENDED_CONTINUATIONS"));
}

/**
 * Run a task to completion, continuing it across turn-budget expiries.
 *
 * Returns as soon as the task reaches a natural end, the continuation budget is
 * spent, or `deadlineMs` passes. `finished` is the field callers must branch
 * on: a run that used its whole budget and is still unfinished is a failure to
 * report, not a result to deliver quietly.
 */
export async function runUnattended(
  runTurn: RunTurn,
  task: string,
  messageIdPrefix: string,
  opts: { deadlineMs?: number } = {},
): Promise<UnattendedResult> {
  const budget = maxContinuations();
  const deadline = opts.deadlineMs !== undefined ? Date.now() + opts.deadlineMs : Infinity;
  const turns: TurnRecord[] = [];

  let result: TurnResult | null = null;
  let stoppedBecause: UnattendedResult["stoppedBecause"] = "completed";

  for (let attempt = 0; attempt <= budget; attempt++) {
    const startedAt = Date.now();
    result = await runTurn(
      attempt === 0 ? task : CONTINUE_PROMPT,
      // First turn keeps the caller's id verbatim so an existing UI that
      // correlates on it is unaffected; continuations are suffixed.
      attempt === 0 ? messageIdPrefix : `${messageIdPrefix}-cont${attempt}`,
    );
    turns.push({
      outcome: result.outcome,
      toolCalls: result.toolCallCount,
      durationMs: Date.now() - startedAt,
      continuation: attempt > 0,
    });

    if (!result.incomplete) {
      stoppedBecause = isContinuable(result.outcome) ? "continuation_budget" : "not_continuable";
      // A terminal outcome that is not continuable (stuck, stopped, no_answer)
      // is still "why we stopped"; a completed one is the happy path.
      if (result.outcome === "completed") stoppedBecause = "completed";
      break;
    }
    // Out of wall clock for the whole run: stop before starting a turn we
    // cannot finish, rather than being killed part-way through one.
    if (Date.now() >= deadline) {
      stoppedBecause = "deadline";
      break;
    }
    if (attempt === budget) {
      stoppedBecause = "continuation_budget";
      break;
    }
  }

  // `budget` is >= 0 and the loop always runs once, so this cannot be null.
  const last = result!;
  const finished = last.outcome === "completed";

  return {
    text: finished ? last.text : `${unfinishedBanner(last.outcome, turns.length)}\n\n${last.text}`,
    outcome: last.outcome,
    finished,
    turns,
    stoppedBecause,
  };
}

/**
 * The line that goes at the top of an unfinished unattended result.
 *
 * Stated before the content, not after: someone reading a notification on a
 * phone sees the first line and nothing else, and "this is not done" is the
 * part they must not miss.
 */
function unfinishedBanner(outcome: TurnOutcome, turnCount: number): string {
  const turnsRun = `${turnCount} turn${turnCount === 1 ? "" : "s"}`;
  switch (outcome) {
    case "out_of_time":
    case "ceiling":
      return `⚠️ **Not finished.** I worked through ${turnsRun} and ran out of budget before completing the task.`;
    case "stuck":
      return `⚠️ **Not finished.** I stopped after ${turnsRun}: repeating the same action stopped making progress.`;
    case "stopped":
      return `⏹️ **Stopped.** The run was cancelled after ${turnsRun}.`;
    case "no_answer":
      return `⚠️ **Not finished.** After ${turnsRun} the model produced no usable answer.`;
    default:
      return `⚠️ **Not finished.** Stopped after ${turnsRun}.`;
  }
}
