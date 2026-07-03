# Faza 4.5 Slice 1 — Runtime Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the tauri-free runtime modules of `src-tauri` into a new workspace crate `feral-core`, so a headless `feral` binary (Slice 2) and the Tauri desktop app share one runtime — with the desktop app behaving byte-for-byte identically.

**Architecture:** Pure mechanical move. Every module with zero `tauri::` references moves to `crates/feral-core`; `src-tauri/src/lib.rs` replaces each removed `mod X;` with `pub use feral_core::X;` so all existing `crate::X::…` paths keep resolving without touching call sites. The one exception is `rsi/`: `commands.rs` (Tauri command wrappers) stays behind under a slim shim module that glob-re-exports the moved `feral_core::rsi`. GPU/whisper cargo features move to feral-core and are forwarded from src-tauri under the same names, so existing `cfg(feature = …)` gates and CI feature selection keep working. Finally the `HostEvents` trait (spec D2) is defined in feral-core as the seam Slice 2 will use.

**Tech Stack:** Rust workspace (root `Cargo.toml`), cargo features, no new dependencies.

## Global Constraints

- Spec: `docs/2026-07-03-faza4-5-headless-design.md`; every decision must satisfy `docs/runtime-invariants.md`.
- Zero sidecar protocol change: nothing under `FeralAgent/` is touched in this slice.
- Desktop app must behave identically after the refactor (Slice 1 acceptance criterion).
- Feature names must stay exactly: `inference` (default), `inference-cuda`, `inference-vulkan`, `inference-metal`, `whisper` — CI and `run-bench-gpu.bat` select these by name. At most ONE GPU feature per build.
- `feral-core` must never depend on `tauri`, `tauri-specta`, `tauri-build`, or `rmcp`. Verify with grep at the end.
- Workspace root is `D:\FeralLocalAI` (Windows; Bash tool available). The Tauri package is named `feral` (lib `app_lib`) in `src-tauri/Cargo.toml`.
- Do not run GPU feature builds (Vulkan build needs the vcvars64+Ninja recipe, see `docs`/memory); default CPU build + `cargo check --features inference-vulkan` compile-check is out of scope here — GPU verification happens at Slice 2.

**Modules that MOVE to `crates/feral-core/src/`** (verified 0 tauri refs, no references to staying modules):
`paths.rs`, `settings.rs`, `db_key.rs`, `sysinfo_mod.rs`, `gpu_detect.rs`, `perf_policy.rs`, `models.rs`, `inference.rs`, `api.rs`, `transcription.rs`, `tools.rs`, `byok.rs`, and `rsi/` **except** `rsi/commands.rs`.

**Modules that STAY in `src-tauri/src/`:**
`lib.rs`, `main.rs`, `events.rs` (tauri_specta), `feral_agent.rs`, `connectors.rs`, `mcp.rs` (rmcp), `skills.rs`, `desktop_control.rs`, `desktop_control_windows.rs`, `memory_graph.rs`, `disk_encryption.rs`, `conversations.rs`, `agents.rs`, `projects.rs`, `rsi/commands.rs`.

---

### Task 1: Scaffold the `feral-core` crate

**Files:**
- Create: `crates/feral-core/Cargo.toml`
- Create: `crates/feral-core/src/lib.rs`
- Modify: `Cargo.toml` (workspace root, line ~6: `members`)

**Interfaces:**
- Produces: empty library crate `feral-core` (rust name `feral_core`) as a workspace member. Later tasks fill it.

- [ ] **Step 1: Create the crate manifest**

Create `crates/feral-core/Cargo.toml`. Copy the exact version/feature strings for each dependency **verbatim from `src-tauri/Cargo.toml` `[dependencies]`** — do not invent versions. Include every dependency from src-tauri EXCEPT: `tauri`, `tauri-specta`, `tauri-plugin-*` (any), `rmcp`, and the `[target.'cfg(windows)'.dependencies]` block (that is desktop-control-only). Skeleton:

```toml
[package]
name = "feral-core"
version.workspace = true
edition.workspace = true
license.workspace = true
authors.workspace = true

[lib]
name = "feral_core"

[dependencies]
# ponytail: copied wholesale from src-tauri minus tauri/rmcp/windows; prune
# unused deps with cargo-machete once the dust settles.
# <every remaining src-tauri dependency line, verbatim, including
#  llama-cpp-2 (optional) and whisper-rs (optional)>

[features]
default = ["inference"]
inference = ["dep:llama-cpp-2"]
inference-cuda   = ["dep:llama-cpp-2", "llama-cpp-2/cuda"]
inference-vulkan = ["dep:llama-cpp-2", "llama-cpp-2/vulkan"]
inference-metal  = ["dep:llama-cpp-2", "llama-cpp-2/metal"]
whisper = ["dep:whisper-rs"]
```

(The `[features]` block is copied from src-tauri — keep its explanatory comments about "pick at most ONE GPU backend" when you move it.)

- [ ] **Step 2: Create the empty lib.rs**

`crates/feral-core/src/lib.rs`:

```rust
//! feral-core — the Feral Runtime, host-agnostic.
//!
//! Everything a Feral host process needs that does NOT depend on Tauri:
//! inference, model management, the local HTTP API, RSI substrate, settings,
//! paths. Consumed by two entry points: the Tauri desktop app (src-tauri)
//! and the headless `feral` binary (Faza 4.5 Slice 2).
//! Invariants: docs/runtime-invariants.md.
```

- [ ] **Step 3: Register in the workspace**

In root `Cargo.toml` change:

```toml
members = ["src-tauri"]
```

to:

```toml
members = ["src-tauri", "crates/feral-core"]
```

- [ ] **Step 4: Verify it builds**

Run: `cargo check -p feral-core`
Expected: `Finished` with no errors (warnings about unused deps are fine at this stage).

- [ ] **Step 5: Commit**

```bash
git add crates/feral-core Cargo.toml
git commit -m "feat(faza4.5): scaffold feral-core workspace crate (Slice 1 Runtime Extraction)"
```

---

### Task 2: Move the runtime modules into feral-core

**Files:**
- Move: the 12 files + `rsi/` listed in Global Constraints, from `src-tauri/src/` to `crates/feral-core/src/`
- Modify: `crates/feral-core/src/lib.rs` (module declarations)
- Modify: `src-tauri/src/lib.rs:1-25` (mod list → pub use shims)
- Create: `src-tauri/src/rsi/mod.rs` (new slim shim; the old one moves)
- Modify: `src-tauri/Cargo.toml` (features become forwards; add feral-core dep; drop moved deps)

**Interfaces:**
- Consumes: empty `feral-core` crate from Task 1.
- Produces: `feral_core::{paths, settings, db_key, sysinfo_mod, gpu_detect, perf_policy, models, inference, api, transcription, tools, byok, rsi}` — same public items as today's `crate::…` equivalents. `src-tauri` re-exports all of them at crate root (`pub use`), so `crate::inference::ModelManager` etc. still resolve everywhere in staying code.

- [ ] **Step 1: Move the files with git mv**

```bash
cd D:/FeralLocalAI
mkdir -p crates/feral-core/src/rsi
for f in paths settings db_key sysinfo_mod gpu_detect perf_policy models inference api transcription tools byok; do
  git mv src-tauri/src/$f.rs crates/feral-core/src/$f.rs
done
for f in audit code_patch goodhart mod paths plan repo sandbox_bounds scorer test_support tier0 types watchdog; do
  git mv src-tauri/src/rsi/$f.rs crates/feral-core/src/rsi/$f.rs
done
# commands.rs stays: src-tauri/src/rsi/commands.rs is NOT moved
```

- [ ] **Step 2: Declare the modules in feral-core**

Append to `crates/feral-core/src/lib.rs`:

```rust
pub mod api;
pub mod byok;
pub mod db_key;
pub mod gpu_detect;
pub mod inference;
pub mod models;
pub mod paths;
pub mod perf_policy;
pub mod rsi;
pub mod settings;
pub mod sysinfo_mod;
pub mod tools;
pub mod transcription;
```

- [ ] **Step 3: Trim the moved rsi/mod.rs**

In `crates/feral-core/src/rsi/mod.rs`: delete the line `pub mod commands;` (commands stay host-side). Keep the NON-NEGOTIABLE INVARIANT docstring intact, and extend it with one sentence so it stays true:

```rust
//! (Faza 4.5: the substrate lives in feral-core, but every WRITE still goes
//! only through the host's command layer — src-tauri/src/rsi/commands.rs.)
```

- [ ] **Step 4: Shim src-tauri**

In `src-tauri/src/lib.rs` delete these lines from the mod list (lines 1-25): `mod api;`, `mod byok;`, `mod transcription;`, `mod db_key;`, `mod gpu_detect;`, `mod inference;`, `mod perf_policy;`, `mod models;`, `mod paths;`, `mod settings;`, `mod sysinfo_mod;`, `mod tools;` — and in their place add:

```rust
pub use feral_core::{
    api, byok, db_key, gpu_detect, inference, models, paths, perf_policy,
    settings, sysinfo_mod, tools, transcription,
};
```

Keep `mod rsi;` — but create the new slim `src-tauri/src/rsi/mod.rs`:

```rust
//! Host-side RSI command layer. The substrate itself lives in
//! `feral_core::rsi` (re-exported below); only the Tauri command wrappers —
//! the sole write path into the substrate — remain here.
pub mod commands;
pub use feral_core::rsi::*;
```

(`commands.rs` needs no edits: its `super::…` and `crate::rsi::…` paths resolve through the glob re-export.)

- [ ] **Step 5: Rewire src-tauri/Cargo.toml**

1. Add to `[dependencies]`:

```toml
feral-core = { path = "../crates/feral-core", default-features = false }
```

2. Remove `llama-cpp-2` and `whisper-rs` from src-tauri's `[dependencies]` (they moved). Leave every other dependency alone — staying modules still use them.
3. Replace the `[features]` block body with forwards (keep the original comments about GPU backend selection):

```toml
[features]
default = ["inference"]
inference        = ["feral-core/inference"]
inference-cuda   = ["feral-core/inference-cuda"]
inference-vulkan = ["feral-core/inference-vulkan"]
inference-metal  = ["feral-core/inference-metal"]
whisper          = ["feral-core/whisper"]
```

- [ ] **Step 6: Compile and fix visibility fallout**

Run: `cargo check -p feral-core 2>&1 | head -50`

Expected failure classes and their ONLY allowed fixes:
- **E0432/E0433 unresolved import `crate::X`** inside feral-core where X stayed behind → should not happen (verified by grep before planning); if one appears, stop and report — do not move more modules.
- **missing dependency** in feral-core → copy that dependency line verbatim from git history of `src-tauri/Cargo.toml`.

Then: `cargo check -p feral 2>&1 | head -50`

Expected failure classes:
- **E0603 private item** — an item in a moved module was `pub(crate)` and lib.rs/commands.rs/staying modules use it → change that item to `pub` in feral-core (do NOT restructure).
- **unresolved `crate::X`** in a staying module → that module imported a moved item; fix the import to go through the crate-root re-export (`use crate::inference::…` already works; only odd spellings like `use super::…` across the boundary need pointing at `crate::…`).

Iterate until both `cargo check -p feral-core` and `cargo check -p feral` pass.

- [ ] **Step 7: Run the test suites**

Run: `cargo test --workspace 2>&1 | tail -20`
Expected: all existing tests pass (rsi tests now run inside feral-core; lib.rs `watchdog_tests` + `tests` modules still run in `feral`). No test content changes allowed — if a test fails on behavior (not paths/visibility), stop and report.

- [ ] **Step 8: Verify the purity gate**

Run: `grep -rn "tauri" crates/feral-core/src crates/feral-core/Cargo.toml`
Expected: zero matches (comments mentioning Tauri in prose are acceptable; `use tauri`/`tauri::`/dependency lines are not).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(faza4.5): Slice 1 Runtime Extraction — move runtime modules to feral-core

Mechanical move of the tauri-free runtime (inference, models, api, rsi
substrate, settings, paths, tools, byok, perf, gpu, transcription) into
crates/feral-core. src-tauri re-exports at crate root so all call sites
are untouched; rsi/commands.rs stays as the sole substrate write path.
Features inference/cuda/vulkan/metal/whisper forwarded under same names."
```

---

### Task 3: Define the `HostEvents` seam (spec D2)

**Files:**
- Create: `crates/feral-core/src/host.rs`
- Modify: `crates/feral-core/src/lib.rs` (add `pub mod host;`)

**Interfaces:**
- Produces: `feral_core::host::HostEvents` trait and `feral_core::host::LogEvents` impl. No consumers in this slice — Slice 2 implements it for headless (`/events` SSE) and the Tauri app wraps `app.emit` with it when `feral_agent.rs` migrates.

- [ ] **Step 1: Write the trait**

`crates/feral-core/src/host.rs`:

```rust
//! The host seam (spec D2, invariant 7: transports are replaceable).
//!
//! feral-core never talks to a UI directly. Anything that today reaches the
//! webview via `app.emit(event, payload)` will instead go through this trait:
//! the Tauri entry point forwards to the webview, the headless entry point
//! logs and publishes on the Public Runtime API `/events` SSE stream.
//! No consumers yet — Slice 2 wires `feral_agent.rs` through it.

use serde_json::Value;

pub trait HostEvents: Send + Sync + 'static {
    /// Fire-and-forget host event, e.g. `emit("feral://agent-ready", json!({}))`.
    fn emit(&self, event: &str, payload: Value);
}

/// Headless default: every event becomes a tracing log line.
pub struct LogEvents;

impl HostEvents for LogEvents {
    fn emit(&self, event: &str, payload: Value) {
        tracing::info!(target: "host_events", %event, %payload, "event");
    }
}
```

- [ ] **Step 2: Register the module**

Add `pub mod host;` to the module list in `crates/feral-core/src/lib.rs`.

- [ ] **Step 3: Verify**

Run: `cargo check -p feral-core`
Expected: PASS. (Trait + trivial impl — no test needed; first real consumer lands in Slice 2 with its own test.)

- [ ] **Step 4: Commit**

```bash
git add crates/feral-core/src/host.rs crates/feral-core/src/lib.rs
git commit -m "feat(faza4.5): HostEvents trait — the D2 seam feral-core uses instead of app.emit"
```

---

### Task 4: Full verification gate

**Files:**
- No new files. Read-only verification + possible micro-fixes from findings.

**Interfaces:**
- Consumes: everything above.
- Produces: green Slice 1 per spec acceptance: both crates build, tests pass, desktop identical, protocol untouched.

- [ ] **Step 1: Full workspace build + tests**

```bash
cargo build --workspace
cargo test --workspace
```
Expected: both succeed with default features (CPU inference).

- [ ] **Step 2: Confirm the sidecar is untouched**

Run: `git status --short FeralAgent/ && git log --oneline -5 -- FeralAgent/`
Expected: no working-tree changes under `FeralAgent/`, no new commits touching it.

- [ ] **Step 3: Desktop smoke (manual, requires Darius or a display)**

Run: `cargo tauri dev` from `src-tauri/` (or the repo's usual `run-app-ui-gpu.bat` if GPU build is set up).
Check: app window opens, chat with local model answers, mascot animates, Agents tab lists the sidecar as ready. This is the "desktop behaves identically" acceptance gate — if the environment cannot run the UI now, mark this step explicitly as PENDING-MANUAL in the final report instead of claiming it passed.

- [ ] **Step 4: Report**

Summarize: modules moved, visibility changes made (list every `pub(crate)`→`pub` promotion), any dependency lines added to feral-core, test results, smoke status.
