# INVARIANTS.md — Cinderpaw BRSI Safety Contracts

> Runtime contracts the engine MUST NOT violate. Each invariant has
> four pillars (Documentation, Test, Runtime Assert, Audit) and a
> classification (HARD or SOFT). An invariant is incomplete until all
> four pillars exist.
>
> **Read this before**: changing any invariant, proposing a new
> invariant, removing an invariant, or relaxing its classification.
>
> **Read this instead of arguing on a PR** when someone proposes
> "let's remove X, it slows evolution". This file is the answer.

---

## 1. Classification

| Class | Violation response | Negotiable? |
| ----- | ------------------ | ----------- |
| **HARD** | HALT / Rollback / Error | Never. Promote → version bump + new ADR. |
| **SOFT** | Warning + log + versioned relaxation | Tunable via SandboxBounds, but the threshold must be declared in this file. |

A SOFT invariant is a target with an explicit threshold. A HARD
invariant is a contract with no version where it doesn't hold.

## 2. The four pillars

Every invariant, regardless of class, must have all four:

| Pillar | What it is | Where it lives |
| ------ | ---------- | -------------- |
| **Documentation** | The Statement field below — precise, testable, complete | This file |
| **Test** | A unit / property test that fails when the invariant breaks | `CinderpawAgent/tests/` or `src-tauri/src/**/tests.rs` |
| **Runtime Assert** | A check inside the engine that fails fast (throws / panics / returns error) | The module that "owns" the invariant |
| **Audit** | A row in `~/.feral/rsi/sandbox_bounds.audit.log` when the invariant is checked OR breached | `audit.rs` |

If any pillar is missing, the invariant is **incomplete**. The Status
field below carries "PENDING RUNTIME ENFORCEMENT" or similar until all
four are present.

## 3. Invariant Index

| # | Name | Class | Owner | Status |
| - | ---- | ----- | ----- | ------ |
| I1  | Ratchet strict-greater              | HARD | `repo.rs`, `ratchet-handler.ts` | ACTIVE |
| I2  | Single advancement path             | HARD | `ratchet-handler.ts`, `repo.rs` | ACTIVE |
| I3  | Journal append-only                 | HARD | `journal.ts` | ACTIVE |
| I4  | Journal corruption observable       | HARD | `journal.ts` | ACTIVE |
| I5  | Budget halt on breach               | HARD | `budget.ts`, Contract FSM (Opus) | ACTIVE (logic) / PENDING (consumer) |
| I6  | Confidence gate precedence          | HARD | `confidence.ts` | ACTIVE |
| I7  | Trust boundary — scorer immutable   | HARD | `scorer.rs` | ACTIVE |
| I8  | Tier 0 immutable                    | HARD | `tier0.rs` | ACTIVE |
| I9  | SandboxBounds agent-immutable       | HARD | `sandbox_bounds.rs`, `audit.rs` | ACTIVE |
| I10 | Personal Fitness bounded            | HARD | `personal-fitness.ts` | ACTIVE |
| I11 | FitnessVector aggregate bounded     | HARD | `fitness.ts` | ACTIVE |
| I12 | Provenance graph acyclic            | HARD | `repo.rs` (git substrate) | ACTIVE |
| I13 | Per-instance data isolation         | HARD | `paths.rs`, per-instance split (PENDING) | PENDING |
| I14 | Human approval gate for L3+ changes | HARD | `pending-patches.ts` | ACTIVE (L3); no L4/L6 proposer exists |
| I15 | EvalHalted requires reason          | HARD | `event-bus.ts` + Contract FSM (Opus) | ACTIVE (type + runtime) / PENDING (emitter) |
| S1  | Average confidence ≥ 0.95           | SOFT | `confidence.ts`, Journal | ACTIVE |
| S2  | Niche count ≥ 3                     | SOFT | `population-manager.ts` | PENDING |
| S3  | Per-cycle observations ≥ 1          | SOFT | Contract FSM (Opus) | PENDING |
| S4  | Tree depth ≤ N (N configurable)     | SOFT | Tree of Champions (Opus) | PENDING |

---

## 4. Hard Invariants

### Invariant I1 — Ratchet strict-greater

**Statement:** The main lineage advances if and only if
`candidate_score > prior_score_value`. The strict-greater comparison in
`crates/cinderpaw-core/src/rsi/repo.rs:362` is the **single source of
truth** for "main advances only on improvement".

**Owner:**
- TypeScript: `CinderpawAgent/src/rsi/l1-config/ratchet-handler.ts`
- Rust: `crates/cinderpaw-core/src/rsi/repo.rs::ratchet_attempt` (line 337)

**Verified By:**
- Documentation: this entry
- Test: `crates/cinderpaw-core/src/rsi/repo.rs::tests` (ratchet_attempt
  fixture tests)
- Runtime Assert: Rust-side invariant; TS-side Confidence gate pre-check
  (`CinderpawAgent/src/rsi/confidence.ts`) before any `rsi_commit_genome`
- Audit: every `RatchetAdvanced` event logged

**Failure Mode:** HALT — a non-ratchet code path attempting to advance
main is an invariant violation.

**Recovery:** Rollback to last known-good commit; require human
intervention.

**Introduced:** v0.9.0 (BRSI spec landed 2026-06-30)
**Status:** ACTIVE

---

### Invariant I2 — Single advancement path

**Statement:** Only `ratchet-handler.ts` may trigger
`rsi_ratchet_attempt` for the main lineage. No other code path is
permitted to advance main, regardless of score.

**Owner:**
- TypeScript: `CinderpawAgent/src/rsi/ratchet-handler.ts`
- Rust: `src-tauri/src/rsi/repo.rs::ratchet_attempt`

**Verified By:**
- Documentation: this entry
- Test: integration test that asserts no other module calls
  `rsi_ratchet_attempt` (grep-based guard)
- Runtime Assert: Rust-side access control — `ratchet_attempt` is the
  only command in `commands.rs` that mutates the main ref
- Audit: every ratchet attempt logged with caller context

**Failure Mode:** HALT.

**Recovery:** Rollback; log the offending caller; surface to UI.

**Introduced:** v0.9.0
**Status:** ACTIVE

**Notes:** This invariant is what makes I1 enforceable. If multiple
paths could advance main, I1's single source of truth would be
ambiguous.

---

### Invariant I3 — Journal append-only

**Statement:** Journal entries are immutable once written. No API
allows modifying, deleting, or reordering existing entries.

**Owner:** `CinderpawAgent/src/rsi/journal.ts::appendJournal`,
`readJournal`

**Verified By:**
- Documentation: this entry
- Test: `tests/rsi-journal.test.ts` (no `updateJournal` /
  `deleteJournal` API exists; happy-path tests cover append-only)
- Runtime Assert: `readJournal` THROWS on malformed JSON
  (`isJournalEntry` type guard rejects stale-schema rows)
- Audit: hash chain discipline (TODO v2 — see `audit.rs:228-229` for
  the pattern to mirror; chain marker `0x02` for cross-language
  auditors)

**Failure Mode:** Corruption — a malformed row throws on read. The
engine does NOT silently drop a corrupt row; the operator must
acknowledge.

**Recovery:** Operator inspects the file, decides whether to (a) fix
the row in place + restart, (b) accept data loss + restart (audited).

**Introduced:** v0.9.0
**Status:** ACTIVE (append-only + throws); PENDING (hash chain v2)

---

### Invariant I4 — Journal corruption observable

**Statement:** A corrupted journal row is surfaced as a thrown error
on read, never silently dropped or skipped. This is the operator's
signal that the audit trail needs inspection.

**Owner:** `CinderpawAgent/src/rsi/journal.ts::readJournal`

**Verified By:**
- Documentation: this entry
- Test: `tests/rsi-journal.test.ts > readJournal > throws on malformed JSON`
- Runtime Assert: `readJournal` propagates `JSON.parse` errors
- Audit: journal reads are not themselves audited (read is idempotent);
  the missing/corrupt row is its own signal

**Failure Mode:** Reading the journal fails loudly. Cycles that need
the journal must handle the error (logged in the next cycle).

**Recovery:** Operator inspects, fixes or accepts.

**Introduced:** v0.9.0
**Status:** ACTIVE

---

### Invariant I5 — Budget halt on breach

**Statement:** When `assertCanSpend(caps, spent, phase, estimate)`
returns `allow: false` for an EXPLICIT estimate, the calling contract
stage MUST halt the cycle, not skip the phase. The fail-open path
applies ONLY when `estimate === null` (no estimator available).

**Owner:**
- TypeScript: `CinderpawAgent/src/rsi/budget.ts::assertCanSpend`
- Contract FSM consumer (Opus territory — Steps 9-10 of BRSI refactor)

**Verified By:**
- Documentation: this entry
- Test: `tests/rsi-budget.test.ts` (breach → allow=false; null estimate
  → allow=true with explicit reason)
- Runtime Assert: `assertCanSpend` returns `allow=false` for any breach
- Audit: every budget decision is logged in the Journal's
  `budget_remaining` + `decided.reason` fields

**Failure Mode:** HALT the cycle. The phase MUST NOT begin.

**Recovery:** Reduce the phase estimate (smaller scope), or queue for
the next cycle.

**Introduced:** v0.9.0
**Status:** ACTIVE (logic) / PENDING (consumer — Contract FSM not yet
written)

**Critical note:** the `null` estimate path is fail-open by design
(BRSI §4.5) so the engine doesn't block on missing estimators. This
is intentional but DOES NOT extend to breaches. The two paths look
similar in code but are different categories: missing data vs
exhausted budget.

---

### Invariant I6 — Confidence gate precedence

**Statement:** The confidence gate runs checks in this order:
sample size → direction → significance → magnitude → confidence.
Each check rejects with a specific reason; no check may be skipped.

**Owner:** `CinderpawAgent/src/rsi/confidence.ts::evaluateGate`

**Verified By:**
- Documentation: this entry
- Test: `tests/rsi-confidence.test.ts > evaluateGate — gate precedence`
  (5 tests, one per precedence level)
- Runtime Assert: code structure enforces order (early returns)
- Audit: every gate decision logged in the Journal's `result.confidence`
  + `decided.reason`

**Failure Mode:** Reject the candidate with a precise reason. The
Journal's `decided.reason` carries the diagnostic.

**Recovery:** More samples; stronger signal; revisit when noise drops.

**Introduced:** v0.9.0 (locked thresholds D2: p<0.05, d≥0.1, conf≥0.95)
**Status:** ACTIVE

---

### Invariant I7 — Trust boundary — scorer immutable

**Statement:** The scorer formula, its weights, and the per-resource
normalisation constants live in Rust and are immutable from the
agent's side. The agent can ship better eval OUTCOMES but cannot
redefine what "better" means.

**Owner:**
- Rust: `src-tauri/src/rsi/scorer.rs`
- Audit: `src-tauri/src/rsi/sandbox_bounds.rs` (weights change → audit)

**Verified By:**
- Documentation: this entry + the scorer.rs module header
- Test: `scorer.rs::tests` (determinism, edge cases)
- Runtime Assert: scorer is compiled into the sidecar binary the agent
  has no filesystem write access to
- Audit: every weights change → row in `sandbox_bounds.audit.log`

**Failure Mode:** HALT — the engine never runs without a scorer;
runtime assertion would catch a missing module.

**Recovery:** Reinstall the sidecar binary.

**Introduced:** v0.9.0
**Status:** ACTIVE

---

### Invariant I8 — Tier 0 immutable

**Statement:** The 13 Tier 0 sanity checks (`TIER0_SPECS` in
`tier0.rs`) are frozen. The agent may not modify, reorder, or
remove them.

**Owner:** `src-tauri/src/rsi/tier0.rs`

**Verified By:**
- Documentation: this entry
- Test: `tier0.rs::tests`
- Runtime Assert: Tier 0 specs are loaded from a constant, not from
  the filesystem
- Audit: any future change to Tier 0 would be an ADR + version bump
  (the constant cannot be modified at runtime)

**Failure Mode:** HALT — a missing Tier 0 check would fail the eval
worker.

**Recovery:** Reinstall sidecar binary.

**Introduced:** v0.9.0
**Status:** ACTIVE

---

### Invariant I9 — SandboxBounds agent-immutable

**Statement:** SandboxBounds (scorer weights, cost caps, Goodhart
thresholds, confidence defaults, budget caps) may only be changed
via the UI, never by the agent. Every change is hash-chained and
audited.

**Owner:**
- Rust: `src-tauri/src/rsi/sandbox_bounds.rs`
- Audit: `src-tauri/src/rsi/audit.rs::save_with_audit`

**Verified By:**
- Documentation: this entry
- Test: `sandbox_bounds.rs::tests`, `audit.rs::tests`
- Runtime Assert: there is NO bridge command `rsi_set_bounds`. Bounds
  change requires UI confirmation.
- Audit: every change appends to `sandbox_bounds.audit.log` (SHA-256
  hash chain, genesis "GENESIS")

**Failure Mode:** HALT — any code path attempting `rsi_set_bounds` is
a contract violation.

**Recovery:** Reject the change; surface to UI.

**Introduced:** v0.9.0
**Status:** ACTIVE

---

### Invariant I10 — Personal Fitness bounded

**Statement:** `computePersonalFitness` returns values in `[0, 1]`,
never outside. NaN inputs are normalised to 0.

**Owner:** `CinderpawAgent/src/rsi/personal-fitness.ts::computePersonalFitness`

**Verified By:**
- Documentation: this entry
- Test: `tests/rsi-personal-fitness.test.ts` (random input sweep
  stays in [0, 1])
- Runtime Assert: `clamp01` function on output
- Audit: not applicable (pure function output, not a side effect)

**Failure Mode:** Caller treats the value as if it were in [0, 1].
If out-of-range somehow escaped, the Journal's aggregate would be
slightly biased — observable in regression tests.

**Recovery:** N/A (clamping is the recovery).

**Introduced:** v0.9.0
**Status:** ACTIVE

---

### Invariant I11 — FitnessVector aggregate bounded

**Statement:** `fitnessVectorAggregate(v)` returns values in `[0, 1]`,
even for pathological inputs.

**Owner:** `CinderpawAgent/src/rsi/fitness.ts::fitnessVectorAggregate`

**Verified By:**
- Documentation: this entry
- Test: `tests/rsi-fitness.test.ts > aggregate stays in [0, 1] for
  arbitrary inputs` (50-iteration random sweep)
- Runtime Assert: `clamp01` on output
- Audit: not applicable

**Failure Mode:** Caller treats as in-range.

**Recovery:** N/A (clamping).

**Introduced:** v0.9.0
**Status:** ACTIVE

---

### Invariant I12 — Provenance graph acyclic

**Statement:** The provenance graph is acyclic. A node's parents are
always older than the node itself. This is enforced by the git
substrate (commits have parent hashes but never child hashes; the
graph is built by walking forward).

**Owner:**
- Rust: `src-tauri/src/rsi/repo.rs` (git substrate)
- TypeScript: `CinderpawAgent/src/rsi/provenance.ts::walkDescendants`

**Verified By:**
- Documentation: this entry
- Test: `tests/rsi-provenance.test.ts > descendants — BFS over parent → children`
- Runtime Assert: libgit2 enforces DAG at commit time
- Audit: every commit carries `parent_hashes`

**Failure Mode:** Cycles would cause infinite loops in `descendants()`.
BFS has a `seen` set as the runtime safety net.

**Recovery:** N/A — git substrate guarantees acyclicity.

**Introduced:** v0.9.0
**Status:** ACTIVE

---

### Invariant I13 — Per-instance data isolation

**Statement:** Each tenant (`~/.feral/instances/<tenant>/`) has its
own genomes, adapters, demos, eval suites, journal, audit log.
Cross-tenant reads are not permitted. Tier 0 specs are the only
shared data.

**Per-run isolation (ACTIVE).** The benchmark half of this invariant
landed first, because a benchmark campaign is where cross-run leakage
turns into a wrong published number. With `FERAL_BENCHMARK_RUN_ID` set,
`feralHome()` returns `<home>/runs/<runId>`, and every profile-dir
consumer — the DB, journal, skill sink, connector store, `paths()` —
derives from that one function, so they all move together. Run N's
learned skills are not on run N+1's disk to be read.

**Owner:**
- Per run: `CinderpawAgent/src/config.ts::feralHome` + `benchmarkRunId`
- Path layout: `src-tauri/src/rsi/paths.rs`
- Per-instance split: BRSI §3.3 in `continual-personal-adaptation-plan.md`

**Verified By:**
- Documentation: this entry
- Test: `paths.rs::tests::require_under` (path-containment);
  `CinderpawAgent/tests/benchmark-mode.test.ts` (two runs never share a
  profile dir; a non-path-safe run id is refused, not sanitized)
- Runtime Assert: `paths.rs::is_under` rejects paths outside the
  tenant root; `assertValidRunId` refuses a traversing run id before it
  can become a directory
- Audit: every IO op logs the tenant id

**Failure Mode:** HALT — a path outside the tenant root fails the
containment check.

**Recovery:** Refuse the operation; surface the offending path.

**Introduced:** v0.9.0 (per-instance split deferred)
**Status:** PENDING — partial coverage today; full split lives in
`continual-personal-adaptation-plan.md` §3.3

---

### Invariant I14 — Human approval gate for L3+ changes

**Statement:** Code Evolution (L3), Architecture Evolution (L4), and
Meta Evolution (L6) changes require explicit human approval before
apply. Governance Evolution (L5) may auto-apply within bounds but
rolls back on regression.

**Owner:** `CinderpawAgent/src/rsi/l3-code/pending-patches.ts` — a
candidate that wins the ratchet is never applied to the source tree by
the winning alone. It lands in `PendingPatchStore` as `pending`, and
`applyPatchLive` refuses unless the store records an approval AND the
patch passes a fresh TS-wall re-check at apply time. The first
`APPROVALS_BEFORE_AUTO` (10) applied patches require a human decision;
`requiresManualApproval()` is what tells the host when that unlocks.
The file is on both patch denylists — the gate cannot rewrite itself.

**Verified By:**
- Documentation: this entry
- Test: `CinderpawAgent/tests/rsi-pending-patches.test.ts`
- Runtime Assert: `applyPatchLive` returns `{ ok: false, reason }` for a
  patch with no recorded approval
- Audit: every approval/rejection recorded in the patch store

**Failure Mode:** Reject the apply.

**Recovery:** Surface to UI; await approval.

**Introduced:** v0.9.0 (mechanism deferred)
**Status:** ACTIVE for L3 code patches. L4 (architecture) and L6 (meta)
have no proposer yet, so nothing reaches a gate there — when they gain
one, it routes through this same store or this entry is wrong.

---

### Invariant I15 — EvalHalted requires reason

**Statement:** Every `EvalHalted` event MUST include a non-empty
`reason` string. A halt without a reason is a silent failure mode
and is not allowed. The contract FSM (or any pre-check wrapper) that
emits `EvalHalted` carries a human-or-machine-readable explanation
of WHY the eval did not start.

**Why this matters:** Without I15, the audit trail can record
"halt" with no explanation, and operators have no way to diagnose
why a candidate was rejected before evaluation. Silent rejections
are exactly the failure mode BRSI is designed to prevent.

**Owner:**
- TypeScript: `CinderpawAgent/src/rsi/event-bus.ts` (the union type with
  `reason: string` non-optional); the Contract FSM (Opus territory)
  is the primary emitter.
- Wire-level: `RsiEvent` discriminated union extension per
  ADR-0011.

**Verified By:**
- Documentation: this entry + ADR-0011
- Test: contract FSM halt tests (when Contract lands); a focused
  unit test for the bus that asserts an `EvalHalted` event without a
  reason is rejected
- Runtime Assert: type system (`reason: string` is non-optional on
  the event); runtime check on emit throws on empty string
- Audit: every halt event written to the Journal carries the reason
  in `JournalEntry.decided.reason`; audit chain entry per ADR-0004

**Failure Mode:** HALT — `EvalHalted` events without a reason are
rejected at the bus level (throw at emit time). The caller must
provide a reason; the audit trail stays honest.

**Recovery:** Caller-side: provide a reason and re-emit.

**Introduced:** v0.9.0 (type-level ACTIVE; runtime guard ACTIVE 2026-07-01
at the bus; emitter-level PENDING until the Contract FSM emits it live)
**Status:** ACTIVE (type + runtime) / PENDING (emitter)

**Related:** ADR-0011 (EvalHalted event semantics), `docs/wiring-spec.md`
§6.2, INVARIANTS.md I3 (Journal append-only — the reason is persisted
in the journal row), INVARIANTS.md I4 (corruption observable — a halt
without reason is a form of corruption).

---

## 5. Soft Invariants (Targets)

Soft invariants are not contracts; they are targets with explicit
thresholds. Drift is logged; persistent drift triggers an ADR +
version bump that lowers the target with a documented reason.

### Soft S1 — Average confidence ≥ 0.95

**Statement:** Over a rolling 30-cycle window, the mean
`JournalEntry.result.confidence` should be ≥ 0.95.

**Owner:** Confidence gate, Journal.

**Verification:** Metric — not enforced at runtime. Computed from
the Journal stream.

**Drift response:** Warning in the dashboard; ADR if persistent.

**Introduced:** v0.9.0
**Status:** ACTIVE (metric); PENDING (dashboard)

---

### Soft S2 — Niche count ≥ 3 (PENDING)

**Statement:** The population manager should maintain at least 3
niches (NEAT-speciation threshold at 0.85 cosine similarity).

**Owner:** `CinderpawAgent/src/rsi/extinction-handler.ts`

**Verification:** Metric on `population.nicheCount`.

**Drift response:** Extinction handler's monoculture detector
already fires; threshold adjustable.

**Introduced:** v0.9.0
**Status:** PENDING — species layer not yet implemented

---

### Soft S3 — Per-cycle observations ≥ 1 (PENDING)

**Statement:** Every cycle's Journal entry should carry at least one
observation. Empty cycles indicate the engine is running but learning
nothing.

**Owner:** Contract FSM (Opus territory).

**Verification:** Metric on `JournalEntry.observed.length > 0`.

**Drift response:** Warning; flag the cycle as low-information.

**Introduced:** v0.9.0
**Status:** PENDING

---

### Soft S4 — Tree depth ≤ N (PENDING)

**Statement:** The tree of champions should not grow beyond a
configured depth without pruning. Default N=10.

**Owner:** Tree of Champions (Opus territory).

**Verification:** Metric on `provenance.show(root).length`.

**Drift response:** Prune; record in Journal.

**Introduced:** v0.9.0
**Status:** PENDING

---

## 6. Adding a New Invariant

1. Write a proposal that justifies the invariant (what failure mode
   it prevents).
2. Declare the class: HARD or SOFT. Justify the choice.
3. Identify the Owner (file paths) and the four pillars.
4. Open an ADR (in `docs/adr/`) capturing the decision and any
   trade-offs.
5. Submit. Existing invariants stay unchanged; new ones are additive.

Removing an invariant requires:
- The original ADR
- A new ADR documenting why removal is safe
- Version bump + changelog entry

Lowering a SOFT invariant's threshold requires:
- The drift data
- A new ADR documenting the new threshold + reason
- Version bump

---

*This file is the answer to "should we remove X?". When in doubt,
the invariant wins.*