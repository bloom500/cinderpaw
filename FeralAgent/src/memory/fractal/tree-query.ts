/**
 * Module F — collapsed-tree / beam traversal.
 *
 * Given a query vector, walks the RAPTOR tree top-down, keeping only the
 * top-`beam` nodes at each level by cosine similarity to the query. At the
 * leaf level we score every surviving leaf, sort descending, and return
 * the top `topK`. Each hit records the chain of ancestor summaries that
 * were traversed to reach it (`viaSummaryPath`) — that's the "collapsed
 * tree" abstraction: the LLM never sees the tree, only the path that
 * justified each hit.
 *
 * Cost is O(beam · log_branch(N)) node visits plus O(topK) leaf scoring —
 * far cheaper than scoring every leaf, and the beam keeps recall high as
 * long as `beam` is at least 2–4. The cap on `beam` is the primary
 * control on tail latency.
 *
 * Pure — only depends on Module B (`cosine`). No I/O, no async.
 */
import { cosine } from "./cosine.ts";
import type { Hit, TreeNode } from "./types.ts";

export interface QueryTreeOpts {
  /** Maximum hits returned. */
  topK: number;
  /** Number of nodes kept per level during the descent. */
  beam: number;
}

/** A node on the frontier together with the summaries of every ancestor
 *  we traversed to reach it. Internal to the traversal. */
interface Front {
  node: TreeNode;
  path: string[];
}

export function queryTree(
  qVec: Float32Array,
  tree: TreeNode,
  opts: QueryTreeOpts,
): Hit[] {
  // Seed the frontier with the root's children. The path starts with the
  // root's own summary so the first hit already carries the apex context.
  let frontier: Front[] = tree.children.map((child) => ({
    node: child,
    path: [tree.summary],
  }));

  // Descend level by level. At each step we:
  //   1. expand every non-leaf entry into ITS children (path extended)
  //   2. carry any leaf entry forward unchanged
  //   3. score the union by cosine to the query
  //   4. keep the top `beam` entries globally (NOT per-parent — that's
  //      the whole point of beam search)
  while (frontier.some((f) => f.node.children.length > 0)) {
    const expanded: Front[] = [];
    for (const f of frontier) {
      if (f.node.children.length === 0) {
        expanded.push(f);
        continue;
      }
      for (const child of f.node.children) {
        expanded.push({ node: child, path: [...f.path, f.node.summary] });
      }
    }
    // Score once per node, then sort the scores. The comparator used to call
    // `cosine` twice per comparison, so a 100-node frontier at 1024 dimensions
    // spent ~1.4M multiply-adds on ONE level of the descent — repeated at every
    // level, in the hot path of the very recall whose speed is the argument for
    // having this tree at all.
    const scored = expanded.map((f) => ({ f, score: cosine(qVec, f.node.centroid) }));
    scored.sort((a, b) => b.score - a.score);
    frontier = scored.slice(0, opts.beam).map((x) => x.f);
  }

  // Frontier is now all leaves (or empty for an empty root). Score, sort, top-K.
  const hits: Hit[] = frontier
    .map((f) => ({
      leafId: f.node.leafIds[0]!,
      score: cosine(qVec, f.node.centroid),
      viaSummaryPath: f.path,
    }))
    .sort((a, b) => b.score - a.score);

  return hits.slice(0, opts.topK);
}
