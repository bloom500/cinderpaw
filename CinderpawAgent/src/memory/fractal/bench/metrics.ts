/**
 * Benchmark metrics — the pure measurement core of the Fractal Memory Search
 * benchmark gate.
 *
 * The spec's gate ("Benchmark gate before declaring replaced") is encoded in
 * `verdict`: ship the RAPTOR hybrid only if its recall@10 is at least FTS5's
 * AND its p99 query latency stays under the budget (80 ms @ 10k memories).
 * Until that passes, FTS5 already covers exact matches, so there is no reason
 * to promote the fractal over it.
 *
 * No I/O, no clock, no model: just arithmetic over inputs the runner collects.
 */

/**
 * recall@k for a single query: the fraction of `relevant` ids that appear in
 * the first `k` entries of the `ranked` retrieval list. Duplicate ids in the
 * ranked list are not double-counted. Returns 0 (never NaN) when the query has
 * no relevant ids.
 */
export function recallAtK(
  ranked: number[],
  relevant: ReadonlySet<number>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  const topK = new Set(ranked.slice(0, k));
  let found = 0;
  for (const id of relevant) {
    if (topK.has(id)) found++;
  }
  return found / relevant.size;
}

/**
 * Nearest-rank percentile of `samples` (e.g. p99 latency). `p` is a percentage
 * in [0, 100]. p0 → min, p100 → max. Throws on an empty sample set, since the
 * percentile of nothing is undefined and silently returning 0 would mask a
 * benchmark that collected no timings.
 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) {
    throw new Error("percentile: empty sample set");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  if (p <= 0) return sorted[0]!;
  if (p >= 100) return sorted[sorted.length - 1]!;
  // Nearest-rank: rank = ceil(p/100 * N), 1-indexed.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1]!;
}

export interface VerdictInput {
  /** Mean recall@10 of the fractal hybrid over the query set. */
  fractalRecall: number;
  /** Mean recall@10 of flat FTS5 over the same query set. */
  ftsRecall: number;
  /** p99 of the fractal path's per-query latency, in milliseconds. */
  fractalP99Ms: number;
  /** Latency budget the p99 must stay under, in milliseconds. */
  budgetMs: number;
}

export interface Verdict {
  /** Whether the fractal hybrid is cleared to ship over FTS5. */
  ship: boolean;
  /** Human-readable blocking reasons; empty when `ship` is true. */
  reasons: string[];
}

/**
 * The ship/no-ship decision. Two independent gates, both must pass:
 *   1. Recall must not regress: fractal recall@10 >= FTS5 recall@10.
 *   2. Tail latency must fit the budget: fractal p99 < budget.
 */
export function verdict(input: VerdictInput): Verdict {
  const reasons: string[] = [];
  if (input.fractalRecall < input.ftsRecall) {
    reasons.push(
      `recall regressed: fractal ${input.fractalRecall.toFixed(3)} < FTS5 ${input.ftsRecall.toFixed(3)}`,
    );
  }
  if (input.fractalP99Ms >= input.budgetMs) {
    reasons.push(
      `p99 latency over budget: ${input.fractalP99Ms.toFixed(1)}ms >= ${input.budgetMs}ms`,
    );
  }
  return { ship: reasons.length === 0, reasons };
}
