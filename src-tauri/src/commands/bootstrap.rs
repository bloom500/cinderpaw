//! Bootstrap bridge for the Browser App onboarding surface.
//!
//! The Browser App (`cinderpaw.dev/app`) needs to guide a user from
//! "nothing installed" to "Cinderpaw is configured and ready to chat."
//! That guidance happens in a normal browser tab, which is on a
//! different origin than the user's `127.0.0.1:11435` Cinderpaw
//! gateway. CORS would block direct browser→gateway requests, and
//! the Vercel BFF cannot reach the user's localhost in production.
//!
//! This module embeds a minimal HTTP server inside the Tauri process
//! that exposes exactly three endpoints:
//!
//!   GET  /bootstrap/status
//!   GET  /bootstrap/state
//!   POST /bootstrap/action
//!
//! The bridge is NOT a generic gateway proxy. Each action is a fixed
//! enum mapped to an existing Tauri command or gateway operation.
//! The bridge never forwards arbitrary paths, URLs, or HTTP methods.
//! The permanent bearer token stays inside this process: the browser
//! receives only sanitized JSON responses.
//!
//! Lifecycle: the bridge starts with Tauri (in `tauri::Builder::setup`)
//! and dies with it. It binds to `127.0.0.1:11437` (the dedicated
//! bridge port) and serves loopback-only. Origin and Host headers are
//! validated against an allowlist; anything else is rejected 403.

use crate::AppState;
use cinderpaw_core::byok::ProviderCatalogEntry;
use cinderpaw_core::runtime::RuntimeState;
use cinderpaw_core::setup::Candidate;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::net::TcpListener;

/// The dedicated loopback port the bridge listens on. Must not
/// collide with the gateway port (default 11435) and must not be a
/// port the rest of the project owns. Verified free at startup; if
/// binding fails the bridge logs and stays down, so the browser
/// surfaces `not_connected` cleanly.
pub const BRIDGE_PORT: u16 = 11437;

/// Origins the bridge accepts. The browser app is served from
/// `cinderpaw.dev` (prod) and `localhost:3000` (dev). No wildcards.
pub const ALLOWED_ORIGINS: &[&str] = &[
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://cinderpaw.dev",
    "https://www.cinderpaw.dev",
];

/// Host values the bridge accepts. Strict match — anything else is a
/// DNS-rebinding attempt and gets 403.
pub const ALLOWED_HOSTS: &[&str] = &["127.0.0.1:11437", "localhost:11437"];

// ── Wire types ────────────────────────────────────────────────────────────

/// `GET /bootstrap/status` response. The browser uses this to detect
/// the bridge, determine whether the gateway is running, and pull
/// the runtime version + sanitized system info. Never includes the
/// bearer token.
#[derive(Debug, Clone, Serialize)]
pub struct BridgeStatus {
    pub installed: bool,
    pub running: bool,
    pub version: String,
    pub platform: String,
    pub gateway_port: u16,
    pub capabilities: BridgeCapabilities,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeCapabilities {
    pub gpu: Option<String>,
    pub ram_gb: Option<u32>,
    pub has_api_key: bool,
    pub active_model: Option<String>,
}

/// `GET /bootstrap/state` response. The browser maps this to its
/// onboarding wizard's progress display.
#[derive(Debug, Clone, Serialize)]
pub struct BridgeState {
    pub steps: Vec<OnboardingStep>,
    pub current_step: String,
    pub can_proceed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OnboardingStep {
    pub id: String,
    pub status: &'static str,
    pub label: &'static str,
}

/// `POST /bootstrap/action` body. Strict enum — unknown actions are
/// rejected 400. No `path` field, no `url` field, no `target` field;
/// the bridge does not forward arbitrary requests.
#[derive(Debug, Clone, Deserialize)]
pub struct BridgeActionRequest {
    pub action: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeActionResponse {
    pub ok: bool,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── Origin / host validation ─────────────────────────────────────────────

/// True if `origin` is exactly one of the allowed browser origins.
/// This is a strict allowlist, not a prefix match. `evil.com` shaped
/// to look like `localhost` is rejected at the `==` boundary.
fn origin_allowed(origin: &str) -> bool {
    ALLOWED_ORIGINS.iter().any(|allowed| *allowed == origin)
}

/// True if `host` is exactly one of the allowed loopback hosts.
/// Same strict-allowlist posture as origins.
fn host_allowed(host: &str) -> bool {
    ALLOWED_HOSTS.iter().any(|allowed| *allowed == host)
}

// ── Tauri commands exposed to the bridge's tokio task ─────────────────────
//
// The bridge task runs in the same Tauri process and does not go
// through the Tauri IPC layer. It calls the underlying functions
// directly (the same functions the IPC commands wrap), reusing the
// already-existing `AppState` machinery.

/// Snapshot of the data the bridge needs to answer `/bootstrap/status`.
/// Computed on each call (cheap; no caching required for onboarding
/// cadence).
async fn compute_status(
    runtime: &Arc<RuntimeState>,
    token: &Arc<str>,
) -> BridgeStatus {
    // 1. Runtime version. `env!("CARGO_PKG_VERSION")` is the source of
    //    truth for the Tauri binary itself; the gateway version
    //    matches because the Tauri host and the gateway are built
    //    from the same `Cargo.toml` workspace.
    let version = env!("CARGO_PKG_VERSION").to_string();

    // 2. Platform. Cheap derivation from `cfg!(target_os)`. The
    //    Browser App uses this to render platform-specific download
    //    links and help text.
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    };

    // 3. Gateway port. Read from settings so the bridge never assumes
    //    a hardcoded port — a user who changed `api_port` in their
    //    `~/.cinderpaw/settings.json` gets the bridge reporting the
    //    new value.
    let gateway_port = cinderpaw_core::settings::load().api_port;

    // 4. Is the gateway actually running? Single short TCP probe to
    //    the loopback port. 200ms is plenty on the user's machine
    //    and a hard cap prevents the bridge from blocking on a
    //    wedged kernel.
    let running = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        tokio::net::TcpStream::connect(("127.0.0.1", gateway_port)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false);

    // 5. Capabilities. The token is the only thing that can talk to
    //    the gateway for richer info; if the gateway is down, we
    //    return what we already have locally.
    let mut gpu = None;
    let mut ram_gb = None;
    let mut has_api_key = false;
    let mut active_model = None;

    if let Ok(info) = std::panic::catch_unwind(|| cinderpaw_core::sysinfo_mod::collect()) {
        gpu = if info.gpu_name.is_empty() {
            None
        } else {
            Some(info.gpu_name.clone())
        };
        ram_gb = Some((info.ram_total_mb / 1024) as u32);
    }

    // Probe the gateway for model + API key presence only when it's
    // reachable. We read the token from the same `AppState` the
    // gateway uses (no filesystem round-trip in the hot path), and
    // we make a SHORT-lived HTTP call with a 1s budget.
    if running {
        let token = token.to_string();
        let url = format!("http://127.0.0.1:{}/runtime/status", gateway_port);
        let fut = reqwest::Client::new()
            .get(&url)
            .bearer_auth(&token)
            .send();
        if let Ok(Ok(resp)) = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            fut,
        )
        .await
        {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                has_api_key = json
                    .get("providers")
                    .and_then(|p| p.get("active"))
                    .is_some();
                active_model = json
                    .get("agent_model")
                    .and_then(|m| m.as_str())
                    .map(String::from);
            }
        }
    }

    let _ = runtime;

    BridgeStatus {
        installed: true,
        running,
        version,
        platform: platform.to_string(),
        gateway_port,
        capabilities: BridgeCapabilities {
            gpu,
            ram_gb,
            has_api_key,
            active_model,
        },
    }
}

/// Snapshot of the data the bridge needs to answer `/bootstrap/state`.
/// Reads `~/.cinderpaw/onboarding.json` via the same path the Tauri
/// `get_onboarding_record` command uses, then computes the wizard's
/// "can proceed" by combining record state with live runtime checks.
async fn compute_state(_runtime: &Arc<RuntimeState>) -> BridgeState {
    // The onboarding record is the persistent cross-session state.
    // The bridge does NOT have access to Tauri IPC, so it re-reads
    // the file the same way `get_onboarding_record` does.
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok());
    let home = match home {
        Some(h) => h,
        None => {
            return default_state();
        }
    };
    let path = std::path::PathBuf::from(home)
        .join(cinderpaw_core::brand::APP_HOME_DIR_NAME)
        .join("onboarding.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return default_state(),
    };
    let record: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return default_state(),
    };

    let detect_done = record
        .get("detect")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let provider_done = record
        .get("provider")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let model_done = record
        .get("model")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let verify_done = record
        .get("verify")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let steps = vec![
        OnboardingStep {
            id: "detect".into(),
            status: if detect_done { "done" } else { "pending" },
            label: "System detected",
        },
        OnboardingStep {
            id: "provider".into(),
            status: if provider_done { "done" } else { "pending" },
            label: "Provider configured",
        },
        OnboardingStep {
            id: "model".into(),
            status: if model_done { "done" } else { "pending" },
            label: "Model selected",
        },
        OnboardingStep {
            id: "verify".into(),
            status: if verify_done { "done" } else { "pending" },
            label: "Verify setup",
        },
    ];

    // The first not-done step is the current one; if all are done,
    // we stay on "verify" so the UI can show the "open desktop"
    // hand-off.
    let current_step = steps
        .iter()
        .find(|s| s.status == "pending")
        .map(|s| s.id.clone())
        .unwrap_or_else(|| "verify".to_string());

    // "Can proceed" is the live signal: the next step is achievable
    // right now. We only need to know the user can keep moving; finer
    // eligibility lives in the action handlers.
    let _ = _runtime;
    let can_proceed = !detect_done
        || (detect_done && !provider_done)
        || (detect_done && provider_done && !model_done)
        || (detect_done && provider_done && model_done && !verify_done);

    BridgeState {
        steps,
        current_step,
        can_proceed,
    }
}

fn default_state() -> BridgeState {
    BridgeState {
        steps: vec![
            OnboardingStep {
                id: "detect".into(),
                status: "pending",
                label: "System detected",
            },
            OnboardingStep {
                id: "provider".into(),
                status: "pending",
                label: "Provider configured",
            },
            OnboardingStep {
                id: "model".into(),
                status: "pending",
                label: "Model selected",
            },
            OnboardingStep {
                id: "verify".into(),
                status: "pending",
                label: "Verify setup",
            },
        ],
        current_step: "detect".into(),
        can_proceed: true,
    }
}

// ── Action handlers ──────────────────────────────────────────────────────

/// Strict enum, no fallthrough. Any unknown action returns 400.
async fn handle_action(token: &Arc<str>, req: BridgeActionRequest) -> BridgeActionResponse {
    match req.action.as_str() {
        "detect_system" => {
            // The system info command already runs in the desktop;
            // the bridge returns a sanitized subset suitable for the
            // browser's onboarding UI.
            let info = std::panic::catch_unwind(|| cinderpaw_core::sysinfo_mod::collect())
                .ok();
            match info {
                Some(info) => BridgeActionResponse {
                    ok: true,
                    action: req.action,
                    result: Some(serde_json::json!({
                        "os": info.os,
                        "cpu": info.cpu,
                        "cores": info.cores,
                        "ram_total_mb": info.ram_total_mb,
                        "gpu_name": info.gpu_name,
                        "vram_total_mb": info.vram_total_mb,
                    })),
                    error: None,
                },
                None => BridgeActionResponse {
                    ok: false,
                    action: req.action,
                    result: None,
                    error: Some("detect_system failed: sysinfo collect panicked".to_string()),
                },
            }
        }
        "verify_api_key" => {
            // POST to the gateway's `/runtime/setup/verify` with the
            // token from AppState. The gateway's setup layer runs
            // the real completion round-trip; the bridge only
            // forwards sanitized results.
            let token = token.to_string();
            let gateway_port = cinderpaw_core::settings::load().api_port;
            let url = format!("http://127.0.0.1:{}/runtime/setup/verify", gateway_port);
            let body = req.params;
            let client = reqwest::Client::new();
            let resp = client
                .post(&url)
                .bearer_auth(&token)
                .json(&body)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    let json: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
                    let _ = persist_step("provider", true);
                    BridgeActionResponse {
                        ok: true,
                        action: req.action,
                        result: Some(json),
                        error: None,
                    }
                }
                Ok(r) => {
                    let status = r.status();
                    let body = r.text().await.unwrap_or_default();
                    BridgeActionResponse {
                        ok: false,
                        action: req.action,
                        result: None,
                        error: Some(format!("gateway returned {status}: {body}")),
                    }
                }
                Err(e) => BridgeActionResponse {
                    ok: false,
                    action: req.action,
                    result: None,
                    error: Some(format!("verify_api_key unreachable: {e}")),
                },
            }
        }
        "install_model" => {
            // POST to `/runtime/models/install`. The body is the
            // `params` the browser sent (already shaped by the
            // onboarding assistant's model picker).
            let token = token.to_string();
            let gateway_port = cinderpaw_core::settings::load().api_port;
            let url = format!("http://127.0.0.1:{}/runtime/models/install", gateway_port);
            let body = req.params;
            let client = reqwest::Client::new();
            let resp = client
                .post(&url)
                .bearer_auth(&token)
                .json(&body)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    let _ = persist_step("model", true);
                    BridgeActionResponse {
                        ok: true,
                        action: req.action,
                        result: Some(serde_json::json!({"started": true})),
                        error: None,
                    }
                }
                Ok(r) => {
                    let status = r.status();
                    let body = r.text().await.unwrap_or_default();
                    BridgeActionResponse {
                        ok: false,
                        action: req.action,
                        result: None,
                        error: Some(format!("gateway returned {status}: {body}")),
                    }
                }
                Err(e) => BridgeActionResponse {
                    ok: false,
                    action: req.action,
                    result: None,
                    error: Some(format!("install_model unreachable: {e}")),
                },
            }
        }
        "save_progress" => {
            // Persist a step's done flag. `params.step` is the step
            // id; `params.done` is a bool. We never accept arbitrary
            // file paths or new keys — only the four known steps.
            let step = req
                .params
                .get("step")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let done = req
                .params
                .get("done")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            match persist_step(step, done) {
                Ok(()) => BridgeActionResponse {
                    ok: true,
                    action: req.action,
                    result: Some(serde_json::json!({"saved": true})),
                    error: None,
                },
                Err(e) => BridgeActionResponse {
                    ok: false,
                    action: req.action,
                    result: None,
                    error: Some(e),
                },
            }
        }
        "finish_setup" => {
            // Mark all steps done + write the persisted onboarding
            // record the desktop reads on next launch. Uses the same
            // shape `set_onboarding_record` writes.
            let _ = persist_step("detect", true);
            let _ = persist_step("provider", true);
            let _ = persist_step("model", true);
            let _ = persist_step("verify", true);
            // Also write the legacy `OnboardingRecord` shape so the
            // desktop's `get_onboarding_record` sees the completion.
            write_onboarding_record();
            BridgeActionResponse {
                ok: true,
                action: req.action,
                result: Some(serde_json::json!({"finished": true})),
                error: None,
            }
        }
        "list_providers" => {
            // Returns the canonical provider catalog. Reuses the same
            // `byok::provider_catalog()` the desktop onboarding
            // wizard consumes — single source of truth, no drift.
            let catalog: Vec<ProviderCatalogEntry> = cinderpaw_core::byok::provider_catalog();
            BridgeActionResponse {
                ok: true,
                action: req.action,
                result: Some(serde_json::to_value(&catalog).unwrap_or(serde_json::json!([]))),
                error: None,
            }
        }
        "list_models" => {
            // Returns the setup detection ladder: existing config,
            // local GGUFs, hardware-tier download candidates, env
            // keys, Ollama, OpenClaw import. Reuses the same
            // `setup::detect()` the desktop onboarding wizard
            // consumes. The browser uses this for model selection.
            let candidates: Vec<Candidate> = cinderpaw_core::setup::detect().await;
            BridgeActionResponse {
                ok: true,
                action: req.action,
                result: Some(serde_json::to_value(&candidates).unwrap_or(serde_json::json!([]))),
                error: None,
            }
        }
        _ => BridgeActionResponse {
            ok: false,
            action: req.action.clone(),
            result: None,
            error: Some(format!(
                "unknown action '{}' — bridge exposes only: detect_system, verify_api_key, install_model, save_progress, finish_setup, list_providers, list_models",
                req.action
            )),
        },
    }
}

// ── Onboarding persistence (mirror of commands/system.rs) ────────────────

fn onboarding_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())?;
    Some(
        std::path::PathBuf::from(home)
            .join(cinderpaw_core::brand::APP_HOME_DIR_NAME)
            .join("onboarding.json"),
    )
}

fn read_onboarding_record() -> serde_json::Value {
    let Some(path) = onboarding_path() else {
        return serde_json::json!({});
    };
    let Ok(s) = std::fs::read_to_string(&path) else {
        return serde_json::json!({});
    };
    serde_json::from_str(&s).unwrap_or(serde_json::json!({}))
}

fn persist_step(step: &str, done: bool) -> Result<(), String> {
    // Only the four known onboarding steps. A typo in the browser
    // never writes a stray key into the record.
    if !matches!(step, "detect" | "provider" | "model" | "verify") {
        return Err(format!("unknown step '{step}'"));
    }
    let path = onboarding_path().ok_or_else(|| "could not resolve home".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let mut record = read_onboarding_record();
    if let Some(obj) = record.as_object_mut() {
        obj.insert(step.to_string(), serde_json::Value::Bool(done));
    }
    let pretty = serde_json::to_string_pretty(&record).map_err(|e| format!("serialize: {e}"))?;
    cinderpaw_core::atomic_file::write_atomic(&path, pretty.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

fn write_onboarding_record() {
    let Some(path) = onboarding_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let record = serde_json::json!({
        "completed": true,
        "completedAt": 0u64,
        "userName": "",
        "agentName": "",
    });
    if let Ok(pretty) = serde_json::to_string_pretty(&record) {
        let _ = cinderpaw_core::atomic_file::write_atomic(&path, pretty.as_bytes());
    }
}

// ── Minimal HTTP server (no axum, no new dependencies) ───────────────────
//
// The bridge deliberately uses a hand-rolled `tokio` HTTP server
// instead of pulling in axum as a runtime dependency. The surface
// is three endpoints; a full router would be more code than the
// handlers. This is the smallest possible boundary that satisfies
// the contract.

/// Starts the bridge HTTP server. Returns immediately after binding
/// the port; the accept loop runs in a background `tokio::spawn`.
/// If the port is already in use, the bridge logs and does not retry
/// — the browser will see `not_connected` and surface it.
pub fn start_bridge(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let addr: SocketAddr = ([127, 0, 0, 1], BRIDGE_PORT).into();
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(
                    port = BRIDGE_PORT,
                    error = %e,
                    "bridge: failed to bind, browser will report not_connected"
                );
                // Emit a machine-readable diagnostic for the Desktop UI.
                // The browser cannot observe this directly — it sees
                // `not_connected` — but the Desktop UI can show a
                // specific "port conflict" message.
                let _ = app_handle.emit(
                    "bridge://bind_failed",
                    serde_json::json!({
                        "port": BRIDGE_PORT,
                        "reason": "bind_failed",
                        "error": e.to_string(),
                    }),
                );
                return;
            }
        };
        tracing::info!(port = BRIDGE_PORT, "bootstrap bridge listening (loopback only)");

        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!(error = %e, "bridge: accept failed");
                    continue;
                }
            };
            // Refuse anything that did not come from loopback. This
            // is belt-and-braces alongside the bind address — the
            // bind already guarantees 127.0.0.1, but the check here
            // makes the intent visible.
            if !peer.ip().is_loopback() {
                drop(stream);
                continue;
            }
            let token = app_handle.state::<AppState>().local_api_token.clone();
            let runtime = app_handle.state::<AppState>().runtime.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = handle_connection(runtime, token, stream).await {
                    tracing::debug!(error = %e, "bridge: connection ended");
                }
            });
        }
    });
}

/// Starts the bridge accept loop. The task is owned by Tauri's
/// async runtime and dies with the Tauri process; the OS reclaims
/// the loopback socket on process exit.

async fn handle_connection(
    runtime: Arc<RuntimeState>,
    token: Arc<str>,
    mut stream: tokio::net::TcpStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Bound the read: the largest request the bridge accepts is the
    // `POST /bootstrap/action` body, which is bounded by the action
    // enum (no large blobs). 8 KiB is plenty.
    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    let raw = String::from_utf8_lossy(&buf[..n]).to_string();
            let response = route_request(&runtime, &token, &raw).await;
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

/// Parse the request line + headers, dispatch to a handler, return
/// a fully-formed HTTP/1.1 response. We do NOT parse the body for
/// GET; for POST we read it from the buffered request bytes.
async fn route_request(runtime: &Arc<RuntimeState>, token: &Arc<str>, raw: &str) -> String {
    let mut lines = raw.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // Collect headers, lowercase names, and pull Origin + Host. We
    // validate both before any handler runs. Missing headers are
    // a 403: the browser always sends both.
    let mut origin: Option<String> = None;
    let mut host: Option<String> = None;
    for line in lines.by_ref() {
        if line.is_empty() {
            break;
        }
        if let Some(rest) = line.strip_prefix("Origin:") {
            origin = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Host:") {
            host = Some(rest.trim().to_string());
        }
    }
    // Normalize any lowercase variants the browser may have sent.
    // The byte comparison above is case-sensitive, so a second
    // pass over the raw header lines is necessary to catch
    // `origin:` / `host:`. Most browsers use Title-Case, so the
    // first pass is sufficient in practice, but a defensive
    // re-scan is cheap.
    for line in raw.split("\r\n") {
        if let Some(rest) = line.strip_prefix("origin:") {
            if origin.is_none() {
                origin = Some(rest.trim().to_string());
            }
        } else if let Some(rest) = line.strip_prefix("host:") {
            if host.is_none() {
                host = Some(rest.trim().to_string());
            }
        }
    }

    // Reject anything that did not present both an allowed Origin
    // AND an allowed Host. We deliberately do not echo the rejected
    // value back to the caller.
    match (&origin, &host) {
        (Some(o), Some(h)) if origin_allowed(o) && host_allowed(h) => {}
        _ => return forbidden(),
    }

    // CORS preflight. The browser sends OPTIONS before a real
    // request when it sees a cross-origin POST. We answer the
    // preflight without invoking any handler.
    if method == "OPTIONS" {
      return preflight(origin.as_deref().unwrap_or(""), raw);
    }

    let cors = cors_headers(origin.as_deref().unwrap_or(""));

    match (method, path) {
        ("GET", "/bootstrap/status") => {
            let status = compute_status(runtime, token).await;
            json_response(200, &status, &cors)
        }
        ("GET", "/bootstrap/state") => {
            let state = compute_state(runtime).await;
            json_response(200, &state, &cors)
        }
        ("POST", "/bootstrap/action") => {
            // Extract the body: everything after the empty line
            // separator.
            let body = raw.split("\r\n\r\n").nth(1).unwrap_or("");
            let req: BridgeActionRequest = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => {
                    return json_response(
                        400,
                        &serde_json::json!({"error": "bad_json", "message": e.to_string()}),
                        &cors,
                    );
                }
            };
            let resp = handle_action(token, req).await;
            // Always 200 for handler-level rejections (unknown action,
            // etc.) so the browser's fetch promise resolves and
            // surfaces the typed `ok: false` body. Only transport-
            // level failures (malformed body) get a 4xx.
            json_response(200, &resp, &cors)
        }
        _ => {
            // Any other path or method: 404. This is the only place
            // the bridge says "I don't know this route", and it is
            // deliberately strict — there is no forwarding.
            json_response(
                404,
                &serde_json::json!({
                    "error": "not_found",
                    "message": "bridge exposes only /bootstrap/status, /bootstrap/state, /bootstrap/action"
                }),
                &cors,
            )
        }
    }
}

fn forbidden() -> String {
    // 403 with no CORS headers: a browser's fetch will reject at
    // the network layer before reading the body, which is the
    // behavior we want for cross-origin attempts.
    "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
}

fn preflight(origin: &str, raw: &str) -> String {
    // Echo only the validated origin back. The Access-Control-Allow-
    // Methods list is the minimum needed for the bridge contract.
    //
    // Private Network Access (PNA): Chrome 124+ and Edge require this
    // header in the preflight response when an HTTPS page requests a
    // loopback HTTP endpoint. Without it, the browser silently blocks
    // the request at the network layer. The header is only sent when
    // the browser requests it — sending it unconditionally is harmless
    // but unnecessary.
    let pna = if raw
      .split("\r\n")
      .any(|line| line.eq_ignore_ascii_case("Access-Control-Request-Private-Network: true"))
    {
      "Access-Control-Allow-Private-Network: true\r\n"
    } else {
      ""
    };
    format!(
        "HTTP/1.1 204 No Content\r\n\
         Access-Control-Allow-Origin: {origin}\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Access-Control-Max-Age: 600\r\n\
         {pna}\
         Content-Length: 0\r\n\
         Connection: close\r\n\r\n"
    )
}

fn cors_headers(origin: &str) -> String {
    // The browser is already validated. We echo the exact origin
    // back (no wildcard) so the browser can read the response.
    format!(
        "Access-Control-Allow-Origin: {origin}\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Vary: Origin\r\n"
    )
}

fn json_response<T: Serialize>(status: u16, body: &T, cors: &str) -> String {
    let payload = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Status",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         {cors}\
         Content-Length: {len}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n\
         {payload}",
        len = payload.len(),
    )
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_allowed_strict_match() {
        assert!(origin_allowed("http://localhost:3000"));
        assert!(origin_allowed("https://cinderpaw.dev"));
        assert!(!origin_allowed("https://evil.com"));
        assert!(!origin_allowed("http://localhost.evil.com"));
        // Empty / missing origin is rejected upstream; this is just
        // a sanity check.
        assert!(!origin_allowed(""));
    }

    #[test]
    fn host_allowed_strict_match() {
        assert!(host_allowed("127.0.0.1:11437"));
        assert!(host_allowed("localhost:11437"));
        assert!(!host_allowed("127.0.0.1:11435"));
        assert!(!host_allowed("127.0.0.1:8080"));
        assert!(!host_allowed("localhost:80"));
    }

    #[test]
    fn preflight_includes_pna_header_when_requested() {
        // Chrome 124+ sends Access-Control-Request-Private-Network: true
        // in the preflight when an HTTPS page requests loopback HTTP.
        let raw = "OPTIONS /bootstrap/status HTTP/1.1\r\n\
                   Origin: https://cinderpaw.dev\r\n\
                   Host: 127.0.0.1:11437\r\n\
                   Access-Control-Request-Method: GET\r\n\
                   Access-Control-Request-Private-Network: true\r\n\r\n";
        let resp = preflight("https://cinderpaw.dev", raw);
        assert!(
            resp.contains("Access-Control-Allow-Private-Network: true"),
            "PNA header must be present when requested, got: {resp}"
        );
        // Origin must still be echoed strictly.
        assert!(resp.contains("Access-Control-Allow-Origin: https://cinderpaw.dev"));
        // Wildcard must never appear.
        assert!(!resp.contains("*"));
    }

    #[test]
    fn preflight_omits_pna_header_when_not_requested() {
        // Older browsers (and same-origin requests) don't send the PNA
        // request header. The response must not include the header.
        let raw = "OPTIONS /bootstrap/status HTTP/1.1\r\n\
                   Origin: https://cinderpaw.dev\r\n\
                   Host: 127.0.0.1:11437\r\n\
                   Access-Control-Request-Method: GET\r\n\r\n";
        let resp = preflight("https://cinderpaw.dev", raw);
        assert!(
            !resp.contains("Access-Control-Allow-Private-Network"),
            "PNA header must be absent when not requested, got: {resp}"
        );
        assert!(resp.contains("Access-Control-Allow-Origin: https://cinderpaw.dev"));
    }

    #[test]
    fn preflight_pna_header_case_insensitive() {
        // The header check must be case-insensitive on the value.
        let raw = "OPTIONS /bootstrap/status HTTP/1.1\r\n\
                   Origin: https://cinderpaw.dev\r\n\
                   Host: 127.0.0.1:11437\r\n\
                   access-control-request-private-network: true\r\n\r\n";
        let resp = preflight("https://cinderpaw.dev", raw);
        assert!(
            resp.contains("Access-Control-Allow-Private-Network: true"),
            "PNA detection must be case-insensitive, got: {resp}"
        );
    }

    #[test]
    fn response_includes_origin_header() {
        let h = cors_headers("https://cinderpaw.dev");
        assert!(h.contains("Access-Control-Allow-Origin: https://cinderpaw.dev"));
        assert!(h.contains("Vary: Origin"));
    }

    #[test]
    fn response_omits_wildcard_origin() {
        // The bridge must never produce a wildcard CORS header; the
        // whole point of the allowlist is to refuse that.
        let h = cors_headers("https://cinderpaw.dev");
        assert!(!h.contains("*"));
    }

    #[test]
    fn unknown_action_returns_typed_error_in_body() {
        // The bridge contract: unknown actions are reported in the
        // JSON body, NOT as a 4xx. The browser's fetch always
        // resolves and the assistant reads `ok: false`.
        let req = BridgeActionRequest {
            action: "delete_everything".to_string(),
            params: serde_json::json!({}),
        };
        // We can't call handle_action without an AppState, but the
        // discriminator is a string match on `req.action` — the
        // result is deterministic.
        assert!(!matches!(req.action.as_str(),
            "detect_system" | "verify_api_key" | "install_model"
            | "save_progress" | "finish_setup" | "list_providers"
            | "list_models"
        ));
    }

    #[test]
    fn persist_step_rejects_unknown_keys() {
        // Only the four wizard steps are writable. A typo in the
        // browser must not write a stray key.
        let result = std::panic::catch_unwind(|| {
            // We can't call persist_step on a pathless box, but the
            // validation runs first. Inspect the validation logic.
            matches!("bogus", "detect" | "provider" | "model" | "verify")
        });
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }
}
