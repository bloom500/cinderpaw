/**
 * Module G — fractal-recall.ts (orchestrator).
 *
 * Hybrid retrieval that combines the RAPTOR tree's semantic hits with the
 * existing FTS5 index's exact-match hits. Flow:
 *
 *   query
 *     │
 *     ├── embed(query) → vector
 *     │     │
 *     │     └── queryTree(vec, tree, {topK, beam}) → semantic hits
 *     │           (leafId, cosine score, collapsed-tree path)
 *     │
 *     └── ftsSearch(query, limit) → exact-match events
 *           (id, sessionId, timestamp, role, content)
 *
 * Merge by id (leafId / episodic.id), boost hits present in BOTH
 * backends (FTS5 presence is a strong relevance signal), drop hits whose
 * sessionId matches the current session, and format the surviving hits
 * into the same `[Memory context] … [End memory context]` block the
 * existing `RecallEngine` produces.
 *
 * Mirrors `RecallEngine.recall()` exactly: same `RecallResult` shape,
 * same session-exclusion semantics. Drop-in replacement; the integration
 * into the live engine is a separate, reviewed step.
 */
import { queryTree } from "./tree-query.ts";
import type { EmbedInvoker } from "./embed.ts";
import type { Leaf, TreeNode } from "./types.ts";
import type { EpisodicEvent } from "../../types.ts";

/** Top-K semantic candidates from the tree before re-rank. */
const QUERY_TOPK = 20;

/** Beam width for the tree descent. */
const QUERY_BEAM = 4;

/** Max hits in the formatted context. Caps both backends after dedup. */
const MAX_CONTEXT_HITS = 10;

/** Boost added to a hit's semantic score when FTS5 also matched it. */
const FTS_BOOST = 0.5;

/** Per-hit snippet length, matching `RecallEngine.snippetMaxChars`. */
const SNIPPET_MAX_CHARS = 200;

/** Narrow fts signature — matches `EpisodicMemory.search(query, limit)`. */
export type FtsSearch = (q: string, limit: number) => EpisodicEvent[];

export interface FractalRecallDeps {
  tree: TreeNode;
  embed: EmbedInvoker;
  ftsSearch: FtsSearch;
  /**
   * Lookup of raw leaf metadata by leafId. The RAPTOR tree itself
   * stores only centroids at the leaf level (Module E drops `text`,
   * `sessionId`, `ts` to keep `TreeNode` minimal); this map fills in
   * what the formatter + session filter need. Production wires this
   * from the same `Leaf[]` passed to `buildTree(...)`; tests build it
   * inline.
   */
  leavesById: Map<number, Leaf>;
}

/** RecallResult mirrors `src/memory/recall.ts` so this is a drop-in. */
export interface RecallResult {
  context: string;
  episodicHits: number;
  semanticFacts: number;
}

/** One entry after merging semantic + FTS5 contributions. */
interface MergedHit {
  id: number;
  score: number;
  fts: boolean;
  text: string;
  sessionId: string;
  ts: number;
  viaSummaryPath: string[];
}

/** Format a date stamp matching the existing engine (`YYYY-MM-DD`). */
function dateStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Truncate to `SNIPPET_MAX_CHARS`, matching the existing engine. */
function snippet(text: string): string {
  return text.length > SNIPPET_MAX_CHARS
    ? text.slice(0, SNIPPET_MAX_CHARS) + "…"
    : text;
}

export class FractalRecallEngine {
  readonly #tree: TreeNode;
  readonly #embed: EmbedInvoker;
  readonly #ftsSearch: FtsSearch;
  readonly #leavesById: Map<number, Leaf>;

  constructor(deps: FractalRecallDeps) {
    this.#tree = deps.tree;
    this.#embed = deps.embed;
    this.#ftsSearch = deps.ftsSearch;
    this.#leavesById = deps.leavesById;
  }

  async recall(query: string, sessionId: string): Promise<RecallResult> {
    // Empty query: never worth surfacing anything.
    if (!query.trim()) {
      return { context: "", episodicHits: 0, semanticFacts: 0 };
    }

    // 1. Embed the query.
    const [qVec] = await this.#embed([query]);
    if (!qVec) {
      throw new Error("fractal-recall: embed returned no vector");
    }

    // 2. Semantic hits from the RAPTOR tree.
    const semanticHits = queryTree(qVec, this.#tree, {
      topK: QUERY_TOPK,
      beam: QUERY_BEAM,
    });

    // 3. Exact-match hits from FTS5.
    const ftsEvents = this.#ftsSearch(query, QUERY_TOPK);

    // 4. Merge by id. FTS5 contributes text/sessionId/ts; semantic
    //    contributes score + collapsed-tree path.
    const merged = new Map<number, MergedHit>();

    for (const hit of semanticHits) {
      const leaf = this.#leavesById.get(hit.leafId);
      merged.set(hit.leafId, {
        id: hit.leafId,
        score: hit.score,
        fts: false,
        text: leaf?.text ?? `event-${hit.leafId}`,
        sessionId: leaf?.sessionId ?? "",
        ts: leaf?.ts ?? 0,
        viaSummaryPath: hit.viaSummaryPath,
      });
    }
    for (const ev of ftsEvents) {
      if (ev.id === undefined) continue;
      const existing = merged.get(ev.id);
      if (existing) {
        existing.fts = true;
        // FTS5 wins on text/sessionId/ts (it's the source of truth).
        existing.text = ev.content;
        existing.sessionId = ev.sessionId;
        existing.ts = ev.timestamp;
      } else {
        merged.set(ev.id, {
          id: ev.id,
          score: 0,
          fts: true,
          text: ev.content,
          sessionId: ev.sessionId,
          ts: ev.timestamp,
          viaSummaryPath: [],
        });
      }
    }

    // 5. Drop hits from the current session; re-rank by score + FTS boost.
    const ranked = [...merged.values()]
      .filter((h) => h.sessionId !== sessionId)
      .sort((a, b) => (b.score + (b.fts ? FTS_BOOST : 0)) - (a.score + (a.fts ? FTS_BOOST : 0)))
      .slice(0, MAX_CONTEXT_HITS);

    // 6. Counters.
    const episodicHits = ranked.filter((h) => h.fts).length;
    const semanticFacts = ranked.length;

    // 7. Format the same `[Memory context] … [End memory context]` block
    //    `RecallEngine` produces.
    if (ranked.length === 0) {
      return { context: "", episodicHits: 0, semanticFacts: 0 };
    }

    const lines = ranked.map((h) => {
      const stamp = h.ts > 0 ? dateStamp(h.ts) : "????-??-??";
      const via = h.viaSummaryPath.length > 0
        ? `via [${h.viaSummaryPath.join(" → ")}] `
        : "";
      return `  ${via}[${stamp}] ${snippet(h.text)}`;
    });

    const context = [
      "[Memory context]",
      "Relevant past exchanges (fractal hybrid):",
      ...lines,
      "[End memory context]",
    ].join("\n");

    return { context, episodicHits, semanticFacts };
  }
}
