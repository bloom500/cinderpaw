/**
 * Module E — bottom-up RAPTOR tree builder.
 *
 * Takes a flat list of `Leaf`s (each carrying its own L2-normalized
 * embedding) and produces a `TreeNode` whose:
 *   - leaves (level 0) wrap raw episodic events
 *   - intermediates are k-means clusters whose centroid is the
 *     L2-normalized mean of their children, summarized by the existing
 *     `summarizeCluster` against the children's text/summaries
 *   - root is the apex; its children are whatever the loop's final level
 *     produced (a level that fits in `BRANCH`).
 *
 * Dependency injection: `Deps` carries `kmeans` + `summarize` (and an
 * optional `embed` fallback for leaves that arrive text-only). Tests
 * inject mocks; production reuses the real implementations.
 *
 * Why deterministic clustering matters: the spec for Module C uses
 * mulberry32 with a fixed seed, and this builder calls kmeans with seed
 * 1. A snapshot rebuild therefore always produces the same tree for the
 * same leaves — required for the persistence + replay path.
 */
import type { Leaf, TreeNode } from "./types.ts";
import { kmeans as defaultKmeans } from "./kmeans.ts";

/** Max children per parent. Tweakable; spec recommends ~8. */
const BRANCH = 8;
/**
 * Leaves are embedded in chunks of this size — ONE bridge roundtrip to Rust
 * per chunk, not one per leaf. A corpus of thousands of leaves embedded
 * one-at-a-time (each its own stdin/stdout roundtrip) never finished before a
 * restart; batching makes the first tree build tractable.
 *
 * Kept small (32) because the bridge response carries the WHOLE chunk's
 * vectors as one JSON line (chunk × 384 floats): at 128 that line was ~0.5 MB
 * and the request/response round-trip deadlocked mid-build (the response came
 * back to the sidecar with a dropped id → the embed Promise never resolved).
 * A smaller chunk keeps each line well within pipe limits. Override with
 * FERAL_EMBED_CHUNK for tuning/diagnosis.
 */
const EMBED_CHUNK = (() => {
  const n = Number(process.env.FERAL_EMBED_CHUNK);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 32;
})();
/**
 * Cluster summaries run through the inference router (cloud or local). A wide
 * corpus produces hundreds of parent nodes; awaiting them one-by-one made the
 * build take ~15 min. Run a bounded number concurrently — fast without
 * hammering the provider's rate limit.
 */
const SUMMARIZE_CONCURRENCY = 6;

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

/** Seed for `kmeans` — fixed for reproducible snapshot rebuilds. */
const KMEANS_SEED = 1;

export interface BuildTreeDeps {
  /** Optional fallback for leaves that arrive without an embedding. */
  embed?: (texts: string[]) => Promise<Float32Array[]>;
  /** Injectable for tests; defaults to the real `kmeans`. */
  kmeans?: (points: Float32Array[], k: number, seed?: number) => number[];
  /**
   * REQUIRED: a 1-arg summarize wrapper. The bare `summarizeCluster`
   * takes an `InferFn` argument; production should bind it (via
   * `summarizeFromRouter(router)` from `./summarize.ts`) and pass the
   * resulting 1-arg function here. There is no default because
   * `buildTree` doesn't have access to the router.
   */
  summarize: (items: string[]) => Promise<string>;
  /**
   * Optional override for the per-parent branching cap. Defaults to 8.
   * Tests use a smaller cap (e.g. 4) to exercise multi-level trees with
   * fewer leaves; production never sets this.
   */
  branch?: number;
  /**
   * Called after each chunk of leaves is embedded so callers can persist
   * the vectors back to their store (typically SQLite, via
   * `EpisodicMemory.setEmbeddings`). Per-chunk rather than once-at-the-end
   * so a crash mid-build only re-pays the embedding cost for the last
   * chunk, not the whole corpus. Optional — when omitted, vectors live
   * only in memory and the next rebuild re-embeds everything.
   */
  persistEmbeddings?: (rows: { id: number; vec: Float32Array }[]) => void;
}

/** L2-normalize a Float32Array in place; returns it for chaining. */
function normalize(v: Float32Array): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += v[i]! * v[i]!;
  if (sq <= 0) return v;
  const inv = 1 / Math.sqrt(sq);
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return v;
}

/** L2-normalized mean of a list of equal-length vectors. */
function normalizedMean(vecs: Float32Array[]): Float32Array {
  if (vecs.length === 0) return new Float32Array(0);
  const dim = vecs[0]!.length;
  const sum = new Float32Array(dim);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
  }
  for (let i = 0; i < dim; i++) sum[i]! /= vecs.length;
  return normalize(sum);
}

/**
 * Build a fresh hierarchical tree from `leaves`. The output is a single
 * root `TreeNode`. Each non-leaf node carries a summary produced by
 * `summarize` over its children's text/summary strings; each leaf-level
 * node has `summary = ""` (the raw leaf text lives in `leafIds[i]`).
 *
 * Throws on empty input (caller error — there is nothing to cluster).
 */
export async function buildTree(
  leaves: Leaf[],
  deps: BuildTreeDeps,
): Promise<TreeNode> {
  const kmeans = deps.kmeans ?? defaultKmeans;
  const summarize = deps.summarize;
  const branch = deps.branch ?? BRANCH;

  if (leaves.length === 0) {
    throw new Error("buildTree: leaves array is empty");
  }

  // Embed any leaf whose `vec` is missing or zero-length. In the common
  // case (snapshots loaded from SQLite) all leaves arrive pre-embedded
  // and `embed` is never called.
  const leafById = new Map<number, Leaf>();
  const needEmbed: Leaf[] = [];
  for (const leaf of leaves) {
    if (leaf.vec && leaf.vec.length > 0 && leaf.vec.some((x) => x !== 0)) {
      leafById.set(leaf.id, leaf);
    } else {
      needEmbed.push(leaf);
    }
  }
  if (needEmbed.length > 0) {
    if (!deps.embed) {
      throw new Error(
        `buildTree: leaf ${needEmbed[0]!.id} has no embedding and no embed() was provided in deps`,
      );
    }
    // Batch the embed calls — one roundtrip per chunk, never one per leaf.
    for (let i = 0; i < needEmbed.length; i += EMBED_CHUNK) {
      const chunk = needEmbed.slice(i, i + EMBED_CHUNK);
      const vecs = await deps.embed(chunk.map((l) => l.text));
      if (vecs.length !== chunk.length) {
        throw new Error(
          `buildTree: embed returned ${vecs.length} vectors for ${chunk.length} texts`,
        );
      }
      // Normalized vectors + matching ids, paired up for the persist hook.
      // Normalize here once so the caller doesn't have to redo it, and so
      // what's stored on disk matches what the tree uses for clustering.
      const persistBatch: { id: number; vec: Float32Array }[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const rawVec = vecs[j];
        if (!rawVec) throw new Error(`buildTree: embed returned no vector for leaf ${chunk[j]!.id}`);
        const vec = normalize(rawVec);
        leafById.set(chunk[j]!.id, { ...chunk[j]!, vec });
        persistBatch.push({ id: chunk[j]!.id, vec });
      }
      // Fire-and-await: persistEmbeddings wraps its own transaction. If the
      // hook throws we propagate — losing durability mid-build is worse
      // than failing loudly, because the next run would silently re-embed
      // everything and double the inference cost.
      deps.persistEmbeddings?.(persistBatch);
    }
  }

  // Level 0 — raw leaves wrapped as tree nodes.
  let current: TreeNode[] = leaves.map((leaf) => ({
    id: `L0-${leaf.id}`,
    level: 0,
    centroid: leafById.get(leaf.id)!.vec,
    summary: "",
    children: [],
    leafIds: [leaf.id],
  }));

  // The "what to summarize" text for a node:
  //   - raw leaf node: the leaf's original text
  //   - any other node: its summary
  const textFor = (node: TreeNode): string => {
    if (node.children.length === 0) {
      return leafById.get(node.leafIds[0]!)?.text ?? "";
    }
    return node.summary;
  };

  // Bottom-up loop. Exit when the current level fits in `branch`; then wrap
  // it in one root.
  let level = 0;
  while (current.length > branch) {
    level++;
    const centroids = current.map((n) => n.centroid);
    const k = Math.ceil(current.length / branch);
    const assignments = kmeans(centroids, k, KMEANS_SEED);

    // Group current-level nodes by cluster id.
    const groups = new Map<number, TreeNode[]>();
    for (let i = 0; i < current.length; i++) {
      const c = assignments[i]!;
      let bucket = groups.get(c);
      if (!bucket) {
        bucket = [];
        groups.set(c, bucket);
      }
      bucket.push(current[i]!);
    }

    // Build a parent per group. Summaries run with bounded concurrency;
    // group order is preserved so node ids stay deterministic.
    const groupList = [...groups.values()];
    const summaries = await mapLimit(groupList, SUMMARIZE_CONCURRENCY, (members) =>
      summarize(members.map(textFor)),
    );
    const parents: TreeNode[] = groupList.map((members, pid) => ({
      id: `L${level}-${pid}`,
      level,
      centroid: normalizedMean(members.map((m) => m.centroid)),
      summary: summaries[pid]!,
      children: members,
      leafIds: [...new Set(members.flatMap((m) => m.leafIds))].sort((a, b) => a - b),
    }));
    current = parents;
  }

  // Wrap whatever fits in BRANCH under one root.
  level++;
  const rootTexts = current.map(textFor);
  const rootSummary = await summarize(rootTexts);
  const root: TreeNode = {
    id: "root",
    level,
    centroid: normalizedMean(current.map((m) => m.centroid)),
    summary: rootSummary,
    children: current,
    leafIds: [...new Set(current.flatMap((m) => m.leafIds))].sort(
      (a, b) => a - b,
    ),
  };
  return root;
}
