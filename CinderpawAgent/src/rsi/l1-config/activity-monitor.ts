/**
 * Activity & error monitor — the trigger inputs to the Dream Cycle scheduler.
 *
 * The Dream Cycle (see `docs/superpowers/specs/2026-06-25-rsi-dream-cycle-design.md`)
 * wakes when the agent has been idle long enough, or when errors have piled up
 * fast enough. Both signals are tracked here as a single, side-effect-free
 * object so the scheduler can poll it cheaply.
 *
 * The class is intentionally pure:
 *   - No timers, no `Date.now()`. Every method takes the current time as an
 *     explicit `nowMs: number`, so tests are deterministic.
 *   - No eviction work happens until the caller asks. The error log is a
 *     plain list and `errorsInWindow` filters on read; this keeps the
 *     write paths branch-free and gives the scheduler a single read cost
 *     per decision.
 *   - `recordActivity` and `recordError` are orthogonal. Activity does not
 *     reset the error log (you can have a healthy long session that just
 *     had a hiccup 10 minutes ago), and errors do not reset the idle clock
 *     (the user can still be hammering the agent while the engine trips).
 */

export interface ActivityMonitorOptions {
  /** Rolling window for the error trigger, in milliseconds. Errors older
   *  than `nowMs - errorWindowMs` are evicted on read. Default 15*60_000. */
  errorWindowMs?: number;
}

const DEFAULT_ERROR_WINDOW_MS = 15 * 60_000;

export class ActivityMonitor {
  private lastActivityMs: number | null = null;
  private readonly errors: number[] = [];
  private readonly outcomes: Array<{ at: number; ok: boolean }> = [];
  private readonly windowMs: number;

  constructor(opts?: ActivityMonitorOptions) {
    this.windowMs = opts?.errorWindowMs ?? DEFAULT_ERROR_WINDOW_MS;
  }

  /** Mark activity (inbound user message, tool/agent step, anything that
   *  counts as the agent doing work for the user). Updates the idle clock. */
  recordActivity(nowMs: number): void {
    this.lastActivityMs = nowMs;
  }

  /** Mark an agent/eval error occurrence. Does NOT touch the idle clock —
   *  errors can pile up while the agent is still serving the user. */
  recordError(nowMs: number): void {
    this.errors.push(nowMs);
  }

  /**
   * Mark a UNIT OF REAL WORK finishing, and whether it worked.
   *
   * The error trigger used to hear only inference failures — the model
   * refusing, the endpoint dying. Those are the times the agent could not
   * speak. They are not the times it was WRONG, and a self-improving system
   * that cannot tell the difference is improving in response to its own
   * plumbing rather than to its results: it fails a task outright, and
   * nothing anywhere counts that as a reason to get better.
   *
   * A failed unit of work now feeds the same rolling window an inference
   * error does, so the thing that wakes the engine is the thing that went
   * wrong out here. Successes are counted too, because a failure rate is
   * the number worth acting on and a bare failure count is not: an agent
   * doing a hundred jobs an hour and missing three is not the same as one
   * that missed three out of three.
   *
   * The idle clock is untouched, exactly as with `recordError` — finishing
   * a job does not mean the user is present.
   */
  recordOutcome(nowMs: number, ok: boolean): void {
    this.outcomes.push({ at: nowMs, ok });
    if (!ok) this.errors.push(nowMs);
  }

  /** Real-work outcomes inside the rolling window: how many finished, and
   *  how many of those failed. `{ total: 0, failed: 0 }` before any land. */
  outcomesInWindow(nowMs: number): { total: number; failed: number } {
    const cutoff = nowMs - this.windowMs;
    while (this.outcomes.length > 0 && this.outcomes[0]!.at < cutoff) {
      this.outcomes.shift();
    }
    let failed = 0;
    for (const o of this.outcomes) if (!o.ok) failed++;
    return { total: this.outcomes.length, failed };
  }

  /** Milliseconds since the last activity. Returns `Number.POSITIVE_INFINITY`
   *  if `recordActivity` was never called — the scheduler treats that as
   *  "as idle as possible" so the first dream can fire on a fresh boot. */
  idleFor(nowMs: number): number {
    if (this.lastActivityMs === null) return Number.POSITIVE_INFINITY;
    return nowMs - this.lastActivityMs;
  }

  /** Count of errors within `errorWindowMs` before `nowMs`. Older entries
   *  are evicted lazily on each call (cheap; the list is bounded by the
   *  rate at which errors are recorded, and the scheduler polls this on
   *  each decision tick). */
  errorsInWindow(nowMs: number): number {
    const cutoff = nowMs - this.windowMs;
    // Evict from the head. The list is monotonically non-decreasing in ts
    // because the scheduler drives it forward in time, so a linear scan
    // from the front is the right shape.
    while (this.errors.length > 0 && this.errors[0]! < cutoff) {
      this.errors.shift();
    }
    return this.errors.length;
  }
}
