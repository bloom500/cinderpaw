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
      () => reject(new Error(`bench timeout after ${ms}ms at ${label}`)),
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
  if (opts.querySetJsonl) {
    queries = parseQuerySet(opts.querySetJsonl);
  } else {
    const leaves = opts.loadLeaves();
    const minLen = 20;
    const eligible = leaves.filter((l) => l.text.trim().length >= minLen);
    // We don't reach into `sample` from query-gen (it isn't exported), so we
    // re-implement the seed-deterministic shuffle locally — the same logic
    // the sampler uses, with the same mulberry32 + Fisher-Yates.
    const picked = deterministicShuffle(eligible, count, opts.seed ?? 1);
    queries = await withTimeout(
      generateQuerySetWithProgress(picked, opts.infer, genConcurrency, safeProgress),
      timeoutMs,
      "queries",
    );
  }

  if (queries.length === 0) {
    // Mirror runBenchmark's empty-set error so callers (including the
    // dev-only env path in index.ts) can rely on the same failure shape.
    throw new Error("runBenchmark: empty query set");
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

/** mulberry32 — same PRNG as `query-gen.ts`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded partial Fisher–Yates: same as query-gen.ts sample(). */
function deterministicShuffle<T>(items: T[], count: number, seed: number): T[] {
  const rand = mulberry32(seed);
  const arr = [...items];
  const n = Math.min(count, arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
}
