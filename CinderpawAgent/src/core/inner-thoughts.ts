/**
 * Inner Thoughts — the proactive background loop.
 *
 * Runs independently of the request/response cycle. On each tick:
 *   1. Checks the mood + activity gates. If both are below threshold,
 *      the tick is suppressed without calling the model.
 *   2. If gates pass, queries episodic memory for recent context.
 *   3. Sends a prompt asking "Is there something worth surfacing?"
 *   4. If the model produces a non-suppressed thought, emits a
 *      `proactive` event.
 *   5. Records the thought (and suppression decision) to inner_thoughts.
 *
 * The loop never crashes the process. All errors are caught and the
 * loop reschedules itself. The inference call goes through the same
 * router (budgets, allowlist) as every other LLM call.
 *
 * PROACTIVE-AGENT DESIGN (P-#12)
 * The agent must feel "human" — come to the user with messages, not
 * only respond. Three gates decide whether a tick actually fires the
 * model:
 *   - Mood gate: at least one dimension (energy, curiosity, concern,
 *     satisfaction) must be above `moodGateThreshold`. A "flat" mood
 *     (everything < 0.4) means the agent has nothing meaningful to
 *     contribute — SUPPRESS.
 *   - Idle gate: skip the tick if the user sent a message in the last
 *     `minIdleMs` milliseconds. Don't interrupt active conversations;
 *     fire on quiet moments.
 *   - Cooldown: even if gates pass, suppress if a thought was
 *     surfaced less than `cooldownMs` ago. Prevents ping-pong spam.
 *
 * The user can disable the loop entirely with
 * `CINDERPAW_INNER_THOUGHTS_ENABLED=false` if they want a strictly
 * reactive agent.
 */

import type { Database } from "bun:sqlite";
import type { InferenceRouter } from "../egress/inference-router.ts";
import type { EpisodicMemory } from "../memory/episodic.ts";
import type { MoodEngine } from "./mood.ts";
import type { EventSink } from "./agent-loop.ts";

export interface InnerThoughtsConfig {
  /** How often the loop ticks, in milliseconds. */
  intervalMs: number;
  /** Session ID used for inference budget tracking. */
  sessionId: string;
  /** Max tokens for the thought-generation completion. */
  maxTokens: number;
  /**
   * Minimum mood dimension (0..1) required for a tick to fire the model.
   * Default 0.5 — a fully flat mood skips the LLM call entirely.
   */
  moodGateThreshold: number;
  /**
   * Skip the tick if the user sent a message in the last N ms.
   * Default 60_000 (1 min) — the agent surfaces thoughts when the user
   * pauses, not while they're actively chatting.
   */
  minIdleMs: number;
  /**
   * Minimum gap between two surfaced thoughts. Default 4 hours — at
   * most 1 message per ~4h of idle, so an 8h work day = max 2-3
   * proactive messages, regardless of how chatty the mood is.
   */
  cooldownMs: number;
  /**
   * Hard daily cap on surfaced thoughts. Default 3 per UTC day. After
   * the cap is hit, the loop won't emit until the next day even if all
   * other gates pass. This is the user-facing guarantee that the
   * agent will not "spam" — backed by an in-memory counter, reset at
   * midnight UTC.
   */
  dailyCap: number;
  /**
   * Timestamp of the user's most recent message, in ms since epoch.
   * Updated by the transport via `noteUserActivity()`. The agent loop
   * calls this on every `handle()` so the inner-thoughts loop can
   * measure idle time.
   */
  lastUserActivityMs: number;
  /**
   * Timestamp of the last SURFACED thought (not the last tick). Used
   * for the cooldown gate. Updated after a successful emit.
   */
  lastSurfacedMs: number;
  /**
   * Mutable counter: how many thoughts have been surfaced today (UTC).
   * Reset to 0 when the UTC day rolls over. Read by the daily-cap
   * gate; written after every successful emit.
   */
  surfacedToday: number;
  /** UTC day-of-year at the time of the last reset. */
  surfacedTodayUtcDay: number;
}

const DEFAULT_CONFIG: InnerThoughtsConfig = {
  intervalMs: 2 * 60 * 1000, // 2 min — fires often enough to feel alive
  sessionId: "inner-thoughts",
  maxTokens: 256,
  moodGateThreshold: 0.5,
  minIdleMs: 10 * 60 * 1000,  // 10 min idle (definitely a real break, not just looking away)
  cooldownMs: 4 * 60 * 60_000, // 4 hours between surfaced messages
  dailyCap: 3,                  // hard daily limit: 2-3 proactive messages per day
  lastUserActivityMs: 0,
  lastSurfacedMs: 0,
  surfacedToday: 0,
  surfacedTodayUtcDay: 0,
};

export class InnerThoughtsLoop {
  readonly #router: InferenceRouter;
  readonly #episodic: EpisodicMemory;
  readonly #mood: MoodEngine;
  readonly #db: Database;
  readonly #config: InnerThoughtsConfig;
  #emit: EventSink | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(
    router: InferenceRouter,
    episodic: EpisodicMemory,
    mood: MoodEngine,
    db: Database,
    config: Partial<InnerThoughtsConfig> = {},
  ) {
    this.#router = router;
    this.#episodic = episodic;
    this.#mood = mood;
    this.#db = db;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record that the user just sent a message. Called by the agent loop
   * on every `handle()` so the idle gate can measure time since last
   * user activity. Cheap (single assignment).
   */
  noteUserActivity(): void {
    this.#config.lastUserActivityMs = Date.now();
  }

  /** Attach the transport sink that receives proactive events. */
  setEmit(emit: EventSink): void {
    this.#emit = emit;
  }

  /** Start the background loop. Idempotent. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule();
  }

  /** Stop the loop cleanly (e.g. on shutdown). */
  stop(): void {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Run ONE tick of the loop synchronously (well, awaits the tick
   * itself). Public for testing — production code uses start()/stop()
   * with the timer. Does NOT require the loop to be running.
   */
  async tickNow(): Promise<void> {
    await this.#tick();
  }

  #schedule(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      void this.#tick().finally(() => this.#schedule());
    }, this.#config.intervalMs);
    // Don't keep the process alive just for this timer.
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    // PROACTIVE-AGENT gates (P-#12). Run BEFORE the expensive LLM call
    // so quiet hours don't burn budget. Each gate is documented inline.
    if (!this.#gatesPass()) {
      this.#persistThought("[gated: idle or low mood]", false);
      return;
    }

    let thought: string;
    try {
      thought = await this.#generateThought();
    } catch {
      this.#mood.applyEvent("inference_error");
      return;
    }

    const suppressed = !thought || thought.trim().toUpperCase() === "SUPPRESS";
    this.#persistThought(thought, !suppressed);

    if (!suppressed && this.#emit) {
      this.#emit({ type: "proactive", content: thought.trim() });
      this.#mood.applyEvent("message_answered");
      this.#config.lastSurfacedMs = Date.now();
      this.#config.surfacedToday++;
    }
  }

  /**
   * Check the four gates. All must pass for the LLM call to fire.
   * Returns false (and the reason implicitly, via #persistThought) when
   * a gate blocks the tick.
   *
   * Gates are intentionally cheap (no I/O) so a quiet loop costs ~zero.
   */
  #gatesPass(): boolean {
    const now = Date.now();
    const cfg = this.#config;

    // Daily cap gate: hard guarantee that the agent surfaces at most
    // `dailyCap` thoughts per UTC day. This is the user-facing promise
    // that the agent won't spam, regardless of mood, idle time, or
    // cooldown state. Counter resets at midnight UTC.
    this.#maybeResetDailyCounter();
    if (cfg.surfacedToday >= cfg.dailyCap) {
      return false;
    }

    // Idle gate: skip if user is actively chatting. The 10-min default
    // means: user types → wait 10 min of silence → agent can speak.
    if (cfg.lastUserActivityMs > 0 && now - cfg.lastUserActivityMs < cfg.minIdleMs) {
      return false;
    }

    // Cooldown gate: even after the user goes quiet, don't ping-pong.
    if (cfg.lastSurfacedMs > 0 && now - cfg.lastSurfacedMs < cfg.cooldownMs) {
      return false;
    }

    // Mood gate: at least one dimension above threshold. A flat mood
    // (all < threshold) means the agent is in "I have nothing to say"
    // mode and SUPPRESS is the right answer. The LLM is the final
    // filter on what to say; this gate only filters "is it worth
    // asking the LLM at all?".
    const mood = this.#mood.snapshot();
    const maxDimension = Math.max(
      mood.energy,
      mood.curiosity,
      mood.concern,
      mood.satisfaction,
    );
    if (maxDimension < cfg.moodGateThreshold) {
      return false;
    }

    return true;
  }

  /**
   * Reset the daily counter if the UTC day has rolled over since the
   * last emit. Uses Date.UTC day-of-year (1..366) — same day → no reset.
   * The cap is per UTC day, not per rolling 24h window, so the user
   * gets a predictable "fresh start" at midnight UTC.
   */
  #maybeResetDailyCounter(): void {
    const now = new Date();
    const utcDay = Math.floor(
      (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        Date.UTC(now.getUTCFullYear(), 0, 0)) / 86_400_000,
    );
    if (utcDay !== this.#config.surfacedTodayUtcDay) {
      this.#config.surfacedToday = 0;
      this.#config.surfacedTodayUtcDay = utcDay;
    }
  }

  async #generateThought(): Promise<string> {
    const recentEvents = this.#episodic.recent(
      this.#config.sessionId,
      10,
    );
    // Also pull recent events from the default session.
    const defaultEvents = this.#episodic.recent("default", 6);
    const allEvents = [...defaultEvents, ...recentEvents]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-10);

    const contextLines = allEvents.map(
      (e) => `[${new Date(e.timestamp).toISOString().slice(11, 19)}] ${e.role}: ${e.content.slice(0, 120)}`,
    );
    const context = contextLines.length > 0
      ? `Recent activity:\n${contextLines.join("\n")}`
      : "No recent activity.";

    const moodDesc = this.#mood.describe();

    const res = await this.#router.complete({
      sessionId: this.#config.sessionId,
      messages: [
        {
          role: "system",
          content: [
            "You are Cinderpaw, a proactive local AI agent running a background reflection loop.",
            `Your current mood: ${moodDesc}.`,
            "",
            "Review the recent activity and decide if there is something genuinely worth",
            "surfacing to the user — a follow-up, an observation, a reminder, a question,",
            "or an insight that would add real value.",
            "",
            "Rules:",
            "- If you have something worth saying, write it as a short, natural message (1-3 sentences).",
            "- If you have nothing worth saying, respond with exactly: SUPPRESS",
            "- Do not explain your reasoning. Do not mention this loop or your mood.",
            "- Prefer SUPPRESS over a weak or filler message.",
          ].join("\n"),
        },
        {
          role: "user",
          content: context,
        },
      ],
      maxTokens: this.#config.maxTokens,
    });

    return res.content.trim();
  }

  #persistThought(thought: string, surfaced: boolean): void {
    try {
      this.#db
        .query(
          `INSERT INTO inner_thoughts (timestamp, thought, surfaced, mood_snapshot)
           VALUES ($timestamp, $thought, $surfaced, $moodSnapshot)`,
        )
        .run({
          $timestamp: Date.now(),
          $thought: thought,
          $surfaced: surfaced ? 1 : 0,
          $moodSnapshot: JSON.stringify(this.#mood.snapshot()),
        });
    } catch {
      // Persistence failure must never crash the loop.
    }
  }
}
