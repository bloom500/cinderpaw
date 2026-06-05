/**
 * Semantic memory extractor — upgraded with claude-mem observation types.
 *
 * Two passes run asynchronously after each completed turn:
 *
 *   1. FACTS pass (existing behaviour, improved prompt):
 *      Extracts durable user facts (name, role, language, preferences) as
 *      key: value lines → stored in SemanticMemory.
 *
 *   2. OBSERVATION pass (new — from claude-mem):
 *      Classifies the turn with a structured type and extracts bullet-point
 *      facts + key concepts → stored in EpisodicMemory as a typed observation
 *      entry alongside the raw transcript, tagged [obs].
 *
 * Observation types (from claude-mem ECC modes):
 *   discovery  — learning about existing system/context
 *   decision   — architectural or preference choice with rationale
 *   bugfix     — something was broken, now resolved
 *   feature    — new capability discussed or built
 *   change     — generic modification (config, docs, etc.)
 *   task       — actionable item identified
 *   preference — user preference or constraint learned
 *
 * Both passes use a minimal token budget and never block the user response.
 */

import type { InferenceRouter } from "../sandbox/inference-router.ts";
import type { SemanticMemory } from "./semantic.ts";
import type { EpisodicMemory } from "./episodic.ts";
import type { ChatMessage } from "../types.ts";

export type ObservationType =
  | "discovery"
  | "decision"
  | "bugfix"
  | "feature"
  | "change"
  | "task"
  | "preference";

const VALID_OBS_TYPES = new Set<string>([
  "discovery", "decision", "bugfix", "feature", "change", "task", "preference",
]);

export class MemoryExtractor {
  readonly #router: InferenceRouter;
  readonly #semantic: SemanticMemory;
  readonly #episodic: EpisodicMemory | null;
  readonly #running = new Set<string>();

  constructor(
    router: InferenceRouter,
    semantic: SemanticMemory,
    episodic?: EpisodicMemory,
  ) {
    this.#router = router;
    this.#semantic = semantic;
    this.#episodic = episodic ?? null;
  }

  extractAsync(sessionId: string, recentTurns: ChatMessage[]): void {
    if (this.#running.has(sessionId)) return;
    if (recentTurns.length < 2) return;

    this.#running.add(sessionId);
    void this.#extract(sessionId, recentTurns).finally(() => {
      this.#running.delete(sessionId);
    });
  }

  async #extract(sessionId: string, turns: ChatMessage[]): Promise<void> {
    const recent = turns.slice(-6);
    let transcript = recent
      .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
      .join("\n");
    if (transcript.length > 2000) transcript = transcript.slice(-2000);

    // Run both passes in parallel — neither blocks the other.
    await Promise.all([
      this.#extractFacts(sessionId, transcript),
      this.#extractObservation(sessionId, transcript),
    ]);
  }

  /** Pass 1: durable user facts → SemanticMemory (original behaviour, improved prompt). */
  async #extractFacts(sessionId: string, transcript: string): Promise<void> {
    try {
      const res = await this.#router.complete({
        sessionId: `${sessionId}__facts`,
        messages: [
          {
            role: "system",
            content: [
              "Extract durable facts about the USER from the conversation.",
              "Output ONE fact per line as: key: value",
              "Only extract facts clearly stated and worth remembering long-term.",
              "Good keys: name, language, role, location, preference, constraint, goal",
              "Examples: name: Maria, language: Romanian, role: dental receptionist",
              "If nothing worth extracting, output exactly: NONE",
              "No explanations. No headers. No markdown.",
            ].join("\n"),
          },
          { role: "user", content: transcript },
        ],
        maxTokens: 128,
        temperature: 0.1,
      });

      const text = res.content.trim();
      if (!text || text.toUpperCase() === "NONE") return;

      for (const line of text.split("\n")) {
        const colon = line.indexOf(":");
        if (colon < 1) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (key && value && key.length <= 60 && value.length <= 300) {
          this.#semantic.upsert(key, value);
        }
      }
    } catch {
      // Never fatal — user already got their response.
    }
  }

  /**
   * Pass 2: typed observation → EpisodicMemory (claude-mem pattern).
   * Stored as a [obs:type] tagged entry so it can be filtered in recall.
   */
  async #extractObservation(sessionId: string, transcript: string): Promise<void> {
    if (!this.#episodic) return;
    try {
      const res = await this.#router.complete({
        sessionId: `${sessionId}__obs`,
        messages: [
          {
            role: "system",
            content: [
              "Classify this conversation turn and extract a structured observation.",
              "",
              "Output exactly this format (no other text):",
              "type: <one of: discovery|decision|bugfix|feature|change|task|preference>",
              "title: <short title, max 60 chars>",
              "facts:",
              "- <fact 1>",
              "- <fact 2>",
              "concepts: <comma-separated keywords>",
              "",
              "If the turn is routine small-talk with nothing worth recording, output: SKIP",
            ].join("\n"),
          },
          { role: "user", content: transcript },
        ],
        maxTokens: 200,
        temperature: 0.1,
      });

      const text = res.content.trim();
      if (!text || text.toUpperCase() === "SKIP") return;

      const obs = parseObservation(text);
      if (!obs) return;

      // Store as a synthetic "assistant" event tagged [obs:type] for easy recall filtering.
      const entry = [
        `[obs:${obs.type}] ${obs.title}`,
        obs.facts.map((f) => `  • ${f}`).join("\n"),
        obs.concepts.length > 0 ? `  concepts: ${obs.concepts.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      this.#episodic.record(sessionId, "assistant", entry);
    } catch {
      // Never fatal.
    }
  }
}

interface ParsedObservation {
  type: ObservationType;
  title: string;
  facts: string[];
  concepts: string[];
}

function parseObservation(raw: string): ParsedObservation | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  let type: ObservationType | null = null;
  let title = "";
  const facts: string[] = [];
  const concepts: string[] = [];
  let inFacts = false;

  for (const line of lines) {
    if (line.startsWith("type:")) {
      const val = line.slice(5).trim().toLowerCase();
      if (VALID_OBS_TYPES.has(val)) type = val as ObservationType;
      inFacts = false;
    } else if (line.startsWith("title:")) {
      title = line.slice(6).trim().slice(0, 80);
      inFacts = false;
    } else if (line.startsWith("facts:")) {
      inFacts = true;
    } else if (line.startsWith("concepts:")) {
      inFacts = false;
      const val = line.slice(9).trim();
      concepts.push(...val.split(",").map((c) => c.trim()).filter(Boolean));
    } else if (inFacts && (line.startsWith("- ") || line.startsWith("* "))) {
      facts.push(line.slice(2).trim());
    }
  }

  if (!type || !title) return null;
  return { type, title, facts, concepts };
}
