/**
 * Inner Thoughts — the proactive background loop.
 *
 * V1 STATUS: disabled by default. Enabled only when FERAL_INNER_THOUGHTS_ENABLED=true.
 * This is intentional — the V1 dental-pilot deliverable does not require it, and
 * the feature contends for inference budget with real user requests.
 *
 * When enabled, runs independently of the request/response cycle. On each tick:
 *   1. Queries episodic memory for recent context.
 *   2. Sends a prompt asking "Is there something worth surfacing to the user?"
 *   3. If the model produces a non-suppressed thought, emits a `proactive` event.
 *   4. Records the thought (and suppression decision) to inner_thoughts table.
 *
 * The loop never crashes the process. All errors are caught and the loop
 * reschedules itself. The inference call goes through the same router (budgets,
 * allowlist) as every other LLM call.
 *
 * V2 additions deferred: mood-gated suppression, minimum-idle guard,
 * cross-session activity tracking, smarter surfacing heuristics.
 */

import type { Database } from "bun:sqlite";
import type { InferenceRouter } from "../sandbox/inference-router.ts";
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
}

const DEFAULT_CONFIG: InnerThoughtsConfig = {
  intervalMs: 5 * 60 * 1000,
  sessionId: "inner-thoughts",
  maxTokens: 256,
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

  #schedule(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      void this.#tick().finally(() => this.#schedule());
    }, this.#config.intervalMs);
    // Don't keep the process alive just for this timer.
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
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
            "You are Feral, a proactive local AI agent running a background reflection loop.",
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
