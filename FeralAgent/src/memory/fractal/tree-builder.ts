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
  for (const leaf of leaves) {
    if (leaf.vec && leaf.vec.length > 0 && leaf.vec.some((x) => x !== 0)) {
      leafById.set(leaf.id, leaf);
      continue;
    }
    if (!deps.embed) {
      throw new Error(
        `buildTree: leaf ${leaf.id} has no embedding and no embed() was provided in deps`,
      );
    }
    const [vec] = await deps.embed([leaf.text]);
    if (!vec) throw new Error(`buildTree: embed returned no vector for leaf ${leaf.id}`);
    leafById.set(leaf.id, { ...leaf, vec: normalize(vec) });
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

    // Build a parent per group.
    const parents: TreeNode[] = [];
    let pid = 0;
    for (const [, members] of groups) {
      const childTexts = members.map(textFor);
      const summary = await summarize(childTexts);
      parents.push({
        id: `L${level}-${pid++}`,
        level,
        centroid: normalizedMean(members.map((m) => m.centroid)),
        summary,
        children: members,
        leafIds: [...new Set(members.flatMap((m) => m.leafIds))].sort(
          (a, b) => a - b,
        ),
      });
    }
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
