# Design — RSI + FMS Production Readiness (Pathway 4)

> Status: design proposed (Mavis, 2026-06-23). Awaiting Opus review.
> Branch of work: depends on the merged step-1 (#2) AND step-2 of Pathway 3.
> This is **Pathway 4** — the "the engines work but won't ship" pass.
> Goals: kill the last production-blockers in the RSI engine and in the
> Fractal Memory Search (FMS) pipeline.

---

## Goal

After Pathway 4 ships, both the RSI engine and the FMS pipeline meet the
"production-ready" bar the user asked for in the original prompt that
escalated this thread:

**RSI Engine (Faza 1)** — every blocker listed below has a verified fix
and a regression test. A user can start the engine, walk away, come back
to a non-stuck panel, and trust that a real champion has either been
promoted or that the log says why no champion has emerged.

**Fractal Memory Search (Faza 5)** — the tree scales beyond the current
2700-leaf bench without regression, GPU embedding is either fixed or
gracefully CPU-only, and the substrate has an explicit policy for pruning
old / dedup-cross-session facts instead of growing forever.

These are NOT design changes — they are quality fixes to systems whose
core algorithms and architecture are already correct and unit-tested.
The "what" is fixed; Pathway 4 only changes "how reliably" and "at what
scale."

## Non-goals (explicit deferrals)

- **Pathway 3 step 2** (the reactive engine: write → hook → reconcile →
  propagate edges → Mandelbrot pulse). That is its own spec and its own
  PR; Pathway 4 assumes step 2 has already landed. Pruning and dedup
  read the provenance tags step 2 adds (`source_turn_id`,
  `first_seen_at`, `last_seen_at`). Without step 2, Pathway 4's pruning
  / dedup tasks have nothing to prune or dedup.
- **A new visualization** (World Tree, ambient Mandelbrot toggle). The
  user proposed this in their last message; it is a separate project
  once Pathway 3 step 2 lands and the tree's reactive shape is stable
  enough that a visualization can be honest about the structure.
- **Tuning the eval suite weights** (`ScorerWeights`). The plan captures
  RSI budget BYOK direction; that is its own change.
- **Cloud-provider embedding** (OpenAI / Voyage / Cohere vectors). FMS
  embeds locally. Pathway 4 does not add a cloud fallback; if the
  local model is missing, the engine degrades to "no recall" (existing
  behaviour).
- **Anything that requires a running app to verify**. All blocker fixes
  ship with pure unit / integration tests. Manual visual smoke is a
  user-side decision (the existing dev workflow).

## Dependencies

```
[step-2 reactive engine merged on main]
      ↓
[Pathway 4 starts]
```

Tasks in Pathway 4 that need step-2-derived state (provenance tags,
reconciler): pruning, cross-session dedup. Both wait until step-2 is
on main.

Tasks in Pathway 4 that DON'T need step-2 (engine-correctness fixes):
RSI eval coverage, champion propagation, budget display, substrate
baseline, auto-restart, telemetry, GPU embedding, bench scale. These
can land in parallel with step 2 — they are RSI / FMS engine work, not
memory pipeline work.

To keep the PRs reviewable, Pathway 4 ships as THREE separate PRs in
this order:

1. **PR-A: RSI Engine correctness** — champion propagation, eval
   coverage gaps, substrate baseline fixity, budget display, telemetry.
   Doesn't depend on step-2.
2. **PR-B: RSI state + restart** — auto-restart on app boot, telemetry
   persistence. Doesn't depend on step-2.
3. **PR-C: FMS quality at scale** — pruning policy, cross-session dedup,
   bench scale at 10k / 100k leaves, GPU embedding repair (or
   documented CPU-only graceful degradation). Depends on step-2.

---

## Architecture (current state vs target)

### RSI Engine

**Current state**:
- Tier 0 has 10 frozen specs in `tier0.rs`. No identity, no search-
  narration, no constraint-adherence checks.
- Champion never propagates: no mutation in the eval log has beaten
  the substrate baseline. Root cause unknown — could be (a) eval suite
  too easy (no signal), (b) scorer weights off, (c) ratchet logic bug,
  (d) substrate baseline so strong that Tier 0 only is insufficient.
- Budget display shows `$25` when env var is `$2.50`. Display-layer
  bug; `cost_so_far_usd` in `RsiEngineState` is the source of truth
  and is correct. The UI's formatter is wrong.
- Substrate baseline is a commit pin (`6d42c2c`-shaped). The pin is
  in `repo.rs` / `plan.rs`; what `6d42c2c` semantically means (which
  genome is the "floor") is documented in code comments only.
- Engine state does NOT persist across app restart. `RsiState.initialized`
  is in-memory; on Tauri restart, the engine is fully reset.
- Telemetry keeps only winners. Rejected candidates are lost (the audit
  chain in `audit.rs` records mutations but not "candidate scored X, was
  rejected, reason: Y").

**Target state (Pathway 4)**:
- Tier 0 grows from 10 to 13 specs (3 new: identity, search-narration,
  constraint-adherence). The new specs follow the existing
  `Tier0Kind` / `Tier0Expected` pattern; they don't add new kinds.
- Champion propagation either works (a mutation has beat baseline at
  least once in CI) OR the log surfaces a clear reason for stagnation.
  Specifically: if `iteration >= N` and `best_score == None`, the
  engine emits a `rsi_engine_event` with `event: "stagnation"` and a
  reason field — visible in the panel and the audit chain.
- Budget display shows the correct `$2.50` (formatter fix; one test).
- Substrate baseline pin documents itself: `SANDBOX_BASELINE_COMMIT`
  constant in `repo.rs` carries a doc comment explaining what
  baseline-X means (which genome, why, what's allowed to beat it).
- Engine state persists across app restart. `RsiState` extended with
  an `engine_persisted: Arc<Mutex<Option<PersistedEngineState>>>` field
  that round-trips through `<dataDir>/rsi/engine-state.json` (atomic
  write). On `rsi_init`, the persisted state is loaded (if present)
  and the engine resumes from `iteration` + `best_score` + the
  candidate queue.
- Telemetry keeps EVERY eval outcome (winner or rejected) for the
  last 1000 iterations in `<dataDir>/rsi/rsi-telemetry.jsonl` (one
  JSON object per line, atomic append). A new Tauri command
  `rsi_get_telemetry(last_n)` returns the tail. The audit chain in
  `audit.rs` continues to record mutations (its current job); the
  telemetry log is a different surface for eval outcomes specifically.

### Fractal Memory Search

**Current state**:
- Tree scale proven to 2700 leaves (p99 32ms after embed-batch fix).
  No data on 10k or 100k.
- GPU embedding (bge-small) crashes on Vulkan. Workaround:
  `FERAL_EMBED_GPU_LAYERS=0` keeps CPU-only path. Not a code bug; it's
  a llama.cpp + Vulkan instability on this dev box.
- Reconciler absent. Tree rebuilds are lazy on `rebuildIfStale()`.
  (Fixed in step-2.)
- **Reactive leaves are in-memory only.** Step-2's `upsertLeaf` records
  new leaves in `FractalMemory.#pendingLeaves` and their `last_seen_at`
  / `hit_count` in the side-channel `#provenance` map. Both are lost on
  restart and are never unified into a durable, queryable store. This is
  the "Known minor item" step-2's PR called out explicitly. It is the
  **prerequisite gap** for everything else in PR-C: eviction and dedup
  read `last_seen_at` / `hit_count`, which today live only in that
  volatile side map — there is nothing durable to evict or dedup.
- Pruning policy absent. Tree grows monotonically.
- Cross-session dedup absent. The 5 copies of the same preference
  across 5 sessions live as 5 separate facts (and after step-2, 5
  separate leaves).

**Target state (Pathway 4, after step-2)**:
- **Durable provenance-bearing leaf store (PR-C Task C.0 — prerequisite).**
  A dedicated `LeafStore` over `<dataDir>/fractal-leaves.jsonl` is the
  canonical home for reactively-captured leaves and their provenance
  (`first_seen_at`, `last_seen_at`, `hit_count`, `source`, `key`,
  `value`). `upsertLeaf` writes through to it instead of the volatile
  in-memory maps; it loads on `init()` (survives restart); and
  `FractalMemory.leaves()` exposes provenance-bearing summaries that
  eviction (C.1/C.2) and cross-session dedup (C.3) operate on as pure
  functions. A dedicated store — not the episodic conversation table —
  keeps fact leaves cleanly separable from turn history, which is exactly
  the surface eviction/dedup want. This task MUST land before C.1.
- Bench scaled to 10k and 100k leaves. p99 < 100ms at 10k, < 500ms at
  100k. If the bench misses the target, the plan adjusts; if it hits,
  the README + `project_fractal_bench_blockers.md` get updated with
  the new numbers.
- GPU embedding: either fixed (llama.cpp / driver update) or
  permanently documented as CPU-only with `FERAL_EMBED_GPU_LAYERS=0`
  as the documented knob. The latter is acceptable; the former is
  preferred. Pathway 4 writes the diagnostic + the docs in either case.
- Pruning policy: an `EvictionPolicy` trait on `FractalMemory` with
  one production impl (`AgeAndHitCountEviction`) and a test-only impl
  (`NoEviction` for deterministic tests). Policy is env-selectable
  via `FERAL_FMS_EVICTION` with default `AgeAndHitCount`. Eviction
  fires on `rebalanceTreeIfNeeded()` when leaf count exceeds
  `FERAL_FMS_MAX_LEAVES` (default 5000). Evicted leaves are persisted
  to `<dataDir>/fractal-evicted.jsonl` (one JSON per line) for audit.
- Cross-session dedup: the `Reconciler.upsertLeaf` cosine merge already
  collapses near-duplicates (from step-2). Pathway 4 adds a SECOND
  pass on the tree that runs during the same rebalance: collapses
  leaves whose `first_seen_at` differ by more than a configurable
  threshold (default: 30 days) and whose cosine >= `MERGE_THRESHOLD`
  (from step-2). The earlier leaf keeps its `first_seen_at`; the later
  one contributes its `last_seen_at` and is removed.

---

## Components per PR

### PR-A: RSI Engine correctness

| Path | Change |
|---|---|
| `src-tauri/src/rsi/tier0.rs` | +3 specs: `tier0/identity_honesty` (FactLookup), `tier0/search_narration` (JsonFormat w/ required key `sources`), `tier0/constraint_count` (TokenBudget on a prompt that requires an exact word count). The new specs follow the existing pattern; they do NOT add new `Tier0Kind` variants. |
| `src-tauri/src/rsi/commands.rs` | Add `engine_persisted` to `RsiState`; add `rsi_get_telemetry` command; add `stagnation` event emission in the sidecar's engine driver (separate PR if it crosses the language boundary). |
| `src-tauri/src/rsi/repo.rs` | Add `SANDBOX_BASELINE_COMMIT` constant with a doc comment block explaining what the baseline represents, which genome is pinned, and what is allowed to beat it. |
| `FeralAgent/src/.../rsi-budget-display.tsx` (or whichever component reads the budget — to be located at start of task) | Fix the formatter. `$25` displayed for `$2.50` env value → `$2.50` displayed. Single test on the formatter. |
| `FeralAgent/src/.../rsi-engine-driver.ts` (to be located) | Emit `rsi_engine_event { event: "stagnation", iteration, reason }` when iteration exceeds the stagnation threshold with no champion. Threshold: `FERAL_RSI_STAGNATION_THRESHOLD` (default 10). |
| `FeralAgent/tests/rsi-engine-*.test.ts` (multiple, TDD) | Each fix gets its own test file. |

### PR-B: RSI state + restart

| Path | Change |
|---|---|
| `src-tauri/src/rsi/commands.rs` | Extend `RsiState` with `engine_persisted: Arc<Mutex<Option<PersistedEngineState>>>`. Add `persist_engine_state()` / `load_engine_state()` helpers (atomic write via tmp + rename). |
| `src-tauri/src/rsi/mod.rs` (or new `persistence.rs`) | `PersistedEngineState` struct: `{ iteration, best_score, best_commit, candidate_queue, last_updated_at }`. |
| `FeralAgent/src/.../rsi-engine-driver.ts` | On every iteration, call `persist_engine_state(...)` (best-effort, swallow errors). On boot, after `rsi_init`, call `load_engine_state()` and resume from `iteration` if present. |
| `FeralAgent/tests/rsi-engine-persistence.test.ts` | TDD: write state → kill driver → spin up new driver → state restored. |

### PR-C: FMS quality at scale

| Path | Change |
|---|---|
| `FeralAgent/src/memory/fractal/leaf-store.ts` (new, **Task C.0 — prerequisite**) | `LeafStore` over `<dataDir>/fractal-leaves.jsonl`: `load()` (tolerant of corrupt lines), `upsert(record)` (atomic rewrite tmp + rename), `remove(ids)`, `all()`. `LeafRecord` carries the provenance fields. |
| `FeralAgent/src/memory/fractal/fractal-memory.ts` (**Task C.0** edit) | `upsertLeaf` writes through to `LeafStore` (replacing the in-memory-only `#pendingLeaves` + `#provenance`); `init()` loads the store; new `leaves(): LeafSummary[]` exposes provenance-bearing summaries for eviction/dedup. |
| `FeralAgent/src/memory/fractal/eviction.ts` (new) | `EvictionPolicy` trait + `AgeAndHitCountEviction` impl + `NoEviction` test impl. Pure functions over `(leaves, now) -> leavesToEvict`, where `leaves` come from `FractalMemory.leaves()` (the C.0 store). |
| `FeralAgent/src/memory/fractal/fractal-memory.ts` | `evict(policy, now)` method. Calls eviction policy, removes leaves, persists to `fractal-evicted.jsonl`. Triggers a re-cluster of the affected cluster only. Emits a `prune` activity pulse (new FractalActivity variant — added to the union in `types.ts`). |
| `FeralAgent/src/memory/fractal/cross-session-dedup.ts` (new) | `dedupAcrossSessions(leaves, policy, now)` — runs AFTER the reconciler's per-write cosine merge. Pure function over the leaves array. |
| `FeralAgent/tests/eviction.test.ts`, `cross-session-dedup.test.ts`, `fractal-scale-10k.test.ts`, `fractal-scale-100k.test.ts` | TDD. The scale tests are bench-style (time-bounded); they live in `tests/` but are gated by env flag (run only when `FERAL_FMS_BENCH=1`). |
| `docs/agents-memory/project_fractal_bench_blockers.md` | Updated with new scale numbers. |
| `docs/superpowers/specs/...` or `AGENTS.md` | GPU embedding status: fixed OR documented CPU-only with `FERAL_EMBED_GPU_LAYERS=0` as the documented knob. |

---

## Data flow (after)

```
[turn ends]   (Pathway 3 step-2 already on main)
  → MemoryExtractor writes
  → HookRegistry.fire("after_memory_write")
      → Reconciler.handle(...)
          → FractalMemory.upsertLeaf(...)  ← step-2
              → LeafStore.upsert(record + provenance)  ← Pathway 4 PR-C C.0 (durable)
          → FractalMemory.evict(policy, now)   ← Pathway 4 PR-C (reads LeafStore via leaves())
          → FractalMemory.dedupAcrossSessions(...)  ← Pathway 4 PR-C (operates on LeafStore)
          → MemoryGraph.reconcile(treeView)
  → activity pulse: grow | seed | prune  ← step-2 + PR-C

[RSI iteration ends]
  → engine writes EvalOutcome to <dataDir>/rsi/rsi-telemetry.jsonl
  → engine persists state to <dataDir>/rsi/engine-state.json
  → audit chain records the mutation in <dataDir>/rsi/audit.log

[app restart]
  → rsi_init loads bounds + audit chain (existing)
  → rsi_init loads engine-state.json (PR-B)
  → engine resumes from persisted iteration
  → fractalMemory.init() loads tree (existing, lazy rebuild if stale)
```

## Error handling

- PR-A: stagnation event emission is best-effort; missing audit chain
  is a hard fail (existing behaviour). Budget display formatter fix
  has no failure modes.
- PR-B: persistence write failure logs and continues — engine is
  resilient to a failed write, never fatal. Load failure logs and
  starts fresh.
- PR-C: eviction failure logs and continues; no retry queue. Bench
  scale tests are skipped when env flag unset; they never run in CI by
  default (CI is not the place for 100k-scale bench).

## Testing (per PR)

**PR-A** (`rsi-engine-correctness`):
- Tier 0 grows to 13; `ten_specs_constant` test becomes
  `thirteen_specs_constant` (or `tier0_spec_count_constant(13)`).
- New: validator tests for the 3 new specs (one per kind).
- New: stagnation event emission (assert sidecar emits the event when
  iteration crosses threshold without a champion).
- New: budget display formatter test.
- New: `SANDBOX_BASELINE_COMMIT` doc-comment existence + non-empty
  string test (regex match).

**PR-B** (`rsi-engine-restart`):
- Persist → load round-trip test.
- Corrupt `engine-state.json` → fresh start, no panic.
- Telemetry append-only test (write 100 lines, read last 10, assert
  ordering).
- `rsi_get_telemetry` command test (last_n param, default).

**PR-C** (`fms-quality-at-scale`):
- `AgeAndHitCountEviction` test: leaves above age threshold + below
  hit-count threshold get evicted. Boundary cases (exactly at threshold,
  zero hit count) explicit.
- Cross-session dedup test: 5 leaves with same embedding + different
  `first_seen_at` spanning > threshold → collapses to 1.
- Scale tests (env-gated): 10k leaves query p99 < 100ms, 100k leaves
  query p99 < 500ms. Tests live in `tests/` but gated by
  `FERAL_FMS_BENCH=1`.
- GPU embedding: integration test that loads the model in CPU mode
  and asserts a non-empty embedding; if Vulkan mode works on the dev
  box, add a second test that asserts Vulkan mode also works.

## Performance budgets

- PR-A: no perf change. The 3 new Tier 0 specs add ~30ms to a single
  eval pass; not on a hot path.
- PR-B: `engine-state.json` is tiny (~1KB). Atomic write is microseconds.
- PR-C: eviction runs on `rebalanceTreeIfNeeded()` (rare); p99 < 50ms
  at 5000 leaves. Cross-session dedup runs in the same rebalance; p99
  < 100ms at 5000 leaves. Scale tests assert p99 at the 10k and 100k
  marks.

## Rollout

Three PRs, sequentially or in parallel (PR-A and PR-B touch different
files; PR-C must wait for step-2).

PR-A branch: `feat/pathway4-prA-rsi-engine-correctness`, off the merged
step-1 head. Can land alongside step-2.

PR-B branch: `feat/pathway4-prB-rsi-engine-restart`, off the merged
step-1 head. Can land alongside step-2.

PR-C branch: `feat/pathway4-prC-fms-quality-at-scale`, off the merged
step-2 head. MUST wait for step-2.

Each PR follows the Opus task pattern: 2-4 commits, TDD, gate before
every commit, PR description with evidence blocks.

## Trade-offs (accepted)

- **Stagnation event vs. automatic tuning**: we surface the stagnation,
  we don't fix it. The fix could be (a) change the eval suite (we add
  harder specs), (b) change the scorer weights (separate concern), (c)
  relax the baseline (separate concern). Stagnation-as-signal is what
  the user can act on.
- **Telemetry is JSONL, not SQLite**: SQLite would be more queryable
  but adds a dep. JSONL is enough for "tail the last 1000 entries",
  which is all the UI needs. Adding SQLite is a later concern.
- **Eviction policy is one impl + one test stub**: the user didn't
  ask for "configurable policy from the UI." One sensible default +
  one stub for tests is the smallest thing that works. Adding more
  policies is a future concern if the default proves wrong.
- **Bench tests are env-gated**: 100k-scale tests take seconds; we
  don't want them in default CI. The dev sets the env flag when
  iterating on perf. CI runs the 10k test as a smoke only if a future
  phase adds it; the default Phase-1 PR doesn't.

---

## PR-A description — required sections

1. **Scope justification** — paste the 6 RSI blockers listed in the
   prompt that escalated Pathway 4, verbatim.
2. **What landed** — list commits, one line each.
3. **Tier-0 invariants** — `tier0_spec_count_constant` test re-baselined
   to 13. Re-run grep: `grep -rn "TIER0_SPECS" src-tauri/src/rsi/`
   shows the constant + the 10→13 update.
4. **Test count** — `bun test` baseline + new tests, tsc clean.
5. **DO-NOT-TOUCH** — explicit grep showing no edits to
   `frontend-react/` or `src-tauri/src/events.rs` (event schema is
   unchanged; the new `stagnation` event rides the existing
   `rsi_engine_event` channel with a new `event` field value).
6. **Dropped tasks** (Opus review, verified against code) — A.3 budget
   formatter: no bug (`$25` is the sandbox default `max_total_cost_usd:
   25.0`, a different cap from the `FERAL_RSI_MAX_COST_USD` setting; the
   panel was already correct). A.4 baseline-comment: no baseline commit
   pin exists anywhere in `src-tauri/src/rsi/` to document. Both premises
   were written from memory, not the code. PR-A's real content is A.1
   (Tier 0 10→13) + A.2 (stagnation event).

## PR-B description — required sections

1. **Scope justification** — the auto-restart blocker from the prompt.
2. **What landed** — commits.
3. **Persistence invariants** — atomic write (tmp + rename) test
   visible; corrupt-file test visible.
4. **Test count** — baseline + new.
5. **Backward compat** — `engine-state.json` is new; no migration
   needed (engine state never existed on disk before).

## PR-C description — required sections

1. **Scope justification** — the 4 FMS blockers not covered by step-2
   (GPU embedding, pruning, cross-session dedup, bench scale) PLUS the
   step-2 "Known minor item": reactive leaves were in-memory only.
2. **What landed** — commits.
3. **Persistence invariant (Task C.0)** — `upsertLeaf` writes through to
   `fractal-leaves.jsonl`; restart round-trip test asserts a leaf
   upserted before "restart" (fresh `FractalMemory.init()`) is present
   afterwards with its `hit_count` / `last_seen_at` intact. Atomic write
   (tmp + rename) test visible; corrupt-line tolerance test visible.
4. **Eviction invariants** — leaves evicted on `rebalanceTreeIfNeeded`
   are persisted to `fractal-evicted.jsonl` (test asserts the file
   contents).
5. **Dedup invariants** — leaf count after dedup is monotonically
   <= pre-dedup count; `first_seen_at` of the survivor is the EARLIEST
   of the merged leaves (test asserts this ordering).
6. **Scale numbers** — bench output pasted into the description
   (with `FERAL_FMS_BENCH=1` env); `project_fractal_bench_blockers.md`
   updated.
7. **GPU embedding status** — fixed OR documented CPU-only.

---

## Conventions (all three PRs)

- One task = one commit. Each commit GREEN: `cd FeralAgent && bunx tsc --noEmit && bun test` AND `cd src-tauri && cargo check --features inference`.
- TDD: tests first.
- Frequent, scoped commits. No amend. No force-push.
- Append `.superpowers/sdd/progress.md` per task.
- Verify-then-delete greps return exactly the expected matches; STOP
  and report otherwise.
