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

const HISTORY_CAP = 50;
const DEFAULT_MAX_RETRIES = 3;

interface CronRow {
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
  readonly #insert: ReturnType<Database["query"]>;
  readonly #list: ReturnType<Database["query"]>;
  readonly #get: ReturnType<Database["query"]>;
  readonly #delete: ReturnType<Database["query"]>;
  readonly #updateAfterRun: ReturnType<Database["query"]>;
  readonly #updateEnabled: ReturnType<Database["query"]>;

  constructor(db: Database) {
    this.#insert = db.query(`
      INSERT INTO cron_jobs (
        id, name, task, schedule_json, delivery_json,
        enabled, last_run_ms, next_run_ms, history_json,
        max_retries, retry_count, created_at, updated_at
      ) VALUES (
        $id, $name, $task, $scheduleJson, $deliveryJson,
        $enabled, $lastRunMs, $nextRunMs, $historyJson,
        $maxRetries, 0, $createdAt, $updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        task = excluded.task,
        schedule_json = excluded.schedule_json,
        delivery_json = excluded.delivery_json,
        enabled = excluded.enabled,
        max_retries = excluded.max_retries,
        updated_at = excluded.updated_at
    `);
    this.#list = db.query(`
      SELECT id, name, task, schedule_json, delivery_json,
             enabled, last_run_ms, next_run_ms, history_json,
             max_retries, retry_count, created_at, updated_at
      FROM cron_jobs
      ORDER BY created_at ASC
    `);
    this.#get = db.query(`
      SELECT id, name, task, schedule_json, delivery_json,
             enabled, last_run_ms, next_run_ms, history_json,
             max_retries, retry_count, created_at, updated_at
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
      SET enabled = $enabled, updated_at = $updatedAt
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
   *  `nextRunMs` is left null on a brand-new job — the scheduler
   *  computes it on its first tick so the same clock source drives
   *  scheduling and "is this job due" comparisons. Existing jobs keep
   *  their `nextRunMs` (the schedule didn't change unless the caller
   *  also overwrote `nextRunMs` via the API).
   */
  upsert(input: CronJobInput): CronJob {
    const existing = input.id ? this.get(input.id) : undefined;
    const id = input.id ?? randomUUID();
    const now = Date.now();
    const scheduleJson = JSON.stringify(input.schedule);
    const deliveryJson = JSON.stringify(input.delivery);

    this.#insert.run({
      $id: id,
      $name: input.name,
      $task: input.task,
      $scheduleJson: scheduleJson,
      $deliveryJson: deliveryJson,
      $enabled: (input.enabled ?? true) ? 1 : 0,
      $lastRunMs: existing?.lastRunMs ?? null,
      $nextRunMs: existing?.nextRunMs ?? null,
      $historyJson: JSON.stringify(existing?.history ?? []),
      $maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
      $createdAt: existing?.createdAt ?? now,
      $updatedAt: now,
    });

    return this.get(id)!;
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
  ): void {
    const job = this.get(id);
    if (!job) return;
    const history = [...job.history, record].slice(-HISTORY_CAP);
    this.#updateAfterRun.run({
      $id: id,
      $lastRunMs: lastRunMs,
      $nextRunMs: nextRunMs,
      $historyJson: JSON.stringify(history),
      $retryCount: retryCount,
      $updatedAt: Date.now(),
    });
  }

  /** Toggle the enabled flag. */
  setEnabled(id: string, enabled: boolean): void {
    this.#updateEnabled.run({
      $id: id,
      $enabled: enabled ? 1 : 0,
      $updatedAt: Date.now(),
    });
  }
}

function fromRow(r: CronRow): CronJob {
  return {
    id: r.id,
    name: r.name,
    task: r.task,
    schedule: JSON.parse(r.schedule_json) as Schedule,
    delivery: JSON.parse(r.delivery_json) as DeliveryTarget,
    enabled: r.enabled === 1,
    lastRunMs: r.last_run_ms ?? undefined,
    nextRunMs: r.next_run_ms ?? undefined,
    history: JSON.parse(r.history_json) as CronRunRecord[],
    maxRetries: r.max_retries,
    retryCount: r.retry_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
