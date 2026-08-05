/**
 * What to do, at boot, with a run whose process never came back.
 *
 * A killed process writes nothing, which is the one thing it does reliably — so
 * a row still marked `running` after a restart IS the crash signal, and needs no
 * crash handler to produce it. This module decides what happens to each such row.
 *
 * `decideResume` is pure: no database, no git, no delivery. Every branch is
 * testable without restarting anything, and the caller owns the side effects.
 *
 * Three of the four outcomes end in a delivered report. A run that died in
 * silence is the failure this feature exists to remove, so "give up quietly" is
 * deliberately not one of the options — every `give_up` carries a `why` written
 * for a person.
 */

import type { RunRow, RunStatus, RunStopReason, TurnRow } from "./run-store.ts";
import type { RunStore } from "./run-store.ts";

/** How many times a boot may pick the same run back up before asking a human. */
export const DEFAULT_MAX_RESUMES = 3;

export type ResumeDecision =
  | { action: "resume" }
  | { action: "give_up"; status: RunStatus; reason: RunStopReason; why: string };

/**
 * Did anything land on disk during the turns that followed the last resume?
 *
 * Only those turns count. Work done before the last resume must not vouch for
 * the last resume — that is precisely the case this guard exists to catch: a run
 * that made real progress at first and has since been dying on the same step.
 */
function lastResumeAchievedNothing(run: RunRow, turns: TurnRow[]): boolean {
  // Nothing has been retried yet, so there is no loop to break. A first crash is
  // not evidence of anything except a crash.
  if (run.resumes === 0) return false;
  const from = run.lastResumeSeq ?? 1;
  const since = turns.filter((t) => t.seq >= from);
  // A resume that died before producing a single turn never got a chance to fail
  // on its own terms. Retry it rather than judge it.
  if (since.length === 0) return false;
  return since.every((t) => t.filesChanged === 0 && t.todosClosed === 0);
}

export function decideResume(
  run: RunRow,
  turns: TurnRow[],
  now: number,
  maxResumes: number = DEFAULT_MAX_RESUMES,
): ResumeDecision {
  // Deadline first, so a run that is both out of time AND out of resumes is
  // reported with the reason that actually ended it.
  //
  // `<=` rather than `<`: a run whose clock ran out at this instant has no time
  // left to do anything with.
  if (run.deadlineAt !== null && run.deadlineAt <= now) {
    return {
      action: "give_up",
      status: "unfinished",
      reason: "process_died",
      why: "the process running it stopped, and its deadline has since passed",
    };
  }
  if (run.resumes >= maxResumes) {
    return {
      action: "give_up",
      status: "needs_attention",
      reason: "resume_cap",
      why: `picked back up ${run.resumes} times and still not finished — stopping rather than looping`,
    };
  }
  if (lastResumeAchievedNothing(run, turns)) {
    return {
      action: "give_up",
      status: "needs_attention",
      reason: "no_progress",
      why: "the last attempt changed no files and closed no tasks, so retrying it would only burn tokens",
    };
  }
  return { action: "resume" };
}

/**
 * Walk every run left in `running` and act on each.
 *
 * Side effects belong to the caller: `resume` re-enters the agent loop and
 * `giveUp` delivers the report, both of which need wiring this module has no
 * business knowing about. What lives here is the ordering and the bookkeeping.
 *
 * One run's failure does not stop the pass. A boot with three interrupted runs
 * must not lose two of them because the first one's delivery target is gone.
 */
export async function resumeInterruptedRuns(
  store: RunStore,
  now: number,
  resume: (run: RunRow) => Promise<void>,
  giveUp: (run: RunRow, decision: Extract<ResumeDecision, { action: "give_up" }>) => Promise<void>,
  opts: { maxResumes?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const maxResumes = opts.maxResumes ?? DEFAULT_MAX_RESUMES;
  const log = opts.log ?? (() => {});
  for (const run of store.runningRuns()) {
    const decision = decideResume(run, store.turnsOf(run.id), now, maxResumes);
    try {
      if (decision.action === "give_up") {
        // Marked first: if delivery throws, the run must not stay `running` and
        // get picked up again on the next boot for the same doomed reason.
        store.finish(run.id, decision.status, decision.reason);
        await giveUp(run, decision);
        continue;
      }
      // Recorded BEFORE running it: if this attempt also dies, the next boot has
      // to be able to see that it was tried.
      store.markResumed(run.id, store.turnsOf(run.id).length + 1);
      await resume(run);
    } catch (err) {
      log(`run ${run.id}: ${decision.action} failed: ${String(err)}`);
    }
  }
}
