/**
 * Bench orchestrator — the sidecar-side wrapper around `runFractalBenchmark`
 * that adds the properties the user-visible button needs:
 *
 *   - **Hard timeout** so a wedged embed or stuck query-generation can never
 *     leave the React panel spinning forever. On timeout we reject with a
 *     labelled `Error` so the sidecar handler emits a `fractal_bench_result
 *     {ok:false, error:"timeout after Xs at phase Y"}` and the panel always
 *     settles.
 *   - **Bounded concurrency for query generation** so a single `infer` call
 *     that hangs on a slow local model doesn't sequentially block dozens of
 *     its siblings — and so the RSI passive engine can still get inference
 *     time in between batches.
 *   - **Sane default `count`** (12, not 50) so a default click is a few
 *     minutes, not a coffee break. The old 50 was set for a planned CI
 *     run, not for a dev clicking a button.
 *   - **Progress callback** fired at well-defined phases so the panel can
 *     render "generating queries 4/12" / "running queries 4/12" instead of
 *     an opaque spinner.
 *   - **Honours a pre-built query set** — when `querySetJsonl` is supplied,
 *     `generateQuerySet` is skipped entirely (its only role is the default
 *     self-supervised paraphrases).
 *
 * The orchestrator delegates the actual measurement to the existing
 * `runFractalBenchmark` — this file is purely a UX/hardening wrapper. Pure
 * functions, no I/O, no model: everything model-shaped is injected.
 */
import { runFractalBenchmark } from "./run-benchmark.ts";
import { parseQuerySet, type GenLeaf } from "./query-gen.ts";
import { sample } from "../prng.ts";
import type { BenchQuery } from "./runner.ts";
import type { BenchReport } from "./runner.ts";
import type { EmbedInvoker } from "../embed.ts";
import type { Leaf, TreeNode } from "../types.ts";
import type { EpisodicEvent } from "../../../types.ts";

/** Phases the orchestrator reports progress for. */
export type BenchProgressKind = "generate_queries" | "run_queries";

/** One progress tick from the orchestrator. Fired in order; total is constant per phase. */
export interface BenchProgress {
  kind: BenchProgressKind;
  /** 1-based index of the item that just started/finished. */
  current: number;
  /** Total items in this phase (known up front). */
  total: number;
  /** Human-readable status line for the panel ("Generating queries 4/12"). */
  message: string;
}

/** Default query-set size for a button click. The old 50 was for CI; 12 is human-scale. */
export const DEFAULT_BENCH_COUNT = 12;
/** Default per-query-set concurrency. Keeps the local-model call from monopolising the infer lock. */
export const DEFAULT_GEN_CONCURRENCY = 4;
/** Default wall-clock cap. 10 min is plenty for 12 queries; a tree build alone shouldn't get close. */
export const DEFAULT_BENCH_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunWithProgressOptions {
  // === Pure deps (mirrors runFractalBenchmark) ===
  loadLeaves: () => GenLeaf[];
  ftsSearch: (q: string, limit: number) => EpisodicEvent[];
  tree: TreeNode;
  leavesById: Map<number, Leaf>;
  embed: EmbedInvoker;
  infer: (prompt: string) => Promise<string>;

  // === Query set source (exactly one) ===
  /** Pre-built JSONL → skips generation entirely. */
  querySetJsonl?: string;
  /** How many queries to generate when no JSONL is given. Default 12. */
  count?: number;
  /** Seed for deterministic sampling. Default 1. */
  seed?: number;

  // === Bench config (mirrors runFractalBenchmark) ===
  k?: number;
  budgetMs?: number;
  /** Clock; injected for deterministic timing. Default Date.now. */
  now?: () => number;

  // === UX hardening (orchestrator-only) ===
  /** Wall-clock cap. Default 10 min. On expiry: reject with a labelled Error. */
  timeoutMs?: number;
  /** Inflight cap for `infer` during query generation. Default 4. */
  genConcurrency?: number;
  /** Fires at every progress tick. Optional. Never throw into the bench. */
  onProgress?: (p: BenchProgress) => void;
}

/** Map `items` through async `fn` with at most `limit` in flight; preserves order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/**
 * Race a promise against a wall-clock timer. On timeout, reject with a
 * labelled Error so the caller knows WHICH phase was running when the
 * budget ran out. `label` is appended to the error message verbatim.
 *
 * Exported so the sidecar can apply the same wall-clock guard to the
 * tree-build phase that runs *before* the orchestrator (the rebuild was
 * the previous infinite-spin path on a cold GPU/batch config).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        // ponytail: `Promise.race` picks a winner, it does not cancel the loser.
        // The benchmark's embed and summarise calls keep running after this
        // rejects, which is why the sidecar stays busy for minutes after the
        // bench "failed" — work nobody is waiting for any more. Cancelling for
        // real needs an AbortSignal threaded through embed/infer/retrieval;
        // until then, at least say so instead of leaving it a mystery.
        process.stderr.write(
          `[bench] timed out at ${label} after ${ms}ms — work already started ` +
            `keeps running in the background until it finishes
`,
        );
        reject(new Error(`bench timeout after ${ms}ms at ${label}`));
      },
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The sidecar's "user clicked the button" path: same measurement contract
 * as `runFractalBenchmark`, plus the UX hardening (timeout, bounded gen
 * concurrency, default count, progress callback). Throws on:
 *   - empty query set (no JSONL, no eligible leaves)
 *   - bench timeout (label = "queries" | "run")
 *   - any error from the underlying engines (propagated)
 */
export async function runFractalBenchmarkWithProgress(
  opts: RunWithProgressOptions,
): Promise<BenchReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BENCH_TIMEOUT_MS;
  const genConcurrency = opts.genConcurrency ?? DEFAULT_GEN_CONCURRENCY;
  const count = opts.count ?? DEFAULT_BENCH_COUNT;
  const onProgress = opts.onProgress;
  const safeProgress = (p: BenchProgress): void => {
    if (!onProgress) return;
    try {
      onProgress(p);
    } catch {
      // A throwing progress sink must never break the bench — swallow.
    }
  };

  // === Phase 1: build the query set ===
  let queries: BenchQuery[];
  // How many memories were paraphrasable (generation path only). Drives the
  // diagnostic below so an empty result names its real cause instead of the
  // bare "empty query set" that sent users hunting the wrong thing.
  let generationAttempted = 0;
  if (opts.querySetJsonl) {
    queries = parseQuerySet(opts.querySetJsonl);
  } else {
    const leaves = opts.loadLeaves();
    const minLen = 20;
    const eligible = leaves.filter((l) => l.text.trim().length >= minLen);
    const picked = sample(eligible, count, opts.seed ?? 1);
    generationAttempted = picked.length;
    queries = await withTimeout(
      generateQuerySetWithProgress(picked, opts.infer, genConcurrency, safeProgress),
      timeoutMs,
      "queries",
    );
  }

  if (queries.length === 0) {
    // Distinguish the two empty-set causes so the panel/log is actionable.
    // When we DID have memories to paraphrase but `infer` returned nothing for
    // every one, the overwhelmingly common cause is that no local chat model is
    // loaded — `router.complete` logs "no model loaded" and yields empty
    // content rather than throwing, so each paraphrase comes back blank. Saying
    // so beats the old cryptic "empty query set".
    if (generationAttempted > 0) {
      throw new Error(
        "runBenchmark: query generation produced no queries from " +
          `${generationAttempted} memories — is a local chat model loaded? ` +
          "The benchmark paraphrases memories into queries via the local model; " +
          "load one (or supply a hand-authored JSONL query set) and retry.",
      );
    }
    throw new Error(
      "runBenchmark: empty query set — no memories long enough to generate " +
        "queries from (need some memories ≥20 chars), and no JSONL query set was supplied.",
    );
  }

  // === Phase 1.5: pre-embed all queries in one batched bge call ===
  // bge-small on CPU embeds ~1–2 tokens/ms; doing N individual embed calls
  // means the longest query in the set dominates p99 and trips the budget
  // even when 11/12 queries finish in <50ms. Embedding the whole query set
  // in a single batched call before the per-query loop amortises the
  // per-call constant and removes that outlier.
  //
  // The fractal retriever in `run-benchmark.ts` reads the resulting map and
  // skips its own embed for any query whose text is present; queries not in
  // the map fall back to per-call embed (defensive — shouldn't happen here,
  // but the wrapper in run-benchmark.ts makes the fallback free).
  const queryTexts = queries.map((q) => q.query);
  const queryVecs = await withTimeout(
    opts.embed(queryTexts),
    timeoutMs,
    "pre_embed",
  );
  const precomputedEmbeddings = new Map<string, Float32Array>();
  for (let i = 0; i < queryTexts.length; i++) {
    const vec = queryVecs[i];
    if (vec) precomputedEmbeddings.set(queryTexts[i]!, vec);
  }

  // === Phase 2: run the measurement with per-query progress ===
  // The runner fires `onQuery` after each engine finishes a query (so
  // N queries → 2N ticks across both engines). Throttle to one tick per
  // query number so the panel shows a single "Running queries i/N" line
  // that doesn't flicker between the FTS and fractal rounds.
  const total = queries.length;
  const announced = new Set<number>();
  return await withTimeout(
    runFractalBenchmark({
      loadLeaves: opts.loadLeaves,
      ftsSearch: opts.ftsSearch,
      tree: opts.tree,
      leavesById: opts.leavesById,
      embed: opts.embed,
      infer: opts.infer,
      queries, // pre-built: skips the JSONL/generation branch inside
      k: opts.k,
      budgetMs: opts.budgetMs,
      now: opts.now,
      precomputedEmbeddings,
      onQuery: (current) => {
        if (announced.has(current)) return;
        announced.add(current);
        safeProgress({
          kind: "run_queries",
          current,
          total,
          message: `Running queries ${current}/${total}`,
        });
      },
    }),
    timeoutMs,
    "run",
  );
}

/**
 * Same logic as `generateQuerySet` but with bounded concurrency for `infer`
 * and a per-query progress callback. Order is preserved so the resulting
 * `BenchQuery[]` is stable across runs (deterministic PRNG already handles
 * sampling; the only non-determinism was the order of `await infer`, which
 * doesn't change the queries' content).
 */
async function generateQuerySetWithProgress(
  leaves: GenLeaf[],
  infer: (prompt: string) => Promise<string>,
  concurrency: number,
  onProgress: (p: BenchProgress) => void,
): Promise<BenchQuery[]> {
  const total = leaves.length;
  const queryFor = (memory: string): string => [
    "Below is a memory from a past conversation. Write ONE short, natural",
    "question a user might later ask whose answer is this memory. Vary the",
    "wording — do not copy the memory's phrasing. Reply with the question only.",
    "",
    `Memory: ${memory}`,
  ].join("\n");

  let done = 0;
  const out = await mapLimit(leaves, concurrency, async (leaf) => {
    const query = (await infer(queryFor(leaf.text))).trim();
    done++;
    onProgress({
      kind: "generate_queries",
      current: done,
      total,
      message: `Generating queries ${done}/${total}`,
    });
    if (query === "") return null;
    return { query, relevant: new Set([leaf.id]) };
  });
  return out.filter((q): q is BenchQuery => q !== null);
}
