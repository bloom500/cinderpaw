# MiniMax M3 Delegation Prompt — Fractal Memory Search (Phase 1: TS modules)

> Paste everything below the line to MiniMax M3. It is self-contained. Claude reviews
> each module after M3 commits it. M3 does NOT touch Rust, Tauri, or the build — only
> TypeScript under `FeralAgent/src/memory/fractal/`.

---

You are implementing the TypeScript modules of "Fractal Memory Search" for the Feral
agent (a Bun/TypeScript sidecar). You build a RAPTOR-like hierarchical memory index that
**augments** the existing FTS5 retrieval — you never replace or delete FTS5.

## Hard rules (violating any = rejected)

1. **Do NOT touch** Rust (`src-tauri/`), the build, `db.ts` schema, or `episodic.ts`'s
   FTS5 logic. TypeScript only, under `FeralAgent/src/memory/fractal/`.
2. **Do NOT delete or alter** `RecallEngine`, `memory_graph`, `memory_ops`, or FTS5. You
   ADD new modules. Integration into `RecallEngine` happens later, under review.
3. **TDD, one module at a time, in the given order.** For each module: write the Bun test
   first, run it (`bun test <path>`) to see it fail, implement, run to see it pass, then
   stop and report. Do not start the next module until told to continue.
4. **Pure where possible.** Modules B (cosine) and C (kmeans) are pure functions with no
   I/O. Test them with fixed inputs and exact expected outputs.
5. **The embedding backend is provided by Claude as a Tauri command `embed_text`.** It is
   NOT your job. In `embed.ts` you call it through the existing sidecar→Rust bridge. Until
   it lands, your tests for modules that need vectors use **hand-written fixed vectors**,
   never real embedding calls.
6. Match the existing code style in `FeralAgent/src/memory/` (2-space indent, `#private`
   fields, named exports, JSDoc headers). Read 2–3 existing files there first.
7. Every test must assert real behavior with concrete values. A test that only checks
   "did not throw" is rejected.

## Shared types — create `FeralAgent/src/memory/fractal/types.ts` FIRST

```ts
export interface Leaf {
  id: number;            // episodic row id
  text: string;
  vec: Float32Array;     // L2-normalized embedding
  ts: number;
  sessionId: string;
}
export interface TreeNode {
  id: string;
  level: number;             // 0 = leaf-cluster, increases toward root
  centroid: Float32Array;    // L2-normalized mean of children centroids
  summary: string;           // "" for a raw-leaf node
  children: TreeNode[];      // [] for leaf nodes
  leafIds: number[];         // all episodic ids under this node
}
export interface Hit { leafId: number; score: number; viaSummaryPath: string[] }
```

## Module B — `cosine.ts` (pure; do this first after types)

Signature: `export function cosine(a: Float32Array, b: Float32Array): number`
- Assume inputs are L2-normalized, so cosine = dot product. Throw if lengths differ.
- Test: `cosine([1,0],[1,0]) === 1`; `cosine([1,0],[0,1]) === 0`;
  `cosine([0.6,0.8],[0.6,0.8])` ≈ 1 (use `toBeCloseTo`); mismatched lengths throws.

## Module C — `kmeans.ts` (pure; deterministic)

Signature: `export function kmeans(points: Float32Array[], k: number, seed?: number): number[]`
- Returns an array `assignments` where `assignments[i]` is the cluster index (0..k-1) of
  `points[i]`. k-means++ initialization seeded by `seed` (default 1) using a small
  deterministic PRNG (mulberry32) so results are reproducible. Cap iterations at 50; stop
  early when no assignment changes. If `k >= points.length`, each point is its own cluster.
- Distance: use `1 - cosine(a,b)` (cosine distance), reusing Module B.
- Centroid update: mean of assigned points, then L2-normalize.
- Test with 6 clearly-separable 2D unit vectors in two groups, k=2: assert the two groups
  get distinct cluster ids and members of the same group share an id. Assert determinism:
  same seed → identical assignments across two calls.

## Module A — `embed.ts` (bridge; mock in tests)

Signature: `export function embed(texts: string[]): Promise<Float32Array[]>`
- Calls the Tauri command `embed_text` through the sidecar's existing Rust bridge (find how
  the sidecar already invokes Rust commands and reuse that exact mechanism — do NOT open a
  raw HTTP connection). Batches all `texts` in one call. Returns one L2-normalized
  `Float32Array` per input, in order.
- Cache by content hash (a `Map<string, Float32Array>`); never re-embed identical text.
- Test by injecting a fake bridge (dependency-inject the invoker, default to the real one)
  and asserting: batching, order preservation, and cache hit on repeat. Do NOT call real
  embeddings in tests.

## Module D — `summarize.ts` (uses existing InferenceRouter)

Signature: `export function summarizeCluster(items: string[], infer: InferFn): Promise<string>`
- `InferFn` is a narrow injected function `(prompt: string) => Promise<string>` so tests
  can mock it. In production it is wired to the existing `InferenceRouter` chat path (find
  it; do not add a new inference path). Prompt: a short fixed instruction to produce a
  ≤200-token thematic summary of the items. Trim and cap the output length.
- Test with a mock `infer` returning a known string; assert the prompt contains the items
  and the output is trimmed/capped. No real model calls.

## Module E — `tree-builder.ts` (uses A/B/C/D)

Signature: `export function buildTree(leaves: Leaf[], deps): Promise<TreeNode>`
where `deps = { embed, kmeans, summarize }` (inject for testing).
- Bottom-up RAPTOR: start with leaf nodes (level 0, `summary=""`, `centroid=leaf.vec`,
  `leafIds=[leaf.id]`). Repeat: if current level has ≤ `BRANCH` (e.g. 8) nodes, make them
  children of a single root and stop; else cluster the current level's centroids with
  `kmeans` (k = ceil(n / BRANCH)), summarize each cluster (concatenate child summaries or
  leaf texts), create parent nodes one level up, recurse.
- Each parent's `centroid` = L2-normalized mean of child centroids; `leafIds` = union of
  children's; `level` = childLevel + 1.
- Test with ~12 hand-built leaves (fixed vectors in 2–3 groups) and mocked
  `summarize`/`embed`; assert: a single root, root.leafIds covers all 12, levels increase,
  and clearly-separated groups end up under different intermediate parents.

## Module F — `tree-query.ts` (uses B)

Signature: `export function queryTree(qVec: Float32Array, tree: TreeNode, opts: { topK: number; beam: number }): Hit[]`
- Collapsed-tree / beam traversal: start at root's children; score each node by
  `cosine(qVec, node.centroid)`; keep the top `beam` nodes; descend into their children;
  repeat until reaching leaf nodes; collect leaf hits, score by cosine, return top `topK`
  sorted desc. `viaSummaryPath` = the summaries of the ancestor nodes traversed to reach
  each hit.
- Test with the tree from Module E's fixture and a query vector near one group; assert the
  returned hits are that group's leaves, sorted by score, length ≤ topK, and
  `viaSummaryPath` is non-empty.

## Module G — `fractal-recall.ts` (orchestration; hybrid with FTS5)

Signature:
```ts
export class FractalRecallEngine {
  constructor(deps: { tree: TreeNode; embed: EmbedFn; ftsSearch: (q: string, limit: number) => EpisodicEvent[] });
  recall(query: string, sessionId: string): Promise<RecallResult>;
}
```
- `RecallResult` must match the existing shape in `recall.ts`
  (`{ context: string; episodicHits: number; semanticFacts: number }` — read the real
  file and mirror it exactly).
- Flow: embed the query → `queryTree` for semantic hits → `ftsSearch` for exact hits →
  merge & dedupe by leafId → re-rank (semantic score + a boost for FTS5 presence) → format
  the same `[Memory context] … [End memory context]` block the current `RecallEngine`
  produces. Exclude the current session like the existing engine does.
- Test with a mocked `ftsSearch` and the fixture tree + mocked `embed`; assert the merged
  block contains both an FTS5-only hit and a semantic-only hit, deduped, current session
  excluded.

## After all 7 modules

Stop and report. Do NOT wire `FractalRecallEngine` into the live `RecallEngine` or touch
the `memory_graph`/`memory_ops` tools yet — that integration + the benchmark harness is a
separate, reviewed step.

## Report format (after EACH module)

- Module letter + file path
- The Bun test command you ran and its RED then GREEN output
- The exact public signature you implemented
- Anything you were unsure about (ask rather than guess)

Then stop and wait for "continue" before the next module.
