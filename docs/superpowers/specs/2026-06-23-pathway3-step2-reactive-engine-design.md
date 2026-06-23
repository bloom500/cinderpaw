# Design — Reactive Memory Engine (Pathway 3, step 2)

> Status: design proposed (Mavis, 2026-06-23). Awaiting Opus review.
> Branch of work: `feat/pathway3-remove-memory-crud-legacy-skills` + the substrate
> that ships on `main` once the step-1 PR (#2) merges.
> This is **step 2** of Pathway 3 ("native single-agent RSI"): the reactive
> engine that connects capture to the live substrate. **All five points** of
> the step-1 spec's "Non-goals (owned by the Pathway-3 step-2 spec)" are
> explicitly in scope here.

---

## Goal

Close the loop between "the user said something durable" and "the substrate
remembers and reflects it." After step 2:

- Every fact / observation that the `MemoryExtractor` persists reaches the
  Fractal Memory Search tree without a manual `rebuildIfStale()` pass.
- Edits to the knowledge graph are derived from the tree (or vice versa —
  one source of truth), so fact ↔ graph can never drift.
- Each mutation emits a `fractal_activity` pulse so the Mandelbrot organism
  (and any future visualization) reflects state changes in real time.
- The ~41 facts currently in `SemanticMemory` that were captured before
  step 1 are migrated into the reactive substrate exactly once at first
  boot after step 2 ships; after that, they flow through the same pipeline
  as new facts.

The substrate becomes "fully reactive" in the strict sense the user asked
for in the prompt that escalated Pathway 3: write a fact → the tree updates
→ the organism pulses → future recall surfaces it. No nightly rebuild, no
manual reconcile button, no double-bookkeeping.

## Non-goals (explicit deferrals)

- **Pruning policy** (size-bounded tree, eviction strategy, age-based
  decay). Lives in Pathway 4 — FMS production readiness — because pruning
  is a quality concern, not a reactivity one. The reactive engine MUST
  tolerate unbounded growth for now; reconciler never deletes a leaf
  on its own.
- **Cross-session fact dedup** (collapse 5 copies of the same preference
  into 1). Same reason: dedup is a quality concern, the reconciler keeps
  all entries and tags them with provenance (`source_turn_id`,
  `first_seen_at`, `last_seen_at`). Dedup logic reads those tags.
- **GPU embedding reliability** (the bge-small Vulkan crash,
  `FERAL_EMBED_GPU_LAYERS=0` workaround). Lives in Pathway 4 — FMS.
  Step 2 ships the *interface* of `embed(text) → vec` and trusts the
  current CPU-only path.
- **Anything in `frontend-react/`** or `src-tauri/` UI surface. The
  reactive engine is a back-end contract. The organism already
  subscribes to `fractal_activity` (the contract is wired through the
  transport today); step 2 makes those events fire more often and at
  meaningful boundaries, but introduces no new Tauri commands or React
  components.
- **Backfilling historical activity**. There is no replay log to feed
  into the organism when the engine starts; the organism starts at its
  current state and pulses only on changes after step-2 boots. This is
  the same behavior it has today and matches the spec's no-idle
  invariant.

## Architecture

### Current shape (post-step-1)

```
[turn ends]
  → MemoryExtractor.#extract()                  (async, in-process)
      → SemanticMemory.upsert(key, value)       (synchronous SQLite write)
      → MemoryGraph.addFact(...) + persist()    (synchronous file write)
      → EpisodicMemory.record(...)              (synchronous SQLite write)
  → FractalMemory.rebuildIfStale()              (manual, lazy, O(N))
```

The tree is decoupled. Substrate is consistent (semantic + graph match)
but the **fractal tree** is stale until the next lazy rebuild.

### Target shape (step 2)

```
[turn ends]
  → MemoryExtractor.#extract()
      → SemanticMemory.upsert(...)
      → MemoryGraph.addFact(...) + persist()
      → EpisodicMemory.record(...)
      → HookRegistry.fire("after_memory_write",
            { kind: "fact"|"observation", ...payload })
            ↓
            [reconciler subscribed at sidecar boot]
              → FractalMemory.upsertLeaf(text, embedding, provenance)
                  → on insert → #emit({ kind: "grow", ... })
                  → on near-duplicate → #emit({ kind: "seed", ... })
              → MemoryGraph.reconcile(treeView)
                  → add/remove edges as the tree mutated
  → (UNCHANGED) FractalMemory stays valid for query(); auto-inject
    in agent-loop continues to work as it does today.
```

Two new things appear:

1. **`after_memory_write` hook event** with a discriminated payload.
   The extractor fires it ONCE per write (after the SQLite/file commit),
   handlers run sequentially (already the registry's contract). The
   reconciler is the first subscriber; the audit hook (if any) is the
   second.

2. **`FractalMemory.upsertLeaf()`** — incremental insert into the
   tree. Bumps a `mutation_seq` counter; the next `rebuildIfStale()` is
   a no-op while `mutation_seq == 0`. Embedding is computed by the
   same `embed()` path the bench uses (no new model logic).

### Why a hook event, not a direct call?

Two reasons the existing `HookRegistry` is the right surface:

1. **Already shared singleton** (`new HookRegistry()` in `index.ts`),
   already async, already handler-error-tolerant. Adding a new event
   is a type-level change in `types.ts` + one `fire()` call in
   `extractor.ts`. No new wiring layer.
2. **Testability**. The reconciler can be tested by firing the event
   in a unit test against a fresh `HookRegistry`. No need to spin up
   the extractor, the SQLite store, and the graph.

### Migration: the ~41 facts

The migration runs ONCE at boot if and only if a marker file is absent.
The marker is `~/.feral/fractal-migration-v1.done`, written atomically
by the migrator after it finishes.

Algorithm:

```
if marker exists: skip
  enumerate all facts in SemanticMemory (SELECT key, value FROM facts)
  for each fact:
    embedding = embed(f"{key}: {value}")
    upsertLeaf(embedding, { source_turn_id: "migration-v1",
                            first_seen_at: created_at,
                            last_seen_at:  updated_at,
                            key, value })
  write marker atomically (write-tmp + rename)
```

Failure modes:

- Embedding model missing → log + skip + DO NOT write marker (next boot
  retries). The reactive engine runs normally for new facts; old facts
  remain in `SemanticMemory` (auto-inject keeps surfacing them via the
  recall path).
- Marker write fails → next boot retries the migration; `upsertLeaf`
  is idempotent on (key, first_seen_at), so duplicates are not possible.
- Migration runs while the app is also capturing new facts → the
  reconciler queue serialises everything via the existing `HookRegistry`
  sequential handler contract. Migration does not block capture.

### Reconciler semantics

For each `after_memory_write` event:

```
upsertLeaf(text, embedding, provenance):
  best = nearestExistingLeaf(embedding)
  if best && cosineSim(best, embedding) >= MERGE_THRESHOLD:
    best.last_seen_at = now()
    best.hit_count += 1
    best.provenance = mergeProvenance(best.provenance, provenance)
    emit({ kind: "seed", leafId: best.id, sessionId, ts: now })
  else:
    newLeaf = createLeaf(text, embedding, provenance)
    insertIntoCluster(newLeaf)             // assign to nearest RAPTOR cluster
    rebalanceTreeIfNeeded()                 // only if tree grew > REBALANCE_FANOUT
    emit({ kind: "grow", leaves: [newLeaf.id], weights: [w] })
```

Tunable constants (with defaults, all env-overridable):

- `FERAL_MERGE_THRESHOLD = 0.92` (cosine). Below this → new leaf.
- `FERAL_REBALANCE_FANOUT = 64` (leaves). Above this → trigger a
  lightweight RAPTOR rebuild of the affected cluster only (NOT a full
  tree rebuild — that's still lazy via `rebuildIfStale()`).

The organism already handles `grow` and `seed` pulses; this just
makes them fire on the new (correct) boundary.

### MemoryGraph coupling

After every reconciler pass, the graph is updated to mirror the
tree:

```
MemoryGraph.reconcile(treeView):
  for each tree leaf with type != "fact":
    upsertNode(leaf.id, leaf.summary, leaf.type)
  for each cluster-node in tree:
    upsertNode(cluster.id, cluster.summary, "cluster")
    for each (leaf, cluster) membership:
      addEdge(leaf, cluster, "member_of")
  removeStaleEdges()  // edges whose endpoints were pruned by full
                      // rebuild; in step 2 this is conservative
                      // (only removes edges whose endpoint is gone)
```

The reconciler is **read-only against the existing
`MemoryGraph.addFact` path** for step 2 — the extractor's direct
graph writes stay. We don't remove `addFact` calls from the
extractor; we add a second pass that ensures the tree view is also
mirrored. This is belt-and-braces on purpose: removing the direct
calls is a refactor for a later step.

The graph ↔ tree coupling has one sharp edge: today, every fact
write writes to BOTH the graph and semantic. After step 2 the
graph also gets an edge from the reconciler. The reconciler must
use **idempotent upserts** so a fact written via the old path and
mirrored via the new path does not create a duplicate node. The
existing `upsertNode` already collapses on `id`; we re-use that.

## Components

### Added

| Path | What |
|---|---|
| `core/memory-write-hook.ts` | The `after_memory_write` event payload type + a `fireMemoryWrite()` helper. Lives next to `hook-registry.ts`. |
| `memory/reconciler.ts` | The `Reconciler` class. Owns the subscription to `after_memory_write`; owns the call to `FractalMemory.upsertLeaf` + `MemoryGraph.reconcile`. |
| `memory/fractal/migration.ts` | The one-shot migration runner (the ~41 facts). Idempotent via marker file. |
| `memory/fractal/fractal-memory.ts` (edit) | Add `upsertLeaf()`, bump `mutation_seq`. |
| `types.ts` (edit) | Add `AfterMemoryWritePayload` to the `HookEvent` union; export the new payload interface. |
| `extractor.ts` (edit) | One new line per write branch: `await this.#hooks?.fire("after_memory_write", {...})`. No behavioural change to extraction itself. |
| `index.ts` (edit) | Construct the reconciler at boot, subscribe to the hook, run migration if marker absent. |

### Untouched (explicit)

- `MemoryExtractor`'s extraction logic, prompt, observation parser.
- `SemanticMemory`, `EpisodicMemory` schemas.
- `MemoryGraph.addFact` — still called by the extractor (belt-and-braces).
- `FractalMemory.query()` and the recall injection in `agent-loop.ts`.
- `MandelbrotCanvas` / organism — it already consumes
  `fractal_activity` events; no API change.
- `src-tauri/` Rust side and `frontend-react/` — no changes.

## Data flow (after)

```
turn ends
  → MemoryExtractor writes (semantic + graph + episodic, unchanged)
  → HookRegistry.fire("after_memory_write", { ... })
  → Reconciler.handle(payload)
      → FractalMemory.upsertLeaf(...)  (idempotent; emits grow/seed pulse)
      → MemoryGraph.reconcile(treeView) (idempotent upserts; never deletes)
turn continues (no blocking)
```

## Error handling

- Reconciler handler errors are caught by `HookRegistry.fire` (existing
  contract — stderr-only, never fatal). The pipeline keeps going.
- `upsertLeaf` failures (embedding model missing, disk full) are
  logged + skipped. The fact stays in `SemanticMemory`; auto-inject
  keeps surfacing it via the recall path. No retry queue in step 2.
- Migration failures are non-fatal (see migration algorithm above).

## Testing

- **Add** `tests/memory-write-hook.test.ts` — payload shape, fire-then-
  handler ordering, handler-error tolerance (re-uses existing
  `HookRegistry` test pattern).
- **Add** `tests/reconciler.test.ts` — given a captured fact, the
  reconciler upserts a leaf, the tree count goes up by 1, and a
  `grow` pulse is emitted. A near-duplicate second fact bumps
  `last_seen_at` on the same leaf and emits a `seed` pulse (not
  `grow`). Asserts no duplicate leaves, no double-fire.
- **Add** `tests/migration.test.ts` — given a fixture SemanticMemory
  with N facts and no marker, migration runs once, N leaves appear
  in the tree, marker is written. Running migration again is a no-op
  (marker present). Missing embedding model → marker NOT written,
  next boot retries, no data loss.
- **Edit** `tests/extractor.test.ts` (if exists) — assert that the
  extractor fires `after_memory_write` once per fact write with the
  expected payload.
- **Gate**: `cd FeralAgent && bunx tsc --noEmit && bun test` green
  before every commit. Sidecar 965/0 baseline MUST hold (per Opus
  progress.md after step-1 merges).

## Performance

- `upsertLeaf` is O(log N) for nearest-neighbour search via the
  existing cluster index in `FractalMemory`. 2700 leaves → <5ms p99
  (per bench numbers in `docs/agents-memory/project_fractal_bench_blockers.md`).
- Migration runs once; ~41 facts × ~5ms = ~200ms. Negligible at boot.
- Memory graph reconciliation is O(edges in tree). 2700 leaves × ~3
  cluster memberships = ~8k edges → <50ms. Not on the hot path.

## Rollout

- Single PR. Branch: `feat/pathway3-step2-reactive-engine`, off the
  merged step-1 head.
- 3-4 tasks, all TDD. Approximate sequence:
  1. Add `after_memory_write` hook event + payload type. Fire it from
     the extractor on every fact/observation write. (Additive, no
     behaviour change. Tests confirm wiring.)
  2. Add `Reconciler` class with `upsertLeaf` + graph reconcile. Tests
     for the upsert/seed/grow flows. Subscribe at sidecar boot.
  3. Add `upsertLeaf()` to `FractalMemory`. Tests for the merge /
     near-duplicate logic. Pulses emitted via the existing
     `onActivity` callback.
  4. Add migration runner. Tests for idempotency and missing-model
     tolerance. Marker file verified.

- **DO NOT** in any task: edit `frontend-react/`, edit `src-tauri/`,
  delete `MemoryGraph.addFact`, change `FractalMemory.query()`.

## Trade-offs (accepted)

- **Double-write to graph**: extractor still calls `addFact` AND the
  reconciler mirrors from the tree. Cost is negligible (idempotent
  upserts), and removing the extractor's call is a separate refactor.
- **No pruning in step 2**: tree grows monotonically. Pathway 4
  (FMS production) adds the eviction policy. Step 2 must NOT add
  pruning logic.
- **Marker file for migration**: simple, correct, debuggable. A more
  sophisticated migration ledger (per-fact source tracking) is a
  later concern if we ever need partial re-migration.
- **No replay log**: the organism starts at its current state; pulses
  only fire on changes after step-2 boots. Acceptable per the user's
  "fully reactive on the write path, not on backfill" framing.

---

## PR shape

Single PR, four commits for clean review:
1. **Additive** — `after_memory_write` hook + fire from extractor +
   payload tests.
2. **Reconciler** — class + subscription + tests.
3. **`upsertLeaf`** — incremental tree insert + pulses + tests.
4. **Migration** — one-shot runner + marker + tests.

PR description must include:
- The two non-goal paragraphs from step-1 spec ("Reactive engine + fact
  migration are deferred to the Pathway-3 step-2 spec.") as the
  scope-justification evidence block.
- Migration marker path + idempotency assertion.
- Final test count + tsc-clean confirmation.
- The explicit DO-NOT-TOUCH list.
