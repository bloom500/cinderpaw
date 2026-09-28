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
import { memoryScope, memoryTokens, type SemanticMemory } from "./semantic.ts";
import type { MemoryGraph } from "./graph.ts";
import type { EpisodicEvent } from "../types.ts";

export interface RecallConfig {
  /** Max episodic events to surface per recall. */
  maxEpisodic: number;
  /** Max characters for each episodic snippet before truncation. */
  snippetMaxChars: number;
  /** Exclude the current session from episodic results. */
  excludeCurrentSession: boolean;
  /** Clock for the block's "today" stamp; tests pin it. */
  now: () => number;
}

const DEFAULT_CONFIG: RecallConfig = {
  maxEpisodic: 5,
  snippetMaxChars: 200,
  excludeCurrentSession: true,
  now: Date.now,
};

/**
 * One memory the block put in front of the model, as data for the app's
 * Memory Peek (spec 7.5): only what was really injected this turn.
 */
export interface MemoryUsed {
  /** A fact about the user, or a line from a past conversation. */
  kind: "fact" | "past";
  text: string;
  /** The graph edge Forget removes (`memory_forget`); absent when there is none. */
  forget?: { from: string; to: string; relation: string };
  /** When a past exchange happened. */
  ts?: number;
}

export interface RecallResult {
  /** Formatted block for prompt injection, or empty string when nothing found. */
  context: string;
  /** What `context` holds, item by item. Absent from engines that do not say. */
  used?: MemoryUsed[];
  episodicHits: number;
  semanticFacts: number;
  /** The leaves the block shows, in block order. Only the fractal path
   *  sets it; the utility ledger records them as shown to the session. */
  leafIds?: number[];
}

export class RecallEngine {
  readonly #episodic: EpisodicMemory;
  readonly #semantic: SemanticMemory;
  readonly #config: RecallConfig;
  #graph: MemoryGraph | null = null;

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
   * Attach the knowledge graph so recall can surface accumulated facts
   * (entity —relation→ concept triples) alongside semantic/episodic memory.
   * Optional: recall degrades gracefully when no graph is attached.
   */
  setGraph(graph: MemoryGraph): void {
    this.#graph = graph;
  }

  /**
   * Retrieve relevant context for the given user message. Called at the start
   * of every agent turn, before the first LLM call.
   */
  recall(query: string, sessionId: string): RecallResult {
    const episodicBlock = this.#recallEpisodic(query, sessionId);
    const known = this.knownFactsDetailed(query, sessionId);
    const parts: string[] = [];
    if (known.text) parts.push(known.text);
    if (episodicBlock.text) parts.push(episodicBlock.text);

    const context = parts.length > 0
      ? `[Memory context]\n${parts.join("\n\n")}\n[End memory context]`
      : "";

    return {
      context,
      used: context ? [...known.used, ...episodicBlock.used] : [],
      episodicHits: episodicBlock.count,
      semanticFacts: this.#semantic.all(memoryScope(sessionId)).length,
    };
  }

  /**
   * What the agent knows ABOUT the user — the facts block and the graph block —
   * without the episodic part, unwrapped. Empty when there is nothing to say.
   *
   * Separate because Fractal Memory Search replaces only the episodic part of
   * recall. It used to replace all of it: once a tree existed, nothing called
   * this engine, and every turn lost the user's name and preferences. The
   * facade now asks for this block and puts it in front of its own hits.
   */
  knownFacts(query: string, sessionId: string): string {
    return this.knownFactsDetailed(query, sessionId).text;
  }

  /** `knownFacts`, with the facts it put in the block as data (`MemoryUsed`). */
  knownFactsDetailed(query: string, sessionId: string): { text: string; used: MemoryUsed[] } {
    // Scoped so a shared-channel session surfaces this speaker's facts plus
    // the owner's global ones — never another speaker's. Empty for every
    // single-user surface, i.e. unchanged there. See `memoryScope`.
    const scope = memoryScope(sessionId);
    // The query is passed down on purpose: both blocks below used to be built
    // without ever looking at what was asked. See `renderForPrompt`.
    const chosen = this.#semantic.selectForPrompt(scope, query);
    const semanticBlock = this.#semantic.renderForPrompt(scope, query);
    // Every extracted fact is ALSO mirrored into the graph as `key —has→
    // value` (extractor.ts), so without this the graph block is a second copy
    // of the block directly above it, in a different notation, at twenty lines
    // a turn. Only what the facts block did not already say gets through.
    const alreadySaid = new Set(chosen.map((f) => f.value.trim().toLowerCase()));
    const graph = this.#recallGraph(query, alreadySaid);
    return {
      text: [semanticBlock, graph.text].filter((b) => b).join("\n\n"),
      used: [
        ...chosen.map((f): MemoryUsed => {
          const edge = this.#mirrorEdge(f.key, f.value);
          return { kind: "fact", text: `${f.key}: ${f.value}`, ...(edge ? { forget: edge } : {}) };
        }),
        ...graph.used,
      ],
    };
  }

  /**
   * The graph edge a fact is mirrored as (`key —has→ value`, extractor.ts), so
   * Forget in the app can go through `memory_forget`, which drops the fact
   * with its edge (forget.ts). Null when the graph has no such edge.
   */
  #mirrorEdge(key: string, value: string): { from: string; to: string; relation: string } | null {
    if (!this.#graph) return null;
    const { nodes, edges } = this.#graph.snapshot();
    const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
    const e = edges.find((x) =>
      x.relation === "has" && norm(nodes[x.from]?.label) === norm(key) && norm(nodes[x.to]?.label) === norm(value));
    return e ? { from: e.from, to: e.to, relation: e.relation } : null;
  }

  /** Max graph triples surfaced per recall — keeps the block compact. */
  static readonly MAX_GRAPH_FACTS = 20;

  /**
   * Render knowledge-graph triples as "subject —relation→ object" lines, the
   * ones that have something to do with the question.
   *
   * It used to be the twenty most recently created edges, whatever they were.
   * Measured over a corpus spanning ten subjects that was 10% relevant, the
   * same as chance, and it cost twenty lines of every prompt to be so. With
   * nothing matching, the block is now omitted rather than filled: an empty
   * section says "nothing on this" honestly, where twenty wrong triples say
   * something false confidently.
   *
   * Recency still decides between equally matching edges, and still orders the
   * block when the turn has no query at all.
   */
  #recallGraph(query = "", alreadySaid: ReadonlySet<string> = new Set()): { text: string; used: MemoryUsed[] } {
    const none = { text: "", used: [] };
    if (!this.#graph) return none;
    const snapshot = this.#graph.snapshot();
    const edges = snapshot.edges.filter(
      (e) => !alreadySaid.has((snapshot.nodes[e.to]?.label ?? "").trim().toLowerCase()),
    );
    if (edges.length === 0) return none;

    const want = new Set(memoryTokens(query));
    const textOf = (e: (typeof edges)[number]) =>
      `${snapshot.nodes[e.from]?.label ?? ""} ${e.relation} ${snapshot.nodes[e.to]?.label ?? ""}`;
    const scoreOf = (e: (typeof edges)[number]) =>
      want.size === 0 ? 0 : memoryTokens(textOf(e)).filter((w) => want.has(w)).length;

    const ranked = edges.slice();
    if (want.size > 0) {
      const scored = ranked
        .map((e) => ({ e, score: scoreOf(e) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.e.createdAt - a.e.createdAt);
      // Nothing matched: say nothing. The whole point of the measurement was
      // that the alternative is twenty confident irrelevant lines.
      if (scored.length === 0) return none;
      ranked.length = 0;
      ranked.push(...scored.map((x) => x.e));
    } else {
      ranked.sort((a, b) => b.createdAt - a.createdAt);
    }

    const shown = ranked
      .slice(0, RecallEngine.MAX_GRAPH_FACTS)
      .flatMap((e) => {
        const from = snapshot.nodes[e.from];
        const to = snapshot.nodes[e.to];
        if (!from || !to) return [];
        return [{ e, line: `${from.label} —${e.relation}→ ${to.label}` }];
      });

    if (shown.length === 0) return none;
    return {
      text: `Knowledge graph (facts learned about the user over time):\n${shown.map((x) => `  ${x.line}`).join("\n")}`,
      used: shown.map(({ e, line }) => ({ kind: "fact", text: line, forget: { from: e.from, to: e.to, relation: e.relation } })),
    };
  }

  #recallEpisodic(
    query: string,
    currentSessionId: string,
  ): { text: string; count: number; used: MemoryUsed[] } {
    if (!query.trim()) return { text: "", count: 0, used: [] };

    // Left out in the query, not only afterwards: the current session's own
    // turns share the question's words and would otherwise take the slots.
    let hits = this.#episodic.search(
      query,
      this.#config.maxEpisodic * 2,
      this.#config.excludeCurrentSession ? currentSessionId : undefined,
    );

    if (this.#config.excludeCurrentSession) {
      hits = hits.filter((e) => e.sessionId !== currentSessionId);
    }

    hits = hits.slice(0, this.#config.maxEpisodic);
    if (hits.length === 0) return { text: "", count: 0, used: [] };

    const lines = hits.map((e) => formatEpisodic(e, this.#config.snippetMaxChars));
    return {
      used: hits.map((e) => ({ kind: "past", text: clip(e.content, this.#config.snippetMaxChars), ts: e.timestamp })),
      // Dated lines need today's date to be read against; see fractal-recall.
      text: `Relevant past exchanges (today is ${new Date(this.#config.now()).toISOString().slice(0, 10)}):\n${lines.join("\n")}`,
      count: hits.length,
    };
  }
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

function formatEpisodic(event: EpisodicEvent, maxChars: number): string {
  const when = new Date(event.timestamp).toISOString().slice(0, 10);
  return `  [${when}] ${event.role}: ${clip(event.content, maxChars)}`;
}
