//! Feral Agent sidecar — binary discovery, process lifecycle, supervisor.
//!
//! Feral Agent is the proactive AI agent with a native security sandbox.
//! It speaks newline-delimited JSON over stdin/stdout (the Tauri sidecar
//! protocol it was built for). All stdout JSON lines are forwarded to the
//! host's event bus (today `feral://agent-output` on the Tauri webview,
//! tomorrow the Public Runtime API `/events` SSE stream). The frontend
//! parses the `type` field and routes to chunk/done/tool/proactive/error
//! handlers.
//!
//! Data files live under `~/.feral/agent/` (DB) and `~/.feral/workspace/`.
//!
//! **Faza 4.5 Slice 2 — host-agnostic core.** This module no longer touches
//! `tauri::AppHandle`. Every host-specific concern flows through the
//! `HostEvents` trait (see `feral_core::host`):
//!   * events: `events.emit(event, payload)` instead of `app.emit(...)`
//!   * state: `Arc<RuntimeState>` (replaces `AppHandle::state::<AppState>()`)
//!   * desktop control: `Option<DesktopControlHandler>` (injected by host)
//!   * binary resolution: `extra_dirs: &[PathBuf]` (host supplies its
//!     `resource_dir`; feral-core walks the rest)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::host::{DesktopControlHandler, HostEvents};
use crate::paths;
use crate::rsi::runtime::{RsiEngineState, RsiRequestRegistry};
use crate::runtime::{PlannedExit, PlannedExitSlot, RuntimeState};

/// A single user answer to a single `ask_user` question.
///
/// Mirrors the TS `AskUserAnswer` shape on the React side so the JSON
/// payload we write to the sidecar's stdin is round-trippable:
/// `{ question, selected[], customText? }`. Used by the
/// `feral_ask_user_response` Tauri command (and the corresponding
/// `build_ask_user_response_line` helper).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AskUserAnswer {
    pub question: String,
    pub selected: Vec<String>,
    #[serde(rename = "customText", skip_serializing_if = "Option::is_none", default)]
    pub custom_text: Option<String>,
}

/// Default cancel reason when the UI doesn't supply one.
const DEFAULT_CANCEL_REASON: &str = "user cancelled";

/// Unix time in milliseconds — the watchdog's clock.
fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Build the JSON line the sidecar expects for an `ask_user_response`.
///
/// Returns an `Err` when `request_id` is empty/whitespace — the sidecar
/// would silently ignore the message anyway, so failing fast at the
/// Tauri boundary surfaces the bug to the UI instead.
pub fn build_ask_user_response_line(
    request_id: &str,
    answers: &[AskUserAnswer],
) -> Result<String, String> {
    if request_id.trim().is_empty() {
        return Err("ask_user_response: requestId is required".to_string());
    }
    Ok(serde_json::json!({
        "type": "ask_user_response",
        "requestId": request_id,
        "answers": answers,
    })
    .to_string())
}

/// Build the JSON line the sidecar expects for an `ask_user_cancel`.
///
/// `reason` is optional; the helper substitutes `DEFAULT_CANCEL_REASON`
/// when `None` so the sidecar's `AskUserBridge.cancel(id, reason)` is
/// always called with a non-empty reason.
pub fn build_ask_user_cancel_line(
    request_id: &str,
    reason: Option<&str>,
) -> Result<String, String> {
    if request_id.trim().is_empty() {
        return Err("ask_user_cancel: requestId is required".to_string());
    }
    Ok(serde_json::json!({
        "type": "ask_user_cancel",
        "requestId": request_id,
        "reason": reason.unwrap_or(DEFAULT_CANCEL_REASON),
    })
    .to_string())
}

/// Resolve the feral-agent binary across every install layout.
///
/// At bundle time Tauri strips the target-triple suffix from externalBin
/// entries and places the binary NEXT TO the main executable — that means
/// `Contents/MacOS/feral-agent` inside a macOS .app, `/usr/bin/feral-agent`
/// for Linux deb/rpm, and `feral-agent.exe` beside `feral.exe` on Windows.
/// The triple-suffixed name only exists in dev (`src-tauri/binaries/`) and,
/// historically, in the Windows installer.
///
/// `extra_dirs` is host-supplied: Tauri passes its `resource_dir` so the
/// bundle lookup still works, feral-cli passes an empty slice. The
/// `current_exe`-relative and `src-tauri/binaries` walk-up probes are
/// host-agnostic and stay in this function.
pub fn find_binary(extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let triple_name = binary_filename();
    let plain_name = if cfg!(target_os = "windows") {
        "feral-agent.exe".to_string()
    } else {
        "feral-agent".to_string()
    };

    // Production: next to the main executable (all platforms), either name.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in [&plain_name, &triple_name] {
                let p = dir.join(name);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    // Host-supplied locations (Tauri's `resource_dir` for the bundle; headless
    // hosts pass an empty slice and rely on the rest of the search path).
    for dir in extra_dirs {
        for name in [&plain_name, &triple_name] {
            let p = dir.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }

    // Development (cargo tauri dev): the binary lives in src-tauri/binaries/.
    // Walk up from the running executable to find a `binaries/<name>` tree.
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.as_path();
        for _ in 0..10 {
            for sub in &["binaries", "src-tauri/binaries"] {
                let candidate = cursor.join(sub).join(&triple_name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
            match cursor.parent() {
                Some(p) => cursor = p,
                None => break,
            }
        }
    }

    None
}

fn binary_filename() -> String {
    if cfg!(target_os = "windows") {
        "feral-agent-x86_64-pc-windows-msvc.exe".to_string()
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "feral-agent-aarch64-apple-darwin".to_string()
        } else {
            "feral-agent-x86_64-apple-darwin".to_string()
        }
    } else if cfg!(target_arch = "aarch64") {
        "feral-agent-aarch64-unknown-linux-gnu".to_string()
    } else {
        "feral-agent-x86_64-unknown-linux-gnu".to_string()
    }
}

/// Discover the model id the bundled engine is serving by hitting
/// `/v1/models` on the local api server (OpenAI-compatible). Returns
/// the first model id (the bundled llama.cpp server exposes one
/// primary model — the `.gguf` filename minus the directory).
async fn discover_active_model(base_url: &str, api_token: &str) -> Option<String> {
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
        .ok()?;
    let resp = client
        .get(&url)
        .bearer_auth(api_token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let arr = body.get("data").and_then(|d| d.as_array())?;
    let pick = arr
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
        .find(|id| *id != paths::EMBED_FILENAME)
        .or_else(|| {
            arr.first()
                .and_then(|m| m.get("id"))
                .and_then(|v| v.as_str())
        })?;
    Some(pick.to_string())
}

/// Spawn the feral-agent sidecar and wire up stdin/stdout communication.
///
/// Populates `runtime.feral_agent_tx` with a `Sender<String>`; callers
/// clone it to write JSON messages to the agent's stdin. Stdout lines
/// are parsed and forwarded to the host's event bus.
///
/// `desktop_control` is `Some` on the desktop host (forwards each
/// `desktop_control_request` to the injected handler); `None` on the
/// headless gateway (responds with `ok:false` so the sidecar's pending
/// Promise never hangs).
///
/// Returns the `Child` handle so the caller can store it in
/// `runtime.feral_agent_process` and let the supervisor watch it. We
/// don't pre-populate the process slot here because the supervisor
/// (which calls `spawn` on every generation) is the sole owner of the
/// slot — pre-populating would race against `try_wait()` polling.
/// Decide which API key the sidecar gets. If the base URL is loopback, hand it
/// the local bearer token (the gated server expects it). For any remote host,
/// REQUIRE an explicit `FERAL_API_KEY` — silently forwarding the local token to
/// a third party would leak a credential. `env_key` is `FERAL_API_KEY` if set.
fn resolve_sidecar_api_key(
    base_url: &str,
    local_token: &str,
    env_key: Option<String>,
) -> Result<String, String> {
    if base_url.contains("127.0.0.1") || base_url.contains("localhost") {
        Ok(local_token.to_string())
    } else {
        env_key.ok_or_else(|| {
            format!(
                "FERAL_API_KEY must be set when FERAL_BASE_URL is not loopback \
                 (got: {base_url}). Refusing to send the local API bearer token \
                 to a remote endpoint."
            )
        })
    }
}

pub async fn spawn(
    runtime: Arc<RuntimeState>,
    events: Arc<dyn HostEvents>,
    desktop_control: Option<DesktopControlHandler>,
    extra_bin_dirs: Vec<PathBuf>,
) -> Result<tokio::process::Child, String> {
    let api_port = runtime.settings.api_port;
    let api_token = runtime.local_api_token.as_ref();

    let binary = find_binary(&extra_bin_dirs).ok_or_else(|| {
        // D1 fix: the `beforeDevCommand` / `beforeBuildCommand` in
        // tauri.conf.json invoke `scripts/build-sidecar.mjs` which
        // builds the sidecar and copies it to `binaries/`. If you see
        // this error it almost always means the script failed silently
        // or the FeralAgent/ directory is missing on disk. Re-run with
        // `FERAL_FORCE_SIDECAR_BUILD=1 cargo tauri dev` to force a
        // rebuild, or invoke the script directly:
        //   node src-tauri/scripts/build-sidecar.mjs
        concat!(
            "feral-agent binary not found. ",
            "The sidecar build script (src-tauri/scripts/build-sidecar.mjs) ",
            "should have run as part of `cargo tauri dev/build`. ",
            "Run it manually with: node src-tauri/scripts/build-sidecar.mjs"
        )
        .to_string()
    })?;

    tracing::info!("feral-agent: binary resolved to {:?}", binary);

    let db_path = paths::feral_agent_db_path();
    let workspace = paths::feral_agent_workspace_path();

    // Faza 4.5 Slice 2 (post-acceptance, user-driven): env-var overrides for
    // the provider + base URL + API key. Defaults preserve the pre-change
    // behavior (point at the bundled llama.cpp on loopback). The headless
    // gateway (or any host) can now point the sidecar at a cloud provider
    // by setting FERAL_BASE_URL/FERAL_API_KEY/FERAL_MODEL before boot —
    // e.g. for testing the Discord connector against a fast model without
    // burning the local GPU.
    let provider = std::env::var("FERAL_PROVIDER")
        .unwrap_or_else(|_| "openai_compatible".to_string());
    let base_url = std::env::var("FERAL_BASE_URL")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{api_port}"));
    let api_key = resolve_sidecar_api_key(&base_url, api_token, std::env::var("FERAL_API_KEY").ok())?;

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.env("FERAL_DB", &db_path)
        .env("FERAL_WORKSPACE", &workspace)
        .env("FERAL_PROVIDER", &provider)
        .env("FERAL_BASE_URL", &base_url)
        .env("FERAL_API_KEY", &api_key);

    // FERAL_MODEL discovery is for the bundled llama.cpp (/v1/models on
    // loopback). For a remote provider the user is expected to set
    // FERAL_MODEL explicitly; we still call discover_active_model as a
    // best-effort (some clouds expose OpenAI-compatible /v1/models) but
    // honour FERAL_MODEL when present so the caller can override.
    let model_name = if let Ok(m) = std::env::var("FERAL_MODEL") {
        m
    } else {
        discover_active_model(&base_url, &api_key)
            .await
            .unwrap_or_else(|| "feral-local".to_string())
    };
    cmd.env("FERAL_MODEL", &model_name);
    tracing::info!(model = %model_name, "feral-agent: using discovered model");

    if let Some(db_key) = crate::db_key::get_or_create() {
        cmd.env("FERAL_DB_KEY", db_key);
    }

    for key in [
        "FERAL_ENABLE_DESKTOP_CONTROL",
        "FERAL_DESKTOP_CONTROL_CONFIRM",
        "FERAL_DESKTOP_CONTROL_ALLOWED_APPS",
        "FERAL_ENABLE_SHELL_EXEC",
    ] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn feral-agent: {e}"))?;

    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    // Channel: commands → stdin writer task.
    let (tx, rx) = mpsc::channel::<String>(64);
    *runtime.feral_agent_tx.lock() = Some(tx);

    // The stdout reader needs a way to write responses back to the sidecar's
    // stdin (for the desktop-control / rsi request/response bridges), so hand
    // it a clone of the stdin sender before `tx` is moved into the slot.
    let response_tx = {
        let guard = runtime.feral_agent_tx.lock();
        guard.as_ref().expect("tx_slot was just populated").clone()
    };

    tokio::spawn(stdin_writer(stdin, rx));
    tokio::spawn(stdout_reader(
        runtime.clone(),
        events.clone(),
        desktop_control,
        stdout,
        response_tx,
        runtime.rsi_request_registry.clone(),
        runtime.rsi_engine.clone(),
        runtime.feral_agent_process.clone(),
        runtime.feral_agent_planned_exit.clone(),
    ));
    tokio::spawn(stderr_logger(events.clone(), stderr));

    tracing::info!("feral-agent: started (pid {:?})", child.id());
    Ok(child)
}

/// Supervise the sidecar: spawn it, watch for unexpected exits, and restart
/// with backoff (#11). Before this, a sidecar crash left Agent mode silently
/// mute — messages went into a dead stdin pipe, no banner, no recovery short
/// of restarting the whole app.
///
/// Behaviour:
///   * On every exit, emits `feral://agent-exit` with `{ code, restarting }`
///     so the frontend can show an "agent offline / restarting" banner.
///   * Restarts with linear backoff (2s, 4s, … capped at 10s), at most
///     `MAX_QUICK_FAILURES` times in a row. A process that stays up for
///     `STABLE_UPTIME_SECS` resets the failure streak (a crash after hours
///     of uptime shouldn't count against the boot-loop budget).
///   * After the budget is exhausted, gives up and emits a final
///     `feral://agent-exit` with `restarting: false`.
///
/// The `Child` stays in `runtime.feral_agent_process` so app-exit kill-on-drop
/// semantics are unchanged; the supervisor polls `try_wait()` through the
/// same mutex instead of taking ownership.
///
/// `rsi_registry` + `rsi_engine_mirror` are cloned into every spawn so each
/// generation of the sidecar gets fresh wiring — a stale oneshot from a
/// previous generation would never fire anyway (the new process never sees
/// the request), but cloning them keeps the contract "every spawn has its
/// own readers" explicit.
pub fn supervise(
    runtime: Arc<RuntimeState>,
    events: Arc<dyn HostEvents>,
    desktop_control: Option<DesktopControlHandler>,
    extra_bin_dirs: Vec<PathBuf>,
) {
    const MAX_QUICK_FAILURES: u32 = 5;
    const STABLE_UPTIME_SECS: u64 = 60;

    tokio::spawn(async move {
        let mut quick_failures: u32 = 0;
        // Faza 3 Slice 3: unexpected-exit timestamps (unix ms) feeding the
        // crash→auto-revert watchdog. Planned exits never land here.
        let mut crash_times_ms: Vec<u64> = Vec::new();
        loop {
            let started = std::time::Instant::now();
            match spawn(
                runtime.clone(),
                events.clone(),
                desktop_control.clone(),
                extra_bin_dirs.clone(),
            )
            .await
            {
                Ok(child) => {
                    *runtime.feral_agent_process.lock() = Some(child);
                }
                Err(e) => {
                    tracing::warn!("feral-agent: spawn failed: {e}");
                    events.emit(
                        "feral://agent-exit",
                        serde_json::json!({ "code": null, "restarting": false, "error": e }),
                    );
                    return;
                }
            }

            // Poll for exit. try_wait() through the mutex keeps ownership in
            // RuntimeState so kill_on_drop still fires on app shutdown.
            let status = loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let exited = {
                    let mut guard = runtime.feral_agent_process.lock();
                    match guard.as_mut() {
                        Some(c) => c.try_wait().ok().flatten(),
                        // Slot cleared externally — stop supervising.
                        None => break None,
                    }
                };
                if exited.is_some() {
                    break exited;
                }
            };
            let Some(status) = status else { return };

            // A planned exit (env-toggle restart, or a post-apply rebuild) is
            // not a crash: skip the failure accounting AND the watchdog
            // counter, then respawn immediately.
            // Scope the guard: holding a parking_lot lock across the rebuild
            // await would make the future !Send.
            let planned = { runtime.feral_agent_planned_exit.lock().take() };
            if let Some(planned) = planned {
                *runtime.feral_agent_tx.lock() = None;
                match planned {
                    PlannedExit::Shutdown => {
                        // Faza 4.5 Slice 2 D7: clean shutdown. The host
                        // asked for one-shot exit; the supervisor stops
                        // here. The agent-exit event still fires (with
                        // restarting:false) so the host can update its
                        // own UI / SSE subscribers.
                        events.emit(
                            "feral://agent-exit",
                            serde_json::json!({ "code": status.code(), "restarting": false }),
                        );
                        return;
                    }
                    PlannedExit::Restart => {
                        events.emit(
                            "feral://agent-exit",
                            serde_json::json!({ "code": status.code(), "restarting": true }),
                        );
                        continue;
                    }
                    PlannedExit::Rebuild { repo_root } => {
                        events.emit(
                            "feral://agent-exit",
                            serde_json::json!({ "code": status.code(), "restarting": true }),
                        );
                        // The process is dead, so its exe is finally writable
                        // (Windows locks running binaries) — rebuild now, before
                        // the respawn picks the binary up again.
                        match run_rebuild_script(&repo_root).await {
                            Ok(()) => {
                                if let Err(e) = refresh_spawn_binary(&extra_bin_dirs, &repo_root) {
                                    tracing::warn!("feral-agent: rebuilt but could not refresh spawn binary: {e}");
                                }
                                tracing::info!("feral-agent: sidecar rebuilt after live patch apply");
                            }
                            Err(e) => tracing::warn!(
                                "feral-agent: sidecar rebuild failed ({e}); respawning the \
                                 previous binary — the watchdog marker will expire harmlessly"
                            ),
                        }
                        continue;
                    }
                }
            }

            if started.elapsed().as_secs() >= STABLE_UPTIME_SECS {
                quick_failures = 0;
            }
            quick_failures += 1;
            let over_budget = quick_failures > MAX_QUICK_FAILURES;
            tracing::warn!(
                code = ?status.code(),
                attempt = quick_failures,
                over_budget,
                "feral-agent: sidecar exited unexpectedly"
            );
            // Invalidate the stale stdin sender so feral_send_message fails
            // fast instead of writing into a dead pipe.
            *runtime.feral_agent_tx.lock() = None;
            let events_for_exit = events.clone();
            events_for_exit.emit(
                "feral://agent-exit",
                serde_json::json!({ "code": status.code(), "restarting": true }),
            );

            // Faza 3 Slice 3: crash→auto-revert watchdog.
            let now_ms = unix_ms();
            crash_times_ms.push(now_ms);
            let marker_path = crate::rsi::watchdog::default_marker_path();
            if let Some(marker) = crate::rsi::watchdog::load_marker(&marker_path) {
                let opts = crate::rsi::watchdog::WatchdogOpts::default();
                crash_times_ms
                    .retain(|t| now_ms.saturating_sub(*t) <= opts.window_ms);
                if crate::rsi::watchdog::marker_expired(&marker, now_ms, &opts) {
                    crate::rsi::watchdog::clear_marker(&marker_path);
                } else if crate::rsi::watchdog::should_revert(
                    &marker,
                    &crash_times_ms,
                    now_ms,
                    &opts,
                ) {
                    revert_bad_patch(events.clone(), &extra_bin_dirs, &marker).await;
                    crate::rsi::watchdog::clear_marker(&marker_path);
                    crash_times_ms.clear();
                    quick_failures = 0;
                    continue;
                }
            }

            let backoff = if over_budget {
                tracing::error!(
                    "feral-agent: {MAX_QUICK_FAILURES} rapid failures — cooling down 30s before retrying"
                );
                quick_failures = 0;
                std::time::Duration::from_secs(30)
            } else {
                std::time::Duration::from_secs((2 * quick_failures as u64).min(10))
            };
            tokio::time::sleep(backoff).await;
        }
    });
}

/// Drain the mpsc channel into the child's stdin, one JSON line at a time.
async fn stdin_writer(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::Receiver<String>) {
    while let Some(msg) = rx.recv().await {
        let line = format!("{msg}\n");
        if stdin.write_all(line.as_bytes()).await.is_err() {
            tracing::warn!("feral-agent: stdin write failed — agent may have exited");
            break;
        }
    }
    tracing::debug!("feral-agent: stdin writer exiting");
}

/// Read stdout line-by-line. Most lines are protocol events forwarded verbatim
/// to the host's event bus as `feral://agent-output` (matching the wire shape
/// `{"data": "<line>"}` the legacy `FeralAgentOutputEvent` Tauri struct used to
/// emit — see Step 3 of Task 2 in
/// `docs/superpowers/plans/2026-07-03-faza4-5-slice2-feral-gateway.md`).
///
/// Exceptions handled in Rust, NOT forwarded as `agent-output`:
///   * `desktop_control_request` — routed to the injected `DesktopControlHandler`
///   * `rsi_request`              — dispatched via `feral_core::rsi::runtime`
///   * `rsi_engine_event`         — engine-driver IPC ack + mirror update
///   * `code_patch_resolved`      — Faza 3 patch lifecycle (marker + restart)
async fn stdout_reader(
    runtime: Arc<RuntimeState>,
    events: Arc<dyn HostEvents>,
    desktop_control: Option<DesktopControlHandler>,
    stdout: tokio::process::ChildStdout,
    response_tx: mpsc::Sender<String>,
    rsi_registry: RsiRequestRegistry,
    rsi_engine_mirror: Arc<Mutex<Option<RsiEngineState>>>,
    process_slot: Arc<Mutex<Option<tokio::process::Child>>>,
    planned_exit: PlannedExitSlot,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            match v.get("type").and_then(|t| t.as_str()) {
                Some("desktop_control_request") => {
                    let tx = response_tx.clone();
                    let dc = desktop_control.clone();
                    tokio::spawn(async move { handle_desktop_control_request(v, dc, tx).await });
                    continue;
                }
                Some("rsi_request") => {
                    let tx = response_tx.clone();
                    let runtime = runtime.clone();
                    tokio::spawn(async move {
                        handle_rsi_request(runtime, v, tx).await;
                    });
                    continue;
                }
                Some("rsi_engine_event") => {
                    handle_rsi_engine_event(&v, &rsi_registry, &rsi_engine_mirror);
                    // Intentionally fall through to the host-event forward.
                }
                Some("code_patch_resolved") => {
                    handle_code_patch_resolved(&v, &process_slot, &planned_exit);
                }
                _ => {}
            }
        }

        tracing::debug!("feral-agent out: {}", &line);
        // Wire shape MUST match the legacy FeralAgentOutputEvent struct:
        // `{"data": "<line>"}`. See Step 3 of Slice 2 Task 2 plan for the
        // event-shape regression check.
        events.emit("feral://agent-output", serde_json::json!({ "data": line }));
    }
    tracing::info!("feral-agent: stdout closed");
}

fn handle_rsi_engine_event(
    v: &serde_json::Value,
    rsi_registry: &RsiRequestRegistry,
    rsi_engine_mirror: &Arc<Mutex<Option<RsiEngineState>>>,
) {
    let event_name = v.get("event").and_then(|t| t.as_str()).unwrap_or("");
    if event_name.is_empty() {
        tracing::warn!("feral-agent: rsi_engine_event without 'event' field: {v}");
        return;
    }

    if let Some(id) = v.get("id").and_then(|t| t.as_str()) {
        let fired = rsi_registry.ack(id);
        if !fired && matches!(event_name, "started" | "stopped" | "concurrency_set") {
            tracing::debug!(
                "feral-agent: rsi_engine_event {event_name} for unknown id {id} (already timed out?)"
            );
        }
    }

    let mut guard = rsi_engine_mirror.lock();
    let prev = guard.clone().unwrap_or_default();
    let next = match event_name {
        "started" => RsiEngineState {
            running: true,
            iteration: v.get("iteration").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.iteration),
            best_score: v.get("bestScore").and_then(|n| n.as_f64()).or(prev.best_score),
            cost_so_far_usd: v.get("costSoFarUsd").and_then(|n| n.as_f64()).unwrap_or(prev.cost_so_far_usd),
            concurrency: v.get("concurrency").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.concurrency),
            stop_reason: None,
        },
        "stopped" => RsiEngineState {
            running: false,
            iteration: v.get("iteration").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.iteration),
            best_score: v.get("bestScore").and_then(|n| n.as_f64()).or(prev.best_score),
            cost_so_far_usd: v.get("costSoFarUsd").and_then(|n| n.as_f64()).unwrap_or(prev.cost_so_far_usd),
            concurrency: prev.concurrency,
            stop_reason: v.get("stopReason").and_then(|t| t.as_str()).map(String::from).or(prev.stop_reason),
        },
        "concurrency_set" => RsiEngineState {
            running: prev.running,
            iteration: prev.iteration,
            best_score: prev.best_score,
            cost_so_far_usd: prev.cost_so_far_usd,
            concurrency: v.get("concurrency").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.concurrency),
            stop_reason: prev.stop_reason,
        },
        "progress" => RsiEngineState {
            running: prev.running,
            iteration: v.get("iteration").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.iteration),
            best_score: v.get("bestScore").and_then(|n| n.as_f64()).or(prev.best_score),
            cost_so_far_usd: v.get("costSoFarUsd").and_then(|n| n.as_f64()).unwrap_or(prev.cost_so_far_usd),
            concurrency: prev.concurrency,
            stop_reason: prev.stop_reason,
        },
        other => {
            tracing::warn!("feral-agent: unknown rsi_engine_event '{other}', ignoring");
            return;
        }
    };
    *guard = Some(next);
}

/// Faza 3 Slices 2+3, the apply side. Called for every `code_patch_resolved`
/// line; only `status: "applied"` acts. On an applied patch:
///   1. writes the watchdog marker (Slice 3 — the crash window starts now);
///   2. if the dev-repo knob `FERAL_CODE_RSI_REPO` is set, schedules a
///      `PlannedExit::Rebuild` and kills the sidecar.
fn handle_code_patch_resolved(
    v: &serde_json::Value,
    process_slot: &Arc<Mutex<Option<tokio::process::Child>>>,
    planned_exit: &PlannedExitSlot,
) {
    if v.get("status").and_then(|s| s.as_str()) != Some("applied") {
        return;
    }
    let Some(id) = v.get("id").and_then(|s| s.as_str()) else {
        return;
    };

    let marker = crate::rsi::watchdog::PatchMarker {
        patch_id: id.to_string(),
        applied_at_ms: unix_ms(),
    };
    let marker_path = crate::rsi::watchdog::default_marker_path();
    if let Err(e) = crate::rsi::watchdog::save_marker(&marker_path, &marker) {
        tracing::warn!("feral-agent: failed to write watchdog marker: {e}");
    }

    let repo = std::env::var("FERAL_CODE_RSI_REPO").unwrap_or_default();
    if repo.trim().is_empty() {
        return;
    }
    tracing::info!("feral-agent: patch '{id}' applied — restarting sidecar for rebuild");
    *planned_exit.lock() = Some(PlannedExit::Rebuild { repo_root: repo });
    if let Some(child) = process_slot.lock().as_mut() {
        let _ = child.start_kill();
    }
}

/// Run `scripts/rsi-rebuild-sidecar.ps1` from the source repo: `bun run
/// build` + copy over the Tauri externalBin target. Must only run while
/// the sidecar is DEAD (the copy fails on a running exe). Windows-only,
/// like the script (per the Faza 3 spec, live apply is a Windows dev-
/// machine story for now).
async fn run_rebuild_script(repo_root: &str) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = repo_root;
        Err("sidecar rebuild script is Windows-only for now".to_string())
    }
    #[cfg(windows)]
    {
        let script = Path::new(repo_root)
            .join("scripts")
            .join("rsi-rebuild-sidecar.ps1");
        let mut cmd = tokio::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .arg("-RepoRoot")
            .arg(repo_root);
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
            .await
            .map_err(|_| "rebuild script timed out after 300s".to_string())?
            .map_err(|e| format!("failed to launch rebuild script: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(format!(
                "rebuild script exited {:?}: {}",
                out.status.code(),
                stderr.lines().last().unwrap_or("").trim()
            ))
        }
    }
}

/// Push the freshly rebuilt sidecar to the path the NEXT spawn will
/// actually use. Gap found by the live smoke: the rebuild script updates
/// `<repo>/src-tauri/binaries/`, but in dev mode `cargo tauri dev` copies
/// the sidecar NEXT TO feral.exe (in the cargo target dir) and
/// `find_binary` prefers that copy — so without this, the supervisor
/// keeps respawning the stale binary forever. Must run while the sidecar
/// is dead (the destination is unlocked then).
fn refresh_spawn_binary(extra_bin_dirs: &[PathBuf], repo_root: &str) -> Result<(), String> {
    let fresh = Path::new(repo_root)
        .join("src-tauri")
        .join("binaries")
        .join(binary_filename());
    let dest = find_binary(extra_bin_dirs).ok_or_else(|| "find_binary resolved no sidecar".to_string())?;
    if let (Ok(a), Ok(b)) = (fresh.canonicalize(), dest.canonicalize()) {
        if a == b {
            return Ok(());
        }
    }
    std::fs::copy(&fresh, &dest)
        .map(|_| ())
        .map_err(|e| format!("copy {} -> {}: {e}", fresh.display(), dest.display()))
}

/// Reverse-apply a patch from the real source repo — the Rust mirror of the
/// TS `revertPatchLive` git invocation.
async fn git_apply_reverse(repo_root: &str, patch: &str) -> Result<(), String> {
    for check in [true, false] {
        let mut cmd = tokio::process::Command::new("git");
        cmd.args([
            "apply",
            "--directory=FeralAgent",
            "--whitespace=nowarn",
            "-R",
        ]);
        if check {
            cmd.arg("--check");
        }
        cmd.current_dir(repo_root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("git spawn failed: {e}"))?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        stdin
            .write_all(patch.as_bytes())
            .await
            .map_err(|e| format!("git stdin write failed: {e}"))?;
        drop(stdin);
        let out = child
            .wait_with_output()
            .await
            .map_err(|e| format!("git wait failed: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(stderr.lines().next().unwrap_or("git apply -R failed").to_string());
        }
    }
    Ok(())
}

/// Faza 3 Slice 3, the revert action. Called from the supervisor when the
/// watchdog says "this patch is killing the sidecar": reverse the patch on
/// the source tree, mark it `reverted` in the pending store, rebuild the
/// sidecar, refresh the spawn binary, and tell the host. Every step is
/// best-effort with a logged reason — the supervisor's respawn loop
/// continues regardless.
async fn revert_bad_patch(
    events: Arc<dyn HostEvents>,
    extra_bin_dirs: &[PathBuf],
    marker: &crate::rsi::watchdog::PatchMarker,
) {
    let id = &marker.patch_id;
    let repo = std::env::var("FERAL_CODE_RSI_REPO").unwrap_or_default();
    if repo.trim().is_empty() {
        tracing::warn!("feral-agent: watchdog fired for '{id}' but FERAL_CODE_RSI_REPO is unset — cannot revert");
        return;
    }
    let store = crate::rsi::watchdog::default_pending_store_path();
    let Some(patch) = crate::rsi::watchdog::applied_patch_text(&store, id) else {
        tracing::warn!("feral-agent: watchdog fired for '{id}' but no applied patch with that id in the pending store");
        return;
    };
    if let Err(e) = git_apply_reverse(&repo, &patch).await {
        tracing::error!("feral-agent: auto-revert of '{id}' FAILED ({e}) — source may still carry the bad patch");
        return;
    }
    if let Err(e) = crate::rsi::watchdog::mark_patch_reverted(&store, id) {
        tracing::warn!("feral-agent: reverted '{id}' but could not mark the store: {e}");
    }
    match run_rebuild_script(&repo).await {
        Ok(()) => {
            if let Err(e) = refresh_spawn_binary(extra_bin_dirs, &repo) {
                tracing::warn!("feral-agent: reverted '{id}' but could not refresh spawn binary: {e}");
            }
        }
        Err(e) => tracing::warn!("feral-agent: reverted '{id}' but rebuild failed ({e}) — the running binary may still carry the patch until the next successful build"),
    }
    tracing::warn!("feral-agent: auto-reverted patch '{id}' after repeated sidecar crashes");
    events.emit(
        "feral://rsi-patch-reverted",
        serde_json::json!({ "patchId": id }),
    );
}

/// Run a single desktop-control request from the sidecar and write the
/// response back to its stdin. All security gating lives inside the
/// host's `DesktopControlHandler` (today: `crate::desktop_control`); this
/// function only marshals JSON and guarantees *every* request gets exactly
/// one response. When the host injects `None` (headless gateway), every
/// request responds with `ok:false, error:"desktop control not available
/// in this host"` so the sidecar's pending Promise never hangs.
async fn handle_desktop_control_request(
    req: serde_json::Value,
    desktop_control: Option<DesktopControlHandler>,
    tx: mpsc::Sender<String>,
) {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let params = req.get("params").cloned().unwrap_or(serde_json::Value::Null);

    let response = match desktop_control {
        Some(dc) => match dc(action, params).await {
            Ok(data) => serde_json::json!({
                "type": "desktop_control_response",
                "id": id,
                "ok": true,
                "data": data,
            }),
            Err(message) => serde_json::json!({
                "type": "desktop_control_response",
                "id": id,
                "ok": false,
                "error": message,
            }),
        },
        None => serde_json::json!({
            "type": "desktop_control_response",
            "id": id,
            "ok": false,
            "error": "desktop control not available in this host",
        }),
    };

    if tx.send(response.to_string()).await.is_err() {
        tracing::warn!("feral-agent: failed to deliver desktop_control_response (sidecar gone?)");
    }
}

/// Run a single `rsi_request` from the sidecar and write a matching
/// `rsi_response` back to its stdin.
async fn handle_rsi_request(
    runtime: Arc<RuntimeState>,
    req: serde_json::Value,
    tx: mpsc::Sender<String>,
) {
    let id = req
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let method = req
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let params = req
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let response = if method.is_empty() {
        serde_json::json!({
            "type": "rsi_response",
            "id": id,
            "ok": false,
            "error": "rsi_request: missing 'method'",
        })
    } else {
        match crate::rsi::runtime::dispatch_rsi_request(&runtime, &method, params).await {
            Ok(data) => serde_json::json!({
                "type": "rsi_response",
                "id": id,
                "ok": true,
                "data": data,
            }),
            Err(message) => serde_json::json!({
                "type": "rsi_response",
                "id": id,
                "ok": false,
                "error": message,
            }),
        }
    };

    if tx.send(response.to_string()).await.is_err() {
        tracing::warn!("feral-agent: failed to deliver rsi_response (sidecar gone?)");
    }
}

/// Log stderr from the agent; emit `feral://agent-ready` when the ready line appears.
async fn stderr_logger(events: Arc<dyn HostEvents>, stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        tracing::info!("[feral-agent] {}", &line);
        if line.contains("ready") {
            events.emit("feral://agent-ready", serde_json::json!({}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_filename_has_expected_extension_on_windows() {
        let name = binary_filename();
        #[cfg(target_os = "windows")]
        assert!(name.ends_with(".exe"), "Windows binary must end with .exe");
        #[cfg(not(target_os = "windows"))]
        assert!(!name.ends_with(".exe"), "non-Windows binary must not end with .exe");
    }

    #[test]
    fn binary_filename_contains_target_triple() {
        let name = binary_filename();
        assert!(name.contains('-'), "binary name must contain a target triple");
        assert!(name.starts_with("feral-agent-"));
    }

    #[test]
    fn sidecar_api_key_loopback_uses_local_token() {
        for url in ["http://127.0.0.1:11435", "http://localhost:11435"] {
            assert_eq!(
                resolve_sidecar_api_key(url, "local-secret", None).unwrap(),
                "local-secret",
                "loopback must reuse the local bearer token even without FERAL_API_KEY"
            );
        }
    }

    #[test]
    fn sidecar_api_key_remote_requires_explicit_key() {
        // No FERAL_API_KEY for a remote host → refuse, never leak the local token.
        let err = resolve_sidecar_api_key("https://api.openai.com/v1", "local-secret", None)
            .unwrap_err();
        assert!(err.contains("FERAL_API_KEY must be set"));
        assert!(!err.contains("local-secret"), "error must not echo the local token");
        // With an explicit key, it is used verbatim (local token never forwarded).
        assert_eq!(
            resolve_sidecar_api_key("https://api.openai.com/v1", "local-secret", Some("sk-remote".into())).unwrap(),
            "sk-remote"
        );
    }

    #[test]
    fn build_ask_user_response_line_emits_correct_json() {
        let answers = vec![
            AskUserAnswer {
                question: "Pick a database".to_string(),
                selected: vec!["Postgres".to_string()],
                custom_text: None,
            },
        ];
        let line = build_ask_user_response_line("req-1", &answers).expect("ok");
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_response");
        assert_eq!(v["requestId"], "req-1");
        assert_eq!(v["answers"][0]["question"], "Pick a database");
        assert_eq!(v["answers"][0]["selected"][0], "Postgres");
        assert!(v["answers"][0].get("customText").is_none(), "customText must be omitted when None");
    }

    #[test]
    fn build_ask_user_response_line_rejects_empty_request_id() {
        let line = build_ask_user_response_line("", &[]);
        assert!(line.is_err(), "empty requestId must be rejected");
        let err = line.unwrap_err();
        assert!(err.contains("requestId") || err.contains("request_id"), "error should mention requestId: {err}");
    }

    #[test]
    fn build_ask_user_response_line_rejects_whitespace_request_id() {
        let line = build_ask_user_response_line("   ", &[]);
        assert!(line.is_err(), "whitespace-only requestId must be rejected");
    }

    #[test]
    fn build_ask_user_cancel_line_emits_correct_json_with_explicit_reason() {
        let line = build_ask_user_cancel_line("req-2", Some("user clicked Skip"))
            .expect("ok");
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_cancel");
        assert_eq!(v["requestId"], "req-2");
        assert_eq!(v["reason"], "user clicked Skip");
    }

    #[test]
    fn build_ask_user_cancel_line_uses_default_reason_when_none_provided() {
        let line = build_ask_user_cancel_line("req-3", None).expect("ok");
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_cancel");
        assert_eq!(v["requestId"], "req-3");
        assert!(v["reason"].is_string(), "reason must be a string");
        assert!(!v["reason"].as_str().unwrap().is_empty(), "default reason must not be empty");
    }

    #[test]
    fn build_ask_user_cancel_line_rejects_empty_request_id() {
        let line = build_ask_user_cancel_line("", None);
        assert!(line.is_err(), "empty requestId must be rejected");
    }

    #[test]
    fn ask_user_response_and_cancel_messages_are_distinct() {
        let r = build_ask_user_response_line("req", &[]).unwrap();
        let c = build_ask_user_cancel_line("req", None).unwrap();
        assert_ne!(r, c, "response and cancel must produce distinct JSON");
        assert!(r.contains("\"type\":\"ask_user_response\""));
        assert!(c.contains("\"type\":\"ask_user_cancel\""));
    }
}