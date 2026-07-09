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
