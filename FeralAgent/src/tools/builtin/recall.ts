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

export function createRecallTool(fractalSearch: EpisodicSemanticSearch): Tool {
  const manifest: ToolManifest = {
    name: "recall",
    description:
      "Search your own past conversations for semantically-relevant memories. " +
      "Read-only. Use it mid-task to look something up with different search terms " +
      "than the current message (e.g. what the user said several messages or " +
      "sessions ago). Returns ranked snippets. Capture is automatic — there is no " +
      "write action.",
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
    async execute(args) {
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

      const content = hits.length === 0
        ? `No past conversations matched "${query}".`
        : `Related past conversations:\n${formatHits(hits)}`;
      return { ok: true, content, data: { hits, query } };
    },
  };
}
