/**
 * Cron jobs repository — SQLite-backed CRUD for {@link CronJob}.
 *
 * Schedule + delivery are stored as JSON blobs so the unions can evolve
 * (new Schedule kinds, new Delivery targets) without a schema migration.
 * History is bounded to the most recent 50 entries; the repo trims
 * automatically on every append.
 *
 * Pure persistence layer — no timers, no inference. The scheduler
 * (cron/scheduler.ts) owns the timing; this class only knows how to
 * read/write rows.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  CronJob,
  CronJobInput,
  CronRunRecord,
  DeliveryTarget,
  Schedule,
} from "../types.ts";
import { parseDoneWhen } from "./done-when.ts";
import { nextRunAt } from "./schedule.ts";
import { isBlockedHost } from "../egress/egress-proxy.ts";

const HISTORY_CAP = 50;

/** Tolerate a corrupt done_when payload — an unparseable one becomes "unchecked". */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
const DEFAULT_MAX_RETRIES = 3;

interface CronRow {
  policy_json: string | null;
  done_when_json: string | null;
  kind: string | null;
  id: string;
  name: string;
  task: string;
  schedule_json: string;
  delivery_json: string;
  enabled: number;
  last_run_ms: number | null;
  next_run_ms: number | null;
  history_json: string;
  max_retries: number;
  retry_count: number;
  created_at: number;
  updated_at: number;
}

export class CronJobsRepo {
  readonly #db: Database;
  readonly #insert: ReturnType<Database["query"]>;
  readonly #list: ReturnType<Database["query"]>;
  readonly #get: ReturnType<Database["query"]>;
  readonly #delete: ReturnType<Database["query"]>;
  readonly #updateAfterRun: ReturnType<Database["query"]>;
  readonly #updateEnabled: ReturnType<Database["query"]>;

  constructor(db: Database) {
    this.#db = db;
    if (!(db.query("PRAGMA table_info(cron_jobs)").all() as {name:string}[]).some(c => c.name === "policy_json")) {
      db.exec("ALTER TABLE cron_jobs ADD COLUMN policy_json TEXT");
    }
    this.#insert = db.query(`
      INSERT INTO cron_jobs (
        id, name, task, schedule_json, delivery_json,
        enabled, last_run_ms, next_run_ms, history_json,
        done_when_json, max_retries, retry_count, created_at, updated_at, kind, policy_json
      ) VALUES (
        $id, $name, $task, $scheduleJson, $deliveryJson,
        $enabled, $lastRunMs, $nextRunMs, $historyJson,
        $doneWhenJson, $maxRetries, 0, $createdAt, $updatedAt, $kind, $policyJson
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        task = excluded.task,
        schedule_json = excluded.schedule_json,
        delivery_json = excluded.delivery_json,
        enabled = excluded.enabled,
        -- Carried through the update too, or a reschedule would keep firing on
        -- the OLD schedule's timestamp. upsert() only puts a new value here
        -- when the schedule actually changed, so an ordinary rename still
        -- leaves the pending run exactly where it was.
        next_run_ms = excluded.next_run_ms,
        done_when_json = excluded.done_when_json,
        max_retries = excluded.max_retries,
        updated_at = excluded.updated_at,
        kind = excluded.kind,
        policy_json = excluded.policy_json
    `);
    this.#list = db.query(`
      SELECT id, name, task, schedule_json, delivery_json,
             enabled, last_run_ms, next_run_ms, history_json,
             done_when_json, max_retries, retry_count, created_at, updated_at, kind, policy_json
      FROM cron_jobs
      ORDER BY created_at ASC
    `);
    this.#get = db.query(`
      SELECT id, name, task, schedule_json, delivery_json,
             enabled, last_run_ms, next_run_ms, history_json,
             done_when_json, max_retries, retry_count, created_at, updated_at, kind, policy_json
      FROM cron_jobs
      WHERE id = ?
    `);
    this.#delete = db.query(`DELETE FROM cron_jobs WHERE id = ?`);
    this.#updateAfterRun = db.query(`
      UPDATE cron_jobs
      SET last_run_ms = $lastRunMs,
          next_run_ms = $nextRunMs,
          history_json = $historyJson,
          retry_count = $retryCount,
          updated_at = $updatedAt
      WHERE id = $id
    `);
    this.#updateEnabled = db.query(`
      UPDATE cron_jobs
      SET enabled = $enabled, next_run_ms = $nextRunMs, updated_at = $updatedAt
      WHERE id = $id
    `);
  }

  /** List all jobs, ordered by creation time (oldest first). */
  list(): CronJob[] {
    return (this.#list.all() as CronRow[]).map((r) => fromRow(r));
  }

  /** Look up a single job by id, or `undefined` if not present. */
  get(id: string): CronJob | undefined {
    const row = this.#get.get(id) as CronRow | null;
    return row ? fromRow(row) : undefined;
  }

  /** Insert or update. Returns the persisted job (with id + timestamps).
   *
   *  `nextRunMs` is computed HERE, from the schedule, whenever the schedule is
   *  new or has changed. It used to be left null for the scheduler to fill in
   *  "on its first tick" — but the tick skips jobs whose `nextRunMs` is null
   *  and the only place that ever computed one was the after-a-run path, so a
   *  freshly created job had no first run to be scheduled from: every cron the
   *  user or the agent added simply never fired, silently, forever.
   *
   *  An unchanged schedule keeps the stored `nextRunMs` — renaming a job or
   *  editing its task must not push the next run out. A changed one recomputes,
   *  which is also what makes "every 5m" → "at <a past date>" mean "never
   *  again" instead of "fire immediately on the next tick" from the stale
   *  timestamp the old schedule had left behind.
   */
  upsert(input: CronJobInput): CronJob {
    const existing = input.id ? this.get(input.id) : undefined;
    const kind = input.kind ?? existing?.kind ?? "agent";
    if (kind !== "agent" && kind !== "reminder" && kind !== "watch") throw new Error("Unknown task kind");
    const watch = input.watch;
    if (kind === "watch") {
      if (!watch || !watch.contains?.trim() || watch.contains.length > 500) throw new Error("A watch needs the exact text to verify on its source");
      const url = new URL(watch.sourceUrl);
      if (url.protocol !== "https:" || url.username || url.password || isBlockedHost(url.hostname)) throw new Error("A watch source must be public HTTPS without credentials");
      if (input.schedule.kind === "at") throw new Error("A watch needs a recurring check");
      if (input.delivery.kind !== "chat") throw new Error("Watch results are notification-only");
    }
    if (input.expiryDays !== undefined && (!Number.isFinite(input.expiryDays) || input.expiryDays < 1 || input.expiryDays > 365)) throw new Error("Expiry must be 1 to 365 days");
    if (input.budgetUsd !== undefined && (!Number.isFinite(input.budgetUsd) || input.budgetUsd < 0)) throw new Error("Task spending limit must be a nonnegative dollar amount");
    const id = input.id ?? randomUUID();
    // Monotonic even for two edits in the same millisecond: this is also the
    // revision used to keep an old async run from overwriting a newer task.
    const now = Math.max(Date.now(), (existing?.updatedAt ?? -1) + 1);
    const policy = {
      watch: kind === "watch" ? watch : undefined,
      expiresAt: kind === "watch" ? (input.expiryDays !== undefined ? now + input.expiryDays * 86400000 : existing?.expiresAt ?? now + 30 * 86400000) : undefined,
      budgetUsd: kind === "agent" ? (input.budgetUsd ?? existing?.budgetUsd ?? 5) : 0,
      spentUsd: existing?.spentUsd ?? 0,
    };
    const scheduleJson = JSON.stringify(input.schedule);
    const deliveryJson = JSON.stringify(input.delivery);
    const scheduleChanged =
      !existing || JSON.stringify(existing.schedule) !== scheduleJson;
    const nextRunMs = scheduleChanged
      ? nextRunAt(input.schedule, new Date(now))
      : (existing.nextRunMs ?? null);

    this.#insert.run({
      $id: id,
      $name: input.name,
      $task: input.task,
      $scheduleJson: scheduleJson,
      $deliveryJson: deliveryJson,
      $enabled: (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
      $lastRunMs: existing?.lastRunMs ?? null,
      $nextRunMs: nextRunMs,
      $historyJson: JSON.stringify(existing?.history ?? []),
      // A malformed done_when is stored as null rather than rejected: a check
      // that can never run would fail the job forever, which is worse than the
      // pre-existing "unverified" state.
      $doneWhenJson: (() => {
        const spec = parseDoneWhen(input.doneWhen ?? existing?.doneWhen ?? null);
        return spec ? JSON.stringify(spec) : null;
      })(),
      $maxRetries: input.maxRetries ?? existing?.maxRetries ?? DEFAULT_MAX_RETRIES,
      $kind: kind,
      $policyJson: JSON.stringify(policy),
      $createdAt: existing?.createdAt ?? now,
      $updatedAt: now,
    });

    return this.get(id)!;
  }

  /** Consume this occurrence before executing it. A crash cannot replay it.
   * ponytail: no spend hold here. Holding the whole $5 showed "$5.00 used"
   * after a crash and became permanent on the next settle, while nothing
   * enforced a per-task cap (24 Oct review); the weekly limit is the cap. */
  claimRun(job: CronJob, at: number, next: number | null): boolean {
    const current = this.get(job.id);
    if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(job)) return false;
    const history = [...current.history, {runAt:at,status:"running",durationMs:0,error:"Interrupted runs are never replayed automatically."}].slice(-HISTORY_CAP);
    const result = this.#db.query("UPDATE cron_jobs SET next_run_ms=?, history_json=? WHERE id=? AND next_run_ms=? AND enabled=1").run(next,JSON.stringify(history),job.id,job.nextRunMs!);
    return result.changes > 0;
  }

  settleSpend(id: string, spentUsd: number): void {
    const job = this.get(id); if (!job) return;
    this.#db.query("UPDATE cron_jobs SET policy_json=? WHERE id=?").run(JSON.stringify({watch:job.watch,expiresAt:job.expiresAt,budgetUsd:job.budgetUsd,spentUsd}),id);
  }

  /** Remove a job. Returns true if a row was deleted. */
  remove(id: string): boolean {
    const result = this.#delete.run(id);
    return result.changes > 0;
  }

  /**
   * Record the outcome of a single run: bumps lastRunMs, computes the
   * next nextRunMs from the same schedule, appends to history (capped
   * at HISTORY_CAP), and sets retryCount (0 on success, current+1 on
   * failure up to the repo's caller-defined max).
   */
  updateAfterRun(
    id: string,
    lastRunMs: number,
    nextRunMs: number | null,
    record: CronRunRecord,
    retryCount: number,
    expectedUpdatedAt?: number,
  ): boolean {
    const job = this.get(id);
    if (!job) return false;
    const current = expectedUpdatedAt === undefined || job.updatedAt === expectedUpdatedAt;
    if (!current) {
      nextRunMs = job.nextRunMs ?? null;
      retryCount = job.retryCount;
      record = { ...record, status: "skipped", proof: undefined, result: "Task changed during this run; the old outcome was not applied. " + (record.result ?? "") };
    }
    const previous = job.history.at(-1)?.status === "running" ? job.history.slice(0, -1) : job.history;
    const history = [...previous, record].slice(-HISTORY_CAP);
    this.#updateAfterRun.run({
      $id: id,
      $lastRunMs: lastRunMs,
      $nextRunMs: nextRunMs,
      $historyJson: JSON.stringify(history),
      $retryCount: retryCount,
      $updatedAt: Math.max(Date.now(), job.updatedAt + 1),
    });
    return current;
  }

  /** Toggle the enabled flag. Turning a job back on schedules it from now:
   *  the run it missed while paused is not fired late on the next tick. */
  setEnabled(id: string, enabled: boolean): void {
    const job = this.get(id);
    if (!job) return;
    const now = Math.max(Date.now(), job.updatedAt + 1);
    // Resuming a one-off whose time passed (missed while closed) runs it now:
    // its schedule alone has no future time left (24 Oct review).
    const nextRunMs = enabled && (job.nextRunMs == null || job.nextRunMs < now)
      ? nextRunAt(job.schedule, new Date(now)) ?? (job.schedule.kind === "at" ? now : null)
      : (job.nextRunMs ?? null);
    this.#updateEnabled.run({
      $id: id,
      $enabled: enabled ? 1 : 0,
      $nextRunMs: nextRunMs,
      $updatedAt: now,
    });
  }
}

function fromRow(r: CronRow): CronJob {
  const policy = safeParse(r.policy_json ?? "{}") as Partial<CronJob> | null;
  return {
    watch: policy?.watch,
    expiresAt: policy?.expiresAt,
    budgetUsd: policy?.budgetUsd ?? (r.kind === "reminder" || r.kind === "watch" ? 0 : 5),
    spentUsd: policy?.spentUsd ?? 0,
    id: r.id,
    name: r.name,
    task: r.task,
    schedule: JSON.parse(r.schedule_json) as Schedule,
    delivery: JSON.parse(r.delivery_json) as DeliveryTarget,
    enabled: r.enabled === 1,
    lastRunMs: r.last_run_ms ?? undefined,
    nextRunMs: r.next_run_ms ?? undefined,
    history: JSON.parse(r.history_json) as CronRunRecord[],
    doneWhen: parseDoneWhen(r.done_when_json ? safeParse(r.done_when_json) : null),
    maxRetries: r.max_retries,
    retryCount: r.retry_count,
    kind: r.kind === "watch" ? "watch" : r.kind === "reminder" ? "reminder" : "agent",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
