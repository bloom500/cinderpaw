# Fractal Memory Search + Living Mandelbrot Organism — Design Spec

**Date:** 2026-06-20
**Status:** Approved direction (Option 2 — embeddings prerequisite + hybrid retrieval)
**Owner split:** Rust/infra prerequisites = Darius/Claude; TS modules + organism viz = MiniMax M3 (Claude reviews/fixes)

## Problem & Decision

The "Fractal Memory" Mandelbrot shipped as a **visualization only** — it displays the
memory graph but plays no role in retrieval, and at the default zoomed-out view with
~200 nodes it reads as a static classic Mandelbrot. Two decisions:

1. **Make the fractal functional, not decorative.** "Fractal Memory Search" becomes a
   real hierarchical (RAPTOR-like) retrieval backend that *augments* the existing FTS5
   recall. The visualization then reflects the actual state of that backend.
2. **Drop filament text; grow a pure-form organism.** The text-on-filaments approach
   has unsolved LOD/density problems at 200 nodes and hides the payoff behind deep
   zoom. Replace it with a procedurally-growing Mandelbrot organism (no text) fed by
   memory/retrieval events.

### Verified ground truth (do NOT build on the earlier false premises)

- **There are NO embeddings anywhere.** Grep of `FeralAgent/src` and `src-tauri/src`
  for `embed|vector|cosine|n_embd|llama_embed` finds only "embedded" (bundled SOUL.md)
  and a KV-cache cost comment. Current retrieval = FTS5 lexical (`episodic.ts`),
  key-value semantic facts (`semantic.ts`), graph triples (`graph.ts`), assembled by
  `RecallEngine` (`recall.ts`) and injected pre-inference.
- **llama.cpp runs in-process via `llama-cpp-2` FFI bindings** (`Cargo.toml:51`,
  `inference.rs`), NOT as `llama-server`. There is no llama.cpp HTTP server.
- **Port 11435 is Feral's own Ollama-compatible Axum API** (`api.rs`) exposing
  `/api/chat`, `/v1/chat/completions`, `/v1/models`, `/tokenize` — **no `/v1/embeddings`**.
  `curl /v1/embeddings` → 404.

**Consequence:** embeddings must be added as a real (bounded) Rust prerequisite —
`llama-cpp-2` supports embeddings (`LlamaContextParams::with_embeddings(true)` +
`embeddings_seq()`), so the work is: an embedding context in `inference.rs`, a Tauri
command (+ optional `/v1/embeddings` route), a bundled embedding GGUF, a SQLite
embedding column, and a one-shot backfill. Estimate: ~1–2 days of Rust/infra.

## Non-Negotiable Principles

- **Augment, never replace FTS5.** FTS5 stays as the permanent leaf-level exact-match
  layer. Embeddings + RAPTOR tree are added as higher layers. Hybrid re-rank at query
  time. This makes regression structurally impossible: exact-match queries still hit
  FTS5; only semantic/multi-hop queries gain.
- **`memory_graph` / `memory_ops` tools are NOT removed.** They become thin facades
  over the new query API (backward compatibility for prompts/skills). They are the
  agent's correct, current memory tools — the fractal does not replace them.
- **Benchmark gate before declaring "replaced."** Measure `recall@10` and p99 latency
  on ≥50 real queries from history vs. flat FTS5. Ship only if fractal ≥ FTS5. Target:
  p99 < 80 ms on 10k memories. If fractal loses on exact matches, FTS5 already covers it.
- **Local-first, zero recurring cost.** Embedding model is a bundled local GGUF
  (`bge-small-en-v1.5.Q8_0` ≈ 130 MB, or `nomic-embed-text-v1.5.Q8_0` ≈ 270 MB) — free,
  no API calls. Cloud embeddings are an optional BYOK fallback, never the default.
- **No idle/auto animation in the organism** (inherits the existing constraint): growth
  and breathing are driven by discrete events + user actions, and any transition
  self-terminates.

## Architecture

```
Query
  │
  ▼
FractalRecallEngine (NEW, replaces RecallEngine internals; same inject contract)
  1. embed(query) → vector                          (Phase 0 IPC)
  2. traverse RAPTOR tree top-down → relevant clusters
  3. at leaf level: FTS5 hybrid (exact + semantic)   (existing FTS5, untouched)
  4. combined re-rank
  5. format block, inject pre-inference              (same as today's recall())
        │                          │
        ▼                          ▼
   RAPTOR tree (NEW)          FTS5 index (EXISTING, untouched)
   leaves = episodic chunks   exact-match leaf retrieval
   + embeddings + summaries

memory_graph / memory_ops  ──facade──▶ fractalQuery({ depth, pattern, limit })
```

### Phase 0 — Embeddings infrastructure (Rust/infra; NOT M3)

- **`inference.rs`**: add an embedding context path using `llama-cpp-2` with
  `with_embeddings(true)`; load a dedicated embedding GGUF (separate from the chat
  model); expose `embed_batch(texts: Vec<String>) -> Vec<Vec<f32>>` (mean-pooled,
  L2-normalized). Run on `spawn_blocking` like existing inference.
- **Command/route**: a Tauri command `embed_text(texts: string[]) -> number[][]` AND/OR
  a `POST /v1/embeddings` Axum route in `api.rs` (OpenAI-shaped:
  `{ data: [{ embedding: number[] }] }`). The Tauri command is the primary path the
  sidecar uses; the HTTP route is optional parity.
- **Bundled model**: ship `bge-small-en-v1.5.Q8_0.gguf` in `src-tauri/binaries/` (or the
  models dir), wired into the build. Document the download source + checksum.
- **Schema**: `ALTER TABLE episodic ADD COLUMN embedding BLOB` (Float32 little-endian).
  One-shot backfill script embeds all existing rows in batches.
- **Sidecar bridge**: the TS `embed.ts` (Module A) calls the Tauri command via the
  existing sidecar↔Rust channel (NOT a raw HTTP call), matching how the sidecar already
  invokes inference.

### Modules 1 (retrieval, TS — M3) — `FeralAgent/src/memory/fractal/`

Each module is independently testable (Bun test) with a precise interface. Built in
dependency order:

| Module | File | Signature | Notes |
|---|---|---|---|
| A. embed | `embed.ts` | `embed(texts: string[]): Promise<Float32Array[]>` | thin bridge to the Phase-0 IPC; batched; caches by content hash |
| B. cosine | `cosine.ts` | `cosine(a: Float32Array, b: Float32Array): number` | pure; assumes L2-normalized inputs (dot product) |
| C. kmeans | `kmeans.ts` | `kmeans(points: Float32Array[], k: number, seed?: number): number[]` | returns cluster index per point; k-means++ init; deterministic with seed; bounded iters |
| D. summarize | `summarize.ts` | `summarizeCluster(items: string[]): Promise<string>` | calls the existing `InferenceRouter` with a short fixed prompt; ≤200-token summary |
| E. tree-builder | `tree-builder.ts` | `buildTree(leaves: Leaf[]): Promise<TreeNode>` | bottom-up: embed → kmeans → summarize each cluster → recurse until root; uses C+D |
| F. tree-query | `tree-query.ts` | `queryTree(qVec: Float32Array, tree: TreeNode, opts): Hit[]` | collapsed-tree traversal; scores nodes by cosine; returns leaf hits + the abstraction path |
| G. fractal-recall | `fractal-recall.ts` | `class FractalRecallEngine` | orchestrates F + FTS5 hybrid re-rank; exposes the SAME `recall(query, sessionId): RecallResult` contract as today's `RecallEngine` |

Plus facades:
- `memory_graph` / `memory_ops` tool handlers call `fractalQuery({...})` instead of (or
  in addition to) their current direct graph/semantic ops, preserving their output shape.

**Types (shared, define once in `fractal/types.ts`):**
```ts
interface Leaf { id: number; text: string; vec: Float32Array; ts: number; sessionId: string }
interface TreeNode {
  id: string;
  level: number;                 // 0 = leaf cluster, increasing toward root
  centroid: Float32Array;
  summary: string;               // "" for raw leaves
  children: TreeNode[];          // empty for leaves
  leafIds: number[];             // episodic rows under this node
}
interface Hit { leafId: number; score: number; viaSummaryPath: string[] }
```

**Persistence:** the tree is rebuilt incrementally — new leaves attach to the nearest
existing cluster; a full re-cluster runs offline/periodically, never at query time.
Store the tree as JSON (or a `fractal_tree` table) keyed by a build version.

### Module 2 (living organism viz, frontend — M3) — `frontend-react/src/components/memory/`

Evolves the just-shipped fractal (branch `feat/rsi-fractal-memory`). **Removes** the
`FilamentText` text-rendering path; keeps the WebGL2 Mandelbrot renderer and the
user-driven transition machinery.

- **`iteration_depth`** counter = completed RSI sessions + (new memories ingested / K).
  Drives shader iteration depth so structure visibly grows from the first dozen memories
  (tune K and the depth curve so ~30 memories already shows clear filament growth — the
  v1 mapping was too conservative).
- **Filament growth**: branch length ∝ depth of the corresponding RAPTOR subtree; new
  ingest → new leaf → a filament extends from its parent cluster's complex-plane position.
- **Mini-brot spawn**: when a RAPTOR cluster becomes terminal (converged topic), a
  mini-Mandelbrot renders at that cluster's complex-plane coordinate.
- **Cluster → complex-plane mapping**: `Re = norm(centroid_x)`, `Im = norm(centroid_y)`
  via a fixed deterministic projection (e.g. first 2 PCA components or a hash) so the
  same cluster always lands in the same place — the organism grows consistently.
  **NOTE:** the RAPTOR tree and the Mandelbrot set are *two different fractals* bridged by
  this deterministic coordinate map — not the same mathematical object. The map is an
  artistic placement, not a derivation.
- **Breathing**: a morph oscillation (~0.3 Hz, noise+sine on GPU) localized to regions
  with recent query-traversal activity; idle regions stay static. This is the only
  continuous motion and it is gated on activity (no activity → no motion), preserving the
  no-idle-animation spirit (motion ⇔ the agent is actively recalling).
- **Coupling (the part that was missing)**: growth is fed by **FractalMemorySearch
  events**, not RSI:
  - new-memory ingest → new leaf → filament grows from parent
  - active query traversal → breathing focuses on the traversed region
  - terminal cluster → mini-brot
  - RSI event (if/when emitted) → short whole-organism pulse (bonus, optional)

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Embedding inference adds latency to recall | Med | embed only the query at recall time (1 vector); tree built offline; cache leaf vectors in SQLite |
| Query latency p99 regresses | Med | benchmark gate (p99 < 80 ms @ 10k); collapsed-tree traversal (HLTM-style); FTS5 stays fast path |
| Lost exact matches on technical terms | Med-High | FTS5 remains leaf layer; fractal traversal seeds from FTS5 hits; hybrid re-rank |
| Offline clustering costly at 100k+ | Med | incremental attach at ingest; full re-cluster periodic, not per-query |
| `llama-cpp-2` embedding path harder than expected | Med | spike the Rust embedding context first; if blocked, fall back to BYOK `/embeddings` (flagged cost) until the local path lands |
| Agent "forgets" vs. FTS5 | High if FTS5 deleted | DO NOT delete FTS5 — keep ≥2 releases as leaf fallback |
| M3 produces wrong/untested code | High (weak model) | per-module spec + Bun tests + Claude review of each module, not at the end |

## Phasing

- **Phase 0 (Rust/infra — Claude):** embedding context in `inference.rs`, `embed_text`
  command + optional `/v1/embeddings`, bundle `bge-small` GGUF, SQLite embedding column +
  backfill. Verify with a direct embed call on real data.
- **Phase 1 (TS — M3):** modules A→G in dependency order, each with tests + review.
- **Phase 2 (TS — M3):** `memory_graph`/`memory_ops` facades over `fractalQuery`;
  benchmark harness (recall@10 + p99 vs FTS5).
- **Phase 3 (frontend — M3):** organism growth engine (iteration_depth, filament growth,
  mini-brot spawn, cluster→plane map); remove `FilamentText` text path.
- **Phase 4 (frontend — M3):** breathing on query activity; organic morph shader.
- **Phase 5 (both):** wire FractalMemorySearch events → growth engine; test on 10k real
  memories; benchmark gate decision (ship facades thin or keep FTS5-primary).

## Out of Scope (this spec)

- Deleting FTS5 (kept as permanent leaf layer).
- Cloud-only embeddings as default (local GGUF is the default; BYOK is fallback).
- True per-pixel coupling of RAPTOR geometry to Mandelbrot escape-time (the coordinate
  map is a deterministic artistic placement, not a mathematical identity).
