/**
 * Dream Cycle wiring — the glue between the activity monitor, the event-driven
 * `DreamScheduler`, the `RsiSidecar` engine, and the host UI/telemetry.
 *
 * This was inline in `index.ts`'s `runAgent()` and never exercised end-to-end
 * (audit D2). Pulled out here so the full path — idle trigger → `dream_cycle`
 * "started" event → bounded episode → run-end telemetry + "ended" event →
 * cooldown — runs against the REAL components in a test, with only the LLM
 * engine faked (the same fake router/bridge the sidecar tests already use).
 *
 * The scheduler and the sidecar reference each other (the scheduler starts the
 * sidecar; the sidecar's run-end drives the scheduler's cooldown). `arm()`
 * breaks that cycle: the sidecar is built first with `onEpisodeEnd` as its
 * `onIdle`, then `arm(sidecar, …)` creates the scheduler that drives it.
 *
 * LIVE SMOKE (manual, with a real local model loaded): make a dream fire in
 * seconds instead of waiting out the 3-minute idle default —
 *   FERAL_RSI_IDLE_MS=5000 FERAL_RSI_POLL_MS=1000 FERAL_RSI_COOLDOWN_MS=1000
 * Launch the app, stop touching it for ~6s, then watch for:
 *   - stderr:  "rsi dream: arming event-driven scheduler …"
 *   - stdout:  {type:"dream_cycle", phase:"started"/"ended", …}
 *   - UI:      typing-bar mascot enters its `dreaming` pose + a toast
 *   - file:    a new line in ~/.feral/rsi/dream.jsonl (or $FERAL_RSI_TELEMETRY)
 * The dream-cycle-e2e test automates this same path with the LLM engine faked.
 */

import { DreamScheduler, type DreamTrigger } from "./dream-scheduler.ts";
import type { ActivityMonitor } from "./activity-monitor.ts";
import type { DreamConfig } from "./dream-config.ts";
import { appendDreamTelemetry } from "./dream-telemetry.ts";
import type { RsiRunStats } from "./sidecar.ts";
import type { EpisodeOptions } from "./episode-options.ts";
import type { OutboundEvent } from "../types.ts";

/** The minimal slice of `RsiSidecar` the Dream Cycle drives. */
export interface DreamEngine {
  start(opts: EpisodeOptions): Promise<void>;
  isRunning(): boolean;
}

export interface DreamCycleDeps {
  /** Emit an event to the host (transport.send). */
  send: (event: OutboundEvent) => void;
  /** JSONL path for per-episode telemetry. */
  telemetryPath: string;
  /** Supplies idle/error trigger signals. */
  activityMonitor: ActivityMonitor;
  /** Thresholds + poll/cooldown timings. */
  config: DreamConfig;
  /** Optional log sink. */
  log?: (msg: string) => void;
}

export interface DreamCycle {
  /** Plug this into `RsiSidecar`'s `onIdle`: appends telemetry, emits the
   *  `dream_cycle` "ended" event, and enters the scheduler cooldown. */
  onEpisodeEnd: (stats?: RsiRunStats) => void;
  /** Build the scheduler that drives `engine`. Returns it so the caller can
   *  `start()` (arm the poll loop) and `shutdown()` it. */
  arm: (engine: DreamEngine, episodeOptions: EpisodeOptions) => DreamScheduler;
}

export function createDreamCycle(deps: DreamCycleDeps): DreamCycle {
  const { send, telemetryPath, activityMonitor, config, log } = deps;
  // Carries the in-flight episode's start time + trigger from the scheduler's
  // `start` callback to the run-end telemetry append.
  let currentEpisode: { startedAt: number; trigger: DreamTrigger } | null = null;
  let scheduler: DreamScheduler | undefined;

  const onEpisodeEnd = (stats?: RsiRunStats): void => {
    if (currentEpisode) {
      appendDreamTelemetry(telemetryPath, {
        startedAt: currentEpisode.startedAt,
        endedAt: Date.now(),
        trigger: currentEpisode.trigger,
        iterations: stats?.iterations ?? 0,
        tokens: stats?.tokens ?? 0,
        ratchets: stats?.ratchets ?? 0,
        stopReason: stats?.stopReason ?? "unknown",
      });
      send({
        type: "dream_cycle",
        phase: "ended",
        trigger: currentEpisode.trigger,
        iterations: stats?.iterations ?? 0,
        ratchets: stats?.ratchets ?? 0,
        stopReason: stats?.stopReason ?? "unknown",
      });
      currentEpisode = null;
    }
    // Enter the sleep/cooldown window; the poll loop relaunches on the next
    // trigger (no immediate restart — that was the burn loop).
    scheduler?.onRunEnded();
  };

  const arm = (engine: DreamEngine, episodeOptions: EpisodeOptions): DreamScheduler => {
    scheduler = new DreamScheduler({
      start: async (trigger) => {
        currentEpisode = { startedAt: Date.now(), trigger };
        // Tell the UI the dream started (toast + mascot dreaming pose).
        send({ type: "dream_cycle", phase: "started", trigger });
        await engine.start(episodeOptions);
      },
      isRunning: () => engine.isRunning(),
      idleForMs: (now) => activityMonitor.idleFor(now),
      errorsInWindow: (now) => activityMonitor.errorsInWindow(now),
      idleThresholdMs: config.idleThresholdMs,
      cooldownMs: config.cooldownMs,
      errorThreshold: config.errorThreshold,
      pollMs: config.pollMs,
      log,
    });
    return scheduler;
  };

  return { onEpisodeEnd, arm };
}
