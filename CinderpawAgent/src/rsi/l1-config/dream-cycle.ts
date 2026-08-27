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
 *   CINDERPAW_RSI_IDLE_MS=5000 CINDERPAW_RSI_POLL_MS=1000 CINDERPAW_RSI_COOLDOWN_MS=1000
 * Launch the app, stop touching it for ~6s, then watch for:
 *   - stderr:  "rsi dream: arming event-driven scheduler …"
 *   - stdout:  {type:"dream_cycle", phase:"started"/"ended", …}
 *   - UI:      typing-bar mascot enters its `dreaming` pose + a toast
 *   - file:    a new line in ~/.cinderpaw/rsi/dream.jsonl (or $CINDERPAW_RSI_TELEMETRY)
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
} from "../infra/journal.ts";
import {
  DEFAULT_BUDGET_CAPS,
  remaining,
  zeroSpend,
  type BudgetCaps,
} from "../infra/budget.ts";
import type { RsiRunStats } from "../sidecar.ts";
import type { EpisodeOptions } from "./episode-options.ts";
import type { OutboundEvent } from "../../types.ts";
import {
  dirSizeMb,
  endResourceSample,
  startResourceSample,
  type ResourceSample,
} from "../infra/resource-monitor.ts";
import { dirname } from "node:path";

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
  /** The episode's resource caps (BRSI §2.5) for honest `budgetRemaining`
   *  reporting in the journal. Absent → §2.5 defaults. The host derives
   *  it from the episode options via `episodeBudgetCaps`. */
  budgetCaps?: BudgetCaps;
  /** Supplies idle/error trigger signals. */
  activityMonitor: ActivityMonitor;
  /** Thresholds + poll/cooldown timings. */
  config: DreamConfig;
  /** Is a model active (local GGUF resident, or a cloud route)? Gates every
   *  wake — see `DreamSchedulerDeps.hasModel`. Absent → always ready. */
  hasModel?: () => boolean | Promise<boolean>;
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
  const { send, telemetryPath, journalPath, budgetCaps, activityMonitor, config, hasModel, log } = deps;
  // Carries the in-flight episode's start time + trigger from the scheduler's
  // `start` callback to the run-end telemetry append. `sample` is the Slice 5
  // resource-measurement window opened at episode start.
  let currentEpisode: {
    startedAt: number;
    trigger: DreamTrigger;
    sample: ResourceSample;
  } | null = null;
  let scheduler: DreamScheduler | undefined;

  const onEpisodeEnd = (stats?: RsiRunStats): void => {
    if (currentEpisode) {
      const endedAt = Date.now();
      // Remember: persist the ops telemetry + the semantic Journal row.
      send({ type: "dream_cycle", stage: "remember", trigger: currentEpisode.trigger });
      // Slice 5: close the resource window opened at episode start. Disk is
      // the RSI state dir (the telemetry file's parent) — the thing dreams
      // actually grow.
      const usage = endResourceSample(currentEpisode.sample);
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
        resources: {
          cpuPct: usage.cpuPct,
          ramMb: usage.ramMb,
          diskMb: dirSizeMb(dirname(telemetryPath)),
        },
      });
      // BRSI §2.9: the semantic lab-notebook row for this episode — what
      // was observed and decided, distinct from the flat ops telemetry
      // above. This is what the journal viewer and Layer-5 meta-evolution
      // read. One row per episode (correct granularity); per-candidate
      // rows arrive when the Contract FSM journals each candidate.
      if (journalPath) {
        appendJournal(
          journalPath(),
          makeCycleSummary(currentEpisode, stats, endedAt, budgetCaps ?? DEFAULT_BUDGET_CAPS),
        );
      }
      // Sleep: the coarse "ended" pulse (UI toast off, mascot wakes) — the
      // seventh stage loops back to a sleeping Wake until the next trigger.
      send({
        type: "dream_cycle",
        phase: "ended",
        stage: "sleep",
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
        currentEpisode = { startedAt: Date.now(), trigger, sample: startResourceSample() };
        // BRSI §2.8 stage sequence. Wake → Observe → (episode = Dream+Mutate+
        // Evaluate). The engine's internal proposal/apply/eval loop is opaque
        // in Faza 1, so it surfaces as one `evaluate` bracket; `dream`/`mutate`
        // are reserved until the engine loop is cracked open (or the Contract
        // FSM owns the per-candidate Evaluate detail — this is that seam). The
        // coarse `phase:"started"` rides the wake pulse for the UI toast +
        // mascot `dreaming` pose.
        send({ type: "dream_cycle", phase: "started", stage: "wake", trigger });
        // Observe: surface WHY the cycle woke (the scheduler already decided;
        // the trigger is the signal). Acceptance/demo signals fold in here once
        // Layer 2 produces them.
        send({ type: "dream_cycle", stage: "observe", trigger });
        // Evaluate: run the bounded episode.
        send({ type: "dream_cycle", stage: "evaluate", trigger });
        await engine.start(episodeOptions);
      },
      isRunning: () => engine.isRunning(),
      hasModel,
      idleForMs: (now) => activityMonitor.idleFor(now),
      errorsInWindow: (now) => activityMonitor.errorsInWindow(now),
      idleThresholdMs: config.idleThresholdMs,
      cooldownMs: config.cooldownMs,
      errorThreshold: config.errorThreshold,
      pollMs: config.pollMs,
      // §2.8 schedule trigger — undefined disables it (idle/error only).
      scheduleIntervalMs: config.scheduleIntervalMs,
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
  caps: BudgetCaps = DEFAULT_BUDGET_CAPS,
): JournalEntry {
  const iterations = stats?.iterations ?? 0;
  const ratchets = stats?.ratchets ?? 0;
  const rejections = stats?.confidenceRejections ?? 0;
  const stopReason = stats?.stopReason ?? "unknown";
  const errors = stats?.errors ?? [];

  // Honest budget accounting (BRSI §2.5): the episode spent this many
  // tokens over this much wall-clock; `remaining` gives the truth the
  // journal used to fake with zeros. CPU/RAM/disk/energy are not measured
  // at the episode level yet, so their spend stays 0 (full cap remaining).
  const wallClockMin = (endedAt - episode.startedAt) / 60_000;
  const spend = { ...zeroSpend(), tokens: stats?.tokens ?? 0, wallClockMin };
  const rem = remaining(caps, spend);
  const clamp0 = (n: number): number => (n > 0 ? n : 0);

  const observed: string[] = [
    `trigger: ${episode.trigger}`,
    `${iterations} evaluation(s), ${ratchets} promoted to main`,
    `stop reason: ${stopReason}`,
    `budget left: ${clamp0(rem.tokens)} tokens, ${clamp0(rem.wallClockMin).toFixed(1)} min`,
  ];
  if (rejections > 0) {
    observed.push(
      `${rejections} candidate(s) beat the score but were blocked by a promotion gate (confidence / Tier 0 floor)`,
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
    // Real remaining budget (BRSI §2.5). Clamped at 0 — a "remaining" field
    // floors at empty; overshoot (rare — GoalConfig stops at the cap) is
    // captured by stopReason, not a negative here.
    budgetRemaining: {
      wallClockMin: clamp0(rem.wallClockMin),
      tokens: clamp0(rem.tokens),
      cpuPct: clamp0(rem.cpuPct),
      ramMb: clamp0(rem.ramMb),
      diskMb: clamp0(rem.diskMb),
    },
  };
}
