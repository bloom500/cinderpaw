/**
 * FractalMemory — the live facade that makes Fractal Memory Search usable by
 * the agent loop, with a guaranteed fall back to the existing FTS5 recall.
 *
 * It owns the RAPTOR tree's lifecycle (load on startup, rebuild on demand) and
 * answers `recall(query, sessionId)` with the SAME `RecallResult` shape the
 * agent already consumes. The contract that keeps this safe to drop into the
 * hot path:
 *
 *   - **Augment, never replace.** When there is no tree yet, or embeddings are
 *     unavailable (no model on disk → Rust `embed_text` errors), or anything
 *     in the semantic path throws, `recall` returns the existing
 *     `RecallEngine` result. The agent never loses memory; it only gains the
 *     semantic layer once the tree + model exist.
 *   - **Never throws.** The agent loop calls recall on every user turn and
 *     relies on it not throwing; every failure here is caught and downgraded
 *     to the fallback.
 *   - **Build is offline.** The tree is (re)built by an explicit `rebuild()`
 *     call (startup, a periodic tick, or after ingest) — never inside
 *     `recall`, which only ever reads + embeds the single query vector.
 *
 * Why `leavesById` is rebuilt from episodic, not loaded from disk: the
 * persisted tree stores only ids + centroids + summaries (see tree-store), not
 * leaf text/session/timestamp. `FractalRecallEngine` needs those to format the
 * block and to apply the current-session filter, so we map them from the live
 * episodic rows each time we (re)load a tree.
 */
import { buildTree } from "./tree-builder.ts";
import { FractalRecallEngine, type RecallResult, type FtsSearch } from "./fractal-recall.ts";
import { saveTree, loadTree } from "./tree-store.ts";
import { projectCentroids } from "./project-centroids.ts";
import { runFractalBenchmark } from "./bench/run-benchmark.ts";
import {
  runFractalBenchmarkWithProgress,
  type BenchProgress,
  DEFAULT_BENCH_COUNT,
  DEFAULT_BENCH_TIMEOUT_MS,
  DEFAULT_GEN_CONCURRENCY,
} from "./bench/orchestrator.ts";
import type { BenchReport } from "./bench/runner.ts";
import type { EmbedInvoker } from "./embed.ts";
import type { Leaf, TreeNode } from "./types.ts";

/** Options for {@link FractalMemory.benchmark}. */
export interface FractalBenchmarkOptions {
  /** Local-model completion, used to generate paraphrase queries. */
  infer: (prompt: string) => Promise<string>;
  /** Pre-labelled JSONL query set; when present, skips generation. */
  querySetJsonl?: string;
  /** Queries to generate when no JSONL is given (default 50). */
  count?: number;
  /** Seed for deterministic query sampling (default 1). */
  seed?: number;
  /** recall@k cutoff (default 10). */
  k?: number;
  /** p99 latency budget in ms (default 80). */
  budgetMs?: number;
}

/** Minimal shape of the legacy engine we fall back to (RecallEngine). */
export interface RecallFallback {
  recall(query: string, sessionId: string): RecallResult;
}

/**
 * A pulse the living organism listens to. The sidecar forwards these to the
 * frontend so the Mandelbrot is driven by Fractal Memory Search, not RSI:
 *   - `recall` — a real semantic query traversed the tree → breathing focuses
 *   - `grow`   — a rebuild grew the tree → filaments extend
 *   - `seed`   — a single memory was written → a fine impulse so the
 *                organism feels alive per-iteration, not only on the next
 *                big rebuild (which is gated by `rebuildIfStale` at 1.2x and
 *                would otherwise miss the +1-memory case).
 *   - `prune`  — a leaf that was in the tree disappeared on the latest rebuild
 *                (deleted memory / cap eviction) → its leaf blackens and falls.
 *                The only real prune source today; no fabricated trigger.
 */
export type FractalActivity =
  | { kind: "recall"; hits: number }
  | {
      kind: "grow";
      leafCount: number;
      clusterCount: number;
      clusters: { x: number; y: number; weight: number }[];
    }
  | { kind: "seed"; leafId: number; sessionId: string; ts: number }
  | { kind: "prune"; leafId: number; clusterIndex?: number };

export interface FractalMemoryDeps {
  /** Pull the current episodic rows as leaves (vectors optional — `buildTree`
   *  embeds any leaf missing one). Used both to build the tree and to map
   *  `leafId → Leaf` metadata for the recall engine. */
  loadLeaves: () => Leaf[];
  /** Embedder (production wires the bridge → Rust; tests pass a fake). */
  embed: EmbedInvoker;
  /** Cluster summarizer (production binds the InferenceRouter). */
  summarize: (items: string[]) => Promise<string>;
  /** FTS5 exact-match search (production passes `episodic.search`). */
  ftsSearch: FtsSearch;
  /** The legacy recall path — always available, used whenever fractal can't. */
  fallback: RecallFallback;
  /** Where the persisted tree lives on disk. */
  treePath: string;
  /** Below this many leaves, skip the tree entirely (FTS5 is plenty for a tiny
   *  corpus, and clustering a handful of rows is noise). Default 8. */
  minLeaves?: number;
  /**
   * Optional upper bound on the leaves used to build/bench the tree (dev-only).
   * When set, the corpus is capped to the first `maxLeaves` rows EVERYWHERE the
   * facade reads leaves — tree build, staleness check, recall metadata, and the
   * benchmark's query generation — so the gate measures a self-consistent
   * subset. Production leaves this unset (the live tree covers the whole
   * corpus); the Fractal Memory benchmark wires it from
   * `FERAL_FRACTAL_BENCH_MAX_LEAVES` to get real numbers in minutes on CPU
   * instead of hours over the full corpus. Unset/0 = no cap.
   */
  maxLeaves?: number;
  /** Optional diagnostics sink (production passes the sidecar logger). */
  log?: (msg: string) => void;
  /**
   * Optional write-back hook. `buildTree` calls it after each chunk of
   * leaves is freshly embedded so vectors land on disk and the next
   * rebuild can skip the embed roundtrip entirely. Production wires this
   * to `EpisodicMemory.setEmbeddings`; tests use an in-memory map.
   */
  persistEmbeddings?: (rows: { id: number; vec: Float32Array }[]) => void;
  /**
   * Optional hook to drop ALL stored embeddings (returns rows cleared).
   * Production wires this to `EpisodicMemory.clearEmbeddings`. The rebuild
   * calls it when the embedding model's output dimension no longer matches the
   * stored vectors (a model swap, e.g. bge-small 384d → bge-m3 1024d) — without
   * it the stale-dimension vectors would crash cosine at recall time.
   */
  clearEmbeddings?: () => number;
  /**
   * Optional sink for organism pulses (recall/grow). Production wires this to
   * the sidecar transport so Rust forwards the pulse to the frontend; tests
   * collect into an array. Best-effort — a throwing sink never breaks recall.
   */
  onActivity?: (activity: FractalActivity) => void;
}

/** Build the `grow` activity from a freshly built tree: real counts + 2D
 *  cluster positions (projected centroids) with leaf-count weights normalized
 *  to 0..1. Pure + exported so it can be unit-tested without a live tree. */
export function buildGrowActivity(tree: {
  leafIds: number[];
  children: { leafIds: number[]; centroid: Float32Array }[];
}): Extract<FractalActivity, { kind: "grow" }> {
  const points = projectCentroids(tree.children.map((c) => c.centroid));
  const counts = tree.children.map((c) => c.leafIds.length);
  const maxCount = Math.max(1, ...counts);
  const clusters = tree.children.map((_c, i) => ({
    x: points[i]?.x ?? 0,
    y: points[i]?.y ?? 0,
    weight: counts[i]! / maxCount,
  }));
  return {
    kind: "grow",
    leafCount: tree.leafIds.length,
    clusterCount: tree.children.length,
    clusters,
  };
}

export class FractalMemory {
  readonly #loadLeaves: () => Leaf[];
  readonly #embed: EmbedInvoker;
  readonly #summarize: (items: string[]) => Promise<string>;
  readonly #ftsSearch: FtsSearch;
  readonly #fallback: RecallFallback;
  readonly #treePath: string;
  readonly #minLeaves: number;
  readonly #maxLeaves: number;
  readonly #log?: (msg: string) => void;
  readonly #persistEmbeddings?: (rows: { id: number; vec: Float32Array }[]) => void;
  readonly #clearEmbeddings?: () => number;
  readonly #onActivity?: (activity: FractalActivity) => void;

  #tree: TreeNode | null = null;
  #leavesById: Map<number, Leaf> | null = null;
  /** Shared promise while a rebuild is in flight; dedupes concurrent callers. */
  #rebuildInFlight: Promise<boolean> | null = null;

  constructor(deps: FractalMemoryDeps) {
    this.#loadLeaves = deps.loadLeaves;
    this.#embed = deps.embed;
    this.#summarize = deps.summarize;
    this.#ftsSearch = deps.ftsSearch;
    this.#fallback = deps.fallback;
    this.#treePath = deps.treePath;
    this.#minLeaves = deps.minLeaves ?? 8;
    this.#maxLeaves = deps.maxLeaves && deps.maxLeaves > 0 ? deps.maxLeaves : 0;
    this.#log = deps.log;
    this.#persistEmbeddings = deps.persistEmbeddings;
    this.#clearEmbeddings = deps.clearEmbeddings;
    this.#onActivity = deps.onActivity;
  }

  /**
   * Current leaves, capped to `maxLeaves` when set (dev bench subset). Single
   * source of truth so the tree, staleness check, recall metadata, and the
   * benchmark's query generation all read the SAME subset — otherwise queries
   * would target gold leaves that aren't in the (capped) tree and the recall
   * comparison would be meaningless.
   */
  #cappedLeaves(): Leaf[] {
    const all = this.#loadLeaves();
    if (this.#maxLeaves && all.length > this.#maxLeaves) {
      return all.slice(0, this.#maxLeaves);
    }
    return all;
  }

  /** Emit an organism pulse; a throwing/absent sink is never fatal. */
  #emit(activity: FractalActivity): void {
    if (!this.#onActivity) return;
    try {
      this.#onActivity(activity);
    } catch (e) {
      this.#log?.(`fractal: activity sink threw (ignored): ${String(e)}`);
    }
  }

  /** True once a tree is loaded/built and ready to serve semantic recalls. */
  get hasTree(): boolean {
    return this.#tree !== null && this.#leavesById !== null;
  }

  /** Leaves covered by the currently loaded/built tree (0 when none). */
  get treeLeafCount(): number {
    return this.#tree?.leafIds.length ?? 0;
  }

  /**
   * Load a persisted tree from disk (if any) and map its leaves to current
   * episodic metadata. Safe to call at startup; never throws. Returns whether
   * a usable tree was loaded.
   */
  init(): boolean {
    const persisted = loadTree(this.#treePath);
    if (!persisted) return false;
    try {
      this.#tree = persisted.tree;
      this.#leavesById = this.#mapLeaves();
      this.#log?.(`fractal: loaded tree (${persisted.leafCount} leaves) from disk`);
      return true;
    } catch (e) {
      this.#tree = null;
      this.#leavesById = null;
      this.#log?.(`fractal: failed to adopt persisted tree: ${String(e)}`);
      return false;
    }
  }

  /**
   * Rebuild the tree from the current episodic rows, persist it, and swap it in
   * atomically. Returns whether a tree was built. Never throws — a corpus
   * below `minLeaves`, or an embedding failure (no model yet), just returns
   * false and leaves the previous tree (and the fallback) untouched.
   */
  async rebuild(): Promise<boolean> {
    // Concurrency guard: the facade is rebuilt from several places (startup,
    // the bench env path, the bench IPC handler, the Settings button). Without
    // this latch they raced into parallel `buildTree` runs over the same
    // corpus — the "3× rebuild started" thrashing we saw live. The latch is
    // assigned synchronously (before the first await), so concurrent callers
    // join the same build instead of starting their own.
    if (this.#rebuildInFlight) {
      this.#log?.("fractal: rebuild already in flight — joining existing build");
      return this.#rebuildInFlight;
    }
    this.#rebuildInFlight = this.#doRebuild().finally(() => {
      this.#rebuildInFlight = null;
    });
    return this.#rebuildInFlight;
  }

  async #doRebuild(): Promise<boolean> {
    let leaves = this.#cappedLeaves();
    if (leaves.length < this.#minLeaves) {
      this.#log?.(`fractal: ${leaves.length} leaves < min ${this.#minLeaves}; using FTS5 only`);
      return false;
    }
    // Embedding-model migration guard. Stored leaf vectors carry a fixed
    // dimension from whatever model produced them; if the model now loaded
    // emits a different dimension (e.g. bge-small 384d → bge-m3 1024d), the
    // tree's centroids and the query vector won't share a length and cosine
    // throws at recall — silently degrading every recall to FTS5 forever. A
    // cheap probe embed detects the mismatch; we then drop the stale vectors
    // and reload so the build re-embeds the whole corpus fresh at the new dim.
    const storedDim = leaves.find((l) => l.vec.length > 0)?.vec.length ?? 0;
    if (storedDim > 0 && this.#clearEmbeddings) {
      try {
        const probe = await this.#embed(["dimension probe"]);
        const currentDim = probe[0]?.length ?? 0;
        if (currentDim > 0 && currentDim !== storedDim) {
          const cleared = this.#clearEmbeddings();
          this.#log?.(
            `fractal: embedding dimension changed (${storedDim} → ${currentDim}); ` +
              `cleared ${cleared} stale vector(s), re-embedding the corpus from scratch`,
          );
          leaves = this.#cappedLeaves(); // reload without the stale vectors
        }
      } catch (e) {
        // Probe failed (no model on disk) — buildTree will fail the same way
        // below and fall back; nothing extra to do here.
        this.#log?.(`fractal: dim-guard probe skipped (${String(e)})`);
      }
    }
    let tree: TreeNode;
    const t0 = Date.now();
    this.#log?.(`fractal: rebuild started (${leaves.length} leaves)`);
    try {
      tree = await buildTree(leaves, {
        embed: this.#embed,
        summarize: this.#summarize,
        persistEmbeddings: (rows) => this.#persistEmbeddings?.(rows),
      });
    } catch (e) {
      this.#log?.(`fractal: tree build failed (embeddings unavailable?): ${String(e)}`);
      return false;
    }
    try {
      saveTree(this.#treePath, tree);
    } catch (e) {
      // Persistence failure is non-fatal: serve the in-memory tree anyway, it
      // just won't survive a restart.
      this.#log?.(`fractal: tree persist failed (serving in-memory): ${String(e)}`);
    }
    // Prune diff: any leaf that was in the previous tree but is gone from the
    // freshly built corpus (deleted memory / cap eviction) gets a `prune` pulse
    // so the living tree drops the matching leaf. Skipped on the first build
    // (no prior tree → nothing could have disappeared).
    const prevById = this.#leavesById;
    const nextById = new Map(leaves.map((l) => [l.id, l]));
    if (prevById) {
      for (const id of prevById.keys()) {
        if (!nextById.has(id)) this.#emit({ kind: "prune", leafId: id });
      }
    }
    this.#tree = tree;
    this.#leavesById = nextById;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    this.#log?.(`fractal: rebuilt tree (${leaves.length} leaves, ${tree.children.length} top-level clusters, ${secs}s)`);
    this.#emit(buildGrowActivity(tree));
    return true;
  }

  /**
   * Rebuild only when worthwhile: no tree yet, or the corpus has grown past
   * `growthRatio`× the tree's current coverage. Avoids re-paying the (cloud)
   * summary cost on every boot when the loaded tree is already fresh.
   */
  async rebuildIfStale(growthRatio = 1.2): Promise<boolean> {
    const covered = this.treeLeafCount;
    if (covered > 0) {
      const corpus = this.#cappedLeaves().length;
      if (corpus < covered * growthRatio) {
        this.#log?.(`fractal: tree fresh (${covered} covered, ${corpus} corpus); skip rebuild`);
        return false;
      }
    }
    return this.rebuild();
  }

  /**
   * Recall relevant context. Uses the semantic (tree + FTS5 hybrid) path when a
   * tree is ready and embeddings work; otherwise — and on ANY error — returns
   * the legacy FTS5 recall. Always resolves, never rejects.
   */
  async recall(query: string, sessionId: string): Promise<RecallResult> {
    if (this.#tree && this.#leavesById) {
      try {
        const engine = new FractalRecallEngine({
          tree: this.#tree,
          embed: this.#embed,
          ftsSearch: this.#ftsSearch,
          leavesById: this.#leavesById,
        });
        const result = await engine.recall(query, sessionId);
        // A real semantic traversal happened → pulse the organism so breathing
        // focuses on the active region. Only on the semantic path, never on the
        // FTS5 fallback below.
        this.#emit({ kind: "recall", hits: result.semanticFacts });
        return result;
      } catch (e) {
        this.#log?.(`fractal: recall fell back to FTS5: ${String(e)}`);
      }
    }
    return this.#fallback.recall(query, sessionId);
  }

  /**
   * Run the benchmark gate against the currently loaded tree: flat FTS5 vs the
   * fractal hybrid, over a generated (or supplied) labelled query set. Returns
   * the recall@k + latency + ship report. Requires a built tree — call
   * `rebuild()`/`init()` first; throws otherwise (a benchmark with no tree
   * would just measure the fallback against itself).
   *
   * This is the entrypoint the dev-only sidecar trigger calls: the facade
   * already holds the live embed bridge, FTS5 search, and leaf map, so the
   * benchmark runs inside the running process where embeddings actually work.
   */
  async benchmark(opts: FractalBenchmarkOptions): Promise<BenchReport> {
    if (!this.#tree || !this.#leavesById) {
      throw new Error("FractalMemory.benchmark: no tree built — call rebuild() first");
    }
    return runFractalBenchmark({
      loadLeaves: () => this.#cappedLeaves().map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: this.#ftsSearch,
      tree: this.#tree,
      leavesById: this.#leavesById,
      embed: this.#embed,
      infer: opts.infer,
      querySetJsonl: opts.querySetJsonl,
      count: opts.count,
      seed: opts.seed,
      k: opts.k,
      budgetMs: opts.budgetMs,
    });
  }

  /**
   * Hardening-wrapped variant of {@link benchmark} for the user-visible
   * Settings button. Same measurement contract, plus:
   *   - bounded query-generation concurrency (default 4) so a slow local
   *     `infer` doesn't sequentially block dozens of siblings
   *   - hard wall-clock cap (default 10 min) that rejects with a labelled
   *     error if the bench never finishes
   *   - sane default `count` (12, not 50)
   *   - per-phase progress callback so the panel can render a real status
   *     line instead of an opaque spinner
   *
   * Throws on the same conditions as `benchmark` (no tree). Timeout
   * errors are surfaced as `Error("bench timeout after Xms at <phase>")`
   * so the sidecar handler can attach a `phase` field to the result.
   */
  async benchmarkWithProgress(
    opts: FractalBenchmarkOptions & {
      timeoutMs?: number;
      genConcurrency?: number;
      onProgress?: (p: BenchProgress) => void;
    },
  ): Promise<BenchReport> {
    if (!this.#tree || !this.#leavesById) {
      throw new Error("FractalMemory.benchmarkWithProgress: no tree built — call rebuild() first");
    }
    return runFractalBenchmarkWithProgress({
      loadLeaves: () => this.#cappedLeaves().map((l) => ({ id: l.id, text: l.text })),
      ftsSearch: this.#ftsSearch,
      tree: this.#tree,
      leavesById: this.#leavesById,
      embed: this.#embed,
      infer: opts.infer,
      querySetJsonl: opts.querySetJsonl,
      count: opts.count ?? DEFAULT_BENCH_COUNT,
      seed: opts.seed,
      k: opts.k,
      budgetMs: opts.budgetMs,
      timeoutMs: opts.timeoutMs ?? DEFAULT_BENCH_TIMEOUT_MS,
      genConcurrency: opts.genConcurrency ?? DEFAULT_GEN_CONCURRENCY,
      onProgress: opts.onProgress,
    });
  }

  /**
   * Structured semantic query over the loaded tree — the `fractalQuery`
   * surface the read-only `recall` tool calls. Returns ranked `{leafId, text}`
   * hits (best first), embedding the query through the tree the same way
   * the per-turn auto-injection does but without formatting a prompt block or
   * excluding any session (an explicit tool query has no "current" session).
   *
   * Same contract as the rest of the facade: never throws, augment never
   * replace. No tree, an embedding failure, or an empty query → `[]`, so the
   * calling tool simply falls back to its own (non-fractal) results.
   */
  async query(pattern: string, limit: number): Promise<FractalQueryHit[]> {
    if (!this.#tree || !this.#leavesById || !pattern.trim() || limit <= 0) return [];
    const leavesById = this.#leavesById;
    try {
      const engine = new FractalRecallEngine({
        tree: this.#tree,
        embed: this.#embed,
        ftsSearch: this.#ftsSearch,
        leavesById,
      });
      const ids = await engine.rankedLeafIds(pattern, "", limit);
      return ids.flatMap((leafId) => {
        const leaf = leavesById.get(leafId);
        return leaf ? [{ leafId, text: leaf.text }] : [];
      });
    } catch (e) {
      this.#log?.(`fractal: query fell back to empty: ${String(e)}`);
      return [];
    }
  }

  /**
   * Notify the organism that a single leaf was just written to episodic
   * memory. Cheap (no rebuild — `rebuildIfStale` still gates the actual
   * tree regrowth at 1.2× coverage), so it can fire on every turn without
   * any LLM cost. Without this, +1 memory on top of 2700 leaves is
   * invisible to the organism until the next 1.2× rebuild threshold —
   * which on a corpus of 2700 means ~540 more memories must accumulate
   * before anything visible happens. The vision is "a fine impulse at
   * every iteration", not "a giant warp every 540 writes", so this
   * carries the per-write signal.
   *
   * Best-effort: a missing or throwing sink never breaks the write.
   */
  noteWrite(leaf: { id: number; sessionId: string; ts: number }): void {
    this.#emit({ kind: "seed", leafId: leaf.id, sessionId: leaf.sessionId, ts: leaf.ts });
  }

  /**
   * Drill-down for the reactive tree's zoom-reveal + leaf card: the real member
   * memories of a top-level cluster (`tree.children[clusterIndex]`), best-effort
   * and never throwing. Returns `[]` when there is no tree or the index is out
   * of range. Leaf order follows the cluster's sorted `leafIds`.
   */
  clusterLeaves(clusterIndex: number): { leafId: number; text: string; ts: number }[] {
    const byId = this.#leavesById;
    const child = this.#tree?.children[clusterIndex];
    if (!byId || !child) return [];
    return child.leafIds.flatMap((id) => {
      const leaf = byId.get(id);
      return leaf ? [{ leafId: id, text: leaf.text, ts: leaf.ts }] : [];
    });
  }

  /** Map current episodic rows to `leafId → Leaf`, for the recall engine. */
  #mapLeaves(): Map<number, Leaf> {
    return new Map(this.#cappedLeaves().map((l) => [l.id, l]));
  }
}

/** One structured hit from {@link FractalMemory.query}. */
export interface FractalQueryHit {
  leafId: number;
  text: string;
}
