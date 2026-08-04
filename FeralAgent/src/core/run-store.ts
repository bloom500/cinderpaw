/**
 * Durable state for an unattended run.
 *
 * Storage only: no git, no policy, no delivery. The decision ladder lives in
 * `run-resume.ts` so it can be tested without a database, and this can be
 * tested without policy.
 *
 * Booleans are stored as 0/1 and the JSON columns as text, because that is what
 * `bun:sqlite` hands back. The mapping happens here, once, so no caller ever
 * sees an integer pretending to be a boolean.
 */

import type { Database } from "bun:sqlite";
import type { DoneWhen } from "../cron/done-when.ts";
import type { TurnOutcome } from "./agent-loop.ts";
import type { UnattendedResult } from "./unattended.ts";

export type RunStatus = "running" | "finished" | "unfinished" | "needs_attention";

/**
 * Why a RUN ended. A superset of why a LOOP ended: the extra three can only
 * happen across a process boundary, which `UnattendedResult` knows nothing
 * about. Kept separate on purpose — `digest.ts` builds an exhaustive `Record`
 * over `UnattendedResult["stoppedBecause"]`, and widening that type would
 * (rightly) break the build.
 */
export type RunStopReason =
  | UnattendedResult["stoppedBecause"]
  | "process_died"
  | "resume_cap"
  | "no_progress";

/**
 * Where a finished run reports to. Without it, a run resumed at boot has
 * finished work and nobody to tell.
 */
export interface RunDelivery {
  kind: "discord" | "slack" | "whatsapp" | "cron" | "tui";
  /** Channel / chat id for a connector, job id for cron. */
  target: string;
  /** Agent session the run belongs to. */
  sessionId: string;
}

export interface RunRow {
  id: string;
  sessionId: string;
  mission: string;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number | null;
  continuationsUsed: number;
  continuationBudget: number;
  replanUsed: boolean;
  safetyRoot: string | null;
  safetyBefore: string | null;
  safetyGitDir: string | null;
  doneWhen: DoneWhen | null;
  delivery: RunDelivery | null;
  status: RunStatus;
  stoppedBecause: RunStopReason | null;
  resumes: number;
  lastResumeSeq: number | null;
}

export interface TurnRow {
  runId: string;
  seq: number;
  startedAt: number;
  durationMs: number;
  outcome: TurnOutcome;
  toolCalls: number;
  continuation: boolean;
  replan: boolean;
  tokens: number;
  filesChanged: number;
  todosClosed: number;
  /** null = no assertion was evaluated this turn. `false` means it failed. */
  doneWhenPass: boolean | null;
}

export interface StartRunInput {
  sessionId: string;
  mission: string;
  deadlineAt: number | null;
  continuationBudget: number;
  safetyRoot: string | null;
  safetyBefore: string | null;
  safetyGitDir: string | null;
  doneWhen: DoneWhen | null;
  delivery: RunDelivery | null;
}

/**
 * A JSON column written by another version must not brick the boot resume pass:
 * a run we cannot fully parse is still a run we have to report on.
 */
function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

export class RunStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** The run currently in flight for a session, if any. */
  activeFor(sessionId: string): RunRow | null {
    const row = this.#db
      .query("SELECT * FROM runs WHERE session_id = ? AND status = 'running' LIMIT 1")
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.#toRun(row) : null;
  }

  /**
   * Begin a run. Returns null when the session already has one in flight — two
   * loops driving one transcript is how side effects get performed twice.
   */
  startRun(input: StartRunInput): RunRow | null {
    if (this.activeFor(input.sessionId)) return null;
    const now = Date.now();
    const id = crypto.randomUUID();
    this.#db
      .query(
        `INSERT INTO runs (id, session_id, mission, created_at, updated_at, deadline_at,
           continuations_used, continuation_budget, replan_used,
           safety_root, safety_before, safety_git_dir, done_when, delivery,
           status, stopped_because, resumes, last_resume_seq)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, 'running', NULL, 0, NULL)`,
      )
      .run(
        id,
        input.sessionId,
        input.mission,
        now,
        now,
        input.deadlineAt,
        input.continuationBudget,
        input.safetyRoot,
        input.safetyBefore,
        input.safetyGitDir,
        input.doneWhen ? JSON.stringify(input.doneWhen) : null,
        input.delivery ? JSON.stringify(input.delivery) : null,
      );
    return this.get(id);
  }

  get(id: string): RunRow | null {
    const row = this.#db.query("SELECT * FROM runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#toRun(row) : null;
  }

  /**
   * Rows still marked running — i.e. every run whose process never came back.
   * Oldest first, so a queue of interrupted runs is worked in the order they
   * were started rather than in whatever order SQLite feels like.
   */
  runningRuns(): RunRow[] {
    const rows = this.#db
      .query("SELECT * FROM runs WHERE status = 'running' ORDER BY created_at ASC, rowid ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.#toRun(r));
  }

  /** Append a turn. Returns its 1-based seq. */
  appendTurn(turn: Omit<TurnRow, "seq">): number {
    const next =
      ((
        this.#db
          .query("SELECT MAX(seq) AS m FROM run_turns WHERE run_id = ?")
          .get(turn.runId) as { m: number | null } | undefined
      )?.m ?? 0) + 1;
    this.#db
      .query(
        `INSERT INTO run_turns (run_id, seq, started_at, duration_ms, outcome,
           tool_calls, continuation, replan, tokens, files_changed, todos_closed, done_when_pass)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.runId,
        next,
        turn.startedAt,
        turn.durationMs,
        turn.outcome,
        turn.toolCalls,
        turn.continuation ? 1 : 0,
        turn.replan ? 1 : 0,
        turn.tokens,
        turn.filesChanged,
        turn.todosClosed,
        turn.doneWhenPass === null ? null : turn.doneWhenPass ? 1 : 0,
      );
    // The counters live on the run so a resume can read the budget it has left
    // without replaying every turn.
    this.#db
      .query(
        "UPDATE runs SET updated_at = ?, continuations_used = continuations_used + ? WHERE id = ?",
      )
      .run(Date.now(), turn.continuation ? 1 : 0, turn.runId);
    if (turn.replan) {
      // Latched, never toggled back: the one retry must not be spendable twice.
      this.#db.query("UPDATE runs SET replan_used = 1 WHERE id = ?").run(turn.runId);
    }
    return next;
  }

  turnsOf(runId: string): TurnRow[] {
    const rows = this.#db
      .query("SELECT * FROM run_turns WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      runId: String(r.run_id),
      seq: Number(r.seq),
      startedAt: Number(r.started_at),
      durationMs: Number(r.duration_ms),
      outcome: String(r.outcome) as TurnOutcome,
      toolCalls: Number(r.tool_calls),
      continuation: Number(r.continuation) === 1,
      replan: Number(r.replan) === 1,
      tokens: Number(r.tokens),
      filesChanged: Number(r.files_changed),
      todosClosed: Number(r.todos_closed),
      doneWhenPass: r.done_when_pass === null ? null : Number(r.done_when_pass) === 1,
    }));
  }

  finish(id: string, status: RunStatus, reason: RunStopReason): void {
    this.#db
      .query("UPDATE runs SET status = ?, stopped_because = ?, updated_at = ? WHERE id = ?")
      .run(status, reason, Date.now(), id);
  }

  /** Record that a boot picked this run up, and at which turn seq it resumed. */
  markResumed(id: string, seqAtResume: number): void {
    this.#db
      .query(
        "UPDATE runs SET resumes = resumes + 1, last_resume_seq = ?, updated_at = ? WHERE id = ?",
      )
      .run(seqAtResume, Date.now(), id);
  }

  #toRun(r: Record<string, unknown>): RunRow {
    return {
      id: String(r.id),
      sessionId: String(r.session_id),
      mission: String(r.mission),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      deadlineAt: r.deadline_at === null ? null : Number(r.deadline_at),
      continuationsUsed: Number(r.continuations_used),
      continuationBudget: Number(r.continuation_budget),
      replanUsed: Number(r.replan_used) === 1,
      safetyRoot: r.safety_root === null ? null : String(r.safety_root),
      safetyBefore: r.safety_before === null ? null : String(r.safety_before),
      safetyGitDir: r.safety_git_dir === null ? null : String(r.safety_git_dir),
      doneWhen: parseJson<DoneWhen>(r.done_when),
      delivery: parseJson<RunDelivery>(r.delivery),
      status: String(r.status) as RunStatus,
      stoppedBecause:
        r.stopped_because === null ? null : (String(r.stopped_because) as RunStopReason),
      resumes: Number(r.resumes),
      lastResumeSeq: r.last_resume_seq === null ? null : Number(r.last_resume_seq),
    };
  }
}
