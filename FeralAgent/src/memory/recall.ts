/**
 * Recall engine — unified retrieval across all memory layers.
 *
 * Given the current user message and session, pulls relevant context from:
 *   1. Episodic memory — past events matching the query via FTS5
 *   2. Semantic memory — all persistent user facts (always injected when present)
 *
 * The output is a formatted string block ready to be injected into the agent's
 * working memory *before* the first inference. This is what makes memory useful:
 * not just recording, but surfacing the right past context at the right moment.
 *
 * Design choices:
 *   - Episodic results are filtered to *other* sessions only by default, so the
 *     agent doesn't get confused by its own current-turn transcript.
 *   - Results are capped and truncated so recall never dominates the context.
 *   - Recall itself is never audited as a tool call; it is a read-only memory
 *     access that the agent performs automatically, not something the LLM invokes.
 */

import type { EpisodicMemory } from "./episodic.ts";
import type { SemanticMemory } from "./semantic.ts";
import type { EpisodicEvent } from "../types.ts";

export interface RecallConfig {
  /** Max episodic events to surface per recall. */
  maxEpisodic: number;
  /** Max characters for each episodic snippet before truncation. */
  snippetMaxChars: number;
  /** Exclude the current session from episodic results. */
  excludeCurrentSession: boolean;
}

const DEFAULT_CONFIG: RecallConfig = {
  maxEpisodic: 5,
  snippetMaxChars: 200,
  excludeCurrentSession: true,
};

export interface RecallResult {
  /** Formatted block for prompt injection, or empty string when nothing found. */
  context: string;
  episodicHits: number;
  semanticFacts: number;
}

export class RecallEngine {
  readonly #episodic: EpisodicMemory;
  readonly #semantic: SemanticMemory;
  readonly #config: RecallConfig;

  constructor(
    episodic: EpisodicMemory,
    semantic: SemanticMemory,
    config: Partial<RecallConfig> = {},
  ) {
    this.#episodic = episodic;
    this.#semantic = semantic;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Retrieve relevant context for the given user message. Called at the start
   * of every agent turn, before the first LLM call.
   */
  recall(query: string, sessionId: string): RecallResult {
    const episodicBlock = this.#recallEpisodic(query, sessionId);
    const semanticBlock = this.#semantic.renderForPrompt();
    const semanticFacts = this.#semantic.all().length;

    const parts: string[] = [];
    if (semanticBlock) parts.push(semanticBlock);
    if (episodicBlock.text) parts.push(episodicBlock.text);

    const context = parts.length > 0
      ? `[Memory context]\n${parts.join("\n\n")}\n[End memory context]`
      : "";

    return {
      context,
      episodicHits: episodicBlock.count,
      semanticFacts,
    };
  }

  #recallEpisodic(
    query: string,
    currentSessionId: string,
  ): { text: string; count: number } {
    if (!query.trim()) return { text: "", count: 0 };

    let hits = this.#episodic.search(query, this.#config.maxEpisodic * 2);

    if (this.#config.excludeCurrentSession) {
      hits = hits.filter((e) => e.sessionId !== currentSessionId);
    }

    hits = hits.slice(0, this.#config.maxEpisodic);
    if (hits.length === 0) return { text: "", count: 0 };

    const lines = hits.map((e) => formatEpisodic(e, this.#config.snippetMaxChars));
    return {
      text: `Relevant past exchanges:\n${lines.join("\n")}`,
      count: hits.length,
    };
  }
}

function formatEpisodic(event: EpisodicEvent, maxChars: number): string {
  const when = new Date(event.timestamp).toISOString().slice(0, 10);
  const snippet =
    event.content.length > maxChars
      ? event.content.slice(0, maxChars) + "…"
      : event.content;
  return `  [${when}] ${event.role}: ${snippet}`;
}
