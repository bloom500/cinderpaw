/**
 * Shared types for the Fractal Memory Search backend.
 *
 * A RAPTOR-like hierarchical memory index that augments (never replaces) the
 * existing FTS5 retrieval: leaves carry raw episodic events with embeddings,
 * parents carry cluster centroids and thematic summaries, and the root sits
 * at the top of the abstraction ladder.
 *
 * Module map (built in dependency order, see the M3 delegation plan):
 *   - A embed         thin bridge to the Phase-0 Rust `embed_text` command
 *   - B cosine        pure: L2-normalized dot product (this file's consumers)
 *   - C kmeans        pure: deterministic k-means++ over Float32Arrays
 *   - D summarize     uses the existing InferenceRouter to caption a cluster
 *   - E tree-builder  bottom-up RAPTOR: kmeans → summarize → recurse → root
 *   - F tree-query    collapsed-tree / beam traversal
 *   - G fractal-recall orchestrator: hybrid semantic + FTS5 re-rank
 */

/** A raw episodic event embedded as a leaf in the fractal tree. */
export interface Leaf {
  /** Episodic row id (matches `episodic.id` in SQLite). */
  id: number;
  /** Original event text — used to feed the cluster summarizer. */
  text: string;
  /** L2-normalized embedding; `cosine(a, b)` is just a dot product. */
  vec: Float32Array;
  /** Event timestamp (ms since epoch, matches `episodic.timestamp`). */
  ts: number;
  /** Session that produced the event — used to filter the current session. */
  sessionId: string;
}

/** A node in the RAPTOR tree. Leaves wrap raw `Leaf`s; parents wrap children. */
export interface TreeNode {
  /** Stable id — synthetic string, unique within a tree. */
  id: string;
  /** 0 = leaf-cluster level, increases toward the root. */
  level: number;
  /** L2-normalized mean of children centroids (or the leaf vector at level 0). */
  centroid: Float32Array;
  /** Thematic summary of the cluster; "" for raw-leaf nodes. */
  summary: string;
  /** Children — empty for leaves. */
  children: TreeNode[];
  /** Every collision-free catalog id that sits under this node (union of children). */
  leafIds: number[];
}

/** A single retrieval hit produced by `queryTree`. */
export interface Hit {
  /** The leaf id the hit resolves to. */
  leafId: number;
  /** Cosine similarity between the query vector and the leaf's path. */
  score: number;
  /** Summaries of the ancestor nodes traversed to reach this hit. */
  viaSummaryPath: string[];
}
