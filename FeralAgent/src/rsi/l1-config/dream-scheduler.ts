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

/** The reason an episode was launched — carried into telemetry (BRSI §2.8
 *  "Wake events"). `idle` / `error` are the literature triggers and fire from
 *  the activity monitor. The four §2.8 triggers:
 *   - `schedule`  — a periodic wake (weekly default); self-driving via
 *                   `scheduleIntervalMs`.
 *   - `user`      — user-initiated; forced via `requestUserDream()`, bypasses
 *                   the cooldown gate (explicit intent beats back-off).
 *   - `threshold` — N demos accumulated. RESERVED: the demo-capture pipeline
 *                   (Layer 2) has no producer yet, so nothing fires it today.
 *   - `budget_available` — resources freed up. RESERVED: no producer yet.
 *  `threshold` / `budget_available` are in the type so the schema is complete
 *  (mirrors the EvalHalted type-first / emitter-later pattern); their firing
 *  paths land when their producers do. */
export type DreamTrigger =
  | "idle"
  | "error"
  | "schedule"
  | "user"
  | "threshold"
  | "budget_available";

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
  /** Periodic "schedule" wake (BRSI §2.8). When set, a `schedule` trigger
   *  fires once per interval (measured from scheduler construction, then from
   *  each schedule fire). Undefined disables the schedule trigger — idle/error
   *  remain the only automatic triggers, preserving Faza-1 behaviour. */
  scheduleIntervalMs?: number;
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
  /** A user asked for a dream; consumed by the next tick (bypasses cooldown). */
  private pendingUserTrigger = false;
  /** When the last `schedule` trigger fired (or construction time), so the
   *  first scheduled wake is one full interval after boot. */
  private lastScheduleFireAt: number;

  constructor(private readonly deps: DreamSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.lastScheduleFireAt = this.now();
  }

  /** Request a user-initiated dream on the next tick (BRSI §2.8 `user`
   *  trigger). Bypasses the cooldown gate — explicit intent beats back-off.
   *  No-op while shutting down; idempotent (repeated calls before the next
   *  tick collapse to one launch). */
  requestUserDream(): void {
    if (this.shuttingDown) return;
    this.pendingUserTrigger = true;
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
    // A user-initiated dream bypasses the cooldown gate (explicit intent beats
    // back-off); every automatic trigger still respects cooldown.
    const userRequested = this.pendingUserTrigger;
    if (!userRequested && now - this.lastEpisodeEndedAt < this.deps.cooldownMs) return;

    const trigger = userRequested ? "user" : this.evaluateTrigger(now);
    if (!trigger) return;

    // Consume the one-shot signals now that this trigger is committed to launch.
    if (trigger === "user") this.pendingUserTrigger = false;
    if (trigger === "schedule") this.lastScheduleFireAt = now;

    this.launching = true;
    try {
      await this.deps.start(trigger);
    } catch (err) {
      this.deps.log?.(`dream: episode start failed (${String(err)})`);
    } finally {
      this.launching = false;
    }
  }

  /** Which automatic trigger fires now, if any. Precedence: error → schedule →
   *  idle. Error wins — a failing agent should be improved even if the user is
   *  active. The `user` trigger is handled in `tick` (it bypasses cooldown);
   *  `threshold` / `budget_available` have no producer yet (see DreamTrigger). */
  private evaluateTrigger(now: number): DreamTrigger | null {
    if (this.deps.errorsInWindow(now) >= this.deps.errorThreshold) return "error";
    if (
      this.deps.scheduleIntervalMs !== undefined &&
      now - this.lastScheduleFireAt >= this.deps.scheduleIntervalMs
    ) {
      return "schedule";
    }
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
