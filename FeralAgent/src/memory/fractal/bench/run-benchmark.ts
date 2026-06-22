/**
 * runFractalBenchmark — the orchestrator behind the Fractal Memory Search
 * benchmark gate.
 *
 * It compares two retrieval engines over one labelled query set:
 *   - **flat FTS5** (the baseline): `ftsSearch(query, k)` → leaf ids.
 *   - **fractal hybrid** (the candidate): the live `FractalRecallEngine`
 *     (semantic tree traversal + FTS5 re-rank) → ranked leaf ids.
 *
 * Because the hybrid takes FTS5's hits as a *subset* of its inputs, it can
 * never score lower on recall than flat FTS5 for the same k — the gate's real
 * question is therefore "does the semantic layer add recall without blowing
 * the latency budget", which is exactly what the report answers.
 *
 * Everything model-shaped (embed, infer) and the clock are injected: this
 * function never imports the bridge or a model. The sidecar trigger supplies
 * the live `embed`/`infer`/`ftsSearch` from the running process.
 */
import { runBenchmark, type BenchQuery, type BenchReport } from "./runner.ts";
import { parseQuerySet, generateQuerySet, type GenLeaf } from "./query-gen.ts";
import { FractalRecallEngine } from "../fractal-recall.ts";
import type { EmbedInvoker } from "../embed.ts";
import type { Leaf, TreeNode } from "../types.ts";
import type { EpisodicEvent } from "../../../types.ts";

export interface FractalBenchDeps {
  /** Episodic rows as `{id, text}` — the pool query generation samples from. */
  loadLeaves: () => GenLeaf[];
  /** FTS5 exact-match search (production: `episodic.search`). */
  ftsSearch: (q: string, limit: number) => EpisodicEvent[];
  /** The RAPTOR tree to evaluate (loaded from disk or freshly rebuilt). */
  tree: TreeNode;
  /** Leaf metadata by id, for the recall engine (same map the live app uses). */
  leavesById: Map<number, Leaf>;
  /** Query embedder (production: the live bridge invoker). */
  embed: EmbedInvoker;
  /** Local-model completion, used only to generate queries. */
  infer: (prompt: string) => Promise<string>;

  /**
   * Pre-built query set; when present, JSONL and generation are both
   * skipped. Mutually exclusive with `querySetJsonl` (if both are given,
   * `queries` wins — it's the lowest-level input).
   */
  queries?: BenchQuery[];
  /** Pre-labelled JSONL query set; when present, skips generation. */
  querySetJsonl?: string;
  /** How many queries to generate when no JSONL and no `queries` are given (default 50). */
  count?: number;
  /** Seed for deterministic query sampling (default 1). */
  seed?: number;

  /** recall@k cutoff (default 10). */
  k?: number;
  /** p99 latency budget in ms (default 80). */
  budgetMs?: number;
  /** Clock; injected for deterministic timing in tests (default Date.now). */
  now?: () => number;
  /** Optional per-query progress tick (1..N). Forwarded to runBenchmark. */
  onQuery?: (current: number) => void;
}

/**
 * Run the benchmark and return the report (per-engine recall@k + latency
 * percentiles + ship verdict). Throws only if the query set ends up empty
 * (nothing labelled to measure).
 */
export async function runFractalBenchmark(deps: FractalBenchDeps): Promise<BenchReport> {
  const k = deps.k ?? 10;
  const budgetMs = deps.budgetMs ?? 80;
  const now = deps.now ?? Date.now;

  const queries: BenchQuery[] = deps.queries
    ? deps.queries
    : deps.querySetJsonl
      ? parseQuerySet(deps.querySetJsonl)
      : await generateQuerySet({
          leaves: deps.loadLeaves(),
          infer: deps.infer,
          count: deps.count ?? 50,
          seed: deps.seed ?? 1,
        });

  const engine = new FractalRecallEngine({
    tree: deps.tree,
    embed: deps.embed,
    ftsSearch: deps.ftsSearch,
    leavesById: deps.leavesById,
  });

  // No session is "current" in a benchmark, so pass "" — real session ids are
  // non-empty, so nothing is excluded and the gold doc can always surface.
  const fractal = (query: string) => engine.rankedLeafIds(query, "", k);
  const fts = async (query: string) =>
    deps.ftsSearch(query, k).flatMap((e) => (e.id === undefined ? [] : [e.id]));

  return runBenchmark({ queries, fts, fractal, k, budgetMs, now, onQuery: deps.onQuery });
}
