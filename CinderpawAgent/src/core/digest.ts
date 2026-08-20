/**
 * The walk-away digest — what happened while you were not at the machine.
 *
 * An unattended run used to deliver one thing: whatever the model said last.
 * That answers "what does it claim" and nothing else — not whether the task
 * finished, not how many turns it took, not which files it touched, and above
 * all not how to put things back. Coming home to that is precisely the state
 * this whole workstream exists to remove.
 *
 * The digest is assembled from facts the runtime already holds — turn outcomes
 * from `runUnattended`, the file diff from the safety point, the `done_when`
 * verdict — so it costs no extra model call and cannot itself hallucinate.
 *
 * Order is deliberate. Verdict, then evidence, then how to undo, then the
 * agent's own words last. Someone reading a phone notification sees only the
 * first line, so the first line is the one that must not be wrong.
 */

import type { UnattendedResult } from "./unattended.ts";
import type { ChangeSummary, SafetyPoint } from "./safety-point.ts";
import type { DoneCheck } from "../cron/done-when.ts";

/** Files listed individually before collapsing to a count. */
const MAX_LISTED_FILES = 12;

const STATUS_WORD: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

function fileLine(f: { status: string; path: string }): string {
  return `- ${STATUS_WORD[f.status] ?? f.status} \`${f.path}\``;
}

/** Compact "3 turns, 41 actions, 12m" line. */
function effortLine(run: UnattendedResult): string {
  const actions = run.turns.reduce((n, t) => n + t.toolCalls, 0);
  const ms = run.turns.reduce((n, t) => n + t.durationMs, 0);
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const continued = run.turns.filter((t) => t.continuation).length;
  const turns = `${run.turns.length} turn${run.turns.length === 1 ? "" : "s"}`;
  const tail = continued > 0 ? ` (${continued} automatic continuation${continued === 1 ? "" : "s"})` : "";
  return `${turns}${tail}, ${actions} action${actions === 1 ? "" : "s"}, ~${minutes} min`;
}

/**
 * Render the digest.
 *
 * `run.text` already carries its own "not finished" banner when the run ended
 * short; the header here states the verdict in one line so the two agree and
 * neither can be missed.
 */
export function renderDigest(
  run: UnattendedResult,
  changes: ChangeSummary,
  check: DoneCheck,
  safety: SafetyPoint[] | null,
  /**
   * Why the RUN ended, when that differs from why the LOOP ended — a run picked
   * up by a later boot, or given up on there.
   *
   * Deliberately a plain string rather than a typed reason: the run-level
   * reasons are a superset of `UnattendedResult["stoppedBecause"]`, and widening
   * that type would break the exhaustive `Record` over it above.
   */
  runReason?: string,
  /**
   * What the shell commands added up to — `[["read-only", 22], ["wrote files", 4]]`.
   *
   * A tool-call count answers "how busy was it", which nobody actually wants to
   * know. This answers "what did it DO while I was out" — the question somebody
   * who walked away is really asking, and the line that separates an agent
   * which read the codebase from one that rewrote it.
   */
  commands?: Array<[string, number]>,
): string {
  const out: string[] = [];

  // 1. The verdict, first line, unambiguous.
  if (run.finished && check.passed) {
    out.push(check.checked ? "✅ **Done** — and verified." : "✅ **Done** — as reported by the agent.");
  } else if (run.finished && !check.passed) {
    // The most valuable line in the whole feature: the agent said it finished
    // and the world says otherwise.
    out.push("❌ **Reported done, but the check failed.** Treat this as unfinished.");
  } else {
    out.push("⚠️ **Not finished.** Work is outstanding.");
  }

  // 2. Effort and why it stopped.
  out.push("");
  out.push(`**Run:** ${effortLine(run)}`);
  if (!run.finished) {
    const why: Record<UnattendedResult["stoppedBecause"], string> = {
      completed: "the task completed",
      continuation_budget: "the continuation budget ran out — raise FERAL_UNATTENDED_CONTINUATIONS to allow more",
      deadline: "the job's wall-clock limit was reached",
      not_continuable: `it ended as \`${run.outcome}\`, which continuing cannot fix`,
      no_progress: "three turns in a row changed no files and closed no tasks, so it stopped rather than burn the budget",
    };
    out.push(`**Stopped because:** ${why[run.stoppedBecause]}`);
  }
  // Why the RUN ended, when that is not the same as why the last LOOP ended —
  // the process died and a later boot concluded it. Placed right after the
  // loop-level reason so the two read as one story rather than contradicting
  // each other from opposite ends of the message.
  if (runReason) out.push(`**Run ended because:** ${runReason}`);
  out.push(`**Completion check:** ${check.detail}`);

  // 3. What it did to the disk.
  out.push("");
  if (commands && commands.length > 0) {
    out.push(`**Commands run:** ${commands.map(([label, n]) => `${n} ${label}`).join(", ")}`);
  }
  if (!changes.available) {
    out.push(`**Files changed:** not tracked — ${changes.reason ?? "no safety point"}.`);
  } else if (changes.files.length === 0) {
    out.push("**Files changed:** none.");
  } else {
    out.push(
      `**Files changed:** ${changes.files.length} ` +
        `(+${changes.insertions}/-${changes.deletions})`,
    );
    for (const f of changes.files.slice(0, MAX_LISTED_FILES)) out.push(fileLine(f));
    if (changes.files.length > MAX_LISTED_FILES) {
      out.push(`- …and ${changes.files.length - MAX_LISTED_FILES} more`);
    }
    if (changes.restoreHint) {
      out.push("");
      out.push("**Review or undo:**");
      out.push("```bash");
      out.push(changes.restoreHint);
      out.push("```");
    }
  }
  if (safety && safety.length > 0 && changes.available && changes.files.length === 0) {
    // Nothing changed, but a snapshot exists — worth saying, since "no diff"
    // and "we didn't look" must never read the same.
    const taken = safety.map((s) => s.before.slice(0, 8)).join(", ");
    out.push(`_(snapshot \`${taken}\` taken before the run)_`);
  }

  // 4. The agent's own account, last.
  out.push("");
  out.push("---");
  out.push(run.text.trim());

  return out.join("\n");
}
