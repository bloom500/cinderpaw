/**
 * Dream Cycle — the event-driven scheduler.
 *
 * Replaces PassiveSupervisor. Where the old supervisor relaunched the
 * engine ~5s after every run end (a continuous always-on loop that burns
 * tokens with no prompt), the DreamScheduler runs ONE bounded episode and
 * then SLEEPS until a trigger fires:
 *
 *   - idle:  the user has been inactive for `idleThresholdMs` (the agent
 *            "dreams" only while it isn't in the user's way);
 *   - error: real failures crossed `errorThreshold` within the activity
 *            monitor's rolling window (the literature's "error" trigger —
 *            improve when something is actually going wrong).
 *
 * Between episodes, `cooldownMs` prevents thrashing (back-to-back relaunch
 * the moment a run ends). The engine math is untouched: the scheduler only
 * decides *when* to start a bounded episode.
 *
 * All time + signals are injected (the activity monitor supplies
 * `idleForMs` / `errorsInWindow`; `now`/timers are injectable) so the
 * lifecycle is deterministic in tests — the same discipline the old
 * supervisor used.
 */

/** The reason an episode was launched — carried into telemetry. */
export type DreamTrigger = "idle" | "error";

export interface DreamSchedulerDeps {
  /** Launch one bounded episode. Resolves once the start is dispatched.
   *  `trigger` is the reason (for telemetry). */
  start: (trigger: DreamTrigger) => Promise<void>;
  /** Is an episode currently running? Guards against double-start. */
  isRunning: () => boolean;
  /** Milliseconds since the user's last activity (from ActivityMonitor). */
  idleForMs: (now: number) => number;
  /** Count of recent errors within the monitor window (from ActivityMonitor). */
  errorsInWindow: (now: number) => number;
  /** Idle duration that triggers a dream cycle. */
  idleThresholdMs: number;
  /** Minimum gap between the end of one episode and the start of the next. */
  cooldownMs: number;
  /** Error count (within the monitor window) that triggers a dream cycle. */
  errorThreshold: number;
  /** Clock source (injectable for tests). Default: Date.now. */
  now?: () => number;
  /** Poll scheduler for the internal tick loop (injectable for tests).
   *  Default: an unref'd setInterval so a pending poll never pins the
   *  process open. Only used by `start()`. */
  schedule?: (cb: () => void, ms: number) => void;
  /** How often `start()`'s loop evaluates triggers. Default 30_000ms. */
  pollMs?: number;
  /** Optional log sink. */
  log?: (msg: string) => void;
}

export class DreamScheduler {
  private shuttingDown = false;
  private launching = false;
  /** When the last episode ended (per `now`). -Infinity means "no episode
   *  yet", so the very first trigger is never gated by cooldown. */
  private lastEpisodeEndedAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(private readonly deps: DreamSchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Begin the trigger loop. Arms a periodic tick; does NOT launch an
   *  episode immediately — the agent waits for an idle/error trigger. */
  start(): void {
    if (this.shuttingDown) return;
    const schedule =
      this.deps.schedule ??
      ((cb, ms) => {
        const t = setInterval(cb, ms);
        if (typeof t === "object" && t && "unref" in t) {
          (t as { unref: () => void }).unref();
        }
      });
    schedule(() => void this.tick(), this.deps.pollMs ?? 30_000);
  }

  /**
   * Evaluate the triggers once and launch a bounded episode if one fires.
   * Public so production drives it from a poll loop and tests drive it
   * directly. No-op while shutting down, already running, mid-launch, or
   * inside the cooldown window.
   */
  async tick(): Promise<void> {
    if (this.shuttingDown || this.launching) return;
    if (this.deps.isRunning()) return;

    const now = this.now();
    if (now - this.lastEpisodeEndedAt < this.deps.cooldownMs) return; // cooldown

    const trigger = this.evaluateTrigger(now);
    if (!trigger) return;

    this.launching = true;
    try {
      await this.deps.start(trigger);
    } catch (err) {
      this.deps.log?.(`dream: episode start failed (${String(err)})`);
    } finally {
      this.launching = false;
    }
  }

  /** Which trigger fires now, if any. Error takes precedence over idle —
   *  a failing agent should be improved even if the user is active. */
  private evaluateTrigger(now: number): DreamTrigger | null {
    if (this.deps.errorsInWindow(now) >= this.deps.errorThreshold) return "error";
    if (this.deps.idleForMs(now) >= this.deps.idleThresholdMs) return "idle";
    return null;
  }

  /** Called when an episode ends. Starts the cooldown window; the tick
   *  loop keeps running and will relaunch once cooldown elapses and a
   *  trigger fires again. */
  onRunEnded(): void {
    if (this.shuttingDown) return;
    this.lastEpisodeEndedAt = this.now();
    this.deps.log?.("dream: episode ended — sleeping until next trigger");
  }

  /** Break the loop (app teardown). After this, no episode ever launches. */
  shutdown(): void {
    this.shuttingDown = true;
  }
}
