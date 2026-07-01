# Feral BRSI — Handoff Brief for Opus

> **Status:** Comprehensive handoff prompt. Self-contained — Opus does
> not need the conversation history.
> **Author:** opencode (MiniMax-M3), 2026-06-30, end of session.
> **Audience:** Opus, on next session.

---

## 0. Mission (one sentence)

Implement the orchestration layer that turns Feral from a config-evolution engine (Faza 1) into the BRSI system described in `docs/brsi-spec.md` — specifically the Evolution Contract 8-stage FSM, the 7-stage Dream Cycle rewrite, and the Tree of Champions refactor — by wiring the 8 production-ready modules already shipped in this session.

---

## 1. Read these first (in order, ~1 hour total)

| # | Doc | Time | Why |
| - | --- | ---- | --- |
| 1 | `docs/feral_philosophy.md` | 5 min | The "why" before any "what". Internalize this or you'll write code that violates invariants for performance. |
| 2 | `docs/wiring-spec.md` | 15 min | The integration guide. Every call site, every required change, every risk, every order of operation. |
| 3 | `docs/invariants.md` | 15 min | Runtime contracts. Each has four pillars (Documentation, Test, Runtime Assert, Audit). HARD = violation = HALT. SOFT = warning + ADR + version bump. |
| 4 | `docs/brsi-spec.md` §5 (Roadmap) + §10 (Architecture DAG) | 10 min | Layers for presentation (autonomy scale); DAG for engineering (dependency graph). |
| 5 | `docs/agents-memory/project_brsi_evolution.md` | 10 min | The project-memory index. Re-read whenever context is lost. |
| 6 | `docs/adr/0001-0011.md` | 10 min | Design history. Each ADR is context/decision/consequences. **ADR-0011 (EvalHalted semantics) is critical for Contract FSM.** |

**If you only have 30 minutes:** read §1 + §3 in full, skim §2 + §4.

---

## 2. Context — what Feral is and where it is

**Feral** is a local-first, bounded-self-improving AI agent:

- **Host:** Tauri (Rust) — the engine, the immutable core, the trust boundary
- **Sidecar:** Bun/TypeScript — the agent loop, talks to host over newline-delimited JSON on stdin/stdout
- **Frontend:** Leptos/React

**BRSI (Bounded Recursive Self-Improvement)** is the project's identity claim:

> Feral is not designed to improve without limits. It is designed to
> improve **safely, measurably, and reversibly**, within explicit
> user-defined boundaries.

The "B" is the contribution. Open-ended RSI is not the goal.

**Current state (2026-06-30):**

- Faza 1 (config evolution) ships. Engine composition works.
- **1412 tests pass, 5 skip, 0 fail.** Typecheck clean.
- **8 modules in `FeralAgent/src/rsi/`** — pure / tested / most NOT wired (this is your work).
- **4 new docs** (invariants, philosophy, observability-data-model, wiring-spec).
- **8 ADRs** + updated BRSI spec with Layer 5/6 split + Architecture DAG.

**What's missing for "BRSI live":**

- **Orchestration.** The primitives are built; the choreography is not.
- **Wire-up.** The 6 production modules need to be called from existing event handlers.
- **Engine composition root changes.** `engine.ts` is the integration point.

---

## 3. What's built (don't redo)

All in `FeralAgent/src/rsi/`:

| Module | Tests | Purpose | Wired? |
| ------ | ----- | ------- | ------ |
| `journal.ts` | 17 | BRSI §2.9 Evolution Journal writer (append-only JSONL, soft-failure, type guard) | Path only |
| `confidence.ts` | 24 | BRSI §2.7 paired bootstrap + Cohen's d + gate evaluator (Mulberry32 PRNG) | **No** |
| `budget.ts` | 21 | BRSI §2.5 6-resource caps, peak vs cumulative semantics, fail-open contract | **No** |
| `fitness.ts` | 15 | BRSI §2.2 6-component FitnessVector + `scoreToFitnessVector` adapter + aggregate | **No** |
| `personal-fitness.ts` | 24 | BRSI §2.10 UserSatisfaction aggregator (Option B magnitudes + audit/recall adapters) | **No** |
| `provenance.ts` | 22 | BRSI §2.6 read-side graph (show/descendants/commonAncestor) over `rsi_log` cache | Frontend |
| `instance-paths.ts` | 14 | Per-tenant path computation, defensive tenant validation (`assertTenant`) | Partial (journal) |
| `contract.ts` | 14 | **Types only.** 9-stage FSM (STAGE_ORDER, ContractState, StageResult, ContractDeps, makeInitialState). **You implement the runner + handlers.** | **No** |

Total new tests: 165. All passing.

**Companion Rust side (untouched, do not edit in this session):**
- `src-tauri/src/rsi/repo.rs` — git substrate, ratchet invariant at line 344
- `src-tauri/src/rsi/scorer.rs` — 4-component scorer (extend to 6 is OUT OF SCOPE this session)
- `src-tauri/src/rsi/sandbox_bounds.rs` — agent-immutable contract
- `src-tauri/src/rsi/audit.rs` — hash-chained NDJSON log
- `src-tauri/src/rsi/goodhart.rs` — regression detector (reuse at Stage 6 of Contract)

---

## 4. What's locked (don't reopen)

Re-opening requires explicit user approval. Defaults are documented in
`docs/brsi-spec.md` §9 and the companion `continual-personal-adaptation-plan.md` §8.

| # | Decision | Value |
| - | -------- | ----- |
| D1 | Initial species list | **2** (research + coding). Per ADR-0002. |
| D2 | Confidence thresholds | **Strict**: p<0.05 + effect≥0.1 + confidence≥0.95 |
| D3 | Promotion gate | N=5 cycles + M=10 ratchets for L0→L5. **Stricter L5→L6: N=10 + M=30.** |
| D4 | Fitness weights | Ship §2.2 defaults (0.30/0.20/0.15/0.15/0.10/0.10); learn from Journal after 30 cycles |
| D5 | Naming | Internal "RSI"; external "Evolution" / "Personal Adaptation" / "Bounded Self-Improvement" by layer |
| D6 | Journal format | JSONL (mirrors `dream-telemetry.ts`) |
| D7 | Confidence-gate failure visibility | **Both** UI + Journal |
| D8 | Tree archive size | 20 per species, age-out LRU |
| D9 | Hybrid operator timing | With species (not deferred) |
| D10 | Provenance storage | Git for code/config + typed envelopes for non-code |

**Hard/Soft invariant classification** (ADR-0003):

- **HARD** = violation = HALT / Rollback / Error. Never negotiable.
- **SOFT** = violation = Warning + log + (if persistent) ADR + version bump.

Lowering a SOFT threshold requires drift data + new ADR + version bump.

---

## 5. What's open (lock before code lands OR ship defaults)

These are the questions `docs/brsi-spec.md` §9 + `continual-personal-adaptation-plan.md` §8 + `rsi-evolution-spec.md` §8 that didn't get locked in the opencode session. Defaults are sensible; ship them if not blocking.

| Source | # | Question | Default |
| ------ | - | -------- | ------- |
| BRSI §9 | #3 | Budget caps | 30 min / 100k tokens / 50% CPU / 2 GB RAM per cycle; user-tunable |
| BRSI §9 | #6 | Personal Fitness v1 signals | acceptance + tool-call + workflow completion; memory-reuse/preference/edit-after-accept deferred |
| BRSI §9 | #12 | Dream cycle trigger | weekly + threshold (N=20 demos), whichever first; user can disable |
| CPA §8 | #2 | UIA demo scope | allowlist per app (capability manifest) |
| CPA §8 | #3 | Personal LoRA v1 | chat-model only (embedder LoRA deferred) |
| CPA §8 | #4 | LoRA training trigger | weekly + N=20 demos, whichever first |
| CPA §8 | #5 | Human-approval gate count (L3 code) | first 10 (UI counter visible) |
| CPA §8 | #6 | Personal eval suite bootstrap | both: agent proposes, user confirms |
| RSI §8 | #1 | Code patch scope (Faza 2) | `FeralAgent/src/rsi/` only (start narrow) |
| RSI §8 | #2 | Sidecar rebuild strategy | full rebuild + sidecar restart (current crash-restart); hot-reload deferred |
| RSI §8 | #3 | Meta-evolution modifying eval suite | NO — agent proposes, "pending" until human approval |
| RSI §8 | #5 | Agent proposing new eval tasks | allow proposal, "pending" until approval |

**Decision rule:** if the default doesn't block your current step, take it and note it. If it blocks, ask the user.

---

## 6. Your scope (the work)

Three pieces, ordered by blast radius (smallest first):

### 6.1 Wiring (smallest, lowest risk)

Per `docs/wiring-spec.md` end-to-end. The 6 production modules need to be called from existing event handlers:

1. Extend `RatchetDeps` and `EvalWorkerDeps` with new fields (TS-only signature changes).
2. Wire `confidence.ts` into `ratchet-handler.ts:77` (BEFORE `ratchetAttempt`).
3. Wire `journal.ts` into `ratchet-handler.ts:80` + `dream-cycle.ts:71`.
4. Wire `personal-fitness.ts` aggregator (Option B per wiring spec §5).
5. Wire `fitness.ts` into `eval-worker.ts:56` (lift scalar → vector).
6. Add new event kinds to `event-bus.ts` (ConfidencePassed/Failed, BudgetExceeded, MutationCreated/Applied, EvalHalted). **ADR per kind** per the Evolution Event Schema (ADR-0004).

Each step has a test scaffold described in wiring-spec §11.

### 6.2 Contract FSM (medium)

`FeralAgent/src/rsi/contract.ts` ships the type layer. You implement:

- The runner (`RunContract` signature in `contract.ts`).
- 8 stage handlers (static_analysis, sandbox_apply, tests, benchmark, safety_checks, regression, deploy, monitoring).
- Pre-check pattern: `assertBudget(phase, estimate)` BEFORE each stage (INVARIANT I5).
- Post-benchmark gate: `evaluateConfidence(samples)` (INVARIANT I6).
- Journal write on completion OR halt (INVARIANT I3, I4).

The runner is the orchestration. Each stage handler is composed from existing primitives.

### 6.3 Dream Cycle rewrite (medium)

Per ADR-0008. `dream-cycle.ts` is currently a glue layer. Refactor to the 7-stage FSM per BRSI §2.8:

```
Wake → Observe → Dream → Mutate → Evaluate → Remember → Wake
```

This means:

- New state machine (similar pattern to Contract FSM, but at cycle level not candidate level).
- Add 4 trigger types to `DreamTrigger` in `dream-scheduler.ts:26`: `"schedule" | "threshold" | "user" | "budget_available"` (currently only `"idle" | "error"`).
- Add `cycle_stage` variant to `fractal_activity` kind (requires FE filter update at `frontend-react/src/lib/tauri/events.ts:87` + `frontend-react/src/pages/MemoryLayersPage.tsx:139-145`).
- Per-stage observability events per `docs/observability-data-model.md`.

### 6.4 Tree of Champions + Species (largest)

Per BRSI §4.3 + §4.4. Refactor:

- `champion.ts` from single global champion to `SpeciesChampions` map.
- Add `species_id` to `Genome` and `IterationMetadata` (population-snapshot version bump v1 → v2).
- Species assignment via `escape-time.ts` region key.
- Per-species champion selection by query context.
- Initial species: research + coding (D1).

---

## 7. Wiring spec

**Read `docs/wiring-spec.md` end-to-end before touching anything.** It has:

- Exact call sites (file:line + context).
- Before/after code diffs for each wire.
- Required signature changes.
- Invariant coverage per wire.
- Risk inventory.
- Order of operations (9 steps).
- Test scaffolding.

---

## 8. Hard constraints (invariants you must honor)

Top 5 you'll hit most often:

| # | Invariant | One-line |
| - | --------- | -------- |
| **I1** | Ratchet strict-greater | Only `ratchet-handler.ts` may advance main lineage. Rust `repo.rs:344` is source of truth. TS gates pre-check BEFORE commit. |
| **I3** | Journal append-only | No update/delete API. Malformed JSON throws on read. |
| **I5** | Budget halt on breach | Explicit estimate + breach → HALT. `null` estimate is fail-open (different category — see INVARIANTS.md). |
| **I6** | Confidence gate precedence | Sample size → direction → significance → magnitude → confidence. Each rejection has a specific reason. |
| **I7** | Trust boundary | Scorer is Rust-immutable. Agent cannot edit the formula. ADR-0007. |

Full list (12 HARD + 4 SOFT) in `docs/invariants.md`. **Every change must identify which invariant(s) it preserves or challenges.**

---

## 9. Risks (12 landmines from the audit)

| # | Risk | Mitigation |
| - | ---- | ---------- |
| 1 | `bridge.ts:54` timeout (30s) won't cover LLM-driven mutations (Faza 2+) | Per-stage timeouts. |
| 2 | `fractal_activity.kind` sealed (`recall\|grow\|seed\|prune`). Adding `cycle_stage` requires FE filter update. | Coordinate with FE. |
| 3 | `eval-worker.ts:67-80` always emits `EvalComplete{errored:true, score:0}`. Contract's pre-check has no entry point that DOESN'T produce an eval. | Add `EvalHalted` event. |
| 4 | `engine.ts:118-120` silently overwrites `selection.taste` when `tasteMiner` is supplied. | Right precedence for production, confusing in tests. |
| 5 | `pbt-controller.ts:46` requires `tokenCost: number`. `ratchet-handler.ts:88` normalises with `?? 0`. | Watch for upstream regressions. |
| 6 | `extinction-handler.ts:62-65` resets `lastBest` at construction. First-cycle blind spot. | Read `iterations_since_improvement` from snapshot. |
| 7 | `population-snapshot.ts:32` is `SNAPSHOT_VERSION = 1`. Adding species state requires v1→v2 + graceful v1 fallback. | Update `readPopulationSnapshot` to reject v1 with fallback. |
| 8 | `tier-loader.ts:43-77` throws on malformed JSON. Personal eval suite loader will hit this if it moves to disk. | Personal suite needs its own validator. |
| 9 | `passive-supervisor.ts` (legacy) coexists with `dream-cycle.ts`. | Cleanup separate from BRSI work. |
| 10 | `audit.rs` and `sandbox/audit-log.ts` share hash-chain discipline. | When Journal adds hash chain (v2), mirror this. |
| 11 | `engine.ts:118-120` (same as #4). | — |
| 12 | `fractal_activity` kind sealed (same as #2). | — |

Plus from wiring-spec §12: per-stage timeouts needed; snapshot v1→v2 bump; tier-loader strictness.

---

## 10. Working agreement

- **Tests gate:** `cd FeralAgent && bun test` must pass at 100% before commit. `cd FeralAgent && bunx tsc --noEmit` must be clean. Existing **1412** + your new tests.
- **One invariant = one ADR.** If you change an invariant (add, remove, reclassify HARD→SOFT, lower threshold), write an ADR first in `docs/adr/`.
- **Schema changes need an ADR.** Adding event kinds to `OutboundEvent` or `RsiEvent`, changing `RsiEvent` payload, bumping `SNAPSHOT_VERSION` — all need ADRs.
- **No silent engine modifications.** Every change to `engine.ts`, `ratchet-handler.ts`, `eval-worker.ts`, `dream-cycle.ts`, `selection-handler.ts` should reference an invariant in the test header.
- **Don't widen SandboxBounds from the agent side.** ADR-0007. UI-only mutation.
- **The git substrate (`repo.rs:344`) is the source of truth for advancement.** TS gates pre-check; Rust decides.
- **Don't extend the Rust scorer this session.** Extending `scorer.rs` from 4 → 6 components is OUT OF SCOPE (per the user's session boundary). TS handles the lift via `scoreToFitnessVector` adapter.
- **Touch `src-tauri/src/rsi/` only for new commands** (e.g., `rsi_run_contract`). Don't modify existing scorers, bounds, audit, repo, paths.

### 10.1 Discipline guard rail

The 8 production modules shipped in this session are **frozen** as
public APIs. Your task is **orchestration, not redesign**:

> **Do not rewrite existing pure modules unless an invariant is
> violated. Prefer composition over replacement. Preserve
> additive migration paths.**

Concretely:

- **Don't rename** `evaluateGate`, `assertCanSpend`, `scoreToFitnessVector`, `computePersonalFitness`, `appendJournal`, `rsiProvenanceGraph`, or any exported symbol. Consumers (the engine) reference these names.
- **Don't change** the signatures of `ConfidenceGateDecision`, `BudgetDecision`, `FitnessVector`, `JournalEntry`, or `ProvenanceNode` without an ADR. Their shapes are the contract.
- **Don't reimplement** the bootstrap in `confidence.ts` (paired bootstrap, Cohen's d, Mulberry32 PRNG). The math is the math.
- **Don't collapse** `budget.ts`'s peak/cumulative distinction. CPU% and RAM are peaks; the rest are cumulative.
- **Don't unify** the Personal Fitness adapter interfaces. `auditEntriesToUserSignals` and `recallCountsToUserSignals` are separate for a reason.

If you find yourself wanting to "improve" one of these modules,
that's a signal to write an ADR proposing the change — not to do
it inline. The discipline is what makes the orchestration safe.

---

## 11. First concrete steps (today)

1. **Read §1 in full.** (~1 hour.) Set the context.
2. **Lock the open decisions** (§5). Either ship the defaults or ask the user. Defaults are sensible.
3. **Wiring-spec §13 step 1** — Extend `RatchetDeps` and `EvalWorkerDeps` with the new fields. TypeScript-only signature change; no behaviour change yet. Tests pass.
4. **Wiring-spec §13 step 2** — Wire `confidence.ts` into `ratchet-handler.ts:77`. This is the smallest blast-radius wire-up. ~20 lines. Add a test that exercises the reject path (INVARIANT I6).
5. **Wiring-spec §13 step 3** — Wire `journal.ts` into `ratchet-handler.ts:80` + `dream-cycle.ts:71`. Begin populating the Journal. Add a test that asserts journal entries appear (INVARIANT I3).

These three steps land "BRSI live" at the L1 layer. Layers 2-6 build on this foundation.

Then continue with steps 4-9 of wiring-spec §13 (wiring completion), then Contract FSM (§6.2), Dream Cycle rewrite (§6.3), Tree of Champions (§6.4).

---

## 12. Resources

- **Code:** `FeralAgent/src/rsi/` (modules), `src-tauri/src/rsi/` (Rust), `frontend-react/` (UI)
- **Docs:** `docs/` — start with `docs/feral_philosophy.md`, `docs/wiring-spec.md`, `docs/invariants.md`
- **ADRs:** `docs/adr/` — 11 captured decisions; add new ones as `0012-name.md` (sequential, never reused)
- **Tests:** `FeralAgent/tests/` — mirror style of `tests/rsi-confidence.test.ts` and `tests/rsi-journal.test.ts`
- **Topic file:** `docs/agents-memory/project_brsi_evolution.md` — the index. Re-read when context is lost.
- **Companion specs:** `docs/rsi-evolution-spec.md` (Faza 1-5 engine internals), `docs/continual-personal-adaptation-plan.md` (6-layer roadmap)
- **Linter:** `scripts/check-invariant-coverage.ts` — verifies each invariant has its 4 pillars. Run with `--strict` to fail CI on missing HARD pillars.

---

## 13. Communication

- **Reversible decisions with obvious defaults → take them, note them, keep moving.**
- **Irreversible or destructive actions → always confirm first.** (Bumping SNAPSHOT_VERSION, removing a HARD invariant, lowering a SOFT threshold without ADR, deleting public APIs.)
- **Don't open new invariant categories without an ADR.** If you find a new safety property that should be guaranteed, propose it as an ADR + invariant entry.
- **When you change the type layer** (e.g., extending `RatchetDeps`), update `docs/wiring-spec.md` so the spec stays in sync with the code.
- **When you decide one of the open questions in §5, update this brief** (or note it in the journal) so the next session has the new state.
- **When you add an event kind to `event-bus.ts` or `OutboundEvent`**, the type union change touches FE. Open an ADR per ADR-0004 (single Evolution Event Schema).

---

*You have everything you need. The hard parts are scoped, the constraints are explicit, the integration points are named. The user's most-quoted line this session: "Feral is more mature than I thought." The infrastructure is solid. Your job is to make it move.*

*Implement.*