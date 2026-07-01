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
import {
  appendJournal,
  type JournalDecision,
  type JournalEntry,
} from "./journal.ts";
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
  /** Where the Evolution Journal (BRSI §2.9) lands. A function because
   *  the journal file rotates per UTC day; resolved at each write. Absent
   *  → no journal is written (Faza 1 behaviour). The host supplies
   *  `() => defaultJournalPath()`. */
  journalPath?: () => string;
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
  const { send, telemetryPath, journalPath, activityMonitor, config, log } = deps;
  // Carries the in-flight episode's start time + trigger from the scheduler's
  // `start` callback to the run-end telemetry append.
  let currentEpisode: { startedAt: number; trigger: DreamTrigger } | null = null;
  let scheduler: DreamScheduler | undefined;

  const onEpisodeEnd = (stats?: RsiRunStats): void => {
    if (currentEpisode) {
      const endedAt = Date.now();
      appendDreamTelemetry(telemetryPath, {
        startedAt: currentEpisode.startedAt,
        endedAt,
        trigger: currentEpisode.trigger,
        iterations: stats?.iterations ?? 0,
        tokens: stats?.tokens ?? 0,
        ratchets: stats?.ratchets ?? 0,
        stopReason: stats?.stopReason ?? "unknown",
        errors: stats?.errors ?? [],
        emptyResponses: stats?.emptyResponses ?? 0,
      });
      // BRSI §2.9: the semantic lab-notebook row for this episode — what
      // was observed and decided, distinct from the flat ops telemetry
      // above. This is what the journal viewer and Layer-5 meta-evolution
      // read. One row per episode (correct granularity); per-candidate
      // rows arrive when the Contract FSM journals each candidate.
      if (journalPath) {
        appendJournal(journalPath(), makeCycleSummary(currentEpisode, stats, endedAt));
      }
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

/** Map an ended dream episode to one Evolution Journal row (BRSI §2.9).
 *  Episode-grained: `experimented` / `result` are null because an episode
 *  spans many candidates, not one — those fields fill in per-candidate
 *  once the Contract FSM journals each candidate. The value here is the
 *  `decided` outcome + `observed` summary, honestly derived from the run
 *  stats. Pure + deterministic given `endedAt`; exported for testing. */
export function makeCycleSummary(
  episode: { startedAt: number; trigger: DreamTrigger },
  stats: RsiRunStats | undefined,
  endedAt: number,
): JournalEntry {
  const iterations = stats?.iterations ?? 0;
  const ratchets = stats?.ratchets ?? 0;
  const rejections = stats?.confidenceRejections ?? 0;
  const stopReason = stats?.stopReason ?? "unknown";
  const errors = stats?.errors ?? [];

  const observed: string[] = [
    `trigger: ${episode.trigger}`,
    `${iterations} evaluation(s), ${ratchets} promoted to main`,
    `stop reason: ${stopReason}`,
  ];
  if (rejections > 0) {
    observed.push(
      `${rejections} candidate(s) beat the score but failed the confidence gate`,
    );
  }
  if (errors.length > 0) {
    observed.push(`${errors.length} eval error(s): ${errors.slice(0, 3).join("; ")}`);
  }

  const decided: JournalDecision =
    stopReason === "error"
      ? { action: "halt", reason: errors[0] ?? "episode errored", stage: "evaluate" }
      : ratchets > 0
        ? {
            action: "accept",
            reason: `${ratchets} candidate(s) cleared the confidence gate and ratcheted main`,
          }
        : {
            action: "reject",
            reason: "no candidate cleared the bar this episode",
            nextStep: "more mutation / lower selection pressure next cycle",
          };

  return {
    cycleId: `c-${new Date(episode.startedAt).toISOString()}`,
    timestamp: endedAt,
    durationMin: (endedAt - episode.startedAt) / 60_000,
    observed,
    // ponytail: no hypothesis engine yet — filled by the Dream stage of the
    // 7-stage cycle rewrite. Empty is honest, not a stub.
    hypothesized: [],
    experimented: null,
    result: null,
    decided,
    // ponytail: budget not enforced yet; zeros until budget.ts wires into
    // the cycle. Real remaining values arrive with the budget controller.
    budgetRemaining: { wallClockMin: 0, tokens: 0, cpuPct: 0, ramMb: 0, diskMb: 0 },
  };
}
