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
 * Scope: this is a replacement for `RecallEngine`'s *episodic* recall path,
 * not the whole engine — it does NOT render the structured-facts or
 * knowledge-graph blocks. It returns the same `RecallResult` shape
 * (`{context, episodicHits, semanticFacts}`) and the same session-exclusion
 * semantics, and the per-line format mirrors `RecallEngine`'s
 * `formatEpisodic` (`[date] role: snippet`) with one addition: a
 * collapsed-tree `via [...]` prefix recording the ancestor summaries that
 * justified the hit. Unlike `RecallEngine.recall()` (synchronous), this is
 * `async` — embedding the query is a bridge roundtrip. Wiring it into the
 * live engine (making that call site await, and deciding how it composes
 * with the facts/graph blocks) is a separate, reviewed step.
 */
import { queryTree } from "./tree-query.ts";
import type { EmbedInvoker } from "./embed.ts";
import type { Leaf, TreeNode } from "./types.ts";
import type { EpisodicEvent } from "../../types.ts";

/** Top-K semantic candidates from the tree before re-rank. */
const QUERY_TOPK = 20;

/**
 * Beam width for the tree descent. MUST be >= QUERY_TOPK: the beam caps the
 * surviving leaf frontier (see `tree-query.ts`), so a beam smaller than topK
 * silently starves the semantic path to `beam` hits regardless of topK.
 * Holding it equal to topK lets the descent surface the full candidate set;
 * scoring the wider frontier is just extra cosine dot products (cheap).
 */
const QUERY_BEAM = QUERY_TOPK;

/** Max hits in the formatted context. Caps both backends after dedup. */
const MAX_CONTEXT_HITS = 10;

/** Boost added to a hit's semantic score when FTS5 also matched it. */
const FTS_BOOST = 0.5;

/**
 * Minimum cosine score for a semantic-only hit to make the block. Now that
 * the beam is wide enough to surface the full candidate set (QUERY_BEAM >=
 * QUERY_TOPK), the descent no longer implicitly filters by relevance — so an
 * anti-correlated leaf (score <= 0, i.e. pointing away from the query) would
 * otherwise pad the block whenever there's a free slot. A floor of 0 drops
 * those without depending on score calibration; the benchmark gate can raise
 * it. FTS5-matched hits bypass the floor — their exact-match presence is its
 * own relevance signal.
 */
const MIN_SEMANTIC_SCORE = 0;

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
  /** Speaker role for the line prefix; "" for semantic-only hits (the
   *  RAPTOR leaf carries no role — only FTS5 events do). */
  role: string;
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

  /**
   * The merge + re-rank that backs both `recall` and `rankedLeafIds`: embed
   * the query, pull semantic hits from the tree and exact hits from FTS5,
   * merge by id (FTS5 is the source of truth for text/session/role, the tree
   * for score + path), drop the current session, apply the relevance floor,
   * and sort by score + FTS boost. Returns the full sorted list — callers
   * slice it to whatever cap they need. Empty/whitespace query → [].
   */
  async #rankedHits(query: string, sessionId: string): Promise<MergedHit[]> {
    if (!query.trim()) return [];

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
        role: "", // RAPTOR leaves carry no role; FTS5 may fill it in below.
        viaSummaryPath: hit.viaSummaryPath,
      });
    }
    for (const ev of ftsEvents) {
      if (ev.id === undefined) continue;
      const existing = merged.get(ev.id);
      if (existing) {
        existing.fts = true;
        // FTS5 wins on text/sessionId/ts/role (it's the source of truth).
        existing.text = ev.content;
        existing.sessionId = ev.sessionId;
        existing.ts = ev.timestamp;
        existing.role = ev.role;
      } else {
        merged.set(ev.id, {
          id: ev.id,
          score: 0,
          fts: true,
          text: ev.content,
          sessionId: ev.sessionId,
          ts: ev.timestamp,
          role: ev.role,
          viaSummaryPath: [],
        });
      }
    }

    // 5. Drop hits from the current session; re-rank by score + FTS boost.
    return [...merged.values()]
      .filter((h) => h.sessionId !== sessionId)
      .filter((h) => h.fts || h.score > MIN_SEMANTIC_SCORE)
      .sort((a, b) => (b.score + (b.fts ? FTS_BOOST : 0)) - (a.score + (a.fts ? FTS_BOOST : 0)));
  }

  /**
   * The ranked leaf ids behind a recall, for the benchmark gate (recall@k).
   * Identical retrieval to `recall` — same embed, merge, session exclusion,
   * dedup, and ordering — but returns ids instead of a formatted block.
   * `limit` defaults to the same cap `recall` applies to its block.
   */
  async rankedLeafIds(
    query: string,
    sessionId: string,
    limit = MAX_CONTEXT_HITS,
  ): Promise<number[]> {
    const ranked = await this.#rankedHits(query, sessionId);
    return ranked.slice(0, limit).map((h) => h.id);
  }

  async recall(query: string, sessionId: string): Promise<RecallResult> {
    const ranked = (await this.#rankedHits(query, sessionId)).slice(0, MAX_CONTEXT_HITS);

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
      // Mirror RecallEngine.formatEpisodic ("[date] role: snippet"); the role
      // prefix is dropped for semantic-only hits (leaves carry no role).
      const rolePart = h.role ? `${h.role}: ` : "";
      return `  ${via}[${stamp}] ${rolePart}${snippet(h.text)}`;
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
