//! Feral Agent sidecar — binary discovery and process lifecycle.
//!
//! Feral Agent is the proactive AI agent with a native security sandbox.
//! It speaks newline-delimited JSON over stdin/stdout (the Tauri sidecar
//! protocol it was built for). All stdout JSON lines are forwarded to the
//! React frontend as `feral://agent-output` events; the frontend parses the
//! `type` field and routes to chunk/done/tool/proactive/error handlers.
//!
//! Data files live under `~/.feral/agent/` (DB) and `~/.feral/workspace/`.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::events::FeralAgentOutputEvent;
use crate::paths;
use crate::rsi::commands::{RsiEngineState, RsiRequestRegistry};
use crate::AppState;

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
/// historically, in the Windows installer. Check all of them — the previous
/// resource-dir-only lookup made the agent silently dead on macOS and Linux
/// production installs.
pub fn find_binary(app: &AppHandle) -> Option<PathBuf> {
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

    // Some layouts (and older bundlers) use the resource directory.
    if let Ok(dir) = app.path().resource_dir() {
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

/// Spawn the feral-agent sidecar and wire up stdin/stdout communication.
///
/// Populates `tx_slot` with a `Sender<String>`; Tauri commands clone it to
/// write JSON messages to the agent's stdin. Stdout lines are parsed and
/// forwarded to the React frontend as `feral://agent-output` events.
///
/// `rsi_registry` + `rsi_engine_mirror` are routed to the stdout reader so
/// the engine-driver IPC round-trip works: every `rsi_engine_event` line is
/// matched against a pending request in `rsi_registry` (acks the oneshot)
/// AND, when the event carries engine state, mirrored into `rsi_engine` so
/// the UI's `rsi_status` shows live progress without polling the sidecar.
///
/// Returns the child process so the caller can store it in `AppState` and
/// kill it on app exit.
pub async fn spawn(
    app: AppHandle,
    tx_slot: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    api_port: u16,
    api_token: &str,
    rsi_registry: RsiRequestRegistry,
    rsi_engine_mirror: Arc<Mutex<Option<RsiEngineState>>>,
) -> Result<tokio::process::Child, String> {
    let binary = find_binary(&app).ok_or_else(|| {
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

    // A1: point the sidecar at Feral's own bundled llama.cpp engine by default
    // (the loopback OpenAI-compatible API on `api_port`), not at an external
    // Ollama install. This makes "fully local" work out of the box with no
    // third-party runtime. The V4 bearer token rides in as FERAL_API_KEY so
    // the now-gated API accepts the sidecar's requests. The frontend may still
    // hot-swap to a cloud BYOK model later via `set_model`; this is only the
    // boot default.
    let base_url = format!("http://127.0.0.1:{api_port}");

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.env("FERAL_DB", &db_path)
        .env("FERAL_WORKSPACE", &workspace)
        .env("FERAL_PROVIDER", "openai_compatible")
        .env("FERAL_BASE_URL", &base_url)
        .env("FERAL_API_KEY", api_token)
        .env("FERAL_MODEL", "feral-local");

    // At-rest encryption key (H-1) for the sidecar's sensitive DB columns. From
    // the OS keychain, generated on first use. Absent ⇒ sidecar stores plaintext
    // (it must never encrypt with a key it can't persist). Passed like the other
    // secrets above and never written to disk by the host.
    if let Some(db_key) = crate::db_key::get_or_create() {
        cmd.env("FERAL_DB_KEY", db_key);
    }

    // Desktop-control opt-in + policy. Forwarded from the host environment so a
    // single env var (or, later, a Settings toggle that sets it) consistently
    // enables BOTH the sidecar's `control_app` tool registration AND the Rust
    // host's command gate — they must agree or the tool is dead. Absent vars
    // are simply not forwarded, keeping desktop control OFF by default.
    for key in [
        "FERAL_ENABLE_DESKTOP_CONTROL",
        "FERAL_DESKTOP_CONTROL_CONFIRM",
        "FERAL_DESKTOP_CONTROL_ALLOWED_APPS",
        // Keep the existing shell_exec opt-in flowing through the same path.
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

    // Suppress console window flash on Windows.
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
    *tx_slot.lock() = Some(tx);

    // The stdout reader needs a way to write responses back to the sidecar's
    // stdin (for the desktop-control request/response bridge), so hand it a
    // clone of the stdin sender before `tx` is moved into the slot.
    let response_tx = {
        let guard = tx_slot.lock();
        guard.as_ref().expect("tx_slot was just populated").clone()
    };

    tokio::spawn(stdin_writer(stdin, rx));
    tokio::spawn(stdout_reader(
        app.clone(),
        stdout,
        response_tx,
        rsi_registry,
        rsi_engine_mirror,
    ));
    tokio::spawn(stderr_logger(app.clone(), stderr));

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
/// The `Child` stays in `process_slot` (AppState) so app-exit kill-on-drop
/// semantics are unchanged; the supervisor polls `try_wait()` through the
/// same mutex instead of taking ownership.
///
/// `rsi_registry` + `rsi_engine_mirror` are cloned into every spawn so each
/// generation of the sidecar gets fresh wiring — a stale oneshot from a
/// previous generation would never fire anyway (the new process never sees
/// the request), but cloning them keeps the contract "every spawn has its
/// own readers" explicit.
pub fn supervise(
    app: AppHandle,
    tx_slot: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    process_slot: Arc<Mutex<Option<tokio::process::Child>>>,
    api_port: u16,
    api_token: String,
    rsi_registry: RsiRequestRegistry,
    rsi_engine_mirror: Arc<Mutex<Option<RsiEngineState>>>,
) {
    const MAX_QUICK_FAILURES: u32 = 5;
    const STABLE_UPTIME_SECS: u64 = 60;

    tauri::async_runtime::spawn(async move {
        let mut quick_failures: u32 = 0;
        loop {
            let started = std::time::Instant::now();
            match spawn(
                app.clone(),
                tx_slot.clone(),
                api_port,
                &api_token,
                rsi_registry.clone(),
                rsi_engine_mirror.clone(),
            )
            .await
            {
                Ok(child) => {
                    *process_slot.lock() = Some(child);
                }
                Err(e) => {
                    tracing::warn!("feral-agent: spawn failed: {e}");
                    let _ = app.emit(
                        "feral://agent-exit",
                        serde_json::json!({ "code": null, "restarting": false, "error": e }),
                    );
                    return;
                }
            }

            // Poll for exit. try_wait() through the mutex keeps ownership in
            // AppState so kill_on_drop still fires on app shutdown.
            let status = loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let exited = {
                    let mut guard = process_slot.lock();
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

            if started.elapsed().as_secs() >= STABLE_UPTIME_SECS {
                quick_failures = 0;
            }
            quick_failures += 1;
            // Within the rapid-failure budget we retry fast; once over it we
            // back off HARD instead of giving up permanently. The old code
            // `return`ed here, which left the agent dead with no recovery short
            // of restarting the whole app — a real dead-end when a *transient*
            // cause (e.g. the sidecar binary being swapped during a rebuild, or
            // a momentary file lock) made it crash 5× quickly. Now a transient
            // failure self-heals after the cool-down, and a genuinely-broken
            // binary just retries slowly (logged) rather than busy-looping.
            let over_budget = quick_failures > MAX_QUICK_FAILURES;
            tracing::warn!(
                code = ?status.code(),
                attempt = quick_failures,
                over_budget,
                "feral-agent: sidecar exited unexpectedly"
            );
            // Invalidate the stale stdin sender so feral_send_message fails
            // fast instead of writing into a dead pipe.
            *tx_slot.lock() = None;
            // We always intend to restart now, so the UI banner never shows a
            // permanent "offline" — at worst a slow recovery.
            let _ = app.emit(
                "feral://agent-exit",
                serde_json::json!({ "code": status.code(), "restarting": true }),
            );
            let backoff = if over_budget {
                tracing::error!(
                    "feral-agent: {MAX_QUICK_FAILURES} rapid failures — cooling down 30s before retrying"
                );
                // Fresh budget after the long cool-down so the next transient
                // blip gets the same fast-retry treatment.
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
/// to the React frontend as `feral://agent-output`. Exceptions (handled in
/// Rust, NOT forwarded):
///   * `desktop_control_request` — the OS accessibility work lives behind
///     the Rust security gate; the response is written back to the sidecar's
///     stdin as `desktop_control_response`.
///   * `rsi_engine_event` — the engine-driver IPC ack + mirror update. The
///     sidecar emits one of these for each `rsi_start` / `rsi_stop` /
///     `rsi_set_concurrency` (with the matching `id`), plus optional
///     `progress` lines that update the engine mirror without acking. After
///     we extract what we need, we still forward the line to the UI so the
///     React layer can render live updates if it wants (the documented path
///     is polling `rsi_status`, but live events are useful for charts).
async fn stdout_reader(
    app: AppHandle,
    stdout: tokio::process::ChildStdout,
    response_tx: mpsc::Sender<String>,
    rsi_registry: RsiRequestRegistry,
    rsi_engine_mirror: Arc<Mutex<Option<RsiEngineState>>>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        // Peek the `type` field cheaply; route the three intercepted types,
        // everything else flows straight to the UI.
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            match v.get("type").and_then(|t| t.as_str()) {
                Some("desktop_control_request") => {
                    let tx = response_tx.clone();
                    tokio::spawn(async move { handle_desktop_control_request(v, tx).await });
                    continue;
                }
                Some("rsi_request") => {
                    // Sidecar asks Rust to do something (commit_genome,
                    // ratchet_attempt, score, etc.). Dispatch and write the
                    // matching rsi_response back to stdin. NOT forwarded to
                    // the UI — it's an internal request/response, like
                    // desktop_control_request.
                    let tx = response_tx.clone();
                    let app_for_rsi = app.clone();
                    tokio::spawn(async move {
                        handle_rsi_request(v, app_for_rsi, tx).await;
                    });
                    continue;
                }
                Some("rsi_engine_event") => {
                    handle_rsi_engine_event(&v, &rsi_registry, &rsi_engine_mirror);
                    // Intentionally fall through to the UI forward — the
                    // rsi_engine_event line may carry useful payload (e.g.
                    // iteration progress) for live widgets.
                }
                _ => {}
            }
        }

        tracing::debug!("feral-agent out: {}", &line);
        let _ = app.emit("feral://agent-output", FeralAgentOutputEvent { data: line });
    }
    tracing::info!("feral-agent: stdout closed");
}

/// Apply a single `rsi_engine_event` line: ack the matching in-flight
/// request (if any) and update the engine mirror.
///
/// Expected shape:
///
/// ```json
/// { "type": "rsi_engine_event",
///   "event": "started" | "stopped" | "concurrency_set" | "progress",
///   "id": "<request_id>",           // only on ack-bearing events
///   "iteration": 0,                  // optional, started/progress/stopped
///   "bestScore": 73.4,               // optional
///   "costSoFarUsd": 0.0,             // optional
///   "concurrency": 1,                // optional, started/concurrency_set
///   "stopReason": "UserStopped"      // only on stopped
/// }
/// ```
///
/// Missing fields fall back to whatever the mirror already holds, so a
/// partial event (e.g. just `iteration`) doesn't wipe the rest. An
/// unknown `event` is logged and ignored — version skew between Rust and
/// the sidecar shouldn't be a panic.
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

    // Ack first (cheap, lock-free w.r.t. the engine mirror). An unknown
    // id simply returns false — no error, the request may have already
    // timed out and that's fine.
    if let Some(id) = v.get("id").and_then(|t| t.as_str()) {
        let fired = rsi_registry.ack(id);
        if !fired && matches!(event_name, "started" | "stopped" | "concurrency_set") {
            tracing::debug!(
                "feral-agent: rsi_engine_event {event_name} for unknown id {id} (already timed out?)"
            );
        }
    }

    // Update the mirror. Seed from the previous value so partial events
    // don't blank fields we don't know about.
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

/// Run a single desktop-control request from the sidecar and write the
/// response back to its stdin. All security gating lives inside
/// `desktop_control::handle_request`; this function only marshals JSON and
/// guarantees that *every* request gets exactly one response (so the sidecar's
/// pending Promise never hangs).
async fn handle_desktop_control_request(req: serde_json::Value, tx: mpsc::Sender<String>) {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let params = req.get("params").cloned().unwrap_or(serde_json::Value::Null);

    let response = match crate::desktop_control::handle_request(&action, &params).await {
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
    };

    if tx.send(response.to_string()).await.is_err() {
        tracing::warn!("feral-agent: failed to deliver desktop_control_response (sidecar gone?)");
    }
}

/// Run a single `rsi_request` from the sidecar and write a matching
/// `rsi_response` back to its stdin. Mirrors `handle_desktop_control_request`:
/// request lines are intercepted by `stdout_reader`, dispatched here, and
/// the response is written back to the stdin writer task via `tx`.
///
/// Every request gets EXACTLY ONE response — even an unknown method or a
/// missing `id` field produces an error response (or a stub with empty id),
/// so the sidecar's pending bridge Promise never hangs. The dispatcher
/// itself is in `rsi::commands::dispatch_rsi_request`; this function only
/// handles the JSON envelope and AppHandle plumbing.
async fn handle_rsi_request(
    req: serde_json::Value,
    app: AppHandle,
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
        // app.state::<AppState>() returns State<'_, AppState>; .inner()
        // gives a plain &AppState the dispatcher can use.
        let state = app.state::<AppState>();
        match crate::rsi::commands::dispatch_rsi_request(state.inner(), &method, params).await {
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
async fn stderr_logger(app: AppHandle, stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        tracing::info!("[feral-agent] {}", &line);
        // The agent writes "[feral] ready — ..." to stderr on startup.
        if line.contains("ready") {
            let _ = app.emit("feral://agent-ready", serde_json::json!({}));
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

    // --- ask_user message builders (regression test for missing Tauri command) ---

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
        // Parse back to assert on shape (string match is too brittle).
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_response");
        assert_eq!(v["requestId"], "req-1");
        assert_eq!(v["answers"][0]["question"], "Pick a database");
        assert_eq!(v["answers"][0]["selected"][0], "Postgres");
        // customText is omitted when None (skip_serializing_if), not serialized as null.
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
        // Regression guard: the bug was that "ask_user_response" was the
        // only supported inbound type — adding "ask_user_cancel" must not
        // accidentally fall through to the same code path.
        let r = build_ask_user_response_line("req", &[]).unwrap();
        let c = build_ask_user_cancel_line("req", None).unwrap();
        assert_ne!(r, c, "response and cancel must produce distinct JSON");
        assert!(r.contains("\"type\":\"ask_user_response\""));
        assert!(c.contains("\"type\":\"ask_user_cancel\""));
    }
}
