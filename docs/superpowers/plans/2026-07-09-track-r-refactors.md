# Track R Refactors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the six post-blocker refactors from `docs/2026-07-09-v1-architecture-hardening-spec.md` Track R (R1, R2, R3, R6, R7, R8) in spec-mandated sequence, behavior-preserving throughout.

**Architecture:** Five phases, each its own task with its own commit and gate. R4/R5 are already done (commits 73fe35c, f7913c0) and are NOT part of this plan. Sequence per spec §"Sequencing": R1 → R2+R8 (combined per spec's own instruction) → R3 → R7 → contributor gate → R6.

**Tech Stack:** Bun/TypeScript sidecar (`FeralAgent/`), Rust Tauri desktop (`src-tauri/`), Rust core lib (`crates/feral-core/`), Go TUI (`tui/`, untouched by this plan).

## Global Constraints

- Zero logic edits on mechanical tasks (R2, R7, R8) — moves and re-exports only, verified by identical test output before/after.
- Every task ends with: `cd FeralAgent && bun test` green, `cargo test --workspace` green (or `-p feral-core`/`-p src-tauri` if scoped), `bunx tsc --noEmit` clean, `cargo tauri dev` boots (spot-check for the tasks touching Rust boot paths).
- TS-side changes to the sidecar require `bun run build` (in `FeralAgent/`) + copy the output binary to `src-tauri/binaries/` before any claim of "smoke tested" — the dev loop does not auto-rebuild the sidecar.
- Never skip hooks, never `--no-verify`, never force-push.
- Each task is its own commit, not amended together.

---

### Task 1: R1 — Version + schema the stdin protocol

**Files:**
- Create: `FeralAgent/src/protocol.ts`
- Create: `crates/feral-core/src/sidecar_protocol.rs`
- Create: `crates/feral-core/tests/protocol_drift.rs`
- Modify: `FeralAgent/src/index.ts` (hello line only — leave the switch as-is per spec §5 fallback)
- Modify: `crates/feral-core/src/feral_agent.rs` (hello read in `stdout_reader`)
- Modify: `crates/feral-core/src/lib.rs` (register `sidecar_protocol` module, if not auto-discovered)

**Interfaces:**
- Produces: `FeralAgent/src/protocol.ts` exports `export const SIDECAR_PROTOCOL = 1;` and `export const INBOUND_TYPES: readonly string[]` / `export const OUTBOUND_TYPES: readonly string[]`.
- Produces: `crates/feral-core/src/sidecar_protocol.rs` exports `pub const SIDECAR_PROTOCOL: u32 = 1;`, `pub const INBOUND_TYPES: &[&str]`, `pub const OUTBOUND_TYPES: &[&str]`.
- Consumes (R1 only, no upstream task dependency in this plan).

- [ ] **Step 1: Harvest the inbound/outbound type lists**

Read `FeralAgent/src/types.ts` `InboundMessage.type` union (~line 905) and `OutboundEvent` union (~line 1095), plus the `switch` in `index.ts` (~line 1259 onward) to catch any case not present in the type union (there should be none — the union is the source of truth; the switch is downstream). Write the exhaustive list down before writing `protocol.ts` — this list becomes the literal array contents in the next step, so get it right the first time (currently ~24 inbound types, ~50 outbound types; exact counts may drift, count what you actually read).

- [ ] **Step 2: Write `FeralAgent/src/protocol.ts`**

```typescript
// FeralAgent/src/protocol.ts
// Single source of truth for the desktop<->sidecar stdin/stdout protocol.
// Rust mirror: crates/feral-core/src/sidecar_protocol.rs (kept in sync by
// crates/feral-core/tests/protocol_drift.rs).

export const SIDECAR_PROTOCOL = 1;

export const INBOUND_TYPES = [
  "message", "ping", "shutdown", "set_model", "stop",
  "ask_user_response", "ask_user_cancel",
  "cron_add", "cron_remove", "cron_toggle", "cron_list",
  "desktop_control_response", "connectors_reload",
  "fractal_benchmark", "fractal_cluster_leaves",
  "rsi_start", "rsi_stop", "rsi_set_concurrency", "rsi_dream_now",
  "rsi_code_patches_list", "rsi_code_patch_resolve",
  "rsi_lora_train", "rsi_lora_reviews_list", "rsi_lora_review_resolve",
  "meta_status", "meta_evolve", "meta_rollback", "meta_history",
  "governance_status", "governance_propose", "governance_approve",
  "governance_reject", "governance_rollback", "governance_freeze",
  "governance_unfreeze", "governance_verify", "governance_history",
  "modules_list", "module_resolve", "module_evaluate",
  "mcp_reload", "mcp_status", "mcp_list_tools", "mcp_call_tool",
  "resume_get",
] as const;

export const OUTBOUND_TYPES = [
  "chunk", "done", "tool_start", "tool_progress", "tool_done", "proactive",
  "model_set", "model_error", "pong", "error", "ask_user",
  "ask_user_cancelled", "usage", "budget_warning", "budget_exceeded",
  "heartbeat", "stream_progress", "cron_fired", "cron_error",
  "desktop_control_request", "rsi_request", "meta_result",
  "governance_result", "modules_result", "mcp_result",
  "resume_get_result", "fractal_bench_progress", "fractal_bench_result",
  "code_patches", "code_patch_resolved", "lora_reviews",
  "lora_review_resolved", "lora_train_result", "fractal_activity",
  "fractal_cluster_leaves_result", "dream_cycle", "provider_added",
  "provider_removed", "provider_validated", "provider_validation_failed",
  "connector_configured", "connector_connected", "connector_disconnected",
  "connector_connection_failed", "memory_mode_changed",
  "permission_changed", "model_download_started",
  "model_download_progress", "model_download_finished",
  "model_download_failed", "wizard_step_completed",
  "onboarding_goal_completed", "onboarding_all_goals_done",
  "onboarding_suggestion", "confirmation_required",
  "confirmation_granted", "confirmation_denied", "hello",
] as const;
```

Note: `hello` is added to `OUTBOUND_TYPES` even though it's not in `types.ts` today — it's the new boot line. Reconcile the exact list against what you actually read in Step 1; this snippet is a starting point, not gospel — if your read finds different names, use what's in the code.

- [ ] **Step 3: Write a TS test asserting the lists are non-empty and have no duplicates**

```typescript
// FeralAgent/tests/protocol.test.ts
import { describe, expect, test } from "bun:test";
import { INBOUND_TYPES, OUTBOUND_TYPES, SIDECAR_PROTOCOL } from "../src/protocol.ts";

describe("protocol.ts", () => {
  test("SIDECAR_PROTOCOL is 1", () => {
    expect(SIDECAR_PROTOCOL).toBe(1);
  });
  test("no duplicate inbound types", () => {
    expect(new Set(INBOUND_TYPES).size).toBe(INBOUND_TYPES.length);
  });
  test("no duplicate outbound types", () => {
    expect(new Set(OUTBOUND_TYPES).size).toBe(OUTBOUND_TYPES.length);
  });
});
```

- [ ] **Step 4: Run the test, verify pass**

Run: `cd FeralAgent && bun test tests/protocol.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Emit the hello line first in `index.ts`**

Find the earliest point stdout becomes protocol-reserved (the comment at the old ~line 2310 area, near `transport.onReady`). Before any other stdout write, add:

```typescript
import { SIDECAR_PROTOCOL } from "./protocol.ts";
// ...
console.log(JSON.stringify({ type: "hello", protocol: SIDECAR_PROTOCOL }));
```

Place it as the literal first line of output the process ever produces — before transport setup logs, before `transport.onReady`. If `transport.onReady`'s callback is itself the earliest safe point (transports may buffer until ready), put it as the first line inside that callback instead, and note in the commit message which point you chose and why.

- [ ] **Step 6: Write `crates/feral-core/src/sidecar_protocol.rs`**

```rust
//! Rust mirror of FeralAgent/src/protocol.ts. Kept in sync by
//! tests/protocol_drift.rs, which reads protocol.ts at test time and
//! diffs the name sets.

pub const SIDECAR_PROTOCOL: u32 = 1;

pub const INBOUND_TYPES: &[&str] = &[
    "message", "ping", "shutdown", "set_model", "stop",
    "ask_user_response", "ask_user_cancel",
    "cron_add", "cron_remove", "cron_toggle", "cron_list",
    "desktop_control_response", "connectors_reload",
    "fractal_benchmark", "fractal_cluster_leaves",
    "rsi_start", "rsi_stop", "rsi_set_concurrency", "rsi_dream_now",
    "rsi_code_patches_list", "rsi_code_patch_resolve",
    "rsi_lora_train", "rsi_lora_reviews_list", "rsi_lora_review_resolve",
    "meta_status", "meta_evolve", "meta_rollback", "meta_history",
    "governance_status", "governance_propose", "governance_approve",
    "governance_reject", "governance_rollback", "governance_freeze",
    "governance_unfreeze", "governance_verify", "governance_history",
    "modules_list", "module_resolve", "module_evaluate",
    "mcp_reload", "mcp_status", "mcp_list_tools", "mcp_call_tool",
    "resume_get",
];

pub const OUTBOUND_TYPES: &[&str] = &[
    "chunk", "done", "tool_start", "tool_progress", "tool_done", "proactive",
    "model_set", "model_error", "pong", "error", "ask_user",
    "ask_user_cancelled", "usage", "budget_warning", "budget_exceeded",
    "heartbeat", "stream_progress", "cron_fired", "cron_error",
    "desktop_control_request", "rsi_request", "meta_result",
    "governance_result", "modules_result", "mcp_result",
    "resume_get_result", "fractal_bench_progress", "fractal_bench_result",
    "code_patches", "code_patch_resolved", "lora_reviews",
    "lora_review_resolved", "lora_train_result", "fractal_activity",
    "fractal_cluster_leaves_result", "dream_cycle", "provider_added",
    "provider_removed", "provider_validated", "provider_validation_failed",
    "connector_configured", "connector_connected", "connector_disconnected",
    "connector_connection_failed", "memory_mode_changed",
    "permission_changed", "model_download_started",
    "model_download_progress", "model_download_finished",
    "model_download_failed", "wizard_step_completed",
    "onboarding_goal_completed", "onboarding_all_goals_done",
    "onboarding_suggestion", "confirmation_required",
    "confirmation_granted", "confirmation_denied", "hello",
];
```

Must be byte-for-byte the same string set as `protocol.ts` (Step 2 as corrected in Step 5). Add `pub mod sidecar_protocol;` to `crates/feral-core/src/lib.rs` if the crate root doesn't already glob-include all top-level files (check the existing `pub mod` list in `lib.rs` first — follow that pattern exactly).

- [ ] **Step 7: Write the cross-language drift test**

```rust
// crates/feral-core/tests/protocol_drift.rs
//! R1: fails if FeralAgent/src/protocol.ts and
//! crates/feral-core/src/sidecar_protocol.rs name sets diverge.

use std::collections::HashSet;
use std::path::PathBuf;

fn extract_ts_array(source: &str, const_name: &str) -> HashSet<String> {
    let start = source
        .find(&format!("export const {const_name}"))
        .unwrap_or_else(|| panic!("{const_name} not found in protocol.ts"));
    let open = source[start..].find('[').unwrap() + start;
    let close = source[open..].find(']').unwrap() + open;
    let body = &source[open + 1..close];
    body.split(',')
        .filter_map(|s| {
            let s = s.trim();
            let s = s.trim_start_matches('"').trim_end_matches('"');
            if s.is_empty() { None } else { Some(s.to_string()) }
        })
        .collect()
}

#[test]
fn inbound_and_outbound_types_match_ts() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let ts_path = PathBuf::from(&manifest_dir)
        .join("../../FeralAgent/src/protocol.ts");
    let ts_source = std::fs::read_to_string(&ts_path)
        .unwrap_or_else(|e| panic!("read {ts_path:?}: {e}"));

    let ts_inbound = extract_ts_array(&ts_source, "INBOUND_TYPES");
    let ts_outbound = extract_ts_array(&ts_source, "OUTBOUND_TYPES");

    let rs_inbound: HashSet<String> = feral_core::sidecar_protocol::INBOUND_TYPES
        .iter().map(|s| s.to_string()).collect();
    let rs_outbound: HashSet<String> = feral_core::sidecar_protocol::OUTBOUND_TYPES
        .iter().map(|s| s.to_string()).collect();

    assert_eq!(ts_inbound, rs_inbound, "inbound type sets diverged");
    assert_eq!(ts_outbound, rs_outbound, "outbound type sets diverged");
}
```

Verify `feral-core`'s crate name in `Cargo.toml` matches `feral_core::` (check `crates/feral-core/Cargo.toml` `[package] name =`). Adjust the `use`/path if the manifest dir structure differs from `../../FeralAgent` (confirm relative path from `crates/feral-core/` to the repo root's `FeralAgent/` — it's two levels up from `crates/feral-core/`).

- [ ] **Step 8: Run the drift test, verify pass**

Run: `cargo test -p feral-core --test protocol_drift`
Expected: 1 pass.

- [ ] **Step 9: Verify the test actually catches drift (manual, once)**

Temporarily delete one entry from `sidecar_protocol.rs`'s `INBOUND_TYPES`, rerun the test, confirm it fails with the assertion diff, then restore the entry. Note in the PR description that this was verified by hand (spec's B5 pattern — "fails when its guard is deliberately broken").

- [ ] **Step 10: Read the hello line on the Rust side**

In `crates/feral-core/src/feral_agent.rs`, find `stdout_reader` (~line 662) where it does `serde_json::from_str::<serde_json::Value>(&line)` (~line 680). Before/alongside the existing dispatch, detect the first line: if `v["type"] == "hello"`, extract `v["protocol"]` as u32, compare to `feral_core::sidecar_protocol::SIDECAR_PROTOCOL`; on mismatch `tracing::warn!` loudly (include both versions in the message) and continue processing — do NOT return an error, do NOT stop the reader loop. If the sidecar's very first line is not a hello (e.g. old binary), just proceed without incident (v1 warn-only per spec — no hard requirement that hello arrives).

Implementation approach: track a `bool` `seen_first_line` (or check via a `matches!` on `v.get("type").and_then(|t| t.as_str())`) so the check runs once, not on every line.

- [ ] **Step 11: Build and test the Rust side**

Run: `cargo build -p feral-core && cargo test -p feral-core`
Expected: builds clean, all tests pass (baseline 165 pass per B5 handoff + the 1 new drift test + any new unit test you added for the hello-read branch).

- [ ] **Step 12: Rebuild the sidecar binary and smoke the hello line**

Run: `cd FeralAgent && bun run build` then copy the produced binary to `src-tauri/binaries/` per the existing naming convention (check `src-tauri/binaries/` for the current filename pattern before copying — it's target-triple-suffixed).

Run: `cd FeralAgent && bun run start` (or the sidecar's direct invocation command — check `package.json` `scripts` for the exact one) piped through `head -1`, confirm the first stdout line is `{"type":"hello","protocol":1}` (formatting may vary; content must match).

- [ ] **Step 13: Full suite gate**

Run: `cd FeralAgent && bun test` — expect the same pass count as the B5 baseline (2118 pass) plus the new `protocol.test.ts` (3 more).
Run: `cargo test --workspace` — expect the B5 baseline (165 for feral-core) plus 1 (drift test) plus whatever new unit test Step 10 added.
Run: `cd FeralAgent && bunx tsc --noEmit` — clean.

- [ ] **Step 14: Commit**

```bash
git add FeralAgent/src/protocol.ts FeralAgent/tests/protocol.test.ts FeralAgent/src/index.ts crates/feral-core/src/sidecar_protocol.rs crates/feral-core/src/feral_agent.rs crates/feral-core/src/lib.rs crates/feral-core/tests/protocol_drift.rs src-tauri/binaries/
git commit -m "refactor(arch): R1 version + schema the sidecar protocol"
```

---

### Task 2: R2 + R8 — Subdivide `rsi/` by layer, rename `sandbox/` → `egress/`

Per spec: "Do it in the same PR as R2 or not at all — one import-churn event, not two." Both are pure `git mv` + import updates, zero logic edits, so they're combined into one task here.

**Files:**
- Move: all 84 files currently in `FeralAgent/src/rsi/` (list captured in Step 1 below) into `rsi/infra/`, `rsi/l1-config/`, `rsi/l2-adapt/`, `rsi/l3-code/`, `rsi/l4-modules/`, `rsi/l5-gov/`, `rsi/l6-meta/`, or leave at `rsi/` root (only `sidecar.ts`, `engine.ts`, `mod.ts`).
- Move: `FeralAgent/src/sandbox/*` → `FeralAgent/src/egress/*`.
- Create: `FeralAgent/src/rsi/README.md`.
- Modify: every file across `FeralAgent/src/` and `FeralAgent/tests/` that imports from `rsi/` or `sandbox/` (import path churn only).
- Modify: `docs/2026-07-09-v1-architecture-hardening-spec.md` ARCHITECTURE.md link target if B4's doc references old paths (check `docs/ARCHITECTURE.md` — the B4 deliverable — for path literals and update them too).

**Interfaces:** None — this task changes no exported names, signatures, or behavior. Downstream tasks (R3, R7) will `import` from these new paths.

- [ ] **Step 1: Categorize every file, resolving ambiguity per the spec's rule**

Take the 84-file listing already captured for this plan (see spec §R2 code block for the bulk of the mapping) and assign every file. For each file NOT explicitly named in the spec's mapping block, check `docs/invariants.md`'s owner column and the L4/L5 spec citations (`docs/2026-07-*-l4-*.md`, `docs/2026-07-*-l5-*.md`) for which layer claims it; if still ambiguous, put it in `infra/` with a one-line `// ponytail:`-style comment noting the ambiguity at the top of the file (do not invent a new rule — the spec says "infra/ + a one-line comment", follow that literally).

Files needing explicit resolution per the spec's own callout: `contract-deps.ts`, `contract-leaves.ts`, `contract-runner.ts`, `contract-stages.ts`, `contract.ts` — check whether L1 promotion consumes the contract FSM (search `rsi/l1-config` candidate files — genome/champion/ratchet — for `import.*contract`) before deciding `l3-code/` vs `infra/`.

Write the final mapping as a shell array or a simple text table before moving anything — this is the artifact reviewers will check against `git log --follow`.

- [ ] **Step 2: Grep for load-bearing string/dynamic-path references before moving**

Run: `cd FeralAgent && grep -rn "import(" src/ tests/` and `grep -rn '\.ts"' src/ tests/` (the spec explicitly calls out `module-host-client.ts`'s text-import of `module-host.ts` as an asset path that must not silently break). Note every hit that references an `rsi/` or `sandbox/` path by string literal (not a normal `import ... from` statement) — these need manual path updates, not a mechanical import-rewrite tool.

- [ ] **Step 3: Create the new directory structure and move files**

```bash
cd FeralAgent/src/rsi
mkdir -p infra l1-config l2-adapt l3-code l4-modules l5-gov l6-meta
# Example (repeat per your Step 1 mapping — this is illustrative, not exhaustive):
git mv journal.ts infra/journal.ts
git mv event-bus.ts infra/event-bus.ts
git mv hash-chain.ts infra/hash-chain.ts
git mv instance-paths.ts infra/instance-paths.ts
git mv provenance.ts infra/provenance.ts
git mv envelope-store.ts infra/envelope-store.ts
git mv budget.ts infra/budget.ts
git mv rsi-cost.ts infra/rsi-cost.ts
git mv resource-monitor.ts infra/resource-monitor.ts
git mv adapters.ts infra/adapters.ts
git mv bridge.ts infra/bridge.ts
git mv genome.ts l1-config/genome.ts
git mv mutation.ts l1-config/mutation.ts
git mv fitness.ts l1-config/fitness.ts
# ... continue for every file per the Step 1 mapping.
# sidecar.ts, engine.ts, mod.ts stay in place — do not move.
cd ../../..
git mv src/sandbox src/egress
```

Do this file-by-file per your Step 1 table, not as a bulk script that guesses — each `git mv` should trace to a specific line in your mapping.

- [ ] **Step 4: Update imports mechanically**

Run a project-wide search/replace for old → new relative paths. Because relative import depth changes (files moving one directory deeper need an extra `../`), do this with the TS compiler as the checker, not blind sed: run `bunx tsc --noEmit` repeatedly, fix each reported broken import path, until clean. Expect several hundred import-line edits — this is expected churn, not a signal something is wrong.

For the `sandbox/` → `egress/` rename specifically, also grep for the string `"sandbox"` (not just import paths) in case any log messages, error strings, or config keys reference the old name literally — spec says rename the directory, not necessarily user-facing strings; only touch import paths and file-system paths, leave unrelated prose alone unless it specifically means "the directory."

- [ ] **Step 5: Fix the flagged string/dynamic-path references from Step 2**

For each hit from Step 2 (e.g. `module-host-client.ts`'s embedded text-import of `module-host.ts`), manually update the literal path to match the new location. Text-import syntax (Bun's `with { type: "text" }` or equivalent — check the existing import statement's exact syntax before editing) must still resolve after the move.

- [ ] **Step 6: Write `FeralAgent/src/rsi/README.md`**

```markdown
# rsi/ layer map

R2 (2026-07): subdivided by BRSI layer. Root holds only the cross-layer
orchestrators (sidecar.ts, engine.ts, mod.ts) — everything else lives under
its layer directory.

- `infra/` — journal, event-bus, hash-chain, instance-paths, provenance,
  envelope-store, budget, rsi-cost, resource-monitor, adapters, bridge.
- `l1-config/` — genome, mutation, fitness, selection, population,
  crossover, champion, taste, strategy-seeds, birth-policy, extinction,
  escape-time, recalcitrance, dream-*, pbt-*, fractal, goal-mode.
- `l2-adapt/` — lora-*, trainers/, dataset-builder, personal-fitness.
- `l3-code/` — code-*, pending-patches, contract-*.
- `l4-modules/` — module-*, seam-*.
- `l5-gov/` — governance*.
- `l6-meta/` — meta-evolution.

RSI = Recursive Self-Improvement. Full glossary: `docs/ARCHITECTURE.md`.
```

Fill in any deviations your Step 1 mapping made from this sketch (e.g. where `contract-*` actually landed) before committing.

- [ ] **Step 7: Update `docs/ARCHITECTURE.md` path references**

Grep `docs/ARCHITECTURE.md` for `rsi/` and `sandbox/` path literals (the B4 layer map names specific files); update each to its new path. Add a link to `rsi/README.md`.

- [ ] **Step 8: Full suite gate**

Run: `cd FeralAgent && bunx tsc --noEmit` — clean, zero errors.
Run: `cd FeralAgent && bun test` — same pass/skip/fail counts as the R1-task baseline (test files themselves may need import-path fixes too — grep `tests/` for `rsi/` and `sandbox/` imports and fix alongside Step 4).
Run: `git log --follow FeralAgent/src/rsi/l1-config/genome.ts` (or any one moved file) — confirms history preserved.
Run: `ls FeralAgent/src/rsi/*.ts` — expect exactly `sidecar.ts engine.ts mod.ts` (plus `README.md`), nothing else.

- [ ] **Step 9: Rebuild sidecar and smoke boot**

Run: `cd FeralAgent && bun run build`, copy to `src-tauri/binaries/`, `cargo tauri dev`, confirm the app boots and a chat round-trips (this is pure import churn but the sidecar binary must still start — a missed relative path in the text-import asset would only surface at runtime, not at `tsc` time).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(arch): R2+R8 subdivide rsi/ by layer, rename sandbox/ to egress/"
```

---

### Task 3: R3 — Central typed config module

**Files:**
- Create: `FeralAgent/src/config.ts`
- Create: `FeralAgent/tests/config.test.ts`
- Create: `scripts/gen-config-docs.mjs`
- Modify: `docs/CONFIGURATION.md` (regenerated TS section; keep B2's Rust section hand-written)
- Modify: `scripts/check-env-docs.mjs` (point at `config.ts` schema instead of hand-maintained list)
- Modify: security-group call sites — `FeralAgent/src/egress/process-sandbox.ts` (shell/code exec knobs), desktop-control call sites (grep `FERAL_DESKTOP_CONTROL`), `FERAL_WORKSPACE`/`FERAL_AGENT_WORKSPACE` readers, `FERAL_DB_KEY` reader — migrate these plus the top-10 most-read vars (determine top-10 by occurrence count in Step 1).

**Interfaces:**
- Consumes: `FeralAgent/src/egress/` (post-R2 path) for the security-group call sites being migrated.
- Produces: `cfgBool(name)`, `cfgInt(name)`, `cfgPath(name)`, `cfgList(name)` typed getters other tasks/future work will call instead of raw `process.env.FERAL_*`.

- [ ] **Step 1: Harvest every `FERAL_*` env read**

Run: `cd FeralAgent && grep -rn "process\.env\.FERAL_" src/ | sort` and dedupe by var name, counting occurrences per name (`grep -roh "FERAL_[A-Z_]*" src/ | sort | uniq -c | sort -rn`). This produces the schema table's row list and identifies the top-10 by read count for the migration scope.

- [ ] **Step 2: Write the failing schema-completeness test**

```typescript
// FeralAgent/tests/config.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SCHEMA } from "../src/config.ts";

const SRC = join(import.meta.dir, "..", "src");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "config.ts") continue; // the schema itself may reference names as strings
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Grandfathered: vars read directly via process.env.FERAL_* outside
// config.ts as of R3. Shrink this list opportunistically; do NOT add to it.
const GRANDFATHERED = new Set<string>([
  // populated in Step 3 from the Step 1 harvest, minus whatever got migrated
]);

describe("config.ts", () => {
  test("no new process.env.FERAL_ reads outside config.ts and the grandfathered list", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      const matches = text.matchAll(/process\.env\.(FERAL_[A-Z_]*)/g);
      for (const m of matches) {
        if (!GRANDFATHERED.has(m[1]!)) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every schema entry has a getter-compatible type", () => {
    for (const entry of CONFIG_SCHEMA) {
      expect(["bool", "int", "path", "list", "string"]).toContain(entry.type);
    }
  });
});
```

- [ ] **Step 3: Run the test to see it fail (no `config.ts` yet)**

Run: `cd FeralAgent && bun test tests/config.test.ts`
Expected: FAIL — `config.ts` module not found.

- [ ] **Step 4: Write `FeralAgent/src/config.ts`**

```typescript
// FeralAgent/src/config.ts
// Single source of truth for FERAL_* environment configuration.
// R3: replaces ad-hoc process.env.FERAL_* reads. New vars: add a schema
// row here, do not read process.env directly elsewhere (tests/config.test.ts
// enforces this for new code; existing call sites are grandfathered).

export interface ConfigEntry {
  name: string;
  type: "bool" | "int" | "path" | "list" | "string";
  default: string | number | boolean | null;
  description: string;
  security: boolean;
}

// Populate from the Step 1 harvest. Security group first (per spec):
export const CONFIG_SCHEMA: ConfigEntry[] = [
  { name: "FERAL_ENABLE_CODE_EXEC", type: "bool", default: false,
    description: "Allow the agent to execute arbitrary shell/code.", security: true },
  { name: "FERAL_AGENT_WORKSPACE", type: "path", default: null,
    description: "Rust-side workspace root (distinct from FERAL_WORKSPACE).", security: true },
  { name: "FERAL_WORKSPACE", type: "list", default: null,
    description: "TS sidecar workspace root path-list.", security: true },
  { name: "FERAL_DB_KEY", type: "string", default: null,
    description: "Database encryption key.", security: true },
  // ... continue with the full Step 1 harvest list, security:false for the rest.
];

function findEntry(name: string): ConfigEntry {
  const e = CONFIG_SCHEMA.find((c) => c.name === name);
  if (!e) throw new Error(`config.ts: ${name} not in CONFIG_SCHEMA — add a schema row first`);
  return e;
}

export function cfgBool(name: string): boolean {
  const entry = findEntry(name);
  const raw = process.env[name];
  if (raw === undefined) return entry.default as boolean;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function cfgInt(name: string): number {
  const entry = findEntry(name);
  const raw = process.env[name];
  if (raw === undefined) return entry.default as number;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? (entry.default as number) : n;
}

export function cfgPath(name: string): string | null {
  const entry = findEntry(name);
  return process.env[name] ?? (entry.default as string | null);
}

export function cfgList(name: string): string[] {
  const entry = findEntry(name);
  const raw = process.env[name];
  if (raw === undefined) return entry.default ? [entry.default as string] : [];
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}
```

Fill `CONFIG_SCHEMA` with every var from the Step 1 harvest — defaults must match the CURRENT call site's default exactly (grep the site, don't guess). Per the spec's trap warning: if two call sites for the same var name have DIFFERENT defaults today, do not silently unify — pick one, and list every such conflict explicitly in the commit message.

- [ ] **Step 5: Populate `GRANDFATHERED` in the test and rerun**

Fill the `GRANDFATHERED` set in `config.test.ts` with every var name from the Step 1 harvest that you are NOT migrating in this pass (i.e. everything except the security group + top-10).

Run: `cd FeralAgent && bun test tests/config.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Migrate the security-group call sites**

For each of `FERAL_ENABLE_CODE_EXEC`, `FERAL_AGENT_WORKSPACE`/`FERAL_WORKSPACE`, `FERAL_DB_KEY`, and the desktop-control knobs: find the call site (from Step 1's grep output), replace `process.env.FERAL_X === "1"` (or whatever the local pattern is) with `cfgBool("FERAL_X")` (or `cfgPath`/`cfgList` as appropriate), add the import `import { cfgBool, cfgPath, cfgList } from "./config.ts";` (adjust relative path per file location post-R2).

- [ ] **Step 7: Migrate the top-10 most-read vars**

Same mechanical replace for the top-10 by occurrence count from Step 1 (excluding ones already done in Step 6).

- [ ] **Step 8: Remove migrated names from `GRANDFATHERED`, rerun the completeness test**

Run: `cd FeralAgent && bun test tests/config.test.ts`
Expected: still 2 pass (offenders list shrinks but stays empty since migrated sites no longer match the regex).

- [ ] **Step 9: Write `scripts/gen-config-docs.mjs`**

```javascript
#!/usr/bin/env node
// scripts/gen-config-docs.mjs
// R3: regenerates the TS-side table in docs/CONFIGURATION.md from
// FeralAgent/src/config.ts CONFIG_SCHEMA. Rust-side vars are hand-maintained
// (separate section, this script does not touch it).
import { readFileSync, writeFileSync } from "node:fs";

const configSrc = readFileSync(
  new URL("../FeralAgent/src/config.ts", import.meta.url), "utf8",
);
const match = configSrc.match(/CONFIG_SCHEMA: ConfigEntry\[\] = \[([\s\S]*?)\n\];/);
if (!match) throw new Error("CONFIG_SCHEMA not found in config.ts");

const entryRe = /\{\s*name:\s*"([^"]+)",\s*type:\s*"([^"]+)",\s*default:\s*([^,]+),\s*description:\s*"([^"]*)",\s*security:\s*(true|false)\s*\}/g;
const rows = [...match[1].matchAll(entryRe)].map((m) => ({
  name: m[1], type: m[2], default: m[3].trim(), description: m[4], security: m[5] === "true",
}));

const lines = [
  "<!-- AUTO-GENERATED by scripts/gen-config-docs.mjs from FeralAgent/src/config.ts. Do not hand-edit this section. -->",
  "",
  "| Var | Type | Default | Security | Description |",
  "|---|---|---|---|---|",
  ...rows.map((r) => `| \`${r.name}\` | ${r.type} | \`${r.default}\` | ${r.security ? "yes" : ""} | ${r.description} |`),
];

const docPath = new URL("../docs/CONFIGURATION.md", import.meta.url);
const existing = readFileSync(docPath, "utf8");
const marker = "<!-- TS-SCHEMA-TABLE -->";
if (!existing.includes(marker)) {
  throw new Error(`docs/CONFIGURATION.md missing ${marker} — add it where the generated table should go`);
}
const [before, after] = existing.split(marker);
const rest = after.split("<!-- /TS-SCHEMA-TABLE -->")[1] ?? "";
writeFileSync(docPath, `${before}${marker}\n${lines.join("\n")}\n<!-- /TS-SCHEMA-TABLE -->${rest}`);
console.log(`wrote ${rows.length} rows to docs/CONFIGURATION.md`);
```

- [ ] **Step 10: Insert the markers into `docs/CONFIGURATION.md` and run the generator**

Open `docs/CONFIGURATION.md` (from B2), find the hand-written TS var table, wrap it with `<!-- TS-SCHEMA-TABLE -->` / `<!-- /TS-SCHEMA-TABLE -->`, delete the hand-written rows between the markers (the script will fill them in).

Run: `node scripts/gen-config-docs.mjs`
Expected: prints row count, `docs/CONFIGURATION.md` TS section now matches `CONFIG_SCHEMA`.

- [ ] **Step 11: Update `scripts/check-env-docs.mjs` to check against the schema**

Read the existing `scripts/check-env-docs.mjs` (from B2) first — it currently checks doc completeness against a hand-scanned var list. Change its source of truth: instead of re-scanning `src/` for `FERAL_*` occurrences from scratch, it should (a) import/parse `CONFIG_SCHEMA` from `config.ts` and assert every entry appears in the generated doc table (this becomes near-trivial since the doc IS generated from the schema — the real check becomes "is the committed doc stale vs a fresh `gen-config-docs.mjs` run", i.e. diff the generated output against what's committed and fail if they differ), and (b) keep its existing grandfathered-list check for non-migrated vars unchanged. Do not silently widen what drift it tolerates — per the handoff note, this was the explicit ask.

- [ ] **Step 12: Add a `package.json` script (optional convenience) and CI-relevant test**

Add a Bun test that shells out to `node scripts/check-env-docs.mjs` and asserts exit code 0, mirroring however B2's original `env-docs.test.ts` invoked its check script (read that file first, match its pattern exactly).

- [ ] **Step 13: Full suite gate**

Run: `cd FeralAgent && bun test` — all green, new `config.test.ts` included.
Run: `node scripts/check-env-docs.mjs` — exit 0.
Run: `node scripts/gen-config-docs.mjs && git diff docs/CONFIGURATION.md` — expect empty diff (doc already matches the schema from Step 10).
Run: `cd FeralAgent && bunx tsc --noEmit` — clean.

- [ ] **Step 14: Commit**

```bash
git add FeralAgent/src/config.ts FeralAgent/tests/config.test.ts scripts/gen-config-docs.mjs scripts/check-env-docs.mjs docs/CONFIGURATION.md
git add -u  # migrated call sites
git commit -m "refactor(arch): R3 central typed config module, regenerate CONFIGURATION.md"
```

---

### Task 4: R7 — Split the god files (dispatch only)

**Files:**
- Create: `src-tauri/src/commands/` (submodules: `conversations.rs`, `models.rs`, `rsi.rs`, `governance.rs`, `connectors.rs`, `settings.rs`, plus whatever other domains the current `lib.rs` command list groups into — determine grouping in Step 1)
- Modify: `src-tauri/src/lib.rs` (shrinks to boot/setup + `mod commands;` + re-exports + the unchanged `collect_commands![...]` list)
- Create: `FeralAgent/src/boot.ts`, `FeralAgent/src/dispatch.ts`
- Modify: `FeralAgent/src/index.ts` (shrinks to a thin entry that calls `boot.ts` then wires `dispatch.ts`)

**Interfaces:**
- Consumes: `FeralAgent/src/protocol.ts` (R1, Task 1) for the dispatch handler map keying, per spec §R1 step 5 / §R7.
- Produces: nothing new consumed downstream — this is the last mechanical task before the contributor gate.

- [ ] **Step 1: Inventory `lib.rs`'s 74 commands and group by domain**

Run: `grep -n '^#\[tauri::command\]' src-tauri/src/lib.rs` to enumerate every command function, then read each function name and body briefly to assign a domain (conversations, models, rsi, governance, connectors, settings, mcp, desktop-control, voice, projects, system-info, etc. — let the actual function names in the current `collect_commands!` list at ~line 3221 dictate the grouping, don't force-fit the spec's example list if the real code suggests a cleaner split).

Record the exact **current order** of the `collect_commands![...]` list (Step 2 of R7's acceptance: diff this list's count and membership before/after — order does not matter, but every name must still appear exactly once).

- [ ] **Step 2: Create `src-tauri/src/commands/mod.rs` and per-domain files**

```rust
// src-tauri/src/commands/mod.rs
pub mod conversations;
pub mod models;
pub mod rsi;
pub mod governance;
pub mod connectors;
pub mod settings;
// ... one per domain identified in Step 1

pub use conversations::*;
pub use models::*;
pub use rsi::*;
pub use governance::*;
pub use connectors::*;
pub use settings::*;
```

For each domain file (e.g. `src-tauri/src/commands/conversations.rs`): move the `#[tauri::command]` functions for that domain verbatim (cut from `lib.rs`, paste into the new file), plus whatever `use` statements those functions need (copy the relevant subset from `lib.rs`'s top-of-file imports — don't paste the entire import block into every file, only what's referenced).

- [ ] **Step 3: Wire `lib.rs` to the new modules**

In `lib.rs`, add `mod commands;` and `use commands::*;` (or targeted re-exports matching Step 2's `pub use`). The `collect_commands![...]` macro invocation keeps the exact same function names — they resolve through the re-export, so this line should need ZERO edits beyond what Step 1 already recorded as the baseline list.

- [ ] **Step 4: Rust build + command-count check**

Run: `cargo build -p src-tauri 2>&1 | tee /tmp/r7-build.log` (or the appropriate `cargo check` invocation for this workspace member — check how other tasks in this repo invoke it, e.g. via `cargo tauri` wrapper) — must build clean with zero errors; any missing `use` shows up as an unresolved-name compile error, fix by importing the missing item into the domain file.

Write a Rust test asserting the command count is unchanged (spec's explicit ask: "bake the count check into a Rust test, not a manual diff"):

```rust
// src-tauri/src/commands/mod.rs (or a tests/ file, follow existing src-tauri test layout)
#[cfg(test)]
mod command_count_test {
    #[test]
    fn collect_commands_count_matches_baseline() {
        // R7: 74 commands as of the pre-split baseline (Task 4 Step 1 inventory).
        // Update this constant ONLY when a command is deliberately added/removed,
        // and note the change in that PR's description.
        const EXPECTED_COMMAND_COUNT: usize = 74; // <- set to your Step 1 count
        // There is no runtime introspection API for collect_commands! contents,
        // so this test reads lib.rs's macro invocation and counts identifiers —
        // mirrors scripts/check-api-docs.mjs's drift-check pattern (B1).
        let lib_rs = include_str!("../lib.rs");
        let start = lib_rs.find("collect_commands![").expect("macro not found");
        let open = start + "collect_commands![".len();
        let close = lib_rs[open..].find(']').unwrap() + open;
        let body = &lib_rs[open..close];
        let count = body.split(',').filter(|s| !s.trim().is_empty()).count();
        assert_eq!(count, EXPECTED_COMMAND_COUNT, "collect_commands! count drifted — update EXPECTED_COMMAND_COUNT if intentional");
    }
}
```

- [ ] **Step 5: Run the count test**

Run: `cargo test -p src-tauri collect_commands_count_matches_baseline` (adjust module path if placed elsewhere)
Expected: 1 pass, count matches Step 1's baseline exactly.

- [ ] **Step 6: `cargo tauri dev` boot smoke**

Run: `cargo tauri dev`, wait for the window, send one chat message, confirm a response streams — this is the acceptance criterion the spec names explicitly ("miss one [command] and the frontend breaks at runtime").

- [ ] **Step 7: Full Rust suite gate**

Run: `cargo test --workspace`
Expected: same pass count as Task 3's baseline plus the new count test.

- [ ] **Step 8: Commit the Rust half separately**

```bash
git add src-tauri/src/commands/ src-tauri/src/lib.rs
git commit -m "refactor(arch): R7 split lib.rs into commands/ modules (dispatch only)"
```

- [ ] **Step 9: Split `index.ts` into `boot.ts` + `dispatch.ts`**

Read `FeralAgent/src/index.ts` (post-R1/R2, now with `protocol.ts` and new `rsi/`/`egress/` paths) in full. Identify the boot section (config loading, transport setup, sidecar wiring, the hello-line emit from Task 1) versus the dispatch section (the `switch` over inbound message `type`).

Create `FeralAgent/src/boot.ts` containing the boot sequence as an exported async function (e.g. `export async function boot(): Promise<BootContext>` — define `BootContext` to carry whatever shared state the dispatch switch currently closes over: registries, transports, sidecar handles — read the switch body to enumerate exactly what it references from the enclosing scope).

Create `FeralAgent/src/dispatch.ts` containing the switch, refactored per R1's spec step 5 IF it stayed mechanical (each `case` body → a named function keyed by the `protocol.ts` `INBOUND_TYPES` names) — if the closure-state sharing is too tangled to extract cleanly (likely, given `index.ts` was 2501 lines), keep the switch as one function `export function dispatch(ctx: BootContext, msg: InboundMessage): void` that takes the boot context as an explicit parameter instead of closing over module scope. This is still "mechanical" per the spec's bar — you're threading state explicitly instead of via closure, not rewriting logic.

`FeralAgent/src/index.ts` becomes:

```typescript
// FeralAgent/src/index.ts
import { boot } from "./boot.ts";
import { dispatch } from "./dispatch.ts";

const ctx = await boot();
ctx.transport.onMessage((msg) => dispatch(ctx, msg));
```

(Adjust to match whatever `boot()`'s actual return shape and the transport's actual message-subscription API look like once you've read the real code — this is illustrative of the target shape, not a literal drop-in.)

- [ ] **Step 10: TS build gate**

Run: `cd FeralAgent && bunx tsc --noEmit` — clean.
Run: `cd FeralAgent && bun test` — same pass count as Task 3's baseline.

- [ ] **Step 11: Rebuild sidecar and smoke boot + one full round-trip per protocol path**

Run: `bun run build`, copy binary to `src-tauri/binaries/`, `cargo tauri dev`, exercise: one chat message, one cron add/list, one governance_status call (pick 3-4 dispatch paths spanning different original case blocks to catch a mis-wired handler map).

- [ ] **Step 12: Commit the TS half**

```bash
git add FeralAgent/src/boot.ts FeralAgent/src/dispatch.ts FeralAgent/src/index.ts src-tauri/binaries/
git commit -m "refactor(arch): R7 split index.ts into boot.ts + dispatch.ts"
```

---

### Task 5: R6 — Move connectors persistence into `feral-core`

**Files:**
- Modify: `src-tauri/src/connectors.rs` (shrinks to Tauri command wrappers only)
- Modify: `crates/feral-core/src/connectors.rs` (grows: load/save/secret-handling moved in)
- Create/Modify: `crates/feral-cli` connectors subcommand file (add `set`/`list`; existing `reload` per handoff note — find the current file via `grep -rn "connectors" crates/feral-cli/src/`)
- Modify: the runtime HTTP API router (find via `grep -rn "runtime/" src-tauri/src/` or `crates/feral-core/src/api.rs` — the B1 handoff names `api.rs:166` for a similar catalog route) — add `/runtime/connectors` GET/POST, `unstable` group per B1's `X-Feral-Api-Stability` header pattern.
- Modify: `docs/API.md` (B1 deliverable) — add the two new routes to keep `scripts/check-api-docs.mjs` (B1) green.

**Interfaces:**
- Consumes: B1's `api_stability_header` middleware pattern (already shipped, commit 9a0aeb8) — the new routes must use it, matching how existing `unstable`-group routes are registered (read one existing unstable route's registration for the exact pattern).
- Consumes: R1's protocol consts are NOT required here (R6 doesn't touch the stdin protocol — the sidecar's `connectors_reload` message already exists in `protocol.ts`'s `INBOUND_TYPES`, unchanged).
- Produces: nothing consumed by later tasks — R6 is last in sequence.

- [ ] **Step 1: Read both connectors.rs files in full**

Read `src-tauri/src/connectors.rs` (491 lines) and `crates/feral-core/src/connectors.rs` (257 lines) completely. Identify the exact split: `src-tauri`'s file currently has `load_config`/`save_config`/secret redaction/the legacy-token migration (per the file header comment already read) plus `#[tauri::command]` wrapper functions; `feral-core`'s file has the catalog (connector metadata, not user config).

- [ ] **Step 2: Write the failing round-trip test in `feral-core`**

```rust
// crates/feral-core/src/connectors.rs (add to existing #[cfg(test)] mod, or create one)
#[cfg(test)]
mod persistence_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn save_then_load_round_trips_and_redacts_secrets_on_read_view() {
        let dir = tempdir().unwrap();
        // R6: load_config/save_config now live here, parameterized by a
        // feral-dir path instead of always reading crate::paths::feral_dir().
        let mut cfg = ConnectorConfig {
            id: "discord".into(),
            enabled: true,
            secrets: [("DISCORD_TOKEN".to_string(), "sekret".to_string())].into(),
            allowlist: vec![],
            channels: vec![],
            token: None,
            mode: None,
            knowledge_base: None,
        };
        save_connector_config(dir.path(), &cfg).unwrap();
        let loaded = load_connector_config(dir.path(), "discord").unwrap();
        assert_eq!(loaded.secrets.get("DISCORD_TOKEN"), Some(&"sekret".to_string()));

        let view = redact_for_frontend(&loaded);
        assert!(view.filled.contains(&"DISCORD_TOKEN".to_string()));
        // The redacted view must never carry the raw secret value.
        assert!(!format!("{view:?}").contains("sekret"));
    }
}
```

Note: this test's exact function signatures (`save_connector_config`, `load_connector_config`, `redact_for_frontend`, the `filled` field name) are a starting hypothesis — Step 1's actual read of the existing code determines the real names. Match whatever `src-tauri/src/connectors.rs` already calls these functions/fields today; do not invent new names, since the frontend UI depends on the existing JSON field names being unchanged (spec: "desktop connectors page unchanged"). If `tempdir` (the `tempfile` crate) isn't already a dev-dependency, check `Cargo.toml` for what temp-dir helper other `feral-core` tests use instead and match that.

- [ ] **Step 3: Run the test, verify it fails**

Run: `cargo test -p feral-core connectors::persistence_tests`
Expected: FAIL — functions not yet defined in `feral-core`.

- [ ] **Step 4: Move the persistence code**

Cut `load_config`/`save_config`/secret redaction/legacy-token migration/the `config_path()` helper from `src-tauri/src/connectors.rs`, paste into `crates/feral-core/src/connectors.rs`, parameterize any hardcoded `crate::paths::feral_dir()` call with an explicit `&Path` argument (so the test can pass a tempdir, and so both the Tauri desktop caller and a future headless-gateway caller can supply their own feral-dir). Keep field names, JSON shape, and redaction behavior byte-for-byte identical — spec says "copy the code, don't rewrite it."

- [ ] **Step 5: Shrink `src-tauri/src/connectors.rs` to wrappers**

Replace the moved bodies with thin `#[tauri::command]` functions that call into `feral_core::connectors::{load_connector_config, save_connector_config, ...}`, passing `crate::paths::feral_dir()` (the desktop-specific path) as the argument. Keep the `connectors_reload` sidecar-poke call exactly as it is today (unrelated to this move).

- [ ] **Step 6: Run the persistence test again**

Run: `cargo test -p feral-core connectors::persistence_tests`
Expected: pass.

- [ ] **Step 7: Rust build + existing connector suites**

Run: `cargo build -p src-tauri && cargo test --workspace`
Expected: clean build; all existing connector-related tests (desktop-side, wherever they live — grep `connectors` in `src-tauri` test files) still pass unmodified, since the wrapper functions preserve the exact same `#[tauri::command]` signatures.

- [ ] **Step 8: Add `/runtime/connectors` GET/POST routes**

Read the B1-shipped route registration pattern for one existing `unstable`-group route (grep `docs/API.md` for an `unstable` example, then find its Rust handler registration). Add:
- `GET /runtime/connectors` → returns the redacted view (never secret values) for all configured connectors, via `feral_core::connectors::load_connector_config` + `redact_for_frontend` per connector id in the catalog.
- `POST /runtime/connectors` → accepts `{ id, enabled?, secrets?, allowlist?, channels?, mode?, knowledgeBase? }`, calls `save_connector_config`, then pokes the sidecar reload (same mechanism the desktop command uses).

Both routes carry the `api_stability_header` middleware exactly as B1's other unstable routes do (copy the registration line pattern, don't hand-roll a new one).

- [ ] **Step 9: Write the secret-never-in-GET test**

```rust
// wherever B1's route tests live (grep for an existing `unstable` route's HTTP test for the harness pattern)
#[tokio::test]
async fn get_runtime_connectors_never_returns_secret_values() {
    // ... spin up the test harness per the existing pattern, save a connector
    // config with a secret, GET /runtime/connectors, assert the response
    // body does not contain the raw secret string, only a `filled` flag.
}
```

Fill in the harness setup by copying an existing B1-era route test verbatim and swapping the endpoint + assertions — match the existing test's exact boilerplate (server startup, request client) rather than inventing a new harness.

- [ ] **Step 10: Add `feral connectors set|list` CLI subcommands**

Find the existing `feral connectors [reload]` subcommand file in `crates/feral-cli` (grep `connectors` under `crates/feral-cli/src/`). Add `set <id> --field value...` (mirrors the POST route — reuse `feral_core::connectors::save_connector_config` directly, not an HTTP round-trip, since the CLI runs in-process against the same feral-dir when no `--gateway-url` is given — check how the existing `reload` subcommand decides in-process vs. remote-gateway mode and match it) and `list` (reuses the redacted view, prints `filled` flags not secret values — never print a raw secret to stdout).

- [ ] **Step 11: CLI smoke**

Run: `feral connectors set discord --token TESTVALUE` (or whatever the real flag name is per Step 10 — read the catalog's field-key naming, e.g. `DISCORD_TOKEN`, to decide the CLI flag shape) against a scratch `FERAL_HOME`, then `feral connectors list`, confirm the output shows `filled: true` for the token field and never echoes `TESTVALUE`.

- [ ] **Step 12: Update `docs/API.md` and rerun B1's drift checker**

Add the two new routes to `docs/API.md` in the same format as the other 47 documented routes (B1's format — header stability tag, method, path, one-line description).

Run: `node scripts/check-api-docs.mjs` (B1's drift script)
Expected: exit 0 — new routes documented, count matches.

- [ ] **Step 13: Desktop connectors page smoke**

Run: `cargo tauri dev`, open the Connectors settings page, confirm existing connector cards still load/save correctly (the Tauri commands are now thin wrappers — behavior must be identical from the UI's perspective).

- [ ] **Step 14: Full suite gate**

Run: `cargo test --workspace` — green.
Run: `node scripts/check-api-docs.mjs` — exit 0.
Run: `cd FeralAgent && bun test` — unaffected, still green (R6 touches no TS files except possibly none at all — this task is Rust-only per the spec).

- [ ] **Step 15: Commit**

```bash
git add crates/feral-core/src/connectors.rs src-tauri/src/connectors.rs crates/feral-cli/ src-tauri/src/ docs/API.md
git commit -m "refactor(arch): R6 move connectors persistence into feral-core, add /runtime/connectors + CLI"
```

---

## Self-Review Notes

- **Spec coverage:** R1 (Task 1), R2+R8 (Task 2, combined per spec's explicit instruction), R3 (Task 3), R7 (Task 4), R6 (Task 5). R4/R5 excluded (already done). Sequencing matches the spec's `R1 → R2+R8 → R3 → R7 → contributor gate → R6` exactly.
- **Placeholder scan:** Task 2 (R2) and parts of Task 4/5 necessarily describe *categorization/discovery* steps ("read X, assign per Y") rather than literal final code, because the spec itself defines these as mechanical-but-wide moves whose exact per-file mapping depends on reading ~85 files' actual import graphs — writing a fake authoritative mapping here would be worse than having the implementer verify against the real code, per the spec's own repeated "verify: ..." callouts. Every step still names exact commands, exact files, and exact acceptance checks.
- **Type/name consistency:** `cfgBool/cfgInt/cfgPath/cfgList` (Task 3) match the spec's exact getter names. `protocol.ts` / `sidecar_protocol.rs` const names (`SIDECAR_PROTOCOL`, `INBOUND_TYPES`, `OUTBOUND_TYPES`) are used consistently between Task 1 and referenced (not re-derived) in Task 4's dispatch-map note.
