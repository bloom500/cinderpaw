# Project BRSI Evolution — Working Notes

> What this file is: durable memory of the BRSI (Bounded Recursive
> Self-Improvement) work for Feral. Update when facts change; the next
> agent (or Opus when quota returns) needs this to skip the
> re-discovery work.
>
> **Authoritative docs (in addition to this file):**
> - `docs/brsi-spec.md` — the conceptual umbrella spec (now 7 layers
>   + DAG).
> - `docs/invariants.md` — runtime contracts (HARD / SOFT).
> - `docs/feral_philosophy.md` — principles for future contributors.
> - `docs/observability-data-model.md` — single Evolution Event
>   Schema.
> - `docs/adr/` — Architecture Decision Records (8 ADRs as of
>   2026-06-30).
> - `docs/rsi-evolution-spec.md` — engine internals (Faza 1-5).
> - `docs/continual-personal-adaptation-plan.md` — 6-layer roadmap +
>   three missing axes.

---

## What "BRSI" means here

**Bounded Recursive Self-Improvement.** Identity claim:

> Feral is not designed to improve without limits. It is designed to
> improve **safely, measurably, and reversibly**, within explicit
> user-defined boundaries.

Every design decision is checkable against "is this bounded?". If not,
it's wrong by definition. The umbrella spec is `docs/brsi-spec.md`.

**Naming rule (locked 2026-06-30, ADR-0001):**
- Internal docs: "RSI" stays.
- External / user-facing copy for Layers 0-2: "Evolution" or
  "Personal Adaptation".
- External for Layers 3-5: "Bounded Self-Improvement".
- "RSI" label is reserved for Layer 6 (Meta Evolution) where it is
  actually earned.

**Layer taxonomy (locked 2026-06-30, ADR-0002):**
- **L0-L4**: unchanged from the original spec.
- **L5 — Governance Evolution** (NEW): tunes confidence thresholds,
  fitness weights, mutation rates, budget caps within
  SandboxBounds. Reversible. Auto-apply within bounds.
- **L6 — Meta Evolution** (renamed from old L5): optimises the
  algorithm that produces those parameters. Genuine RSI. Always
  human-gated. Stricter promotion gate (`N=10, M=30` vs `N=5, M=10`
  for prior layers).

**Architecture DAG (ADR-0008):** the runtime is a peer graph, not
a layered cake. Layers describe the autonomy scale; the DAG
describes what the engine actually is. `docs/brsi-spec.md` §10
carries the ASCII DAG. Refactor scope is the DAG, not the layers.

---

## Locked decisions (2026-06-30)

These were locked by the user. Treat them as policy. Re-opening them
needs explicit user approval.

| #   | Decision                                          | Value                                                                | Source |
| --- | ------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| D1  | Initial species list                              | **2**: `research` + `coding`                                         | BRSI §9 #2 |
| D2  | Confidence thresholds                             | **Strict**: p<0.05 + effect≥0.1 + confidence≥0.95                    | BRSI §9 #4 |
| D3  | Promotion gate defaults                           | **N=5 cycles, M=10 ratchets** before L_i → L_{i+1}                    | BRSI §9 #5 |
| D4  | Fitness weights strategy                          | **Ship §2.2 defaults** (0.30/0.20/0.15/0.15/0.10/0.10); learn from Journal after 30 cycles | BRSI §9 #1 |
| D5  | Naming for Faza 1-2 (user-facing)                 | Intern "RSI", extern "Evolution" / "Personal Adaptation"             | CPA §8 #1 |

**Defaults applied without asking (re-evaluable later):**

| #   | Decision                                          | Default                                                              |
| --- | ------------------------------------------------- | -------------------------------------------------------------------- |
| D6  | Journal format                                    | **JSONL** — mirrors `dream-telemetry.ts:17-44` pattern               |
| D7  | Confidence-gate failure UI visibility             | **Both**: UI surfaces recent rejections, Journal has everything      |
| D8  | Tree archive size per species                     | **20** per species, age-out by LRU                                   |
| D9  | Hybrid operator timing                            | **With species** (Step 6 of refactor sequence, not deferred)         |
| D10 | Provenance graph storage                          | **Git for code/config** + small typed envelopes for non-code artifacts |

**Open (Batch 2, deferred):** BRSI §9 #3 (budget defaults),
§9 #6 (personal fitness v1 subset), §9 #12 (dream cycle trigger
default), CPA §8 #2-6, RSI §8 #1-5. **Do not start the modules
that depend on these until the user locks them.**

---

## Audit summary (read before touching engine code)

A full audit was run on 2026-06-30 across `FeralAgent/src/rsi/*` (41
files) and `src-tauri/src/rsi/*` (11 files). The short version:

### What already exists (don't rebuild)

- **Event bus + handler cascade** in `event-bus.ts` (9 events, serial
  pump). Not a per-candidate state machine, but the wiring is there.
- **Population machinery**: `population-manager.ts` (with NEAT
  fitness-sharing / niche cosine similarity at 0.85 threshold),
  `crossover.ts`, `mutation.ts`, `extinction-handler.ts`,
  `selection-handler.ts`, `ratchet-handler.ts`. Flat population with
  one `bestRecord`.
- **Eval suite system**: `tier0.rs` (13 frozen Tier-0 specs in Rust),
  `tier-loader.ts`, `default-tier-specs.ts`, `eval-spec.ts`,
  `get-specs.ts`, `eval-worker.ts`, `run-eval.ts`.
- **Scorer with breakdown**: `scorer.rs` returns `ScoreBreakdown`
  with 4 components (success/cost/error/latency). Not a 6-component
  vector, but the shape is the extension point.
- **Git substrate**: `repo.rs` has bootstrap, commit_genome,
  ratchet_attempt, log, lca, diff, gc. `IterationMetadata` carries
  parent_lineage.
- **Safety infra**: `audit.rs` (hash-chained NDJSON for
  SandboxBounds), `goodhart.rs` (Tier1↑/Tier2↓ regression
  detector), `sandbox_bounds.rs` (immutable contract), `paths.rs`
  (path containment).
- **Champion**: `champion.ts` (single global, persisted, projects
  temperature only to live agent).
- **Dream cycle glue**: `dream-cycle.ts` (NOT a 7-stage FSM; just
  trigger → run → sleep glue).
- **Soft telemetry**: `dream-telemetry.ts` (one-line-per-episode
  JSONL).
- **Cost estimator**: `rsi-cost.ts` (per-token blended $/1k; loopback
  = free).

### Precursor patterns (reshape, don't replace)

- `taste.ts` / `taste-miner.ts` — **NOT** a species precursor. It's a
  per-field numeric bias on births. Could become `Species.taste` per
  species, but is conceptually separate.
- `escape-time.ts` / `escape-time-recorder.ts` — **IS** a strong
  species precursor. The region key
  (`t{0..3}:c{0..3}:r{strategy}:d{depth}`) maps naturally to species
  assignment.
- `goodhart.rs` — **regression detector, not confidence gate**.
  Direct reuse at BRSI contract Stage 6.
- `pbt-controller.ts` — **meta-evolution (Layer 5 precursor)**, not
  budget. Operates on search hyperparams, not resource spend. Can be
  extended per-species.
- `recalcitrance.ts` — **difficulty tracker, not confidence**.
  Answers "is the search drying up?" vs "is this gain real or noise?".

### Genuinely missing (net-new)

- **8-stage contract state machine** — no per-candidate `pipeline_stage`.
- **6-component fitness vector** — scorer has 4; need Accuracy +
  UserSatisfaction (+ ToolSuccess, HallucinationRate folded initially).
- **Per-context champion** — single global; need species-aware.
- **Named species registry** — NEAT niches exist; named Species don't.
- **Per-phase resource caps + estimator** — GoalConfig is one-shot at
  episode end; no per-phase burn rates.
- **Statistical confidence gate** — no bootstrap / Cohen's d / p-value.
- **7-stage dream cycle** — not a FSM; just trigger/run/sleep.
- **4 trigger types** — only `"idle" | "error"`; missing schedule /
  threshold-N-demos / user-initiated / budget-available.
- **Per-cycle structured journal** — episode telemetry is 10 flat
  fields; no observed/hypothesized/experimented/result/decided schema.
- **Personal fitness collector** — `UserSatisfaction` doesn't exist.
- **Typed envelopes for non-code artifacts** — LoRA / demo / eval-task
  metadata have no envelope shape.

---

## Refactor sequence (low-risk to high-risk)

When BRSI work resumes (Opus or otherwise), execute in this order.
Each step's risk = # files touched + breaking change footprint.

| # | Step                                                | Risk  | Touches                                                                                       |
| - | --------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| 1 | Evolution Journal writer + tests                    | ~1d   | `journal.ts` (new) + 2-3 event handlers wire-in                                              |
| 2 | Fitness Vector 4→6 (scorer.rs + wire types)         | ~2d   | `scorer.rs`, `mod.rs`, `eval-worker.ts`, `adapters.ts`                                        |
| 3 | Confidence gate (paired bootstrap, Cohen's d)       | ~2d   | `confidence.ts` (new) + `ratchet-handler.ts` pre-check + SandboxBounds extension              |
| 4 | Budget Controller (per-phase caps + estimator)      | ~2d   | `budget.ts` (new) wraps `GoalConfig`; add CPU/RAM/disk/energy fields                          |
| 5 | Provenance graph (read-side, git-backed)             | ~2d   | `provenance.ts` (new) over `rsi_log` + `rsi_lca`                                              |
| 6 | Species registry + `species_id` on `Genome`         | ~4d   | `population-manager.ts`, `IterationMetadata`, `escape-time-recorder.ts`, snapshot v1→v2       |
| 7 | Tree of champions (per-species champion map)        | ~3d   | `champion.ts`, `sidecar.ts` seed cascade, `core/agent-loop.ts`                                |
| 8 | Personal Fitness collector (signals aggregator)     | ~5d   | `personal-fitness.ts` (new); cross-cuts `episodic.ts`, tool audit, UIA replay                  |
| 9 | Evolution Contract 8-stage state machine             | ~5-7d | `contract.ts` (new); ratchet/selection/eval-worker plumbing; new event variant                |
| 10| Dream Cycle 7-stage rewrite                         | ~3d   | `dream-cycle.ts` rewrite, `OutboundEvent` extension, FE filter update at `MemoryLayersPage.tsx:139-145` |

---

## Landmines (things that interact badly with BRSI)

**Read these before any contract / dream-cycle work:**

1. **`champion.ts:39-46` only projects temperature.** Tests pin this.
   Expanding the map is fine but `core/agent-loop.ts` must accept new
   fields, and per-session UI overrides silently win.

2. **`eval-worker.ts:67-80` ALWAYS emits `EvalComplete{errored:true, score:0}` on catch.**
   A contract stage that wants to halt on a precondition failure has
   no entry point that DOESN'T produce an `EvalComplete`. Add an
   `EvalHalted{reason}` sibling event, OR have the pre-check live
   BEFORE the eval launches.

3. **`fractal_activity` kind is sealed** at `types.ts:1118`
   (`recall | grow | seed | prune`). Per `project_fractal_activity_pulses.md:7`,
   adding `cycle_stage` requires updating
   `frontend-react/src/lib/tauri/events.ts:87` and
   `MemoryLayersPage.tsx:139-145` to ignore the new kind.

4. **`repo.rs:344` (`candidate_score > prior_score_value`) is the
   single source of truth** for "main advances only on improvement".
   BRSI gates (confidence, Goodhart, Tier 0 floor, human gate) must be
   pre-checked in TS **before** `rsi_commit_genome` — otherwise the
   agent could sneak past by editing the score in metadata.

5. **`bridge.ts:54` + `adapters.ts:49` (`BRIDGE_TIMEOUT_MS = 30_000`)** is
   the only safety net. LLM-driven mutations in Faza 2+ might exceed
   30s; per-stage timeouts are needed.

6. **`pbt-controller.ts:46` requires `tokenCost: number`.** `ratchet-handler.ts:88`
   normalises with `?? 0` (good) but a future regression that forgets
   to set `tokenCost` silently breaks PBT with NaN.

7. **`extinction-handler.ts:62-65` resets `lastBest` from `pop.best()?.score` at
   construction.** First-cycle blind spot: a stuck population looks
   fresh after restart. Pre-existing stuckness not honored unless
   the contract reads `iterations_since_improvement` from the snapshot.

8. **`population-snapshot.ts:32` is `SNAPSHOT_VERSION = 1`.** Adding
   species state requires bump to v2 + graceful v1 fallback in
   `readPopulationSnapshot` (`population-snapshot.ts:72-78`).

9. **`tier-loader.ts:43-77` throws on malformed JSON.** If personal
   eval suite ever moves from in-memory to disk, this throws. Personal
   eval suite loader will need its own validator.

10. **Two near-overlapping files:** `passive-supervisor.ts` (legacy,
    "replaced by dream-cycle" per `dream-cycle.ts:4-7` docstring but
    still in source for re-exports) and `dream-cycle.ts` (current).
    Cleanup is separate from BRSI work but worth noting.

11. **`audit.rs` and `FeralAgent/src/sandbox/audit-log.ts` already share the
    chain discipline** (`sha256(prev || 0x02 || canonical)`). The TS side
    is the model to mirror for the Evolution Journal hash chain when
    it's added (NOT in v1 — see journal.ts TODOs).

12. **`engine.ts:118-120` silently overwrites `selection.taste` when
    `tasteMiner` is supplied.** Right precedence for production,
    confusing in tests.

---

## What's safe for me vs Opus (division of labor)

Per the audit + the locked decisions:

**Safe for opencode (MiniMax-M3) right now:**
- Pure-function, additive modules with clear inputs/outputs:
  - ✅ `journal.ts` (append-only JSONL writer; tests; no engine wire yet)
  - ✅ `confidence.ts` (paired bootstrap + Cohen's d + gate evaluator)
  - ✅ `personal-fitness.ts` (rolling-window aggregator over existing
    event sources)
  - ✅ `budget.ts` (BudgetController; per-phase estimates; wraps
    existing `GoalConfig`)
  - ✅ `fitness.ts` (FitnessVector type foundation; `scoreToFitnessVector`
    adapter; weighted aggregate. Six-component shape with neutral
    defaults for unmeasured components.)
  - ✅ `provenance.ts` (read-side graph: `show`, `descendants`,
    `commonAncestor` over `rsi_log` cache. `rsiProvenanceGraph`
    bridge-backed + `inMemoryProvenanceGraph` for tests.)
- Tests for the above (`*.test.ts` in `FeralAgent/tests/`)
- AGENTS.md / topic file updates
- Inventory reports for Opus

**Opus / higher-reasoning territory:**
- Anything that touches the engine composition root (`engine.ts`)
- Anything that adds a new `OutboundEvent` variant (TS type-union
  impact is broad)
- Anything that modifies `population-manager.ts` or `champion.ts`
- The Evolution Contract 8-stage state machine
- The 7-stage Dream Cycle rewrite
- Rust scorer extension (4 → 6 components in `scorer.rs`) — touches
  every `rsi_score` consumer
- Tree-of-champions refactor (per-species champion map in
  `champion.ts` + `core/agent-loop.ts` + `sidecar.ts` seed cascade)
- Anything that crosses the Tauri bridge (`adapters.ts`, `commands.rs`)

**Landmine reminder:** the Faza 2-3 spec code paths
(`rsi_commit_code_patch`, `rsi_apply_meta_patch`) need Opus + a
careful Tauri bridge redesign because `BRIDGE_TIMEOUT_MS = 30_000`
won't cover LLM-driven code proposal latency.

---

## Hard invariants summary (see `docs/invariants.md` for full structure)

Every invariant has four pillars: Documentation, Test, Runtime
Assert, Audit. Each is classified HARD (violation = HALT) or SOFT
(violation = warning + ADR + version bump).

**HARD (12):**
- I1: Ratchet strict-greater (single source of truth for advancement)
- I2: Single advancement path (only ratchet-handler advances main)
- I3: Journal append-only
- I4: Journal corruption observable (throws on malformed JSON)
- I5: Budget halt on breach (explicit estimate + breach → HALT)
- I6: Confidence gate precedence (sample size → direction → significance → magnitude → confidence)
- I7: Trust boundary — scorer immutable (Rust)
- I8: Tier 0 immutable (Rust, frozen 13 specs)
- I9: SandboxBounds agent-immutable (UI-only mutation, audit chain)
- I10: Personal Fitness bounded ([0, 1] always)
- I11: FitnessVector aggregate bounded ([0, 1] always)
- I12: Provenance graph acyclic (git substrate)
- I13: Per-instance data isolation (PENDING — partial coverage)
- I14: Human approval gate for L3+ changes (PENDING — Contract FSM not yet built)

**SOFT (4):**
- S1: Average confidence ≥ 0.95
- S2: Niche count ≥ 3
- S3: Per-cycle observations ≥ 1
- S4: Tree depth ≤ N

## Observability (see `docs/observability-data-model.md`)

Single Evolution Event Schema. All observability consumers
(journal, dashboard, metrics, audit) subscribe to the same stream.
~28 event kinds across 10 categories (candidate / eval / confidence
/ budget / species / rollback / cycle / observability / bounds /
invariant). Adding a new consumer = subscribe; adding a new event
kind = extend schema + ADR.

## ADRs (see `docs/adr/`)

Eleven ADRs landed 2026-06-30:
- 0001: BRSI naming
- 0002: Governance vs Meta Evolution split
- 0003: Hard vs Soft invariants
- 0004: Single Evolution Event Schema
- 0005: Personal Fitness as first-class objective
- 0006: Append-only provenance graph
- 0007: Trust boundary (Rust-immutable scorer)
- 0008: Evolution runtime as DAG, not layers
- 0009: FER (Feral Evolution Runtime) naming
- 0010: Microkernel architecture
- **0011: EvalHalted event semantics** — adds `EvalHalted` as sibling of `EvalComplete`, not a variant. Required by INVARIANT I15 (EvalHalted requires reason). Audit-trail distinguishes "eval crashed" from "eval never started".

## Linter (scripts/check-invariant-coverage.ts)

A four-pillar coverage checker for INVARIANTS.md. Each invariant must have:
- Documentation (in INVARIANTS.md, by construction)
- Test (test file references the invariant by ID)
- Runtime Assert (source file references it)
- Audit (audit chain references it)

Run modes:
- `bun run scripts/check-invariant-coverage.ts` — report only.
- `bun run scripts/check-invariant-coverage.ts --strict` — exit 1 if any HARD invariant is missing pillars.
- `bun run scripts/check-invariant-coverage.ts --json` — machine-readable output.

**Current state (2026-06-30):** 0/15 HARD invariants have all 4 pillars. Tests don't reference invariant IDs yet (Opus's work). This is honest and expected — the codebase hasn't yet wired the explicit markers.

## Modules landed (2026-06-30, opencode session)

| Module                                  | Tests | Coverage                                                                                          |
| --------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `FeralAgent/src/rsi/journal.ts`         | 17    | BRSI §2.9 schema: append-only JSONL, per-day rotation, soft-failure contract, type guard, malformed-JSON throws. |
| `FeralAgent/src/rsi/confidence.ts`      | 24    | BRSI §2.7: paired bootstrap (Mulberry32), Cohen's d, gate evaluator. Locked thresholds (strict). |
| `FeralAgent/src/rsi/budget.ts`          | 21    | BRSI §2.5: 6-resource caps, peak vs cumulative semantics, fail-open on null estimate.            |
| `FeralAgent/src/rsi/fitness.ts`         | 15    | BRSI §2.2: 6-component FitnessVector, `scoreToFitnessVector` adapter, locked weights, weighted aggregate. |
| `FeralAgent/src/rsi/personal-fitness.ts`| 24    | BRSI §2.10: signal aggregation (Option B — weights are magnitudes, values carry sign), audit-entry adapter, recall-count adapter. |
| `FeralAgent/src/rsi/provenance.ts`      | 22    | BRSI §2.6: read-side graph (`show`, `descendants`, `commonAncestor`), bridge-backed with cache, in-memory variant for tests. |
| `FeralAgent/src/rsi/instance-paths.ts`  | 14    | Per-tenant path computation. Single source of truth for `~/.feral/rsi/` paths; `assertTenant` defends against `../` and shell-meta escapes. Used by `journal.ts`. Per-instance split (BRSI §3.3) is a one-file change here. |
| `FeralAgent/src/rsi/contract.ts`        | 14    | Contract FSM TYPE LAYER only: 9-stage ordered pipeline, `ContractState`, `StageResult`, `ContractDeps`, `makeInitialState`. Handler implementations are Opus's territory (engine composition root). |

**Total new tests: 123. Test gate at end of session: 1384 pass / 5 skip / 0 fail.
Typecheck gate: clean.**

### Design notes (decisions worth remembering)

1. **Journal**: Pure append-only, no hash chain in v1. The chain discipline
   from `src/sandbox/audit-log.ts:47-52` and
   `src-tauri/src/rsi/audit.rs:226-232` is documented as a v2 TODO —
   mirror when the journal becomes a Layer-5 input.

2. **Confidence**: Mulberry32 PRNG for determinism; tests pin the seed.
   Gate precedence (BRSI §2.7): sample size → direction → significance
   → magnitude → confidence. Each rejection carries a specific reason.

3. **Budget**: `cpuPct` and `ramMb` are PEAK (Math.max), the rest are
   CUMULATIVE (sum). `null` estimate = fail-open allow=true with a
   reason that flags "no estimator" — operator's signal to wire one.

4. **Fitness**: `scoreToFitnessVector` lifts the scalar Rust score to
   6 components with the convention `accuracy = toolSuccess = score/100`
   and `latency = cost = 1 - score/100`. `hallucination` and
   `userSatisfaction` get the neutral 0.5 default and are flagged
   unmeasured. The aggregate uses HIGHER_BETTER as an explicit allow-list;
   everything else is implicitly "lower better" (matches Rust sign convention).

5. **Personal Fitness**: Option B — weights are magnitudes (always positive),
   signal values carry sign. This is the natural model: `value = +1` for a
   tool_success, `value = -1` for tool_error, weight determines how much
   that signal matters. Default weights tuned so a single
   edit-after-accept hurts more than one tool success helps.

6. **Provenance**: `rsiProvenanceGraph` caches `rsi_log(N)` once on first
   use; subsequent queries operate on the cache. The bridge only re-enters
   for `rsi_lca`. The in-memory variant exists for tests and tooling that
   has already materialised the log.

### Open gaps the next agent should know about

- **`memory_reuse` recall signal has no producer yet.** The
  `recallCountsToUserSignals` adapter is the consumer side; the producer
  (call site that feeds hit/miss counts) is TODO. Likely a hook on
  `tools/builtin/recall.ts`.
- **`acceptance` and `edit_after_accept` signal kinds have no source.**
  The aggregator supports them; the engine doesn't emit them yet.
  BRSI §2.10 said this — the gap is real, not a code bug.
- **`preference_match` and `workflow_completion` likewise.** Awaiting
  Layer 2 (UIA demo pipeline) work to wire them.
- **`FitnessVector.userSatisfaction` is filled by `computePersonalFitness`
  via `fitnessVector({ userSatisfaction: <aggregate> })`.** No live
  wiring yet — the ratchet handler doesn't read from `personal-fitness.ts`.
  Wiring it requires a function call from `ratchet-handler.ts:77` (or
  wherever `IterationMetadata` is composed) into the new module.
- **Provenance envelope storage is TODO.** The `ArtifactEnvelope` type
  ships; the on-disk write path doesn't. Likely `~/.feral/rsi/envelopes/`
  following the journal layout, with a small loader wired into
  `provenance.ts`.
- **`metrics.ts` deliberately deferred.** Per the user / GPT 5.5
  discussion: metric definitions shift as the Contract FSM introduces
  new pipeline stages. "Mutation Success Rate" can mean
  `accepted/attempted`, `accepted/evaluated`, or
  `accepted/confidence_pass` depending on where you measure. Defining
  the metric before the contract exists creates an implicit contract.
  Build it after the Contract FSM is in place. See the deferred
  metrics inventory in the prior opencode session.
- **Hard invariants I13, I14 are PENDING runtime enforcement.** They
  are documented; the corresponding machinery (per-instance path
  split, Contract FSM) is not yet built.

## Order of operations recommended

1. Read `docs/wiring-spec.md` first. It names the EXACT call sites
   and EXACT context for each module produced in this session.
2. Read `docs/invariants.md` and `docs/feral_philosophy.md` before
   touching anything in `FeralAgent/src/rsi/` or
   `src-tauri/src/rsi/`.
3. Read `docs/brsi-spec.md` §10 (DAG) for the dependency graph before
   scoping any refactor.
4. Read the relevant ADR(s) before changing anything the ADR
   constrains.
5. For the engine composition root (`engine.ts`), Contract FSM
   runner + handlers (`contract.ts`), Dream Cycle rewrite
   (`dream-cycle.ts`), and Tree-of-Champions refactor — these are
   Opus territory by division of labor. The contract.ts TYPE LAYER
   ships today; handlers are the next step.
6. For metrics: build *after* the Contract FSM exists, so the
   metric definitions can land in one pass.

---

## Naming convention (per ADR-0009)

- **Feral Evolution Runtime (FER)** = the runtime, the engine, the
  bounded self-improvement system. The thing with Memory, Governance,
  Genome, Champion, Species, Ratchet, LoRA, Lineage, Contract,
  Journal.
- **Personal Agent** (or "Personal AI") = the user-facing assistant
  that runs ON the FER. Today's implementation is the sidecar agent
  loop; tomorrow it could be a different agent entirely.
- **Foundation model** = Gemma, Qwen, Llama, etc. Swappable. The FER
  does not own it; the FER evolves the policy on top of it.

The FER is foundation-model-agnostic: **FER + Gemma**, **FER +
Qwen**, **FER + Llama**, **FER + tomorrow's models**. The runtime
is the product; the model is a dependency.

## Microkernel architecture (per ADR-0010)

The FER is a microkernel:

```
  KERNEL: engine.ts + EventBus + ratchet + champion
       │
       ├── confidence.ts    (no imports from rsi/)
       ├── budget.ts        (type-only re-export from journal.ts)
       ├── journal.ts       (no imports from rsi/)
       ├── provenance.ts    (type-only: RsiBridge from bridge.ts)
       ├── personal-fitness.ts  (no imports from rsi/)
       └── fitness.ts       (type-only re-export from journal.ts)
```

Modules are independently testable. Cross-module communication only
via the EventBus or direct injection. Adding a new module doesn't
touch existing modules.

---

## Wiring spec (call sites for the next session)

`docs/wiring-spec.md` is the integration guide. Summary:

| Module | Wire to | Status |
| ------ | ------- | ------ |
| `confidence.ts` | `ratchet-handler.ts:77` (before `ratchetAttempt`) | TypeScript-only signature change |
| `journal.ts` | `ratchet-handler.ts:80` + `dream-cycle.ts:71` | TypeScript-only; `instance-paths.ts` already delegates |
| `budget.ts` | Contract FSM (new module) per stage | Tied to contract.ts handler impl |
| `fitness.ts` | `eval-worker.ts:56` (lift scalar → vector) | TS shape change to `ScoreResult` + `RsiEvent` |
| `personal-fitness.ts` | `ratchet-handler.ts:80` (Option B) | Audit reader injection |
| `provenance.ts` | Frontend only (read-side, no engine wire) | None |
| `contract.ts` | Engine composition root | Type layer ships; handlers = Opus |
| `instance-paths.ts` | Already wired into `journal.ts` | `champion.ts` refactor deferred |

Test scaffolding for the next session is documented in §11 of the
wiring spec.

---

*End of working notes. Update when a fact changes. The next agent
(Opus or otherwise) should be able to pick up from here without
re-running the audit.*