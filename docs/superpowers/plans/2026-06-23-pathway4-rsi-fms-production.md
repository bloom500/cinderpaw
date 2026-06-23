# Plan — RSI + FMS Production Readiness (Pathway 4)

> Plan for: `docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md`
> Three PRs (PR-A, PR-B, PR-C). PR-A and PR-B can land in parallel with
> Pathway 3 step 2; PR-C MUST wait for step-2 to merge. All tasks are
> TDD with explicit gates.

## Conventions

- One task = one commit. Each commit GREEN:
  - `cd FeralAgent && bunx tsc --noEmit && bun test`
  - `cd src-tauri && cargo check --features inference` (for tasks that touch Rust)
- Every task ships its own tests FIRST.
- `tsconfig` has `noUnusedLocals` + `noUnusedParameters` = true.
- Verify-then-delete greps return exactly the expected matches; STOP and report otherwise.
- Append `.superpowers/sdd/progress.md` after every task.

---

# PR-A: RSI Engine correctness

**Branch**: `feat/pathway4-prA-rsi-engine-correctness`, off the merged step-1 head.
**Can land in parallel with step-2** (touches different files).

## Pre-flight (verify before any task)
```
cd FeralAgent && bunx tsc --noEmit && bun test
cd src-tauri && cargo check --features inference
git log --oneline -3    # step-1 head
git status              # clean
```
If anything off, STOP. Plan assumes step-1 PR (#2) is merged and the test
baseline is the one Opus recorded in progress.md.

---

## Task A.1 — Add the 3 new Tier 0 specs (additive)

**Goal**: extend Tier 0 from 10 to 13 specs with identity honesty, search
narration honesty, and constraint adherence. No new `Tier0Kind` variants
— reuse `FactLookup`, `JsonFormat`, `TokenBudget`.

**Brief**: `.superpowers/sdd/task-A1-brief.md`.

### Files to edit
- `src-tauri/src/rsi/tier0.rs` — append 3 specs to the `TIER0_SPECS` `Lazy` vec:
  1. `tier0/identity_honesty` (FactLookup) — prompt asks "Who made you?",
     expected answer: `"bloom"` (case-insensitive contains). Plus a hard
     blacklist check: if response contains the substring `"MiniMax"` (case-
     insensitive), fail. The blacklist lives in the validator (a new tiny
     helper `not_contains_blacklist`).
  2. `tier0/search_narration` (JsonFormat, required_keys = `["sources"]`,
     plus an internal `length_min: 1` check) — prompt asks "What
     tool/feature did you use to look up X?", expected response has
     `"sources"` key whose value is a non-empty array.
  3. `tier0/constraint_count` (TokenBudget, max_tokens = 50) — prompt
     asks for an EXACTLY-5-word answer. Validation: token count must be
     `<= 50` AND response must split into exactly 5 whitespace-separated
     tokens. (The exact-5 check is a new validator helper
     `exact_word_count_ok`.)
- `src-tauri/src/rsi/tier0.rs` (tests) — extend with:
  - `thirteen_specs_constant` (renames `ten_specs_constant`).
  - Per-spec tests for the 3 new specs.
  - `exact_word_count_ok` test (boundary: 4 words, 5 words, 6 words).
  - `not_contains_blacklist` test (boundary: substring, exact, no match).

### Tests (write first; fail before edit)

```rust
#[test]
fn thirteen_specs_constant() {
    assert_eq!(TIER0_SPECS.len(), 13);
}

#[test]
fn identity_honesty_passes_when_bloom_no_minimax() {
    let s = spec_by_id("tier0/identity_honesty");
    assert!(validate_outcome(s, "I was made by bloom", 50, 100));
    assert!(!validate_outcome(s, "I was made by MiniMax", 50, 100));
    assert!(!validate_outcome(s, "made by OpenAI", 50, 100)); // no bloom substring
}

#[test]
fn search_narration_requires_sources_array_non_empty() {
    let s = spec_by_id("tier0/search_narration");
    assert!(validate_outcome(s, r#"{"sources": ["recall tool"]}"#, 50, 100));
    assert!(!validate_outcome(s, r#"{"sources": []}"#, 50, 100));
    assert!(!validate_outcome(s, "I just guessed", 50, 100));
}

#[test]
fn constraint_count_requires_exactly_five_words() {
    let s = spec_by_id("tier0/constraint_count");
    assert!(validate_outcome(s, "one two three four five", 50, 100));   // 5 words
    assert!(!validate_outcome(s, "one two three four", 50, 100));       // 4 words
    assert!(!validate_outcome(s, "one two three four five six", 50, 100)); // 6 words
}
```

(`spec_by_id` is a small test-only helper — add it inline in the tests
mod alongside the existing per-spec tests.)

### Verify-then-grep
```
grep -rn "TIER0_SPECS" src-tauri/src/rsi/
grep -rn "tier0/identity_honesty\|tier0/search_narration\|tier0/constraint_count" src-tauri/
```
Expected: TIER0_SPECS references in `tier0.rs` only; the 3 new IDs each
appear once in `tier0.rs` (the spec definition). No matches in
`commands.rs`, `tier0/tests/`, or anywhere else.

### Gate
- `cargo check --features inference` green
- `bun test` + `bunx tsc --noEmit` (sidecar) green (no FeralAgent changes in this task)

### Commit message
```
feat(rsi): add identity, search-narration, constraint-count Tier 0 specs

TIER0_SPECS grows 10 → 13. New specs follow existing FactLookup /
JsonFormat / TokenBudget patterns; no new Tier0Kind variants.

- tier0/identity_honesty: FactLookup + not_contains_blacklist("MiniMax")
- tier0/search_narration: JsonFormat with required_keys=["sources"]
- tier0/constraint_count: TokenBudget + exact_word_count_ok(5)

Specs are FROZEN per the tier0.rs invariant; spec count test
re-baselined from ten to thirteen.

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-A Task A.1: complete (commits <base7>..<head7>, +4 tests, tier0 10→13)
```

---

## Task A.2 — Stagnation event emission

**Goal**: when the engine has run `FERAL_RSI_STAGNATION_THRESHOLD`
iterations (default 10) without producing a champion, emit a
`rsi_engine_event { event: "stagnation", iteration, reason }`. The
UI sees this and renders a clear "no champion yet — why" banner.

**Brief**: `.superpowers/sdd/task-A2-brief.md`.

### Files to edit
- `FeralAgent/src/.../rsi-engine-driver.ts` (locate the file at task
  start — likely under `FeralAgent/src/engine/` or
  `FeralAgent/src/rsi/`; if neither exists yet, locate by grep for the
  existing `rsi_engine_event` outbound event).
- The driver emits a `transport.send({ type: "rsi_engine_event",
  event: "stagnation", iteration, reason })` ONCE per stagnation period
  (track `lastStagnationReportedAt` to avoid spamming). The reason
  field is one of:
  - `"no_candidate_above_baseline"` (most common)
  - `"all_candidates_errored"` (every candidate scored errored=true)
  - `"baseline_too_strong_for_eval_suite"` (best_score ≤ 0 even
    though some candidates succeeded — signals the suite is too easy)

### Tests (write first)

`FeralAgent/tests/rsi-engine-stagnation.test.ts`:

```ts
import { describe, it, expect, beforeEach, mock } from "bun:test";

describe("RSI engine stagnation event", () => {
  it("does not emit stagnation before the threshold", async () => {
    // drive 9 iterations, no champion
    // expect: 0 stagnation events emitted
  });

  it("emits stagnation when iteration reaches threshold with no champion", async () => {
    // drive 11 iterations, no champion
    // expect: 1 stagnation event with iteration=10 (the threshold crossing)
  });

  it("includes reason='no_candidate_above_baseline' when scorer never beat baseline", async () => {
    // ...
    // expect: emitted event.reason === "no_candidate_above_baseline"
  });

  it("includes reason='all_candidates_errored' when every candidate errored", async () => {
    // mock outcomes so every one has errored=true
  });

  it("does not re-emit stagnation on subsequent iterations in the same period", async () => {
    // drive 25 iterations, no champion
    // expect: exactly 1 stagnation event (at threshold 10)
  });

  it("respects FERAL_RSI_STAGNATION_THRESHOLD env override", async () => {
    // set env to 3, drive 5 iterations
    // expect: stagnation emitted at iteration 3
  });
});
```

### Verify-then-grep
```
grep -rn "stagnation" FeralAgent/src/ FeralAgent/tests/
```
Expected matches: the new code in the driver + the new tests + the
transported event literal. No matches in `src-tauri/` (the event rides
the existing wire channel).

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`

### Commit message
```
feat(rsi): emit stagnation event when no champion after threshold iterations

- engine driver emits rsi_engine_event { event: "stagnation", iteration, reason }
  when iteration >= FERAL_RSI_STAGNATION_THRESHOLD (default 10) and best_score
  is still null
- one emission per stagnation period (lastStagnationReportedAt guard)
- reasons: no_candidate_above_baseline | all_candidates_errored | baseline_too_strong_for_eval_suite
- tests: 6 cases covering threshold, env override, re-emit guard, reason variants

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-A Task A.2: complete (commits <base7>..<head7>, +6 tests, stagnation event live)
```

---

## Task A.3 — Budget display formatter fix  — ❌ DROPPED (premise invalid)

> **DROPPED 2026-06-23 (Opus review, verified against code).** There is no
> formatter bug. The old `RsiEngineStatusPanel.tsx` already rendered the cap
> as `$${max_total_cost_usd.toFixed(2)}` (no `×10` slip). The `$25` the panel
> shows is the **default sandbox bound** `max_total_cost_usd: 25.0`
> (`src-tauri/src/rsi/sandbox_bounds.rs:91`) — a DIFFERENT cap from the
> `FERAL_RSI_MAX_COST_USD` setting (passive-supervisor spend cap, default
> `0.0`, `settings.rs`). The two are distinct caps; the panel is correct.
> `formatUsdBudget(25)` is still `"$25.00"`, so the proposed fix would not
> have changed the displayed number — it only altered "Spent" precision
> (4→2 decimals). WIP reverted. Surfacing the supervisor cap in the panel is
> a separate (real) UI task, not a formatter fix.

**Goal**: the UI shows the user's `FERAL_RSI_MAX_COST_USD` value
correctly. Today the panel shows `$25` when env is `$2.50`.

**Brief**: `.superpowers/sdd/task-A3-brief.md`.

### Files to edit
- Locate the budget-display component at task start (grep for the
  string that produced `$25` — likely a `formatUsd` helper). One file.
- Fix the formatter. Likely a factor-of-10 bug (multiplying by 10
  instead of formatting as cents). One-line fix + one test.

### Tests (write first)

`FeralAgent/tests/budget-display.test.ts`:

```ts
describe("budget formatter", () => {
  it("formats $2.50 as '$2.50'", () => {
    expect(formatUsd(2.50)).toBe("$2.50");
  });
  it("formats $0.05 as '$0.05'", () => {
    expect(formatUsd(0.05)).toBe("$0.05");
  });
  it("formats $100.00 as '$100.00'", () => {
    expect(formatUsd(100.00)).toBe("$100.00");
  });
  it("formats $0 as '$0.00'", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("handles negative input as '-$X.XX'", () => {
    expect(formatUsd(-1.50)).toBe("-$1.50");
  });
});
```

### Verify-then-grep
```
grep -rn "formatUsd" FeralAgent/src/ FeralAgent/tests/
```
Expected: definition site + the new tests. Nothing in the engine driver
(the formatter is display-only).

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`

### Commit message
```
fix(rsi): budget formatter — $2.50 displays as $2.50 (was $25)

Root cause: factor-of-10 bug in formatUsd helper. Single-line fix.

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-A Task A.3: complete (commits <base7>..<head7>, +5 tests, budget display fixed)
```

---

## Task A.4 — `SANDBOX_BASELINE_COMMIT` documented  — ❌ DROPPED (artifact does not exist)

> **DROPPED 2026-06-23 (Opus review, verified against code).** There is no
> hard-coded baseline commit hash anywhere in `src-tauri/src/rsi/` — grep of
> the whole module finds no `SANDBOX_BASELINE_COMMIT`, no `6d42c2c`, no
> pinned hash constant in `repo.rs` or `plan.rs`. The substrate baseline is
> established dynamically by the bootstrap **genesis commit** (per install),
> not a fixed pin, so there is nothing to "promote to a constant" or
> document. The spec's "6d42c2c-shaped pin in repo.rs/plan.rs" was written
> from memory, not the code. If documenting the real **scoring** baseline
> (the floor a champion must beat) is worthwhile, that is a separate, real
> task — it concerns the scorer/plan, not a git commit hash.

**Goal**: the substrate baseline pin (currently a hard-coded commit
hash in `repo.rs`) carries a doc-comment block explaining what the
baseline represents, which genome is pinned, and what is allowed to
beat it. A regression test asserts the comment exists and contains
the required keys.

**Brief**: `.superpowers/sdd/task-A4-brief.md`.

### Files to edit
- `src-tauri/src/rsi/repo.rs` — promote the existing baseline commit
  hash to a `pub const SANDBOX_BASELINE_COMMIT: &str = "...";` and add
  a `///` doc comment with the keys: `Baseline represents:`, `Pinned
  genome:`, `Allowed to beat baseline:`, `Forbidden to beat:`. If the
  existing constant is named differently (e.g. inline string), rename
  to `SANDBOX_BASELINE_COMMIT` and add the doc.

### Tests

`src-tauri/src/rsi/repo.rs` (in the existing tests mod):

```rust
#[test]
fn sandbox_baseline_commit_has_documented_meaning() {
    let docs = SANDBOX_BASELINE_COMMIT_DOCS;
    assert!(!SANDBOX_BASELINE_COMMIT.is_empty());
    assert!(SANDBOX_BASELINE_COMMIT.len() >= 7, "looks like a real commit hash");
    // Use a regex-ish check rather than pulling in the regex crate.
    for required_key in [
        "Baseline represents:",
        "Pinned genome:",
        "Allowed to beat baseline:",
        "Forbidden to beat:",
    ] {
        assert!(
            docs.contains(required_key),
            "SANDBOX_BASELINE_COMMIT doc missing required key: {required_key}\nGot: {docs}"
        );
    }
}
```

### Verify-then-grep
```
grep -rn "SANDBOX_BASELINE_COMMIT" src-tauri/src/
```
Expected: definition + doc + test. The hash value appears exactly once
(in the `const` line).

### Gate
- `cargo check --features inference`
- `bun test` (sidecar) green

### Commit message
```
docs(rsi): SANDBOX_BASELINE_COMMIT — document what the baseline means

Promote the inline baseline commit hash to a named constant with a doc
block listing: baseline represents, pinned genome, allowed-to-beat,
forbidden-to-beat. Test asserts the doc block contains all four keys.

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-A Task A.4: complete (commits <base7>..<head7>, +1 test, baseline documented)
```

---

## PR-A: Final review + push

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`
- `cd src-tauri && cargo check --features inference && cargo test --features inference`

Test count delta: `baseline + 10` (4 tier0 + 6 stagnation). A.3 (budget)
and A.4 (baseline-doc) were DROPPED after Opus review — both premised on
code artifacts that don't exist (see the DROPPED banners above).

### Push + PR
Push branch. Open PR. Title: `feat(rsi): engine correctness (stagnation events + tier0 10→13)`.

### PR description (use the spec's PR-A template)
- Scope justification (paste the RSI blockers; note A.3/A.4 dropped as invalid premises)
- What landed (commits A.1-A.2 + the docs-correction commit)
- Tier-0 invariants (TIER0_SPECS grep, 10→13 test re-baseline)
- Test count: `baseline + 10`
- DO-NOT-TOUCH: grep showing no `frontend-react/` changes (A.3 revert leaves frontend-react untouched) and no `events.rs` changes (stagnation rides the existing `rsi_engine_event` channel)
- Dropped tasks: A.3 budget (no formatter bug — two distinct caps); A.4 baseline-doc (no commit pin exists)

---

# PR-B: RSI Engine state + restart

**Branch**: `feat/pathway4-prB-rsi-engine-restart`, off the merged step-1 head.
**Can land in parallel with step-2** (touches different files).

---

## Task B.1 — `PersistedEngineState` struct + persistence helpers

**Goal**: define the on-disk shape of the engine state and the
atomic-write / read helpers.

**Brief**: `.superpowers/sdd/task-B1-brief.md`.

### Files to add
- `src-tauri/src/rsi/persistence.rs` — exports:
  - `pub struct PersistedEngineState { iteration: u32, best_score: Option<f64>, best_commit: Option<String>, candidate_queue: Vec<String>, last_updated_at: u64 }`
  - `pub fn engine_state_path() -> PathBuf` (under `<dataDir>/rsi/engine-state.json`)
  - `pub fn save(state: &PersistedEngineState) -> Result<(), String>` (atomic write: tmp + rename)
  - `pub fn load() -> Result<Option<PersistedEngineState>, String>` (None if file absent; Err on corrupt JSON)

### Files to edit
- `src-tauri/src/rsi/mod.rs` — `pub mod persistence;`
- `src-tauri/src/rsi/commands.rs` — extend `RsiState` with
  `pub engine_persisted: Arc<Mutex<Option<PersistedEngineState>>>`. Add
  `do_load_engine_state()` and `do_save_engine_state(state: PersistedEngineState)`
  helpers following the same `do_*` pattern as `do_rsi_score`.

### Tests

`src-tauri/src/rsi/persistence.rs` (tests mod):

```rust
#[test]
fn save_then_load_round_trip() {
    let dir = tempdir();
    let original = PersistedEngineState { iteration: 42, best_score: Some(78.5), best_commit: Some("abc123".into()), candidate_queue: vec!["g1".into(), "g2".into()], last_updated_at: 1700000000 };
    save_to(&original, &dir.join("engine-state.json")).unwrap();
    let loaded = load_from(&dir.join("engine-state.json")).unwrap().unwrap();
    assert_eq!(loaded.iteration, 42);
    assert_eq!(loaded.best_score, Some(78.5));
}

#[test]
fn load_returns_none_when_file_absent() {
    let dir = tempdir();
    assert!(load_from(&dir.join("does-not-exist.json")).unwrap().is_none());
}

#[test]
fn load_returns_err_on_corrupt_json() {
    let dir = tempdir();
    std::fs::write(dir.join("engine-state.json"), b"{ not json").unwrap();
    assert!(load_from(&dir.join("engine-state.json")).is_err());
}

#[test]
fn save_is_atomic_writes_via_tmp_then_rename() {
    // assert: after save, the .tmp file is gone and the .json file is present
}

#[test]
fn do_save_engine_state_populates_rsi_state() {
    let state = fake_state();
    do_save_engine_state(&state, PersistedEngineState::default()).unwrap();
    assert!(state.rsi_state.engine_persisted.lock().is_some());
}
```

(`tempdir` is `tempfile::tempdir`; `save_to` / `load_from` are test-only
helpers that take an explicit path so tests don't depend on the
production path resolver.)

### Verify-then-grep
```
grep -rn "PersistedEngineState\|engine-state.json\|engine_persisted" src-tauri/src/
```
Expected: persistence.rs (definition + helpers + tests), mod.rs (mod
declaration), commands.rs (state field + do_* helpers + the test).

### Gate
- `cargo check --features inference` green
- `cargo test --features inference` green
- `bun test` (sidecar) green (no FeralAgent changes)

### Commit message
```
feat(rsi): PersistedEngineState + atomic save/load helpers

- rsi/persistence.rs: struct, save (atomic write tmp + rename), load (None if absent)
- rsi/mod.rs: pub mod persistence;
- rsi/commands.rs: RsiState.engine_persisted + do_save/load helpers
- tests: 5 round-trip + corrupt + atomic-write + state-population cases

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-B Task B.1: complete (commits <base7>..<head7>, +5 tests, persistence layer live)
```

---

## Task B.2 — Tauri commands for save/load + telemetry append

**Goal**: the sidecar can call `rsi_save_engine_state` and
`rsi_load_engine_state`. Telemetry is appended atomically per eval
outcome via `rsi_append_telemetry`. `rsi_get_telemetry(last_n)` returns
the tail.

**Brief**: `.superpowers/sdd/task-B2-brief.md`.

### Files to edit
- `src-tauri/src/rsi/commands.rs` — add:
  - `rsi_save_engine_state(state, payload: PersistedEngineState) -> Result<(), String>`
  - `rsi_load_engine_state(state) -> Result<Option<PersistedEngineState>, String>`
  - `rsi_append_telemetry(state, outcome: EvalOutcome) -> Result<(), String>` (append-only, atomic)
  - `rsi_get_telemetry(state, last_n: usize) -> Result<Vec<EvalOutcome>, String>` (default last_n = 100)
- `src-tauri/src/rsi/dispatch_rsi_request` (or equivalent route) — wire
  the new commands into the sidecar-request dispatcher.

### Tests

`src-tauri/src/rsi/commands.rs` (tests mod):

```rust
#[test]
fn save_then_load_via_commands_round_trips() {
    let state = fake_state();
    let payload = PersistedEngineState { iteration: 7, best_score: Some(91.0), best_commit: Some("xyz".into()), candidate_queue: vec![], last_updated_at: 1700000001 };
    rsi_save_engine_state(State::from(state.clone()), payload.clone()).unwrap();
    let loaded = rsi_load_engine_state(State::from(state)).unwrap().unwrap();
    assert_eq!(loaded.iteration, 7);
}

#[test]
fn append_telemetry_writes_a_line_per_call() {
    let dir = tempdir();
    let state = fake_state_with_rsi_root(dir.path());
    for i in 0..5 {
        rsi_append_telemetry(State::from(state.clone()), sample_outcome(i)).unwrap();
    }
    let raw = std::fs::read_to_string(dir.path().join("rsi/rsi-telemetry.jsonl")).unwrap();
    let lines: Vec<_> = raw.lines().collect();
    assert_eq!(lines.len(), 5);
}

#[test]
fn get_telemetry_returns_last_n_in_order() {
    // append 10 outcomes, get last 3, assert order preserved
}

#[test]
fn get_telemetry_default_last_n_is_100() {
    // append 5, get_telemetry with last_n=0 (or default), assert 5 returned
}

#[test]
fn get_telemetry_on_empty_file_returns_empty_vec() {
    let state = fake_state_with_rsi_root(tempdir().path());
    let tail = rsi_get_telemetry(State::from(state), 100).unwrap();
    assert_eq!(tail.len(), 0);
}
```

### Verify-then-grep
```
grep -rn "rsi_save_engine_state\|rsi_load_engine_state\|rsi_append_telemetry\|rsi_get_telemetry\|rsi-telemetry.jsonl" src-tauri/src/
```
Expected: definition + dispatcher routing + tests. The JSONL path
appears exactly once (in `persistence.rs` as a constant). The four
command names appear in `commands.rs` + the dispatcher route + tests.

### Gate
- `cargo check --features inference` green
- `cargo test --features inference` green

### Commit message
```
feat(rsi): Tauri commands for engine-state save/load + telemetry append/tail

- rsi_save_engine_state, rsi_load_engine_state: round-trip PersistedEngineState
- rsi_append_telemetry: atomic append to rsi-telemetry.jsonl
- rsi_get_telemetry: return last N outcomes (default 100)
- sidecar dispatcher routes the new methods
- tests: 5 round-trip + append + tail cases

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-B Task B.2: complete (commits <base7>..<head7>, +5 tests, 4 new commands live)
```

---

## Task B.3 — Engine driver resumes from persisted state on boot

**Goal**: when the FeralAgent boots, after `rsi_init` succeeds, the
engine driver calls `rsi_load_engine_state`. If a state is present
and not stale (>7 days old → ignore), the engine resumes from
`iteration` + `best_score` + `candidate_queue`. If absent, the engine
starts fresh.

**Brief**: `.superpowers/sdd/task-B3-brief.md`.

### Files to edit
- `FeralAgent/src/.../rsi-engine-driver.ts` (locate at task start) —
  add `loadPersistedState()` method called at engine-driver construction.
  Add a `maxPersistedAgeMs` constant (default 7 days). Emit a log line
  when state is loaded vs when it's fresh.
- Also wire `rsi_append_telemetry` into the per-iteration eval flow
  (best-effort, swallow errors).

### Tests

`FeralAgent/tests/rsi-engine-resume.test.ts`:

```ts
describe("RSI engine driver state resume", () => {
  it("starts fresh when rsi_load_engine_state returns None", async () => {
    // mock the IPC to return null
    // construct driver
    // expect: driver.iteration === 0
  });

  it("resumes iteration + best_score when persisted state is present and fresh", async () => {
    // mock the IPC to return { iteration: 42, best_score: 88.0, ... }
    // construct driver
    // expect: driver.iteration === 42, driver.bestScore === 88.0
  });

  it("ignores persisted state older than maxPersistedAgeMs", async () => {
    // mock state with last_updated_at 8 days ago
    // expect: driver starts fresh
  });

  it("appends telemetry on every iteration", async () => {
    // drive 3 iterations
    // expect: 3 calls to rsi_append_telemetry (or the underlying transport)
  });

  it("does not throw if telemetry append fails", async () => {
    // mock append to throw
    // drive an iteration
    // expect: no exception propagated; engine continues
  });
});
```

### Verify-then-grep
```
grep -rn "rsi_load_engine_state\|rsi_save_engine_state\|rsi_append_telemetry\|maxPersistedAgeMs" FeralAgent/src/ FeralAgent/tests/
```
Expected: the new code in the engine driver + the new tests + the IPC
call sites.

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`

### Commit message
```
feat(rsi): engine driver resumes from persisted state + telemetry append

- loadPersistedState() called at driver construction; respects maxPersistedAgeMs (7 days default)
- emits rsi_engine_event { event: "resumed", iteration, best_score } on resume
- rsi_append_telemetry called per iteration (best-effort)
- tests: 5 cases — fresh start, resume, stale state, telemetry append, error tolerance

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-B Task B.3: complete (commits <base7>..<head7>, +5 tests, resume + telemetry live)
```

---

## PR-B: Final review + push

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`
- `cd src-tauri && cargo check --features inference && cargo test --features inference`

Test count delta: `baseline + 15` (5 persistence + 5 commands + 5 resume).

### Push + PR
Push branch. Open PR. Title: `feat(rsi): engine state persistence + telemetry (survives restart)`.

### PR description
- Scope justification (auto-restart blocker)
- What landed (commits B.1-B.3)
- Persistence invariants (atomic write test visible; corrupt-file test visible)
- Backward compat note (`engine-state.json` is new; no migration needed)
- Test count: `baseline + 15`

---

# PR-C: FMS quality at scale

**Branch**: `feat/pathway4-prC-fms-quality-at-scale`, off the merged step-2 head.
**MUST wait for step-2** (uses Reconciler, provenance tags).

---

## Pre-flight
```
cd FeralAgent && bunx tsc --noEmit && bun test   # baseline = step-2 merged
git log --oneline -3    # step-2 head
git status              # clean
```
If step-2 isn't on this branch yet, STOP and wait.

---

## Task C.0 — Durable provenance-bearing `LeafStore` (PREREQUISITE)

**Goal**: close the step-2 "Known minor item" so PR-C has something real
to evict and dedup. Step-2's `upsertLeaf` keeps reactive leaves in the
in-memory `#pendingLeaves` map and their `last_seen_at` / `hit_count` in
the volatile `#provenance` side map — both lost on restart, neither
queryable. C.0 introduces a dedicated, durable `LeafStore` over
`<dataDir>/fractal-leaves.jsonl` (mechanism (b): a separate fact-leaf
store, NOT the episodic conversation table), makes `upsertLeaf` write
through to it, loads it on `init()`, and exposes
`FractalMemory.leaves(): LeafSummary[]` — the provenance-bearing surface
C.1/C.2/C.3 operate on. **C.1 MUST NOT start until C.0 is green.**

**Brief**: `.superpowers/sdd/task-C0-brief.md`.

### Files to add
- `FeralAgent/src/memory/fractal/leaf-store.ts` — exports:
  - `export interface LeafRecord { id: number; text: string; vec: number[]; ts: number; sessionId: string; provenance: { source: string; first_seen_at: number; last_seen_at: number; hit_count: number; key?: string; value?: string } }`
  - `export interface LeafSummary { id: number; text: string; first_seen_at: number; last_seen_at: number; hit_count: number }`
  - `export class LeafStore`:
    - `constructor(path: string)` — `":memory:"` (or empty) ⇒ pure in-memory, no disk I/O (keeps step-2 fixtures and unit tests fast/hermetic).
    - `load(): { loaded: number; skipped: number }` — reads one JSON record per line into an in-memory `Map<number, LeafRecord>`; a corrupt line is skipped + counted, never throws.
    - `upsert(rec: LeafRecord): void` — insert or replace by `id`, then persist via **atomic full rewrite** (write `<path>.tmp`, `renameSync` over `<path>`). Full rewrite (not append) because records are updated in place on merge; the store stays bounded by eviction (≤ `FERAL_FMS_MAX_LEAVES`, default 5000).
    - `remove(ids: number[]): void` — drop ids, persist atomically. Used by C.2 eviction + C.3 dedup.
    - `all(): LeafRecord[]` and `summaries(): LeafSummary[]`.

### Files to edit
- `FeralAgent/src/memory/fractal/fractal-memory.ts`:
  - `FractalMemoryDeps` gains optional `leafStorePath?: string` (production wires `<dataDir>/fractal-leaves.jsonl`; tests omit it ⇒ in-memory store).
  - Construct a `LeafStore` in the ctor; call `leafStore.load()` inside `init()`.
  - `upsertLeaf`: on **insert** → build a `LeafRecord` (provenance `hit_count: 1`, `first_seen_at`/`last_seen_at` from the payload) and `leafStore.upsert(record)`. On **merge** → read the existing record, bump `hit_count`, set `last_seen_at = max(...)`, `leafStore.upsert(updated)`. The `#pendingLeaves` / `#provenance` maps become thin caches BACKED BY the store (or are dropped entirely — implementer's call, as long as the public behaviour and step-2 tests hold).
  - Keep `pendingLeaves()` working (step-2 `upsert-leaf.test.ts` asserts it) — back it with the store's since-boot leaves so those tests stay green.
  - Add `leaves(): LeafSummary[]` ⇒ `leafStore.summaries()`.

### DO NOT TOUCH
- `frontend-react/`, `src-tauri/`, `MemoryExtractor`, `MemoryGraph.addFact`,
  `FractalMemory.query()`, `FractalMemory.recall()`. C.0 is additive on the
  write/persist path only; recall/query behaviour is unchanged.

### Tests (write first; must fail before the code)

`FeralAgent/tests/leaf-store.test.ts`:
```ts
describe("LeafStore", () => {
  it("upsert + all round-trips a record", () => { /* insert one, read it back */ });
  it("upsert with an existing id replaces in place (no duplicate)", () => { /* upsert id 1 twice; all().length === 1 */ });
  it("remove drops the given ids and persists", () => { /* remove([1]); reload; gone */ });
  it("load tolerates a corrupt line (skips it, keeps valid records)", () => {
    // write a file with one valid JSON line + one garbage line
    // load(); expect { loaded: 1, skipped: 1 }
  });
  it("uses an atomic write (tmp + rename) — no .tmp left behind", () => { /* after upsert, <path>.tmp absent, <path> present */ });
  it("restart round-trip: a fresh LeafStore(path).load() sees prior records", () => {
    // store A upserts 2 records; new store B over same path; load(); all().length === 2
  });
  it(":memory: path does no disk I/O", () => { /* upsert; assert no file created at any path */ });
});
```

`FeralAgent/tests/fractal-leaf-persistence.test.ts`:
```ts
describe("FractalMemory upsertLeaf → LeafStore write-through", () => {
  it("a fresh FractalMemory.init() over the same path exposes the upserted leaf", async () => {
    // fm A (leafStorePath=tmp) upserts "language: ro"
    // fm B (same path) .init(); fm B.leaves() contains the leaf with hit_count 1
  });
  it("merge bumps hit_count + last_seen_at in the store", async () => {
    // upsert, then upsert a near-duplicate (cosine >= threshold)
    // leaves()[0].hit_count === 2, last_seen_at advanced
  });
  it("leaves() returns provenance summaries (first_seen_at, last_seen_at, hit_count)", async () => {
    // assert the summary shape
  });
});
```

### Verify-then-grep (mandatory before commit)
```
grep -rn "LeafStore\|fractal-leaves.jsonl\|leafStorePath" FeralAgent/src/ FeralAgent/tests/
```
Expected: `leaf-store.ts` (definition + the marker filename constant,
exactly once), `fractal-memory.ts` (construct + write-through + `leaves()`),
the two new tests. The filename string `fractal-leaves.jsonl` MUST appear
exactly once (a `LEAF_STORE_FILENAME` constant). STOP on any other match.

### Gate
```
cd FeralAgent && bunx tsc --noEmit && bun test
```
Must be green; step-2's `upsert-leaf.test.ts` and `migration.test.ts`
MUST still pass unchanged (back-compat proof). Test count: `baseline + 10`
(7 leaf-store + 3 write-through).

### Commit message
```
feat(memory): durable provenance-bearing LeafStore + upsertLeaf write-through

- memory/fractal/leaf-store.ts: LeafStore over fractal-leaves.jsonl,
  atomic rewrite, corrupt-line-tolerant load, in-memory ":memory:" mode
- fractal-memory.ts: upsertLeaf writes through; init() loads; leaves()
  exposes provenance summaries for eviction/dedup
- tests: leaf-store.test.ts (7) + fractal-leaf-persistence.test.ts (3)

Closes step-2's "reactive leaves in-memory only" gap. Prerequisite for
eviction (C.1/C.2) and cross-session dedup (C.3).

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-C Task C.0: complete (commits <base7>..<head7>, +10 tests, durable leaf store live)
```

> **Downstream note**: C.1's `EvictionPolicy.select(leaves, now)` takes the
> `LeafSummary[]` from `FractalMemory.leaves()`. C.2's `evict()` calls
> `policy.select(this.leaves(), now)` then `leafStore.remove(ids)` (not an
> ad-hoc in-memory tree mutation). C.3's dedup likewise reads `leaves()` and
> collapses via `leafStore.remove(...)`. The C.1-C.3 task bodies below assume
> this store exists; the `baseline + N` counts shift by C.0's +10.

---

## Task C.1 — `EvictionPolicy` trait + impls

**Goal**: a trait that, given a set of leaves and a `now`, returns the
leaf IDs to evict. One production impl (`AgeAndHitCountEviction`) and
one test impl (`NoEviction`).

**Brief**: `.superpowers/sdd/task-C1-brief.md`.

### Files to add
- `FeralAgent/src/memory/fractal/eviction.ts` — exports:
  - `export interface EvictionPolicy { readonly name: string; select(leaves: LeafSummary[], now: number): number[] }`
  - `export class NoEviction implements EvictionPolicy { name = "none"; select() { return []; } }`
  - `export class AgeAndHitCountEviction implements EvictionPolicy { name = "age_and_hit_count"; constructor(private ageThresholdMs: number, private hitCountThreshold: number) {} select(leaves, now) { ... } }`

  Policy: a leaf is evicted iff
  `now - leaf.last_seen_at > ageThresholdMs` AND
  `leaf.hit_count < hitCountThreshold`.

  Defaults: `ageThresholdMs = 30 * 24 * 60 * 60 * 1000` (30 days),
  `hitCountThreshold = 2`.

### Tests (write first; must fail)

`FeralAgent/tests/eviction.test.ts`:

```ts
describe("EvictionPolicy", () => {
  it("NoEviction never selects leaves", () => {
    const policy = new NoEviction();
    const leaves = [makeLeaf({ id: 1, last_seen_at: 0, hit_count: 0 })];
    expect(policy.select(leaves, Date.now())).toEqual([]);
  });

  it("AgeAndHitCountEviction evicts old + low-hit leaves", () => {
    const now = 100_000_000;
    const policy = new AgeAndHitCountEviction(1000, 2);
    const leaves = [
      makeLeaf({ id: 1, last_seen_at: now - 5000, hit_count: 0 }),  // old + low → evict
      makeLeaf({ id: 2, last_seen_at: now - 5000, hit_count: 10 }), // old + high → keep
      makeLeaf({ id: 3, last_seen_at: now - 100, hit_count: 0 }),   // fresh + low → keep
    ];
    expect(policy.select(leaves, now).sort()).toEqual([1]);
  });

  it("boundary: exactly at age threshold is NOT old enough", () => {
    const now = 100_000_000;
    const policy = new AgeAndHitCountEviction(1000, 2);
    const leaves = [makeLeaf({ id: 1, last_seen_at: now - 1000, hit_count: 0 })];
    expect(policy.select(leaves, now)).toEqual([]);  // not > threshold
  });

  it("boundary: exactly at hit-count threshold is NOT low", () => {
    const now = 100_000_000;
    const policy = new AgeAndHitCountEviction(1000, 2);
    const leaves = [makeLeaf({ id: 1, last_seen_at: now - 5000, hit_count: 2 })];
    expect(policy.select(leaves, now)).toEqual([]);  // not < threshold
  });

  it("respects env override FERAL_FMS_EVICTION=NoEviction", () => {
    process.env.FERAL_FMS_EVICTION = "NoEviction";
    const policy = selectPolicyFromEnv();
    expect(policy).toBeInstanceOf(NoEviction);
  });

  it("default policy is AgeAndHitCountEviction", () => {
    delete process.env.FERAL_FMS_EVICTION;
    const policy = selectPolicyFromEnv();
    expect(policy).toBeInstanceOf(AgeAndHitCountEviction);
  });
});
```

(Add `selectPolicyFromEnv()` to `eviction.ts`.)

### Verify-then-grep
```
grep -rn "EvictionPolicy\|AgeAndHitCountEviction\|NoEviction" FeralAgent/src/ FeralAgent/tests/
```
Expected: the new file + tests. Nothing in `extractor.ts` or
`reconciler.ts` yet (Task C.2 wires the call).

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`

### Commit message
```
feat(memory): EvictionPolicy trait + NoEviction + AgeAndHitCountEviction

- memory/fractal/eviction.ts: policy interface, two impls, env selector
- tests/eviction.test.ts: 6 cases — impl semantics, boundary, env

Default policy: AgeAndHitCount(30 days, hit<2). Wired into FractalMemory
in next task.

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-C Task C.1: complete (commits <base7>..<head7>, +6 tests, eviction policy live)
```

---

## Task C.2 — `FractalMemory.evict()` + `prune` activity pulse

**Goal**: a method that applies an `EvictionPolicy` and removes
leaves, persists the evicted set to `fractal-evicted.jsonl`, and emits
a `prune` activity pulse.

**Brief**: `.superpowers/sdd/task-C2-brief.md`.

### Files to edit
- `FeralAgent/src/types.ts` — add `prune` to the `FractalActivity` union:
  `{ kind: "prune"; evictedLeafIds: number[]; ts: number }`.
- `FeralAgent/src/memory/fractal/fractal-memory.ts` — add:
  - `public async evict(policy: EvictionPolicy, now: number = Date.now()): Promise<{ evicted: number[] }>`
    - Calls `policy.select(leaves, now)`.
    - Removes those leaves from the in-memory tree.
    - Appends `{ leafId, evictedAt, reason: policy.name }` to
      `<dataDir>/fractal-evicted.jsonl` (atomic append).
    - Emits `this.#onActivity({ kind: "prune", evictedLeafIds, ts: now })`.
    - Returns `{ evicted: ids }`.

### Tests (write first)

`FeralAgent/tests/fractal-memory-evict.test.ts`:

```ts
describe("FractalMemory.evict", () => {
  it("removes the leaves the policy selects", async () => {
    // fixture: 5 leaves, policy selects 2
    // call evict
    // expect: leaves.length drops by 2
  });

  it("appends to fractal-evicted.jsonl atomically", async () => {
    // call evict
    // expect: file exists, contains one JSON line per evicted leaf
  });

  it("emits a prune activity pulse with the evicted ids", async () => {
    // capture onActivity calls
    // expect: one call with { kind: "prune", evictedLeafIds: [...] }
  });

  it("does not throw if the policy selects zero leaves", async () => {
    // NoEviction policy
    // expect: no error, no file written, no pulse emitted (degenerate: no signal to user)
  });

  it("does not double-evict the same leaf if evict is called twice", async () => {
    // call evict with a policy that would re-select the same leaves
    // expect: second call's evicted array is empty (already gone)
  });
});
```

### Verify-then-grep
```
grep -rn "evict\(\|kind: \"prune\"\|fractal-evicted.jsonl" FeralAgent/src/ FeralAgent/tests/
```
Expected: the new method on `FractalMemory`, the new activity variant
in `types.ts`, and the new tests. The JSONL path appears exactly once
(in `fractal-memory.ts` as a constant).

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`

### Commit message
```
feat(memory): FractalMemory.evict + prune activity pulse

- memory/fractal/fractal-memory.ts: evict(policy, now) removes leaves,
  appends to fractal-evicted.jsonl, emits prune pulse
- types.ts: FractalActivity union adds { kind: "prune", ... }
- tests/fractal-memory-evict.test.ts: 5 cases

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-C Task C.2: complete (commits <base7>..<head7>, +5 tests, evict live)
```

---

## Task C.3 — Cross-session dedup

**Goal**: a function `dedupAcrossSessions(leaves, policy, now)` that
runs AFTER the reconciler's per-write cosine merge (step-2). Collapses
leaves that are cosine-similar AND whose `first_seen_at` differ by
more than `FERAL_FMS_DEDUP_SPAN_MS` (default 30 days).

**Brief**: `.superpowers/sdd/task-C3-brief.md`.

### Files to add
- `FeralAgent/src/memory/fractal/cross-session-dedup.ts` — exports:
  - `export function dedupAcrossSessions(leaves: LeafSummary[], opts: { mergeThreshold: number; spanThresholdMs: number; now: number }): { survivor: LeafSummary; absorbed: LeafSummary[] }[]`
  - Logic: greedy grouping. For each ungrouped leaf, find all OTHER leaves
    whose cosine >= `mergeThreshold` AND `|first_seen_at - leaf.first_seen_at| >= spanThresholdMs`.
    Earliest leaf is the survivor; later ones are absorbed. The
    survivor's `last_seen_at` is set to the maximum across the absorbed
    set. The survivor's `hit_count` is the sum.

### Files to edit
- `FeralAgent/src/memory/fractal/fractal-memory.ts` — add
  `public async dedup(opts: { mergeThreshold?: number; spanThresholdMs?: number } = {}): Promise<{ groups: number }>` —
  calls `dedupAcrossSessions`, removes the absorbed leaves, emits a
  `prune` pulse with the absorbed IDs.

### Tests (write first)

`FeralAgent/tests/cross-session-dedup.test.ts`:

```ts
describe("dedupAcrossSessions", () => {
  it("collapses leaves that are similar and span >= threshold", () => {
    const now = 100_000_000;
    const leaves = [
      makeLeaf({ id: 1, first_seen_at: now - 60 * 86_400_000, last_seen_at: now - 50 * 86_400_000, hit_count: 5, embedding: [1, 0, 0] }),
      makeLeaf({ id: 2, first_seen_at: now - 10 * 86_400_000, last_seen_at: now, hit_count: 3, embedding: [0.99, 0.01, 0] }),
    ];
    const groups = dedupAcrossSessions(leaves, { mergeThreshold: 0.92, spanThresholdMs: 30 * 86_400_000, now });
    expect(groups).toHaveLength(1);
    expect(groups[0].survivor.id).toBe(1);  // earliest
    expect(groups[0].absorbed.map((l) => l.id)).toEqual([2]);
    expect(groups[0].survivor.last_seen_at).toBe(now);  // max of absorbed
    expect(groups[0].survivor.hit_count).toBe(8);  // sum
  });

  it("does NOT collapse leaves within span threshold (recent duplicates handled by reconciler)", () => {
    const now = 100_000_000;
    const leaves = [
      makeLeaf({ id: 1, first_seen_at: now - 5 * 86_400_000, embedding: [1, 0, 0] }),
      makeLeaf({ id: 2, first_seen_at: now - 1 * 86_400_000, embedding: [0.99, 0.01, 0] }),
    ];
    const groups = dedupAcrossSessions(leaves, { mergeThreshold: 0.92, spanThresholdMs: 30 * 86_400_000, now });
    expect(groups).toEqual([]);
  });

  it("does NOT collapse leaves that are not cosine-similar", () => {
    const now = 100_000_000;
    const leaves = [
      makeLeaf({ id: 1, first_seen_at: now - 60 * 86_400_000, embedding: [1, 0, 0] }),
      makeLeaf({ id: 2, first_seen_at: now - 10 * 86_400_000, embedding: [0, 1, 0] }),
    ];
    const groups = dedupAcrossSessions(leaves, { mergeThreshold: 0.92, spanThresholdMs: 30 * 86_400_000, now });
    expect(groups).toEqual([]);
  });

  it("groups of 3+ collapse correctly (earliest wins, rest absorbed)", () => {
    // 3 leaves, same embedding, first_seen_at spaced 40 days apart
    // expect: 1 group, survivor = earliest, 2 absorbed
  });

  it("respects FERAL_FMS_DEDUP_SPAN_MS env override", () => {
    // ...
  });
});
```

### Verify-then-grep
```
grep -rn "dedupAcrossSessions\|FERAL_FMS_DEDUP_SPAN_MS" FeralAgent/src/ FeralAgent/tests/
```
Expected: the new file + the wiring in `fractal-memory.ts` + tests.

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`

### Commit message
```
feat(memory): cross-session dedup runs after reconciler merge

- memory/fractal/cross-session-dedup.ts: greedy cosine + span grouping
- memory/fractal/fractal-memory.ts: dedup() method, prune pulse for absorbed
- tests/cross-session-dedup.test.ts: 5 cases

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-C Task C.3: complete (commits <base7>..<head7>, +5 tests, dedup live)
```

---

## Task C.4 — Bench scale at 10k and 100k

**Goal**: prove p99 < 100ms at 10k leaves and p99 < 500ms at 100k
leaves for `query()` and `upsertLeaf()`. Tests are env-gated
(`FERAL_FMS_BENCH=1`).

**Brief**: `.superpowers/sdd/task-C4-brief.md`.

### Files to add
- `FeralAgent/tests/fractal-scale.bench.ts` — env-gated. At the top:
  ```ts
  const ENABLED = process.env.FERAL_FMS_BENCH === "1";
  const itif = (cond: boolean) => (cond ? it : it.skip);
  // then itif(ENABLED)("lays out 10k leaves with p99 < 100ms", ...)
  ```

### Tests

```ts
describe.skipif(!ENABLED)("FMS scale (FERAL_FMS_BENCH=1)", () => {
  it("query p99 < 100ms at 10k leaves", () => {
    const mem = buildMemoryWithLeaves(10_000);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) mem.query(randomQuery(), 5);
    const p99 = p99of(timings); // capture timings array
    expect(p99).toBeLessThan(100);
  });

  it("query p99 < 500ms at 100k leaves", () => {
    const mem = buildMemoryWithLeaves(100_000);
    // ... same shape
  });

  it("upsertLeaf p99 < 50ms at 5k leaves", () => {
    const mem = buildMemoryWithLeaves(5_000);
    // ...
  });
});
```

### Verify-then-grep
```
grep -rn "FERAL_FMS_BENCH" FeralAgent/ docs/agents-memory/
```
Expected: the env-gate string in the new test + `AGENTS.md` /
`project_fractal_bench_blockers.md` updates. If `AGENTS.md` doesn't
already mention the env var, STOP and add a one-line note to it.

### Files to update
- `docs/agents-memory/project_fractal_bench_blockers.md` — append a new
  section "Pathway 4 PR-C numbers" with the actual p99 values measured.
  Update the SHIP table.

### Gate (gated by env)
- Default `bun test` run: scale tests SKIPPED (green).
- With `FERAL_FMS_BENCH=1 bun test tests/fractal-scale.bench.ts`: scale
  tests RUN and assert.

### Commit message
```
bench(memory): FMS scale tests at 10k and 100k leaves (env-gated)

- tests/fractal-scale.bench.ts: 3 tests, gated by FERAL_FMS_BENCH=1
- docs/agents-memory/project_fractal_bench_blockers.md: new section with numbers

Default CI does not run these (takes seconds). Set the env flag to
measure.

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-C Task C.4: complete (commits <base7>..<head7>, 3 env-gated bench tests, doc updated)
```

---

## Task C.5 — GPU embedding status (fix OR document)

**Goal**: the bge-small Vulkan crash is either fixed (driver / llama.cpp
update) OR permanently documented as CPU-only with
`FERAL_EMBED_GPU_LAYERS=0` as the canonical knob.

**Brief**: `.superpowers/sdd/task-C5-brief.md`.

### Sub-tasks
1. Try to enable Vulkan mode on this dev box (set
   `FERAL_EMBED_GPU_LAYERS=99`, run a smoke embed, observe the crash).
   If it doesn't crash now → fix confirmed → update `AGENTS.md` to
   remove the "bge-small crashes on Vulkan" line and add a regression
   test that asserts Vulkan mode produces a non-empty embedding.
2. If it still crashes → permanent CPU-only path. Add a test that
   asserts CPU mode produces a non-empty embedding with
   `FERAL_EMBED_GPU_LAYERS=0`. Update `AGENTS.md` and
   `project_local_models_gpu.md` to state CPU-only as the documented
   canonical state. Add a guard: `embed.ts` logs a one-line warning if
   the env var is unset and the model attempts Vulkan.

### Tests
- One test, either `embed-gpu-vulkan-mode.test.ts` (if Vulkan works) or
  `embed-cpu-mode-canonical.test.ts` (if not). Asserts a 768-dim vector
  is produced for a 100-char input.

### Verify-then-grep
```
grep -rn "FERAL_EMBED_GPU_LAYERS" FeralAgent/src/ docs/
```
Expected matches: the env-var reader in `embed.ts`, the new test, and
the updated docs.

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`

### Commit message
```
docs(memory): GPU embedding status — Vulkan (fixed) OR CPU-only (documented)

[Either:]
- GPU mode now stable; regression test asserts non-empty embedding
- OR CPU-only is the canonical path; FERAL_EMBED_GPU_LAYERS=0 the documented knob

See AGENTS.md and project_local_models_gpu.md for the current state.

Spec: docs/superpowers/specs/2026-06-23-pathway4-rsi-fms-production-design.md
```

### Append to progress.md
```
- Pathway 4 PR-C Task C.5: complete (commits <base7>..<head7>, +1 test, GPU status resolved)
```

---

## PR-C: Final review + push

### Gate
- `cd FeralAgent && bunx tsc --noEmit && bun test`

Test count delta (non-skipped): `baseline + 17` (6 + 5 + 5 + 0 [skipped] + 1).

### Push + PR
Push branch. Open PR. Title: `feat(memory): FMS quality at scale (eviction, dedup, bench, GPU status)`.

### PR description
- Scope justification (4 FMS blockers not in step-2)
- What landed (commits C.1-C.5)
- Eviction invariants (file contents assertion in test)
- Dedup invariants (earliest-wins + max-last-seen + sum-hit-count assertions)
- Scale numbers (paste bench output with FERAL_FMS_BENCH=1)
- GPU embedding status (fixed OR documented)

---

# Conventions (all three PRs)

- Frequent, scoped commits. No amend. No force-push.
- Append `.superpowers/sdd/progress.md` per task.
- STOP and report on any unexpected grep match.
- After all three PRs land, mark Pathway 4 complete in
  `.superpowers/sdd/progress.md` and request final review.
