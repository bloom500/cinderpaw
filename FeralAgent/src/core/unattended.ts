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
  /** True for the one turn spent looking for a different approach after a stuck one. */
  replan?: boolean;
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
  stoppedBecause: "completed" | "continuation_budget" | "deadline" | "not_continuable" | "no_progress";
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

/**
 * What a replan turn says to the model, after the loop detector proved the
 * current approach returns the same result no matter how often it is retried.
 *
 * A continuation prompt is wrong here and would make things worse: it says
 * "pick up where you stopped", and where it stopped is precisely the thing that
 * does not work. The stuck outcome is not "ran out of time", it is "this
 * approach is refuted" — so the prompt asks for the refutation to be stated
 * first. Naming what was tried and why it failed is what stops the model
 * rediscovering the same dead end with slightly different arguments, which is
 * the failure mode of a bare "try something else".
 *
 * Permission to give up is deliberate. An agent that cannot say "there is no
 * other way in" will invent one, and an invented approach run unattended for
 * another hour is worse than an honest stop.
 */
const REPLAN_PROMPT =
  "(system: you stopped because the same action kept returning the same result. That " +
  "approach is refuted — retrying it in any form will not work. This is an automatic " +
  "replan; no human is watching, so do not ask questions and do not wait for approval.\n" +
  "First, state in one or two lines: what you were trying to achieve, what you tried, and " +
  "why it could not have worked. Then choose a DIFFERENT approach — a different tool, a " +
  "different entry point, or a smaller sub-goal whose result you can actually verify. Do " +
  "not repeat the action that got you stuck.\n" +
  "If there is genuinely no other approach available to you, say so plainly, say what you " +
  "would need, and stop. That is a valid answer and a better one than a guess.)";

/**
 * What the first turn after a RESTART says to the model.
 *
 * Different situation from an ordinary continuation, and the difference matters:
 * a continuation follows a turn this same process just ran, so the transcript is
 * warm and "pick up where you stopped" is enough. Here the process died — the
 * transcript may have been summarised or reloaded, and the only thing certain to
 * have survived intact is the durable task list. So it names the mission again,
 * says plainly that time has passed, and points at the two sources of truth
 * (the task list, and the files themselves) rather than at "where you stopped",
 * which nothing can now guarantee it knows.
 *
 * Naming the mission is what stops the model treating the restart as a brand new
 * request and redoing side effects it already performed.
 */
export function resumePrompt(mission: string): string {
  return (
    "(system: this task was interrupted — the process running it stopped and has just " +
    "been restarted. Time has passed. No human is watching, so do not ask questions and " +
    "do not wait for approval.\n" +
    `The task is: ${mission}\n` +
    "Your durable task list survived the restart; the work already written to disk did " +
    "too. Read both BEFORE doing anything, and verify current state before any write that " +
    "might already have happened — you may have completed steps you no longer remember.\n" +
    "Do NOT start the task over. If it is in fact already complete, say so plainly and stop.)"
  );
}

/**
 * Continuations allowed after the first turn.
 *
 * Exported so a caller can snapshot it onto a run row at start: read again later
 * it could have changed, and a run already in flight must not have its budget
 * moved underneath it.
 */
export function maxContinuations(): number {
  return Math.max(0, cfgInt("FERAL_UNATTENDED_CONTINUATIONS"));
}

/**
 * Somewhere to put a turn as it finishes, so a run stays auditable after the
 * process that ran it is gone. The `turns` array below dies with the process;
 * this is how the same information reaches disk.
 *
 * Deliberately fire-and-forget: a recorder that fails is never allowed to be the
 * reason unattended work stops. Telemetry is not the work.
 *
 * `tokens` is passed through as 0 here — the loop has no access to a token
 * counter and must not invent one. The caller's recorder owns the router and
 * fills it in.
 */
export interface TurnRecorder {
  record(turn: TurnRecord & { startedAt: number; tokens: number }): Promise<void> | void;
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
  opts: {
    deadlineMs?: number;
    recorder?: TurnRecorder;
    /**
     * Is the run producing nothing? Supplied by the caller because the evidence
     * lives in the run store, which this loop deliberately knows nothing about:
     * `filesChanged` / `todosClosed` are filled in by the caller's recorder.
     *
     * Checked AFTER the recorder has written the turn, so the callback sees the
     * turn that just happened rather than judging on stale rows.
     */
    stalled?: () => boolean;
  } = {},
): Promise<UnattendedResult> {
  const budget = maxContinuations();
  // The caller's deadline wins (cron sizes one from the job timeout); otherwise
  // fall back to the configured mission deadline. Defaulted HERE rather than at
  // the three call sites because two of them — dispatch and the connectors —
  // passed nothing, so an autonomous run reached over a connector had no
  // wall-clock bound at all, only a continuation count. A counter cannot
  // express "stop at 6am", which is the thing a walk-away run actually needs.
  const configured = cfgInt("FERAL_MISSION_DEADLINE_MS");
  const deadlineMs = opts.deadlineMs ?? (configured > 0 ? configured : undefined);
  const deadline = deadlineMs !== undefined ? Date.now() + deadlineMs : Infinity;
  const turns: TurnRecord[] = [];

  let result: TurnResult | null = null;
  let stoppedBecause: UnattendedResult["stoppedBecause"] = "completed";
  // The prompt for the NEXT turn. A variable rather than a ternary on `attempt`
  // because a replan turn is neither the first turn nor an ordinary continuation.
  let nextPrompt = task;
  // A replan is allowed once per run. Twice would mean the second replan is
  // reacting to the first one's failure with no more information than it had,
  // and unattended runs are exactly where an unbounded "try again differently"
  // burns a night's budget.
  let replanned = false;

  for (let attempt = 0; attempt <= budget; attempt++) {
    const startedAt = Date.now();
    const isReplan = nextPrompt === REPLAN_PROMPT;
    result = await runTurn(
      nextPrompt,
      // First turn keeps the caller's id verbatim so an existing UI that
      // correlates on it is unaffected; continuations are suffixed.
      attempt === 0 ? messageIdPrefix : `${messageIdPrefix}-cont${attempt}`,
    );
    const record: TurnRecord = {
      outcome: result.outcome,
      toolCalls: result.toolCallCount,
      durationMs: Date.now() - startedAt,
      continuation: attempt > 0,
      ...(isReplan ? { replan: true } : {}),
    };
    turns.push(record);
    if (opts.recorder) {
      try {
        // Awaited so a recorder writing to SQLite finishes before the next turn
        // starts — a half-written turn row is worse than a late one.
        await opts.recorder.record({ ...record, startedAt, tokens: 0 });
      } catch {
        // Silent here on purpose: the caller's recorder owns its own logging,
        // and this catch exists only so the work continues. A recorder that
        // cannot write is a reporting problem, not a reason to abandon a task
        // nobody is watching.
      }
    }
    nextPrompt = CONTINUE_PROMPT;

    if (!result.incomplete) {
      // A stuck turn is not "out of time" — the approach was refuted, and the
      // run still has budget. Spend one turn looking for a different way in
      // before declaring the whole task dead. This is the only outcome worth
      // re-invoking for that `isContinuable` deliberately excludes: continuing
      // a stuck turn is pointless, but REPLANNING one is not the same thing.
      if (result.outcome === "stuck" && !replanned && attempt < budget && Date.now() < deadline) {
        replanned = true;
        nextPrompt = REPLAN_PROMPT;
        continue;
      }
      stoppedBecause = isContinuable(result.outcome) ? "continuation_budget" : "not_continuable";
      // A terminal outcome that is not continuable (stuck, stopped, no_answer)
      // is still "why we stopped"; a completed one is the happy path.
      if (result.outcome === "completed") stoppedBecause = "completed";
      break;
    }

    // A run that is moving nothing gets one shot at a different approach, then
    // stops. Same replan budget as a stuck turn and the same reasoning: a second
    // replan has no more information than the first one did, and an unbounded
    // "try again differently" is how a night's budget disappears.
    //
    // Reached only when `result.incomplete` — the block above already returned
    // on every terminal outcome, `completed` included. A turn that legitimately
    // finishes with nothing on disk (an analysis, a question answered) is not a
    // stall; `stoppedBecause` must never read "no_progress" on a finished run.
    if (opts.stalled?.() === true) {
      if (!replanned && attempt < budget && Date.now() < deadline) {
        replanned = true;
        nextPrompt = REPLAN_PROMPT;
        continue;
      }
      stoppedBecause = "no_progress";
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
    text: finished
      ? last.text
      : `${unfinishedBanner(last.outcome, turns.length, replanned)}\n\n${last.text}`,
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
function unfinishedBanner(outcome: TurnOutcome, turnCount: number, replanned = false): string {
  const turnsRun = `${turnCount} turn${turnCount === 1 ? "" : "s"}`;
  switch (outcome) {
    case "out_of_time":
    case "ceiling":
      return `⚠️ **Not finished.** I worked through ${turnsRun} and ran out of budget before completing the task.`;
    case "stuck":
      // Whether a different approach was already tried is the first thing the
      // reader needs: it decides whether their next move is "try again" or
      // "this needs me".
      return replanned
        ? `⚠️ **Not finished.** I stopped after ${turnsRun}: the first approach stopped making progress, and the alternative I tried did not work either.`
        : `⚠️ **Not finished.** I stopped after ${turnsRun}: repeating the same action stopped making progress.`;
    case "stopped":
      return `⏹️ **Stopped.** The run was cancelled after ${turnsRun}.`;
    case "no_answer":
      return `⚠️ **Not finished.** After ${turnsRun} the model produced no usable answer.`;
    default:
      return `⚠️ **Not finished.** Stopped after ${turnsRun}.`;
  }
}
