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
import { runFractalBenchmark } from "./bench/run-benchmark.ts";
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
  /** Optional diagnostics sink (production passes the sidecar logger). */
  log?: (msg: string) => void;
  /**
   * Optional write-back hook. `buildTree` calls it after each chunk of
   * leaves is freshly embedded so vectors land on disk and the next
   * rebuild can skip the embed roundtrip entirely. Production wires this
   * to `EpisodicMemory.setEmbeddings`; tests use an in-memory map.
   */
  persistEmbeddings?: (rows: { id: number; vec: Float32Array }[]) => void;
}

export class FractalMemory {
  readonly #loadLeaves: () => Leaf[];
  readonly #embed: EmbedInvoker;
  readonly #summarize: (items: string[]) => Promise<string>;
  readonly #ftsSearch: FtsSearch;
  readonly #fallback: RecallFallback;
  readonly #treePath: string;
  readonly #minLeaves: number;
  readonly #log?: (msg: string) => void;
  readonly #persistEmbeddings?: (rows: { id: number; vec: Float32Array }[]) => void;

  #tree: TreeNode | null = null;
  #leavesById: Map<number, Leaf> | null = null;

  constructor(deps: FractalMemoryDeps) {
    this.#loadLeaves = deps.loadLeaves;
    this.#embed = deps.embed;
    this.#summarize = deps.summarize;
    this.#ftsSearch = deps.ftsSearch;
    this.#fallback = deps.fallback;
    this.#treePath = deps.treePath;
    this.#minLeaves = deps.minLeaves ?? 8;
    this.#log = deps.log;
    this.#persistEmbeddings = deps.persistEmbeddings;
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
    const leaves = this.#loadLeaves();
    if (leaves.length < this.#minLeaves) {
      this.#log?.(`fractal: ${leaves.length} leaves < min ${this.#minLeaves}; using FTS5 only`);
      return false;
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
    this.#tree = tree;
    this.#leavesById = new Map(leaves.map((l) => [l.id, l]));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    this.#log?.(`fractal: rebuilt tree (${leaves.length} leaves, ${tree.children.length} top-level clusters, ${secs}s)`);
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
      const corpus = this.#loadLeaves().length;
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
        return await engine.recall(query, sessionId);
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
      loadLeaves: () => this.#loadLeaves().map((l) => ({ id: l.id, text: l.text })),
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

  /** Map current episodic rows to `leafId → Leaf`, for the recall engine. */
  #mapLeaves(): Map<number, Leaf> {
    return new Map(this.#loadLeaves().map((l) => [l.id, l]));
  }
}
