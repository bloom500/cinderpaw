/**
 * Semantic memory extractor.
 *
 * After each completed conversation turn, sends a lightweight LLM pass over
 * the most recent exchanges to extract durable facts about the user — name,
 * role, preferences, constraints, recurring topics. Extracted facts are stored
 * in SemanticMemory and injected into every future turn via the recall engine.
 *
 * Design choices:
 * - Runs asynchronously after the agent has already sent its final response;
 *   the user never waits for extraction.
 * - Uses a very small token budget (128 tokens) so it does not meaningfully
 *   compete with real conversations.
 * - Returns "NONE" when there is nothing worth extracting — extraction is
 *   silent when the conversation is routine.
 * - Facts are expressed as "key: value" lines so parsing is robust even if the
 *   model drifts slightly from the prompt.
 */

import type { InferenceRouter } from "../sandbox/inference-router.ts";
import type { SemanticMemory } from "./semantic.ts";
import type { ChatMessage } from "../types.ts";

export class MemoryExtractor {
  readonly #router: InferenceRouter;
  readonly #semantic: SemanticMemory;
  /** Sessions whose extraction is already in-flight — prevents overlaps. */
  readonly #running = new Set<string>();

  constructor(router: InferenceRouter, semantic: SemanticMemory) {
    this.#router = router;
    this.#semantic = semantic;
  }

  /**
   * Trigger a non-blocking extraction pass over recent turns.
   * Safe to call after every completed agent turn; it dedups by session.
   */
  extractAsync(sessionId: string, recentTurns: ChatMessage[]): void {
    if (this.#running.has(sessionId)) return;
    if (recentTurns.length < 2) return;

    this.#running.add(sessionId);
    void this.#extract(sessionId, recentTurns).finally(() => {
      this.#running.delete(sessionId);
    });
  }

  async #extract(sessionId: string, turns: ChatMessage[]): Promise<void> {
    // Keep it small: only the last 6 turns, capped at 2000 chars total.
    const recent = turns.slice(-6);
    let transcript = recent
      .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
      .join("\n");
    if (transcript.length > 2000) transcript = transcript.slice(-2000);

    try {
      const res = await this.#router.complete({
        sessionId: `${sessionId}__extract`,
        messages: [
          {
            role: "system",
            content: [
              "Extract durable facts about the USER from the conversation below.",
              "Output ONE fact per line as: key: value",
              "Only extract facts that are clearly stated and worth remembering long-term.",
              "Examples: name: Maria, language: Romanian, role: dental receptionist",
              "If there is nothing worth extracting, output exactly: NONE",
              "Do NOT output anything else. No explanations, no headers.",
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
      // Extraction failure is never fatal — the agent already responded.
    }
  }
}
