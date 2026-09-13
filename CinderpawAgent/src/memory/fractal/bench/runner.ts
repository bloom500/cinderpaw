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

/**
 * What a query actually asks of memory. Declared per query, because recall@k
 * is only a meaningful score for one of these three:
 *
 *   - `historical`: "what did I say/do about X" — a past record answers it, so
 *     recall over the labelled evidence is the right measure. The default.
 *   - `live-state`: "what windows do I have open right now" — the correct
 *     behaviour is a live tool call. Any archived snapshot that scores a hit
 *     here is being rewarded for returning stale state.
 *   - `no-memory`: "hey, are you there?" — nothing needs retrieving, and the
 *     correct behaviour is to not reach for memory at all.
 *
 * The last two still run (they cost latency like any real turn) but they are
 * excluded from recall, because averaging them in scores the engine on
 * questions document retrieval cannot answer.
 */
export type BenchTask = "historical" | "live-state" | "no-memory";

/** Every task kind, for validation and for reporting the excluded counts. */
export const BENCH_TASKS: readonly BenchTask[] = ["historical", "live-state", "no-memory"];

/** A labelled query: the text plus the set of leaf ids considered relevant. */
export interface BenchQuery {
  query: string;
  relevant: Set<number>;
  /**
   * What this query asks of memory. Omitted means `historical`, so every
   * query set written before this field existed scores exactly as it did.
   */
  task?: BenchTask;
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
  /**
   * Every leaf id that says the same thing as `leafId`, itself included. The
   * corpus folds identical memories into one leaf before the tree is built,
   * so the labelled id may not be the one the tree can return; a hit on any
   * copy is the answer. Absent means every id stands alone.
   */
  equivalents?: (leafId: number) => number[];
}

/** One query's outcome for a single engine. */
export interface PerQuery {
  query: string;
  task: BenchTask;
  /** recall@k, or `null` when the task is not scored by document recall. */
  recall: number | null;
  ms: number;
}

/** Aggregated results for a single engine across the whole query set. */
export interface EngineReport {
  /** Mean recall@k over the `historical` queries only. */
  meanRecallAtK: number;
  p50Ms: number;
  p99Ms: number;
  perQuery: PerQuery[];
}

export interface BenchReport {
  k: number;
  /** Queries that ran. Latency percentiles cover all of them. */
  n: number;
  /** Queries behind `meanRecallAtK` — the `historical` ones. */
  scoredN: number;
  /** How many queries each non-scored task kind excluded, for display. */
  unscoredByTask: Record<Exclude<BenchTask, "historical">, number>;
  fts: EngineReport;
  fractal: EngineReport;
  verdict: Verdict;
}

/**
 * recall@k where each labelled id is satisfied by any of its copies. Still
 * one point per LABELLED id: widening the relevant set instead would turn a
 * hit on one of fifteen copies into one fifteenth of a hit, which is the
 * single-gold defect in a new costume.
 */
function groupRecallAtK(
  ranked: number[],
  relevant: ReadonlySet<number>,
  k: number,
  equivalents?: (id: number) => number[],
): number {
  if (!equivalents) return recallAtK(ranked, relevant, k);
  if (relevant.size === 0) return 0;
  const topK = new Set(ranked.slice(0, k));
  let found = 0;
  for (const id of relevant) if (equivalents(id).some((e) => topK.has(e))) found++;
  return found / relevant.size;
}

/** Run one engine over the whole query set, timing each call. */
async function runEngine(
  queries: BenchQuery[],
  retrieve: Retriever,
  k: number,
  now: () => number,
  onQuery?: (current: number) => void,
  equivalents?: (leafId: number) => number[],
): Promise<EngineReport> {
  const perQuery: PerQuery[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    const t0 = now();
    const ranked = await retrieve(q.query);
    const ms = now() - t0;
    const task = q.task ?? "historical";
    perQuery.push({
      query: q.query,
      task,
      recall: task === "historical" ? groupRecallAtK(ranked, q.relevant, k, equivalents) : null,
      ms,
    });
    // 1-based, fires once per query in each engine. Orchestrator uses this
    // to drive a single "running queries i/N" line; tests omit the hook.
    onQuery?.(i + 1);
  }
  // Only scored tasks feed the mean; latency covers every query, since an
  // unscored turn costs the user the same wait as a scored one.
  const recalls = perQuery.flatMap((p) => (p.recall === null ? [] : [p.recall]));
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
  const scoredN = opts.queries.filter((q) => (q.task ?? "historical") === "historical").length;
  if (scoredN === 0) {
    throw new Error(
      "runBenchmark: no scorable queries — every query declares task " +
        '"live-state" or "no-memory", and recall@k is only defined for ' +
        '"historical". Label at least one query as historical.',
    );
  }
  const fts = await runEngine(opts.queries, opts.fts, opts.k, opts.now, opts.onQuery, opts.equivalents);
  const fractal = await runEngine(opts.queries, opts.fractal, opts.k, opts.now, opts.onQuery, opts.equivalents);
  return {
    k: opts.k,
    n: opts.queries.length,
    scoredN,
    unscoredByTask: {
      "live-state": opts.queries.filter((q) => q.task === "live-state").length,
      "no-memory": opts.queries.filter((q) => q.task === "no-memory").length,
    },
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

/**
 * One human-readable phrase saying what the recall figure covers, for the
 * places a person actually reads: the boot log line and the bench panel.
 * Without it the excluded queries exist only inside the JSON report, and
 * "n=12, recall 0.58" silently means "7 queries, recall 0.58".
 *
 * Returns "" when nothing was excluded, so the common case adds no noise.
 */
export function describeScope(report: BenchReport): string {
  const parts = (Object.keys(report.unscoredByTask) as (keyof typeof report.unscoredByTask)[])
    .filter((task) => report.unscoredByTask[task] > 0)
    .map((task) => `${report.unscoredByTask[task]} ${task}`);
  if (parts.length === 0) return "";
  return `recall covers ${report.scoredN} of ${report.n} queries (${parts.join(", ")} not scored by document recall)`;
}
