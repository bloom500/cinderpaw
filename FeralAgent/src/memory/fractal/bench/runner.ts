/**
 * Benchmark runner — the orchestration layer of the Fractal Memory Search
 * gate. It drives a labelled query set through two retrieval engines (flat
 * FTS5 and the RAPTOR hybrid), measuring recall@k and per-call latency for
 * each, then folds the result into the spec's ship/no-ship verdict.
 *
 * Everything external is injected: the two retrievers (each maps a query to a
 * ranked list of leaf ids) and the clock. That keeps the runner pure-ish and
 * unit-testable with fakes — the real wiring (DB, embed bridge, FractalMemory)
 * lives in the `bench-fractal` entrypoint, which only this layer's contract
 * touches.
 */
import { recallAtK, percentile, verdict, type Verdict } from "./metrics.ts";

/** A labelled query: the text plus the set of leaf ids considered relevant. */
export interface BenchQuery {
  query: string;
  relevant: Set<number>;
}

/** Maps a query to a ranked list of leaf ids (best first). */
export type Retriever = (query: string) => Promise<number[]>;

export interface RunBenchmarkOptions {
  queries: BenchQuery[];
  /** Flat FTS5 baseline retriever. */
  fts: Retriever;
  /** RAPTOR hybrid retriever (the candidate). */
  fractal: Retriever;
  /** Cutoff for recall@k. */
  k: number;
  /** p99 latency budget in ms for the verdict. */
  budgetMs: number;
  /** Millisecond clock; injected so timing is deterministic in tests. */
  now: () => number;
  /**
   * Optional per-query progress tick. Fired after each query completes
   * against BOTH engines (1..N, 1..N), so a single counter can drive a
   * "running queries i/N" line. The orchestrator (`bench/orchestrator.ts`)
   * uses this; the test suite omits it.
   */
  onQuery?: (current: number) => void;
}

/** One query's outcome for a single engine. */
export interface PerQuery {
  query: string;
  recall: number;
  ms: number;
}

/** Aggregated results for a single engine across the whole query set. */
export interface EngineReport {
  meanRecallAtK: number;
  p50Ms: number;
  p99Ms: number;
  perQuery: PerQuery[];
}

export interface BenchReport {
  k: number;
  n: number;
  fts: EngineReport;
  fractal: EngineReport;
  verdict: Verdict;
}

/** Run one engine over the whole query set, timing each call. */
async function runEngine(
  queries: BenchQuery[],
  retrieve: Retriever,
  k: number,
  now: () => number,
  onQuery?: (current: number) => void,
): Promise<EngineReport> {
  const perQuery: PerQuery[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    const t0 = now();
    const ranked = await retrieve(q.query);
    const ms = now() - t0;
    perQuery.push({ query: q.query, recall: recallAtK(ranked, q.relevant, k), ms });
    // 1-based, fires once per query in each engine. Orchestrator uses this
    // to drive a single "running queries i/N" line; tests omit the hook.
    onQuery?.(i + 1);
  }
  const recalls = perQuery.map((p) => p.recall);
  const latencies = perQuery.map((p) => p.ms);
  return {
    meanRecallAtK: recalls.reduce((a, b) => a + b, 0) / recalls.length,
    p50Ms: percentile(latencies, 50),
    p99Ms: percentile(latencies, 99),
    perQuery,
  };
}

/**
 * Run the full benchmark: both engines over the same query set, then the
 * verdict. Throws on an empty query set — a benchmark with nothing to measure
 * is a configuration error, not a passing run.
 */
export async function runBenchmark(opts: RunBenchmarkOptions): Promise<BenchReport> {
  if (opts.queries.length === 0) {
    throw new Error("runBenchmark: empty query set");
  }
  const fts = await runEngine(opts.queries, opts.fts, opts.k, opts.now, opts.onQuery);
  const fractal = await runEngine(opts.queries, opts.fractal, opts.k, opts.now, opts.onQuery);
  return {
    k: opts.k,
    n: opts.queries.length,
    fts,
    fractal,
    verdict: verdict({
      fractalRecall: fractal.meanRecallAtK,
      ftsRecall: fts.meanRecallAtK,
      fractalP99Ms: fractal.p99Ms,
      budgetMs: opts.budgetMs,
    }),
  };
}
