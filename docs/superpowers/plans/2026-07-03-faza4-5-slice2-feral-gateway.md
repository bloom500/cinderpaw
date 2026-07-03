# Faza 4.5 Slice 2 — `feral` Gateway (Headless Binary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless binary that boots the full Feral runtime (model server on 11435 + supervised sidecar with connectors) with no Tauri, no webview, no desktop app — with graceful shutdown.

**Architecture:** Finish the decoupling Slice 1 seeded. (1) `RuntimeState` (the tauri-free core of today's `AppState`) moves to feral-core, and the RSI IPC dispatcher moves with it; `AppState` derefs to it so desktop call sites don't change. (2) `feral_agent.rs` (sidecar spawn/supervise/IPC routing) loses its `AppHandle` — events go through the Slice-1 `HostEvents` trait, RSI dispatch through `RuntimeState`, desktop-control through an injected handler — then moves to feral-core. (3) The boot sequence (token, RSI substrate bootstrap, env exports, API server, sidecar supervision) is extracted from lib.rs's setup closure into `feral_core::boot`, shared verbatim by both entry points. (4) A new `crates/feral-cli` package provides the headless entry point with Ctrl+C graceful shutdown and a single-instance guard.

**Tech Stack:** Rust workspace; tokio (already a dep); no new dependencies (hand-rolled arg parsing — clap arrives with the full CLI in Slice 4 only if needed).

## Global Constraints

- Spec: `docs/2026-07-03-faza4-5-headless-design.md` (D1, D2, D6, D7); invariants: `docs/runtime-invariants.md` — esp. 1 (runtime owns state), 7 (transports replaceable), 8 (one inference stack), 10 (confidence gate), 12 (runtime owns scheduling).
- **Zero sidecar changes**: nothing under `FeralAgent/` is touched. The stdin/stdout NDJSON protocol is frozen.
- **Desktop app behaves identically** — all `#[tauri::command]` signatures and event names (`feral://agent-output`, `feral://agent-ready`, `feral://agent-exit`, etc.) are unchanged.
- feral-core still must not depend on tauri/tauri-specta/tauri-build/rmcp.
- **Binary naming (D6a, flagged for Darius):** the dev binary is `feral-cli` (package `feral-cli`, bin `feral-cli`) because the desktop dev binary already claims `target/debug/feral.exe` (src-tauri package name `feral`). The user-facing name `feral` is applied at packaging time (installer alias/rename). Do not rename the desktop package in this slice.
- The Tauri package is `feral` (lib `app_lib`); branch `feat/faza4-5-runtime-extraction`; run cargo with 600000ms timeouts (llama.cpp C++).
- New non-trivial logic (shutdown sequencing, arg parsing) gets a minimal test; mechanical moves are covered by the existing 234 tests.

---

### Task 1: `RuntimeState` in feral-core + RSI dispatcher split

**Files:**
- Create: `crates/feral-core/src/runtime.rs`
- Create: `crates/feral-core/src/rsi/runtime.rs`
- Modify: `crates/feral-core/src/lib.rs` (add `pub mod runtime;`), `crates/feral-core/src/rsi/mod.rs` (add `pub mod runtime;`)
- Modify: `src-tauri/src/rsi/commands.rs` (keep ONLY `#[tauri::command]` fns; import the rest)
- Modify: `src-tauri/src/lib.rs` (`AppState` gains `runtime: Arc<RuntimeState>` + `Deref`)
- Modify: `src-tauri/src/feral_agent.rs` (import `PlannedExit`/`PlannedExitSlot` from feral-core)

**Interfaces:**
- Produces:
  - `feral_core::runtime::RuntimeState` with pub fields: `manager: Arc<inference::ModelManager>`, `settings: settings::Settings`, `local_api_token: Arc<str>`, `feral_agent_process: Arc<parking_lot::Mutex<Option<tokio::process::Child>>>`, `feral_agent_tx: Arc<parking_lot::Mutex<Option<tokio::sync::mpsc::Sender<String>>>>`, `feral_agent_planned_exit: PlannedExitSlot`, `rsi_state: rsi::RsiState`, `rsi_goodhart: rsi::runtime::GoodhartSlot`, `rsi_engine: Arc<parking_lot::Mutex<Option<rsi::runtime::RsiEngineState>>>`, `rsi_request_registry: rsi::runtime::RsiRequestRegistry`.
    (Match the EXACT existing field types from `src-tauri/src/lib.rs:53-100` — the list above is the intent; where the current AppState uses `tokio::sync::Mutex` vs `parking_lot::Mutex` for a given field, keep the current type verbatim. `PlannedExit` + `PlannedExitSlot` move from `src-tauri/src/feral_agent.rs:~59` into `runtime.rs`.)
  - `feral_core::rsi::runtime::{GoodhartSlot, RsiRequestRegistry, RsiEngineState, dispatch_rsi_request, …}` — everything currently in `src-tauri/src/rsi/commands.rs` EXCEPT the `#[tauri::command]` fns and their specta glue: the shared types (lines ~68-160), the plain `do_rsi_*` helpers, `require_string`, `ensure_initialized`, `dispatch_rsi_request` (line ~789) and its tests.
  - `dispatch_rsi_request(state: &RuntimeState, method: &str, params: Value)` — signature changes from `&AppState` to `&RuntimeState`.
- Consumes: Slice 1's `feral_core::rsi`, `feral_core::inference`, `feral_core::settings`.

- [ ] **Step 1: Move `PlannedExit`/`PlannedExitSlot` into `crates/feral-core/src/runtime.rs`**

Cut the type definitions from `src-tauri/src/feral_agent.rs` (around line 40-60 — take the whole `PlannedExit` struct/enum with its doc comments) into the new `runtime.rs`. In `feral_agent.rs` replace them with `use feral_core::runtime::{PlannedExit, PlannedExitSlot};`.

- [ ] **Step 2: Define `RuntimeState` in `runtime.rs`**

Copy the exact field declarations (with doc comments) from `AppState` for the ten fields listed in Interfaces. Add a constructor that today's lib.rs can call:

```rust
impl RuntimeState {
    pub fn new(manager: Arc<crate::inference::ModelManager>, settings: crate::settings::Settings, local_api_token: Arc<str>) -> Self {
        Self {
            manager,
            settings,
            local_api_token,
            feral_agent_process: Arc::new(Default::default()),
            feral_agent_tx: Arc::new(Default::default()),
            feral_agent_planned_exit: Arc::new(Default::default()),
            rsi_state: Default::default(),
            rsi_goodhart: Default::default(),
            rsi_engine: Arc::new(Default::default()),
            rsi_request_registry: Default::default(),
        }
    }
}
```

(If a field's type lacks `Default`, construct it the same way today's lib.rs does at `AppState` construction, `src-tauri/src/lib.rs:~3280-3300` — copy that expression.)

- [ ] **Step 3: Split rsi/commands.rs**

Create `crates/feral-core/src/rsi/runtime.rs` and move into it, verbatim: `GoodhartSlot`, `RsiRequestRegistry`, `RsiEngineState` (+ any other shared type in commands.rs used by feral_agent.rs or the dispatcher), all plain helper fns (`require_string`, `ensure_initialized`, every `do_rsi_*`), `dispatch_rsi_request`, and the `dispatch_rsi_request` routing tests (rewrite their `AppState` construction to build a bare `RuntimeState` — the test at `src-tauri/src/rsi/commands.rs:1458+` currently builds an AppState with `mcp`; the RuntimeState version simply drops the fields that no longer exist). Change `dispatch_rsi_request` (and `ensure_initialized`/`do_*` where they take state) to `&RuntimeState`. Add `pub mod runtime;` to `crates/feral-core/src/rsi/mod.rs`.

`src-tauri/src/rsi/commands.rs` keeps ONLY the `#[tauri::command]` fns; at its top add `use feral_core::rsi::runtime::*;` so the wrappers keep calling the helpers by the same names. Where a command accesses the moved state fields via `state.inner()`, it now works through the Deref added in Step 4.

- [ ] **Step 4: `AppState` composition + Deref**

In `src-tauri/src/lib.rs`: delete the ten moved field declarations from `AppState`, add `pub runtime: std::sync::Arc<feral_core::runtime::RuntimeState>,` and:

```rust
impl std::ops::Deref for AppState {
    type Target = feral_core::runtime::RuntimeState;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}
```

At the `AppState { … }` construction site (`src-tauri/src/lib.rs:~3280`), build `RuntimeState` first from the same expressions (manager/settings/token), wrap in `Arc`, keep the non-moved fields (`downloads`, `stop_signal`, `system_info_cache`, `feral_model_config`, `mcp`, and anything else remaining) as they are. Existing `state.manager`, `state.rsi_state`, `state.feral_agent_tx` etc. throughout lib.rs keep compiling via Deref — do NOT rewrite call sites; only touch ones the compiler rejects (e.g. struct-literal or field-init positions where Deref does not apply: fix those by going through `state.runtime.`).

- [ ] **Step 5: Compile + tests**

Run: `cargo check -p feral-core && cargo check -p feral`, then `cargo test --workspace`.
Expected: all green; the moved dispatcher tests now run in feral-core. Allowed fixes: visibility promotions (`pub(crate)`→`pub`) in feral-core, import-path fixes, `state.runtime.` where Deref can't apply. Anything else: stop and report.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(faza4.5): RuntimeState in feral-core + RSI dispatcher split from Tauri commands"
```

---

### Task 2: Decouple `feral_agent.rs` from Tauri and move it to feral-core

**Files:**
- Move: `src-tauri/src/feral_agent.rs` → `crates/feral-core/src/feral_agent.rs` (after edits)
- Modify: `crates/feral-core/src/host.rs` (add `DesktopControlHandler` type)
- Modify: `crates/feral-core/src/lib.rs` (add `pub mod feral_agent;`)
- Modify: `src-tauri/src/lib.rs` (add `TauriEvents`, re-export `pub use feral_core::feral_agent;`, update the `supervise` call)
- Modify: `src-tauri/src/events.rs` only if `FeralAgentOutputEvent` needs to stay host-side (it does — see Step 2)

**Interfaces:**
- Consumes: `HostEvents` (Slice 1), `RuntimeState` (Task 1).
- Produces:
  - `feral_core::host::DesktopControlHandler` =
    ```rust
    pub type DesktopControlHandler = std::sync::Arc<
        dyn Fn(String, serde_json::Value) -> futures::future::BoxFuture<'static, Result<serde_json::Value, String>>
            + Send + Sync,
    >;
    ```
  - `feral_core::feral_agent::supervise(runtime: Arc<RuntimeState>, events: Arc<dyn HostEvents>, desktop_control: Option<DesktopControlHandler>, extra_bin_dirs: Vec<PathBuf>)` — replaces today's 8-arg signature; port and token come from `runtime.settings.api_port` / `runtime.local_api_token`; the slots come from `runtime`.
  - `feral_core::feral_agent::spawn(...)` — same substitution.
  - `feral_core::feral_agent::find_binary(extra_dirs: &[PathBuf]) -> Option<PathBuf>` — the `app.path().resource_dir()` probe becomes a loop over `extra_dirs`; the `current_exe`-relative and `src-tauri/binaries` walk-up probes stay as-is.

- [ ] **Step 1: Mechanical decoupling inside feral_agent.rs (before moving it)**

In `src-tauri/src/feral_agent.rs`:
1. Delete `use tauri::{AppHandle, Emitter, Manager};`.
2. `find_binary(app: &AppHandle)` → `find_binary(extra_dirs: &[std::path::PathBuf])`; replace the `app.path().resource_dir()` block with `for dir in extra_dirs { for name in [&plain_name, &triple_name] { … } }`.
3. Every `app.emit("feral://…", payload)` (sites ≈ lines 457, 491, 539, 670, 948, 1057) → `events.emit("feral://…", serde_json::to_value(payload).unwrap_or_default())`. Where the payload is a typed specta event struct (`FeralAgentOutputEvent`), emit its JSON value; the struct itself stays in src-tauri if it derives tauri_specta::Event — in that case emit `serde_json::json!({ "data": line })` and have the Tauri `HostEvents` impl deliver it (the frontend only sees the wire shape, which must remain identical — verify the JSON field names match the specta serialization exactly).
4. `handle_rsi_request(req, app, tx)` → `handle_rsi_request(req, runtime: Arc<RuntimeState>, tx)`; body: replace the `app.state::<AppState>()` block with `feral_core-local` call `crate::rsi::runtime::dispatch_rsi_request(&runtime, &method, params).await`.
5. `handle_desktop_control_request` → takes `dc: Option<DesktopControlHandler>`; `None` ⇒ respond `ok:false, error:"desktop control not available in this host"`; `Some(h)` ⇒ `h(action, params).await` in place of `crate::desktop_control::handle_request`.
6. `tauri::async_runtime::spawn` → `tokio::spawn`.
7. Thread `runtime`, `events`, `desktop_control`, `extra_bin_dirs` through `spawn`/`supervise`/`stdout_reader`/`stderr_logger`/`revert_bad_patch`/`refresh_spawn_binary` in place of `app` — the slot/registry/mirror params disappear (read them from `runtime`).

- [ ] **Step 2: Move the file + wire the Tauri side**

`git mv src-tauri/src/feral_agent.rs crates/feral-core/src/feral_agent.rs`; add `pub mod feral_agent;` to feral-core's lib.rs; in src-tauri lib.rs replace `mod feral_agent;` with `pub use feral_core::feral_agent;`.

Add to src-tauri (in lib.rs, near the top, or in events.rs — implementer's choice, one place only):

```rust
/// HostEvents for the desktop entry point: forward runtime events to the webview.
struct TauriEvents(tauri::AppHandle);
impl feral_core::host::HostEvents for TauriEvents {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.0.emit(event, payload);
    }
}
```

Update the `feral_agent::supervise(…)` call site (`src-tauri/src/lib.rs:~3600`) to the new signature: `runtime` = `app.state::<AppState>().runtime.clone()`, `events` = `Arc::new(TauriEvents(app.handle().clone()))`, `desktop_control` = `Some(Arc::new(|action, params| Box::pin(async move { crate::desktop_control::handle_request(&action, &params).await })))`, `extra_bin_dirs` = `vec![app.path().resource_dir().ok()].into_iter().flatten().collect()`. Same for the direct `spawn` call in `restart_sidecar` (`src-tauri/src/lib.rs:~2204`) and any other spawn call sites (grep `feral_agent::spawn`, `feral_agent::supervise`).

- [ ] **Step 3: Frontend-contract check (event wire shapes)**

For each emitted event name, compare the JSON the new `events.emit` produces against what `app.emit(event, TypedStruct)` produced before (specta/serde serialization of the struct). They must be byte-equivalent in field names/casing. Check `frontend-react/src` listeners (grep `feral://agent-output`, `feral://agent-ready`, `feral://agent-exit`) for the fields they read. If any shape differs, fix the payload construction — never the frontend.

- [ ] **Step 4: Compile + tests + commit**

`cargo check -p feral-core && cargo check -p feral && cargo test --workspace` → green.

```bash
git add -A
git commit -m "feat(faza4.5): feral_agent decoupled from Tauri — HostEvents + RuntimeState + DC handler, moved to feral-core"
```

---

### Task 3: Shared boot sequence in `feral_core::boot`

**Files:**
- Create: `crates/feral-core/src/boot.rs`
- Modify: `crates/feral-core/src/lib.rs` (add `pub mod boot;`)
- Modify: `src-tauri/src/lib.rs` (setup closure delegates to boot)

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces:
  ```rust
  /// Build the runtime: ModelManager, per-launch API token (persisted to
  /// ~/.feral/api-token), loaded settings (api_server_enabled forced on).
  pub fn build_runtime() -> Arc<RuntimeState>;
  /// Start the runtime services: GPU embed quirk guard (vulkan builds),
  /// RSI substrate bootstrap (repo + SandboxBounds + audit → runtime.rsi_state),
  /// settings env exports (budgets, rsi cost cap, desktop-control flags),
  /// API server on runtime.settings.api_port, sidecar supervision.
  /// Non-blocking: spawns tasks on the current tokio runtime.
  pub fn start(runtime: Arc<RuntimeState>, events: Arc<dyn HostEvents>, desktop_control: Option<DesktopControlHandler>, extra_bin_dirs: Vec<PathBuf>);
  ```
- The bodies are MOVED, not rewritten, from `src-tauri/src/lib.rs`: token creation + persist (~3246-3260), RSI bootstrap block (~3489-3545), env exports + `api_server_enabled = true` + `api::serve` spawn (~3546-3600), `supervise` call (~3600-3620), and the `#[cfg(feature = "inference-vulkan")]` fragile-AMD embed guard (~3463-3487). Every comment moves with its code.

- [ ] **Step 1: Extract `build_runtime` + `start` into boot.rs** (cut/paste the blocks listed above; replace `app.handle().state::<AppState>()` reads with the `runtime` fields; `tauri::async_runtime::spawn` → `tokio::spawn`).

- [ ] **Step 2: Rewire the desktop entry point**

lib.rs setup closure: construct `AppState` from `boot::build_runtime()` (plus its tauri-only fields), then call `boot::start(runtime, Arc::new(TauriEvents(…)), Some(dc_handler), resource_dirs)`. The MCP reconnect block and all webview/specta wiring stay in lib.rs. Order preserved: boot::start is called at the same point in setup where the moved blocks began.

- [ ] **Step 3: Compile + tests + commit**

`cargo check --workspace && cargo test --workspace` → green.

```bash
git add -A
git commit -m "feat(faza4.5): shared boot sequence in feral_core::boot — one boot path for desktop and headless"
```

---

### Task 4: `feral-cli` — the headless gateway binary

**Files:**
- Create: `crates/feral-cli/Cargo.toml`
- Create: `crates/feral-cli/src/main.rs`
- Modify: `Cargo.toml` (workspace members += `crates/feral-cli`)

**Interfaces:**
- Consumes: `feral_core::boot`, `feral_core::host::LogEvents`, `RuntimeState`.
- Produces: binary `feral-cli` with subcommand `gateway` (foreground run). Exit codes: 0 clean shutdown, 1 startup failure, 2 usage error.

- [ ] **Step 1: Crate manifest**

```toml
[package]
name = "feral-cli"
version.workspace = true
edition.workspace = true
license.workspace = true
authors.workspace = true

[[bin]]
name = "feral-cli"
path = "src/main.rs"

[dependencies]
feral-core = { path = "../feral-core", default-features = false }
tokio = { version = "1", features = ["full"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
serde_json = "1"

[features]
default = ["inference"]
inference        = ["feral-core/inference"]
inference-cuda   = ["feral-core/inference-cuda"]
inference-vulkan = ["feral-core/inference-vulkan"]
inference-metal  = ["feral-core/inference-metal"]
whisper          = ["feral-core/whisper"]
```

(Copy exact version strings for tokio/tracing/tracing-subscriber/serde_json from feral-core's Cargo.toml.)

- [ ] **Step 2: main.rs**

```rust
//! `feral-cli` — the headless Feral Runtime entry point (Faza 4.5 Slice 2).
//!
//! Same brain as the desktop app: feral_core::boot starts the model server
//! (127.0.0.1:api_port, bearer-token gated), the supervised Bun sidecar
//! (AgentLoop + connectors), and the RSI substrate. No webview, no Tauri.
//! Ships as `feral-cli` in dev; packaged installs alias it to `feral` (D6a).

use std::sync::Arc;

const USAGE: &str = "Feral Runtime (headless)

USAGE:
  feral-cli gateway    run the gateway in the foreground (Ctrl+C to stop)
  feral-cli help       show this help
";

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    match arg.as_str() {
        "gateway" => run_gateway(),
        "help" | "--help" | "-h" | "" => {
            print!("{USAGE}");
            if arg.is_empty() {
                std::process::exit(2);
            }
        }
        other => {
            eprintln!("unknown command: {other}\n{USAGE}");
            std::process::exit(2);
        }
    }
}

fn run_gateway() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let code = rt.block_on(async {
        let runtime = feral_core::boot::build_runtime();

        // Single-instance guard: the API port is the lock. If it's taken,
        // another Feral host (desktop app or gateway) already owns this brain.
        let port = runtime.settings.api_port;
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(probe) => drop(probe), // free it for the real server below
            Err(_) => {
                eprintln!(
                    "feral: port {port} is busy — a Feral host (desktop app or another \
                     gateway) is already running. One brain, one process."
                );
                return 1;
            }
        }

        let events: Arc<dyn feral_core::host::HostEvents> =
            Arc::new(feral_core::host::LogEvents);
        // Desktop control is a desktop-host feature; the gateway declines it.
        feral_core::boot::start(runtime.clone(), events, None, Vec::new());
        tracing::info!(port, "feral gateway up — model API + sidecar supervised");

        tokio::signal::ctrl_c().await.ok();
        tracing::info!("shutdown requested — draining (D7)");
        shutdown(&runtime).await;
        0
    });
    std::process::exit(code);
}

/// Graceful shutdown per spec D7: mark the exit as planned (so the sidecar
/// supervisor doesn't treat it as a crash / the RSI watchdog doesn't count
/// it), close the sidecar's stdin (its transport drains in-flight handlers
/// and exits), wait bounded, then hard-kill as the last resort.
async fn shutdown(runtime: &feral_core::runtime::RuntimeState) {
    *runtime.feral_agent_planned_exit.lock() =
        Some(feral_core::runtime::PlannedExit::shutdown());
    // Dropping the tx closes the stdin writer channel → sidecar sees EOF,
    // drains its #pending handlers, flushes, exits (existing behavior).
    runtime.feral_agent_tx.lock().take();
    let child = runtime.feral_agent_process.lock().take();
    if let Some(mut child) = child {
        match tokio::time::timeout(std::time::Duration::from_secs(30), child.wait()).await {
            Ok(status) => tracing::info!(?status, "sidecar exited cleanly"),
            Err(_) => {
                tracing::warn!("sidecar did not exit within 30s — killing");
                let _ = child.kill().await;
            }
        }
    }
}
```

Adjust to reality while implementing (compiler is the referee): the exact `PlannedExit` constructor (`shutdown()` may need to be added in runtime.rs if today's enum only has watchdog variants — add a `Shutdown` variant treated by `supervise` as "do not restart"), the Mutex kinds on the slots (parking_lot vs tokio — match Task 1's types), and whether `supervise`'s restart loop needs an explicit stop flag (if dropping tx + planned_exit isn't enough to stop restarts, add a `shutting_down: AtomicBool` on RuntimeState checked by the supervise loop before respawn).

- [ ] **Step 3: Minimal check for the new logic**

Add to main.rs:

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn usage_covers_all_commands() {
        assert!(super::USAGE.contains("gateway"));
    }
}
```

(The real check is Step 4 — a live run. The shutdown path is exercised in Task 5's smoke.)

- [ ] **Step 4: Build + run smoke**

```bash
cargo build -p feral-cli
./target/debug/feral-cli help          # prints usage, exit 0
./target/debug/feral-cli bogus; echo $? # usage + exit 2
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(faza4.5): feral-cli gateway — headless entry point with single-instance guard + D7 shutdown"
```

---

### Task 5: Verification gate (Slice 2 acceptance)

**Files:** none (verification; micro-fixes only from findings).

- [ ] **Step 1: Workspace gates**

`cargo build --workspace && cargo test --workspace` → green; confirm NO artifact-name collision (`feral.exe` desktop vs `feral-cli.exe`); `grep -rn "use tauri\|tauri::" crates/feral-core/src` → zero.

- [ ] **Step 2: Headless live smoke (desktop app CLOSED)**

```bash
./target/debug/feral-cli gateway &   # watch stderr for "gateway up" + sidecar ready
TOKEN=$(cat ~/.feral/api-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:11435/v1/models   # 200 + model list
curl -s -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"<a model present on disk>","messages":[{"role":"user","content":"Say OK"}],"max_tokens":8}'
```
Expected: completion returns (wait_for_model handles lazy load). Then send Ctrl+C (or `kill -INT`) to the gateway: logs show planned shutdown, sidecar exits cleanly, exit code 0, no orphan `feral-agent.exe` in Task Manager/`tasklist`.

- [ ] **Step 3: PENDING-MANUAL (Darius)**

(a) Discord/Slack message answered by the gateway with the desktop app closed — same memory visible; (b) desktop app still boots and chats normally afterwards (`cargo tauri dev`) — includes the Slice 1 smoke that is still pending.

- [ ] **Step 4: Report** — build/test results, smoke transcript, any `PlannedExit`/supervise adjustments made in Task 4 Step 2, open items for Darius.
