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
 * Why `leavesById` is rebuilt from the owner-aware catalog, not loaded from disk: the
 * persisted tree stores only ids + centroids + summaries (see tree-store), not
 * leaf text/session/timestamp. `FractalRecallEngine` needs those to format the
 * block and to apply the current-session filter, so we map them from the live
 * live SQLite + LeafStore rows each time we (re)load a tree.
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
import { LeafStore, type LeafRecord, type LeafSummary } from "./leaf-store.ts";
import type { EvictionPolicy } from "./eviction.ts";
import type { RouterInferScope } from "./summarize.ts";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  /** Shared cancellation for every model/embedding phase in this run. */
  signal?: AbortSignal;
  /** Called before a timed-out phase is drained. */
  onTimeout?: (error: Error) => void | Promise<void>;
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
 *                next full rebuild.
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
  | { kind: "prune"; evictedLeafIds: number[]; ts: number };

export interface FractalMemoryDeps {
  /** Pull the current episodic rows as leaves (vectors optional — `buildTree`
   *  embeds any leaf missing one). Used both to build the tree and to map
   *  `leafId → Leaf` metadata for the recall engine. */
  loadLeaves: () => Leaf[];
  /** Embedder (production wires the bridge → Rust; tests pass a fake). */
  embed: EmbedInvoker;
  /** Cluster summarizer (production binds the InferenceRouter). */
  summarize: (items: string[], scope?: RouterInferScope) => Promise<string>;
  /** FTS5 exact-match search (production passes `episodic.search`). */
  ftsSearch: FtsSearch;
  /** The legacy recall path — always available, used whenever fractal can't. */
  fallback: RecallFallback;
  /** Where the persisted tree lives on disk. */
  treePath: string;
  /**
   * Where the durable reactive-leaf store lives (Pathway 4 PR-C C.0).
   * Production wires `<dataDir>/fractal-leaves.jsonl`; omit (or pass
   * `":memory:"`) for hermetic tests — the store then does no disk I/O.
   */
  leafStorePath?: string;
  /** Below this many leaves, skip the tree entirely (FTS5 is plenty for a tiny
   *  corpus, and clustering a handful of rows is noise). Default 8. */
  minLeaves?: number;
  /**
   * Optional upper bound on the leaves used to build/bench the tree (dev-only).
   * When set, the corpus is capped to the first `maxLeaves` rows EVERYWHERE the
   * facade reads leaves — tree build, staleness check, recall metadata, and the
   * benchmark's query generation — so the gate measures a self-consistent
   * owner-fair subset. Production leaves this unset (the live tree covers the whole
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

export type LeafOwner = "episodic" | "reactive";

interface CatalogLeaf {
  owner: LeafOwner;
  sourceId: number;
  /** Tree-facing leaf whose id is stable and collision-free across owners. */
  leaf: Leaf;
}

export class FractalMemory {
  readonly #loadLeaves: () => Leaf[];
  readonly #embed: EmbedInvoker;
  readonly #summarize: (items: string[], scope?: RouterInferScope) => Promise<string>;
  readonly #ftsSearch: FtsSearch;
  readonly #fallback: RecallFallback;
  readonly #treePath: string;
  readonly #minLeaves: number;
  readonly #maxLeaves: number;
  readonly #log?: (msg: string) => void;
  readonly #persistEmbeddings?: (rows: { id: number; vec: Float32Array }[]) => void;
  readonly #clearEmbeddings?: () => number;
  readonly #onActivity?: (activity: FractalActivity) => void;
  /** Durable provenance-bearing store for reactive leaves (PR-C C.0). */
  readonly #leafStore: LeafStore;
  /** Raw store path — used to derive the sibling evicted-leaf audit log (C.2). */
  readonly #leafStorePath: string;

  #tree: TreeNode | null = null;
  #leavesById: Map<number, Leaf> | null = null;
  #ownersById: Map<number, LeafOwner> | null = null;
  #treeCorpusFingerprint: string | null = null;
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
    this.#leafStorePath = deps.leafStorePath ?? ":memory:";
    this.#leafStore = new LeafStore(this.#leafStorePath);
  }

  /**
   * Current leaves, capped to `maxLeaves` when set (dev bench subset). Single
   * source of truth so the tree, staleness check, recall metadata, and the
   * benchmark's query generation all read the SAME subset — otherwise queries
   * would target gold leaves that aren't in the (capped) tree and the recall
   * comparison would be meaningless.
   */
  #cappedLeaves(): Leaf[] {
    return this.#cappedCatalog().map((entry) => entry.leaf);
  }

  /**
   * Stable owner-aware catalog. Episodic ids remain unchanged. Any legacy
   * reactive collision is atomically remapped in its owner store above the
   * occupied range, so every tree id is durable, public, and collision-free.
   */
  #catalogLeaves(): CatalogLeaf[] {
    const episodicLeaves = this.#loadLeaves();
    const reactiveRecords = this.#remapReactiveCollisions(episodicLeaves);
    const episodic = episodicLeaves.map((leaf) => catalogLeaf("episodic", leaf));
    const reactive = reactiveRecords.map((rec) => catalogLeaf("reactive", recordToLeaf(rec)));
    return [...episodic, ...reactive];
  }

  #remapReactiveCollisions(episodic: Leaf[]): LeafRecord[] {
    const records = this.#leafStore.all();
    const occupied = new Set(episodic.map((leaf) => leaf.id));
    let nextId = Math.max(0, ...occupied, ...records.map((record) => record.id)) + 1;
    let changed = false;
    const remapped = records.map((record) => {
      if (!occupied.has(record.id)) {
        occupied.add(record.id);
        return record;
      }
      while (occupied.has(nextId)) nextId += 1;
      const next = { ...record, id: nextId++ };
      occupied.add(next.id);
      changed = true;
      return next;
    });
    if (changed) {
      this.#leafStore.replaceAll(remapped);
      this.#hydrateReactiveState();
      this.#log?.("fractal: atomically remapped colliding reactive leaf ids");
    }
    return remapped;
  }

  /** Deterministic source-fair cap: each non-empty owner gets membership. */
  #cappedCatalog(): CatalogLeaf[] {
    const all = this.#catalogLeaves();
    if (!this.#maxLeaves || all.length <= this.#maxLeaves) return all;
    const episodic = all.filter((entry) => entry.owner === "episodic");
    const reactive = all.filter((entry) => entry.owner === "reactive");
    if (episodic.length === 0 || reactive.length === 0 || this.#maxLeaves === 1) {
      return all.slice(0, this.#maxLeaves);
    }
    const usable = this.#maxLeaves - 2;
    const episodicExtra = Math.min(
      episodic.length - 1,
      Math.floor(usable * episodic.length / all.length),
    );
    const episodicCount = 1 + episodicExtra;
    const reactiveCount = Math.min(reactive.length, this.#maxLeaves - episodicCount);
    const filledEpisodicCount = this.#maxLeaves - reactiveCount;
    return [
      ...episodic.slice(0, filledEpisodicCount),
      ...reactive.slice(0, reactiveCount),
    ];
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
    return this.#tree !== null && this.#leavesById !== null && this.#ownersById !== null;
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
    // Load the durable reactive-leaf store first (PR-C C.0) — independent of
    // the tree, so reactive leaves survive restart even when no tree exists.
    const loaded = this.#leafStore.load();
    if (loaded.loaded > 0 || loaded.skipped > 0) {
      this.#log?.(`fractal: loaded ${loaded.loaded} reactive leaf(s) from store (${loaded.skipped} skipped)`);
    }
    this.#hydrateReactiveState();
    const persisted = loadTree(this.#treePath);
    if (!persisted) return false;
    try {
      const fingerprint = corpusFingerprint(this.#cappedLeaves());
      if (persisted.corpusFingerprint !== fingerprint) {
        this.#log?.("fractal: persisted tree corpus changed; forcing rebuild");
        return false;
      }
      this.#tree = persisted.tree;
      this.#treeCorpusFingerprint = fingerprint;
      this.#leavesById = this.#mapLeaves();
      this.#log?.(`fractal: loaded tree (${persisted.leafCount} leaves) from disk`);
      return true;
    } catch (e) {
      this.#tree = null;
      this.#leavesById = null;
      this.#ownersById = null;
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
  async rebuild(scope: RouterInferScope = {}): Promise<boolean> {
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
    this.#rebuildInFlight = this.#doRebuild(scope).finally(() => {
      this.#rebuildInFlight = null;
    });
    return this.#rebuildInFlight;
  }

  async #doRebuild(scope: RouterInferScope): Promise<boolean> {
    let catalog = this.#cappedCatalog();
    let leaves = catalog.map((entry) => entry.leaf);
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
          const cleared = this.#clearEmbeddings() + this.#leafStore.clearEmbeddings();
          this.#log?.(
            `fractal: embedding dimension changed (${storedDim} → ${currentDim}); ` +
              `cleared ${cleared} stale vector(s), re-embedding the corpus from scratch`,
          );
          catalog = this.#cappedCatalog();
          leaves = catalog.map((entry) => entry.leaf); // reload without stale vectors
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
        embed: (texts) => abortableWork(this.#embed(texts), scope.signal),
        summarize: (items) => this.#summarize(items, scope),
        persistEmbeddings: (rows) => this.#persistOwnedEmbeddings(rows, catalog),
      });
    } catch (e) {
      scope.spendAuthority?.stop(e);
      this.#log?.(`fractal: tree build failed (embeddings unavailable?): ${String(e)}`);
      return false;
    }
    try {
      saveTree(this.#treePath, tree, corpusFingerprint(leaves));
    } catch (e) {
      // Persistence failure is non-fatal: serve the in-memory tree anyway, it
      // just won't survive a restart.
      this.#log?.(`fractal: tree persist failed (serving in-memory): ${String(e)}`);
    }
    this.#tree = tree;
    this.#treeCorpusFingerprint = corpusFingerprint(leaves);
    this.#leavesById = new Map(leaves.map((l) => [l.id, l]));
    this.#ownersById = new Map(catalog.map((entry) => [entry.leaf.id, entry.owner]));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    this.#log?.(`fractal: rebuilt tree (${leaves.length} leaves, ${tree.children.length} top-level clusters, ${secs}s)`);
    this.#emit(buildGrowActivity(tree));
    return true;
  }

  /**
   * Rebuild only when the exact catalog fingerprint changed. Avoids re-paying
   * the summary cost on an unchanged boot while detecting growth, shrinkage,
   * replacement, and owner-membership changes at the same count.
   */
  async rebuildIfStale(_growthRatio = 1.2, scope: RouterInferScope = {}): Promise<boolean> {
    const leaves = this.#cappedLeaves();
    const currentFingerprint = corpusFingerprint(leaves);
    if (this.#tree && this.#treeCorpusFingerprint === currentFingerprint) {
      this.#log?.(`fractal: tree fresh (${this.treeLeafCount} covered, ${leaves.length} corpus); skip rebuild`);
      return false;
    }
    return this.rebuild(scope);
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
          ftsLeafId: (sourceId) => sourceId,
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
      ftsLeafId: (sourceId) => sourceId,
      tree: this.#tree,
      leavesById: this.#leavesById,
      embed: (texts) => abortableWork(this.#embed(texts), opts.signal),
      infer: (prompt) => abortableWork(opts.infer(prompt), opts.signal),
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
      ftsLeafId: (sourceId) => sourceId,
      tree: this.#tree,
      leavesById: this.#leavesById,
      embed: (texts) => abortableWork(this.#embed(texts), opts.signal),
      infer: (prompt) => abortableWork(opts.infer(prompt), opts.signal),
      querySetJsonl: opts.querySetJsonl,
      count: opts.count ?? DEFAULT_BENCH_COUNT,
      seed: opts.seed,
      k: opts.k,
      budgetMs: opts.budgetMs,
      timeoutMs: opts.timeoutMs ?? DEFAULT_BENCH_TIMEOUT_MS,
      genConcurrency: opts.genConcurrency ?? DEFAULT_GEN_CONCURRENCY,
      onProgress: opts.onProgress,
      onTimeout: opts.onTimeout,
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
        ftsLeafId: (sourceId) => sourceId,
      });
      const ids = await engine.rankedLeafIds(pattern, "", limit);
      return ids.flatMap((treeId) => {
        const leaf = leavesById.get(treeId);
        if (!leaf) return [];
        const owner = this.#ownersById?.get(treeId);
        return owner ? [{ leafId: treeId, owner, text: leaf.text }] : [];
      });
    } catch (e) {
      this.#log?.(`fractal: query fell back to empty: ${String(e)}`);
      return [];
    }
  }

  /**
   * Cluster drill-down — every source id under a top-level cluster, paired
   * with its owner and the leaf metadata the UI shows in the per-cluster card. Returns
   * `[]` when there is no tree or the index is out of range; never throws.
   *
   * TreeNode leaf ids are collision-free catalog identities. Translate them
   * back to the owner-qualified public identity at this boundary.
   */
  clusterLeaves(clusterIndex: number): { leafId: number; owner: LeafOwner; text: string; ts: number }[] {
    if (!this.#tree || !this.#leavesById || !this.#ownersById) return [];
    const tree = this.#tree;
    if (clusterIndex < 0 || clusterIndex >= tree.children.length) return [];
    const root = tree.children[clusterIndex]!;
    const out: { leafId: number; owner: LeafOwner; text: string; ts: number }[] = [];
    for (const treeId of root.leafIds) {
      const leaf = this.#leavesById.get(treeId);
      const owner = this.#ownersById.get(treeId);
      if (!owner) continue;
      out.push({
        leafId: treeId,
        owner,
        text: leaf?.text ?? "",
        ts: leaf?.ts ?? 0,
      });
    }
    return out;
  }

  /**
   * Notify the organism that a single leaf was just written to episodic
   * memory. Cheap (no rebuild — `rebuildIfStale` still gates the actual
   * tree regrowth), so it can fire on every turn without
   * any LLM cost. Without this, +1 memory on top of 2700 leaves is
   * invisible to the organism until the next rebuild. The vision is "a fine impulse at
   * every iteration", so this
   * carries the per-write signal.
   *
   * Best-effort: a missing or throwing sink never breaks the write.
   */
  noteWrite(leaf: { id: number; sessionId: string; ts: number }): void {
    this.#emit({ kind: "seed", leafId: leaf.id, sessionId: leaf.sessionId, ts: leaf.ts });
  }

  /** Map current episodic rows to `leafId → Leaf`, for the recall engine. */
  #mapLeaves(): Map<number, Leaf> {
    const catalog = this.#cappedCatalog();
    this.#ownersById = new Map(catalog.map((entry) => [entry.leaf.id, entry.owner]));
    return new Map(catalog.map((entry) => [entry.leaf.id, entry.leaf]));
  }

  /** Membership mutations must never leave removed leaves recallable. */
  #invalidateTree(): void {
    this.#tree = null;
    this.#leavesById = null;
    this.#ownersById = null;
    this.#treeCorpusFingerprint = null;
  }

  // -------------------------------------------------------------------------
  // Pathway 3 step 2 — upsertLeaf
  //
  // Reactive write entry point: the Reconciler calls this on every
  // `after_memory_write` fact event so the tree reflects new captures
  // without waiting for a full `rebuild()`. Two paths:
  //
  //   1. Near-duplicate (cosine >= MERGE_THRESHOLD) → bump provenance on
  //      the existing leaf + emit `seed`. The tree's cluster topology is
  //      unchanged; the leaf's hit_count / last_seen_at are updated via
  //      the side-channel #provenance map.
  //   2. New leaf → add to the in-memory pending set, persist the
  //      embedding through the optional `persistEmbeddings` hook, and
  //      emit `grow`. The next `rebuild()` will pick the leaf up via
  //      `loadLeaves()` (the source of truth) and cluster it.
  //
  // Idempotency: the dedup key is `sha256(text + first_seen_at)`. Calling
  // upsertLeaf twice with the same `(text, first_seen_at)` returns the
  // same leaf id without emitting a second pulse or persisting twice.
  //
  // Best-effort: empty embedding (model missing), zero-length embedding,
  // or persist failure all surface as graceful no-ops. A new memory
  // write NEVER crashes the extraction pipeline.
  // -------------------------------------------------------------------------

  /** Bumped on every successful insert; merge and failed-write are silent. */
  #mutationSeq = 0;
  /** Per-leaf provenance side-channel (hit_count, last_seen_at, provenance). */
  readonly #provenance = new Map<number, LeafProvenance>();
  /** Deduplication: `provenanceKey(leafId)` is set on first insert. */
  readonly #provenanceKeys = new Set<string>();
  /** Pending leaves awaiting the next `loadLeaves()` cycle / rebuild. */
  readonly #pendingLeaves = new Map<number, Leaf>();

  get mutationSeq(): number {
    return this.#mutationSeq;
  }

  /**
   * Read-only view of leaves inserted via upsertLeaf since the last
   * full rebuild. Used by the Reconciler (Task 4) to drive graph
   * reconcile; useful for tests too. The durable LeafStore is already part of
   * the canonical catalog, so the next rebuild picks these up directly.
   */
  pendingLeaves(): Leaf[] {
    return Array.from(this.#pendingLeaves.values());
  }

  /**
   * Provenance-bearing summaries of the durable reactive leaves (PR-C C.0).
   * This is the surface eviction (C.1/C.2) and cross-session dedup (C.3)
   * operate on as pure functions: each summary carries `first_seen_at`,
   * `last_seen_at`, and `hit_count`. Reads from the durable LeafStore, so it
   * reflects leaves written across restarts (after `init()` loaded them).
   */
  leaves(): LeafSummary[] {
    return this.#leafStore.summaries();
  }

  /**
   * Apply an EvictionPolicy to the durable store (PR-C C.2). Removes the
   * selected leaves, appends them to `<dir>/fractal-evicted.jsonl` for audit,
   * and emits a `prune` pulse so the organism reflects the loss. A no-op
   * (no removal, no file, no pulse) when the policy selects nothing.
   */
  async evict(policy: EvictionPolicy, now: number = Date.now()): Promise<{ evicted: number[] }> {
    const ids = policy.select(this.#leafStore.summaries(), now);
    if (ids.length === 0) return { evicted: [] };
    this.#leafStore.remove(ids);
    this.#hydrateReactiveState();
    this.#invalidateTree();
    this.#appendEvicted(ids, now, policy.name);
    this.#emit({ kind: "prune", evictedLeafIds: ids, ts: now });
    return { evicted: ids };
  }

  /** Append evicted leaves to the audit log; skipped for the in-memory store. */
  #appendEvicted(ids: number[], now: number, reason: string): void {
    if (this.#leafStorePath === ":memory:" || this.#leafStorePath === "") return;
    const path = join(dirname(this.#leafStorePath), "fractal-evicted.jsonl");
    const body = ids.map((leafId) => JSON.stringify({ leafId, evictedAt: now, reason })).join("\n") + "\n";
    try {
      appendFileSync(path, body, "utf8");
    } catch (e) {
      this.#log?.(`fractal: evicted-log append failed (ignored): ${String(e)}`);
    }
  }

  /**
   * Cross-session dedup (PR-C C.3). Collapses leaves whose cosine similarity
   * >= mergeThreshold AND whose first_seen_at differ by >= spanThresholdMs.
   * Absorbed leaves are removed from the store; survivors get summed hit_count
   * and max last_seen_at. Emits a `prune` pulse with the absorbed ids.
   */
  async dedup(opts: { mergeThreshold?: number; spanThresholdMs?: number } = {}): Promise<{ groups: number }> {
    const { dedupAcrossSessions } = await import("./cross-session-dedup.ts");
    const records = this.#leafStore.all();
    const dedupLeaves = records.map((r) => ({
      id: r.id,
      text: r.text,
      first_seen_at: r.provenance.first_seen_at,
      last_seen_at: r.provenance.last_seen_at,
      hit_count: r.provenance.hit_count,
      vec: r.vec,
    }));
    const mergeThreshold = opts.mergeThreshold ?? Number(process.env.FERAL_FMS_MERGE_THRESHOLD ?? "0.92");
    const spanThresholdMs = opts.spanThresholdMs ?? Number(process.env.FERAL_FMS_DEDUP_SPAN_MS ?? String(30 * 24 * 60 * 60 * 1000));
    const groups = dedupAcrossSessions(dedupLeaves, {
      mergeThreshold,
      spanThresholdMs,
      now: Date.now(),
    });
    if (groups.length === 0) return { groups: 0 };
    const nextRecords = new Map(records.map((record) => [record.id, record]));
    for (const group of groups) {
      const record = records.find((r) => r.id === group.survivor.id);
      if (!record) continue;
      const provenance = {
        ...record.provenance,
        first_seen_at: group.survivor.first_seen_at,
        last_seen_at: group.survivor.last_seen_at,
        hit_count: group.survivor.hit_count,
      };
      nextRecords.set(record.id, {
        ...record,
        provenance,
      });
      this.#provenance.set(record.id, { ...provenance });
      for (const absorbed of group.absorbed) nextRecords.delete(absorbed.id);
    }
    const absorbedIds = groups.flatMap((g) => g.absorbed.map((l) => l.id));
    this.#leafStore.replaceAll([...nextRecords.values()]);
    this.#hydrateReactiveState();
    this.#invalidateTree();
    this.#appendEvicted(absorbedIds, Date.now(), "dedup");
    this.#emit({ kind: "prune", evictedLeafIds: absorbedIds, ts: Date.now() });
    return { groups: groups.length };
  }

  /**
   * Read-only snapshot of the tree's cluster + leaf summary — what
   * the MemoryGraph needs to mirror fact ↔ graph. Currently a thin
   * shape: cluster ids + summaries, leaf ids + first 80 chars of
   * their text. The graph's `reconcile(view)` upserts nodes only;
   * edges are derived from cluster membership at a later step.
   *
   * Cheap (no rebuild, no embedding). Safe to call on every
   * observation write.
   */
  treeView(): { clusters: Array<{ id: string; summary: string }>; leaves: Array<{ id: number; summary: string }> } {
    const clusters: Array<{ id: string; summary: string }> = [];
    if (this.#tree) {
      const walk = (node: TreeNode) => {
        if (node.level > 0) clusters.push({ id: node.id, summary: node.summary });
        for (const c of node.children) walk(c);
      };
      walk(this.#tree);
    }
    const leaves: Array<{ id: number; summary: string }> = [];
    const seen = new Set<number>();
    const collect = (l: Leaf) => {
      if (seen.has(l.id)) return;
      seen.add(l.id);
      leaves.push({ id: l.id, summary: l.text.slice(0, 80) });
    };
    for (const l of this.#cappedLeaves()) collect(l);
    return { clusters, leaves };
  }

  /**
   * Insert a single leaf, merging into the nearest existing one when their
   * cosine similarity meets `MERGE_THRESHOLD` (env-overridable, default
   * 0.92). Returns the activity kind that was emitted so callers can
   * log or forward without re-classifying.
   */
  async upsertLeaf(opts: {
    text: string;
    embedding: number[];
    provenance: {
      source: string;
      first_seen_at: number;
      sessionId: string;
      ts: number;
      key?: string;
      value?: string;
    };
  }): Promise<{ kind: "grow"; leafId: number } | { kind: "seed"; leafId: number }> {
    const threshold = readMergeThreshold();
    const key = provenanceKey(opts.text, opts.provenance.first_seen_at);

    // 1. Idempotency: same (text, first_seen_at) already inserted → reuse.
    if (this.#provenanceKeys.has(key)) {
      const existingId = [...this.#pendingLeaves.entries()].find(
        ([, l]) => l.text === opts.text,
      )?.[0];
      if (existingId !== undefined) {
        return { kind: "grow", leafId: existingId };
      }
    }

    // 2. Near-duplicate scan: nearest existing leaf by cosine.
    const nearest = this.#nearestByCosine(opts.embedding);
    if (nearest && nearest.sim >= threshold) {
      this.#mergeInto(nearest.entry, opts.provenance);
      this.#emit({
        kind: "seed",
        leafId: nearest.entry.sourceId,
        sessionId: opts.provenance.sessionId,
        ts: opts.provenance.ts,
      });
      return { kind: "seed", leafId: nearest.entry.sourceId };
    }

    // 3. Insert path — allocate inside the reactive owner namespace. The tree
    //    catalog maps it to a distinct internal id even if SQLite uses the same
    //    numeric source id.
    const embeddingVec = embeddingAsFloat32(opts.embedding);
    if (embeddingVec.length === 0) {
      // No model — degrade gracefully. Same return shape; no pulse, no bump.
      return { kind: "grow", leafId: -1 };
    }
    const newId = this.#nextLeafId();
    const leaf: Leaf = {
      id: newId,
      text: opts.text,
      vec: embeddingVec,
      ts: opts.provenance.ts,
      sessionId: opts.provenance.sessionId,
    };
    this.#pendingLeaves.set(newId, leaf);
    this.#provenance.set(newId, {
      first_seen_at: opts.provenance.first_seen_at,
      last_seen_at: opts.provenance.ts,
      hit_count: 1,
      source: opts.provenance.source,
      key: opts.provenance.key,
      value: opts.provenance.value,
    });
    this.#provenanceKeys.add(key);

    // Write the leaf through to the durable store (PR-C C.0) so it survives
    // restart and carries provenance for eviction/dedup.
    this.#leafStore.upsert({
      id: newId,
      text: opts.text,
      vec: Array.from(embeddingVec),
      ts: opts.provenance.ts,
      sessionId: opts.provenance.sessionId,
      provenance: {
        source: opts.provenance.source,
        first_seen_at: opts.provenance.first_seen_at,
        last_seen_at: opts.provenance.ts,
        hit_count: 1,
        key: opts.provenance.key,
        value: opts.provenance.value,
      },
    });

    this.#mutationSeq++;
    this.#emit({
      kind: "grow",
      leafCount: this.#pendingLeaves.size,
      clusterCount: 0,
      clusters: [],
    });
    return { kind: "grow", leafId: newId };
  }

  /** Scan pending + fresh loadLeaves() for the nearest cosine. */
  #nearestByCosine(embedding: number[]): { entry: CatalogLeaf; sim: number } | null {
    const target = embeddingAsFloat32(embedding);
    if (target.length === 0) return null;

    const candidates = this.#cappedCatalog();
    if (candidates.length === 0) return null;

    let best: { entry: CatalogLeaf; sim: number } | null = null;
    for (const entry of candidates) {
      if (entry.leaf.vec.length !== target.length) continue;
      const sim = cosineSafe(target, entry.leaf.vec);
      if (best === null || sim > best.sim) best = { entry, sim };
    }
    return best;
  }

  /** Bump hit_count + last_seen_at on a merged leaf. */
  #mergeInto(entry: CatalogLeaf, provenance: { ts: number; source: string; key?: string; value?: string; first_seen_at: number }): void {
    // Episodic ownership stays in SQLite. A reactive observation may match an
    // episodic row, but must never manufacture a same-id LeafStore record.
    if (entry.owner === "episodic") return;
    const leaf = sourceLeaf(entry);
    const existing = this.#provenance.get(entry.sourceId);
    if (existing) {
      existing.hit_count++;
      existing.last_seen_at = Math.max(existing.last_seen_at, provenance.ts);
    } else {
      this.#provenance.set(entry.sourceId, {
        first_seen_at: provenance.first_seen_at,
        last_seen_at: provenance.ts,
        hit_count: 2, // existing leaf had 1, this merge is the 2nd hit
        source: provenance.source,
        key: provenance.key,
        value: provenance.value,
      });
    }
    // Mirror the bumped provenance into the durable store (PR-C C.0) so
    // eviction/dedup see the current hit_count / last_seen_at.
    const prov = this.#provenance.get(entry.sourceId);
    if (prov) {
      this.#leafStore.upsert({
        id: entry.sourceId,
        text: leaf.text,
        vec: Array.from(leaf.vec),
        ts: leaf.ts,
        sessionId: leaf.sessionId,
        provenance: {
          source: prov.source,
          first_seen_at: prov.first_seen_at,
          last_seen_at: prov.last_seen_at,
          hit_count: prov.hit_count,
          key: prov.key,
          value: prov.value,
        },
      });
    }
  }

  /** Pick the next globally stable id above both episodic and reactive owners. */
  #nextLeafId(): number {
    const episodicMax = this.#loadLeaves().reduce((max, leaf) => Math.max(max, leaf.id), 0);
    return this.#leafStore.all().reduce((max, record) => Math.max(max, record.id), episodicMax) + 1;
  }

  /** Restore the in-memory reactive index from its durable owner store. */
  #hydrateReactiveState(): void {
    this.#pendingLeaves.clear();
    this.#provenance.clear();
    this.#provenanceKeys.clear();
    for (const rec of this.#leafStore.all()) {
      this.#pendingLeaves.set(rec.id, recordToLeaf(rec));
      this.#provenance.set(rec.id, { ...rec.provenance });
      this.#provenanceKeys.add(provenanceKey(rec.text, rec.provenance.first_seen_at));
    }
  }

  /** Route embedding write-back to the row's real owner. */
  #persistOwnedEmbeddings(
    rows: { id: number; vec: Float32Array }[],
    catalog: CatalogLeaf[],
  ): void {
    const owners = new Map(catalog.map((entry) => [entry.leaf.id, entry]));
    const reactive: { id: number; vec: Float32Array }[] = [];
    const episodic: { id: number; vec: Float32Array }[] = [];
    for (const row of rows) {
      const owner = owners.get(row.id);
      if (!owner) continue;
      const owned = { id: owner.sourceId, vec: row.vec };
      if (owner.owner === "reactive") reactive.push(owned);
      else episodic.push(owned);
    }
    this.#leafStore.setEmbeddings(reactive);
    if (episodic.length > 0) this.#persistEmbeddings?.(episodic);
  }
}

/** Provenance side-channel — keeps `Leaf` shape stable across writes. */
interface LeafProvenance {
  first_seen_at: number;
  last_seen_at: number;
  hit_count: number;
  source: string;
  key?: string;
  value?: string;
}

function catalogLeaf(owner: LeafOwner, leaf: Leaf): CatalogLeaf {
  return {
    owner,
    sourceId: leaf.id,
    leaf: { ...leaf },
  };
}

function abortableWork<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    work.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function sourceLeaf(entry: CatalogLeaf): Leaf {
  return { ...entry.leaf, id: entry.sourceId };
}

function recordToLeaf(rec: import("./leaf-store.ts").LeafRecord): Leaf {
  return {
    id: rec.id,
    text: rec.text,
    vec: new Float32Array(rec.vec),
    ts: rec.ts,
    sessionId: rec.sessionId,
  };
}

/** FNV-1a over identity-bearing fields; vectors are derived and excluded. */
function corpusFingerprint(leaves: Leaf[]): string {
  let h = 0x811c9dc5;
  const canonical = leaves
    .map((leaf) => `${leaf.id}\u0000${leaf.ts}\u0000${leaf.sessionId}\u0000${leaf.text}`)
    .join("\u0001");
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${leaves.length}:${h.toString(16)}`;
}

/** Compute the dedup key for a leaf insertion. Stable across runs. */
function provenanceKey(text: string, firstSeenAt: number): string {
  // FNV-1a 32-bit. Good enough for dedup; not for crypto.
  let h = 0x811c9dc5;
  const combined = `${text}\u0000${firstSeenAt}`;
  for (let i = 0; i < combined.length; i++) {
    h ^= combined.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Convert a number[] embedding to a Float32Array (unit-norm expected). */
function embeddingAsFloat32(values: number[]): Float32Array {
  if (values.length === 0) return new Float32Array(0);
  return new Float32Array(values);
}

/** Cosine for same-length Float32Arrays; returns 0 on length mismatch. */
function cosineSafe(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Read MERGE_THRESHOLD from env, falling back to 0.92. */
function readMergeThreshold(): number {
  const raw = process.env.FERAL_MERGE_THRESHOLD;
  if (!raw) return 0.92;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v > 1) return 0.92;
  return v;
}

/** One structured hit from {@link FractalMemory.query}. */
export interface FractalQueryHit {
  leafId: number;
  owner: LeafOwner;
  text: string;
}
