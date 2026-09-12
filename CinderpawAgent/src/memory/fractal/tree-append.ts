/**
 * Module E2 — incremental append, so a new memory is findable now.
 *
 * `rebuildIfStale` only rebuilds once the corpus has grown 20% past what the
 * tree covers. At 2700 leaves that is 540 new memories before the 541st is
 * routable, and until then the semantic path cannot see any of them. FTS5
 * still matches them lexically, so the failure is quiet and shaped like a bad
 * retriever: ask about this morning's work in your own words rather than its
 * words, and the tree has never heard of it.
 *
 * The rebuild is deferred for a real reason — it re-clusters everything AND
 * re-summarises every cluster through the model, which is `project_fractal_
 * bench_blockers.md` Blocker #2, "CPU: rebuild thrashing on 2697 leaves".
 * MemORAI (arXiv 2605.01386) names this as the structural cost of tree
 * retrieval and answers it by appending nodes without re-encoding what is
 * already there. This is that, for our tree.
 *
 * **Why it is safe to skip the summaries.** `tree-query.ts` scores every node
 * with `cosine(qVec, node.centroid)` and nothing else. Summaries are carried
 * along the descent as `viaSummaryPath` context strings and never influence
 * which branch is taken. So an appended leaf is routed on exactly the same
 * signal as a rebuilt one; what goes stale is the prose a hit is annotated
 * with, not the retrieval. That is the whole reason this can be cheap: the
 * expensive half of a rebuild is the half routing does not read.
 *
 * Pure — depends only on `cosine`. No I/O, no async, no model.
 */

import { cosine } from "./cosine.ts";
import type { TreeNode } from "./types.ts";

/** Raw leaves are level 0 with no children; every cluster is level >= 1. */
const LEAF_LEVEL = 0;

/**
 * L2-normalize in place and return. A zero vector is left alone rather than
 * producing NaNs: it cannot be routed to either way, and a NaN centroid would
 * poison every comparison in its subtree.
 */
function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0 || !Number.isFinite(norm)) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

/**
 * Fold one more vector into a centroid that is the normalized mean of `count`
 * vectors.
 *
 * ponytail: approximate, deliberately. The exact update needs the mean BEFORE
 * normalization, and the tree only stores it after, so the magnitude — which
 * carries how tightly the cluster agrees with itself — is gone. Treating the
 * stored centroid as the mean's direction and re-weighting by `count` is the
 * standard streaming approximation and is exact when the children already
 * point the same way. The error accumulates with each append, and the periodic
 * full rebuild is what clears it; if drift ever shows up in the benchmark,
 * the upgrade is to store the unnormalized sum alongside the centroid.
 */
function foldIn(centroid: Float32Array, count: number, vec: Float32Array): Float32Array {
  const out = new Float32Array(centroid.length);
  for (let i = 0; i < out.length; i++) out[i] = centroid[i]! * count + vec[i]!;
  return normalize(out);
}

export interface AppendResult {
  /** False when the tree could not take the leaf; the caller should rebuild. */
  ok: boolean;
  /** Ids of the clusters whose centroid moved, root last. Empty when !ok. */
  touched: string[];
  /** Why it was refused, for the log. Absent on success. */
  reason?: string;
}

/**
 * Attach one leaf to an existing tree, mutating it in place.
 *
 * Descends greedily from the root, taking the nearest child centroid at each
 * level, until it reaches a cluster whose children are raw leaves; the leaf
 * joins there. Greedy and not beam search on purpose: this runs on the write
 * path, a wrong-but-near cluster still puts the leaf within reach of a query
 * that lands nearby, and the next full rebuild re-clusters it properly
 * anyway. Being findable in roughly the right place beats being invisible in
 * exactly the right one.
 *
 * Returns `ok: false` rather than throwing for every shape it cannot handle,
 * because the caller's fallback — leave it to the next rebuild — is what the
 * system did before this module existed, and a write must never fail because
 * an index could not be updated.
 */
export function appendLeaf(tree: TreeNode, leafId: number, vec: Float32Array): AppendResult {
  if (tree.children.length === 0) {
    return { ok: false, touched: [], reason: "tree has no clusters yet" };
  }
  if (vec.length !== tree.centroid.length) {
    // A dimension change means the embedding model changed under us. Routing
    // across two models is meaningless, and a rebuild is the correct answer.
    return {
      ok: false,
      touched: [],
      reason: `vector is ${vec.length}d, tree is ${tree.centroid.length}d (embedding model changed?)`,
    };
  }
  if (tree.leafIds.includes(leafId)) {
    return { ok: false, touched: [], reason: `leaf ${leafId} is already in the tree` };
  }

  // Descend to the cluster that will hold the raw leaf.
  const path: TreeNode[] = [tree];
  let node = tree;
  while (node.children.length > 0 && node.children.some((c) => c.level > LEAF_LEVEL)) {
    let best = node.children[0]!;
    let bestScore = -Infinity;
    for (const child of node.children) {
      // Skip raw leaves in a mixed level: they cannot hold children.
      if (child.level === LEAF_LEVEL) continue;
      const score = cosine(vec, child.centroid);
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    node = best;
    path.push(node);
  }

  node.children.push({
    id: `L0-${leafId}`,
    level: LEAF_LEVEL,
    centroid: vec,
    summary: "",
    children: [],
    leafIds: [leafId],
  });

  // Centroids and leaf sets, root included. `leafIds.length` is the count the
  // centroid is a mean over, so it is read BEFORE the new id is pushed.
  for (const ancestor of path) {
    ancestor.centroid = foldIn(ancestor.centroid, ancestor.leafIds.length, vec);
    ancestor.leafIds.push(leafId);
  }

  return { ok: true, touched: path.map((n) => n.id) };
}
