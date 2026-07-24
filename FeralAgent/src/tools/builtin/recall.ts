/**
 * recall — read-only, on-demand semantic search over the agent's own past
 * conversations.
 *
 * Capture is automatic (MemoryExtractor) and relevant context is auto-injected
 * each turn (agent-loop `#recall.recall`). This tool is the on-demand counterpart:
 * it lets the agent search mid-task with DIFFERENT terms than the current message
 * (e.g. "what did the user say about X several messages / sessions ago?"). It is
 * a thin, read-only facade over Fractal Memory Search — there is no write action.
 *
 * Best-effort by design: a fractal failure or a missing embedding model yields an
 * empty result, never an error into the turn.
 */
import { memoryScope, type SemanticMemory } from "../../memory/semantic.ts";
import type { Tool, ToolManifest } from "../../types.ts";

/** Ranked episodic search surface, satisfied in production by FractalMemory.query. */
export type EpisodicSemanticSearch = (
  query: string,
  limit: number,
) => Promise<{ leafId: number; text: string }[]>;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const SNIPPET_MAX_CHARS = 200;

function formatHits(hits: { leafId: number; text: string }[]): string {
  return hits
    .map((h) => {
      const snippet = h.text.length > SNIPPET_MAX_CHARS
        ? h.text.slice(0, SNIPPET_MAX_CHARS) + "…"
        : h.text;
      return `- ${snippet}`;
    })
    .join("\n");
}

const MAX_FACT_HITS = 10;

/**
 * Question words and filler that would match nearly every fact. Dropped from
 * the query so the remaining words are the ones that actually discriminate.
 *
 * This is a stopword list rather than a minimum word LENGTH, because length is
 * the wrong signal: "what is my id" would lose `id` — and short tokens (`id`,
 * `qr`, a two-letter city or airport code) are exactly the keys a user asks
 * about by name.
 */
const STOPWORDS = new Set([
  "what", "whats", "who", "whos", "when", "where", "why", "how", "which",
  "is", "are", "was", "were", "do", "does", "did", "the", "a", "an",
  "my", "me", "i", "you", "your", "of", "for", "to", "in", "on", "about",
  "tell", "know", "remember", "again",
]);

/**
 * Facts written by the `remember` tool (and mined by the extractor) live in
 * SemanticMemory, which the fractal index does not cover — a fact stored one
 * minute ago would be invisible until the next RAPTOR rebuild. Match them
 * directly: a fact is a hit when any query word occurs in its key or value.
 *
 * ponytail: substring match over the whole fact table. It is tens of rows;
 * move to FTS5 if it ever grows past a few thousand.
 */
function searchFacts(semantic: SemanticMemory, query: string, scope: string): string[] {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
  if (words.length === 0) return [];
  const hits: string[] = [];
  for (const fact of semantic.all(scope)) {
    const hay = `${fact.key} ${fact.value}`.toLowerCase();
    if (words.some((w) => hay.includes(w))) hits.push(`- ${fact.key}: ${fact.value}`);
    if (hits.length >= MAX_FACT_HITS) break;
  }
  return hits;
}

export function createRecallTool(
  fractalSearch: EpisodicSemanticSearch,
  semantic?: SemanticMemory,
): Tool {
  const manifest: ToolManifest = {
    name: "recall",
    description:
      "Search your own durable memory: facts you stored with `remember`, plus " +
      "semantically-relevant snippets from past conversations. Read-only. Use it " +
      "whenever the user refers to something from an earlier session, or asks what " +
      "you know about them — do not claim you don't remember without calling this " +
      "first. Write with the `remember` tool.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      query: {
        type: "string",
        description: "What to search for across past conversations.",
        required: true,
      },
      limit: {
        type: "number",
        description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        required: false,
      },
    },
    async execute(args, ctx) {
      const query = typeof args.query === "string" && args.query.trim()
        ? args.query.trim() : "";
      if (!query) {
        return { ok: false, content: "recall: 'query' is required.", error: "bad_args" };
      }
      let limit = DEFAULT_LIMIT;
      if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
        limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(args.limit)));
      }

      let hits: { leafId: number; text: string }[] = [];
      try {
        hits = await fractalSearch(query, limit);
      } catch {
        hits = [];
      }

      let facts: string[] = [];
      try {
        // Scoped: recall must not surface another channel member's facts.
        facts = semantic ? searchFacts(semantic, query, memoryScope(ctx?.sessionId ?? "")) : [];
      } catch {
        facts = [];
      }

      const blocks: string[] = [];
      if (facts.length > 0) blocks.push(`Known facts:\n${facts.join("\n")}`);
      if (hits.length > 0) blocks.push(`Related past conversations:\n${formatHits(hits)}`);
      const content = blocks.length === 0
        ? `Nothing in memory matched "${query}".`
        : blocks.join("\n\n");
      return { ok: true, content, data: { hits, facts, query } };
    },
  };
}
