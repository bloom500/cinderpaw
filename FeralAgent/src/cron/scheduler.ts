/**
 * Cron scheduler — the timer loop that fires due jobs.
 *
 * Design notes (P0-3):
 *   - The scheduler is constructed with a `runJob` function injected
 *     from index.ts. V1 implementation calls `InferenceRouter.complete()`
 *     with a system-prompted "you are a scheduled task" message. V2
 *     (P0-1) will replace this with a subagent run for tool-using jobs.
 *   - A single setTimeout fires `tick()` at a fixed interval
 *     (default 30s, co-operates with the heartbeat). The tick walks
 *     the job list, picks every enabled job whose `nextRunMs <= now`,
 *     and runs them in series (parallel would complicate budget
 *     accounting and is rarely needed for user-schedulable jobs).
 *   - Failed runs increment `retryCount`. Successful runs reset it to 0.
 *     When `retryCount >= maxRetries`, the job is left in the DB but
 *     the run is recorded as `failed` and the user can see the
 *     pattern in the history. We don't auto-disable — the user might
 *     want a noisy reminder of a recurring failure.
 *   - One-shot `at` jobs are disabled after a successful run so the
 *     scheduler doesn't keep checking them.
 */

import { nextRunAt } from "./schedule.ts";
import { deliverCron, type CronDeliveryContext } from "./delivery.ts";
import type {
  CronJob,
  CronRunRecord,
  DeliveryTarget,
  OutboundEvent,
} from "../types.ts";
import type { CronJobsRepo } from "./jobs.ts";

/**
 * The function the scheduler calls to actually execute a job's task.
 * Injected so tests can stub the inference path; the production wiring
 * lives in index.ts and routes through `InferenceRouter`.
 */
export type CronRunFn = (job: CronJob) => Promise<string>;

export interface CronSchedulerConfig {
  repo: CronJobsRepo;
  runJob: CronRunFn;
  /** Delivery dispatcher. The default uses the chat/webhook/tool helper. */
  deliver?: (
    target: DeliveryTarget,
    content: string,
    job: CronJob,
    ctx: CronDeliveryContext,
  ) => Promise<void> | void;
  /** How often the timer tick runs. Default 30s (matches heartbeat). */
  tickIntervalMs?: number;
  /** Wall-clock cap for a single job. Default 5 min. */
  jobTimeoutMs?: number;
  /** Override the clock (for tests). */
  now?: () => Date;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000;

export class CronScheduler {
  readonly #repo: CronJobsRepo;
  readonly #runJob: CronRunFn;
  readonly #deliver: NonNullable<CronSchedulerConfig["deliver"]>;
  readonly #tickMs: number;
  readonly #jobTimeoutMs: number;
  readonly #now: () => Date;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #inflight = false;

  constructor(config: CronSchedulerConfig) {
    this.#repo = config.repo;
    this.#runJob = config.runJob;
    this.#deliver = config.deliver ?? deliverCron;
    this.#tickMs = config.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.#jobTimeoutMs = config.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    this.#now = config.now ?? (() => new Date());
  }

  /** Start the timer. Idempotent. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule();
  }

  /** Stop the timer cleanly. */
  stop(): void {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Run one tick synchronously. Public for tests and for an
   * explicit "fire now" tool (V2). Walks all enabled jobs whose
   * `nextRunMs <= now` and runs them in series.
   */
  async tick(): Promise<void> {
    if (this.#inflight) return; // never overlap ticks
    this.#inflight = true;
    try {
      const now = this.#now();
      const due = this.#repo.list().filter((j) => {
        if (!j.enabled) return false;
        if (j.nextRunMs == null) return false;
        return j.nextRunMs <= now.getTime();
      });
      for (const job of due) {
        await this.#runOne(job);
      }
    } finally {
      this.#inflight = false;
    }
  }

  #schedule(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.tick()
        .catch((err) => {
          // Last-resort visibility — the scheduler must never crash the sidecar.
          process.stderr.write(`[cron] tick failed: ${String(err)}\n`);
        })
        .finally(() => this.#schedule());
    }, this.#tickMs);
    this.#timer.unref?.();
  }

  async #runOne(job: CronJob): Promise<void> {
    const startedAt = this.#now().getTime();
    const from = this.#now();
    let record: CronRunRecord;
    let content: string | undefined;

    try {
      content = await this.#withTimeout(this.#runJob(job), this.#jobTimeoutMs);
      const newRetry = 0; // success resets the streak
      record = {
        runAt: startedAt,
        status: "success",
        durationMs: this.#now().getTime() - startedAt,
        result: content.slice(0, 2_000),
      };
      this.#repo.updateAfterRun(
        job.id,
        startedAt,
        computeNext(job, from),
        record,
        newRetry,
      );
      if (job.schedule.kind === "at") {
        // One-shot consumed.
        this.#repo.setEnabled(job.id, false);
      }
    } catch (err) {
      const newRetry = job.retryCount + 1;
      record = {
        runAt: startedAt,
        status: err instanceof CronTimeoutError ? "timeout" : "failed",
        durationMs: this.#now().getTime() - startedAt,
        error: String(err).slice(0, 500),
      };
      this.#repo.updateAfterRun(
        job.id,
        startedAt,
        computeNext(job, from),
        record,
        newRetry,
      );
    }

    // Deliver the content on success only — failed runs have no
    // meaningful content to show the user.
    if (record.status === "success" && content != null) {
      // Delivery is fire-and-forget here; failures update the run
      // record via the deliver helper (it emits an error event).
      try {
        await this.#deliver(job.delivery, content, job, {
          emit: (_e: OutboundEvent) => {
            // The production wiring in index.ts overrides this with
            // `transport.send`. Tests inject their own deliver that
            // bypasses emit entirely.
          },
          fetch: globalThis.fetch,
        });
      } catch (err) {
        process.stderr.write(
          `[cron] delivery failed for "${job.name}": ${String(err)}\n`,
        );
      }
    }
  }

  async #withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CronTimeoutError(`job exceeded ${ms}ms`)),
        ms,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class CronTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronTimeoutError";
  }
}

/** Next run timestamp for a job, or null when the schedule is exhausted. */
function computeNext(job: CronJob, from: Date = new Date()): number | null {
  if (job.schedule.kind === "at") {
    const target = Date.parse(job.schedule.isoTimestamp);
    if (Number.isNaN(target) || target <= from.getTime()) return null;
    return target;
  }
  return nextRunAt(job.schedule, from);
}
