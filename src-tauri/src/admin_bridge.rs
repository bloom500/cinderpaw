//! Admin bridge — the commands the agent can run on its own installation.
//!
//! Feral's `self_*` tools already cover the READ half of what the CLI shows:
//! status, providers, health, dreams, genome. This is the ACT half — the
//! things a person would open a terminal for. The goal is that once someone
//! has set Feral up, they never have to run a command themselves: they say
//! "update yourself" or "use the local model for this" and it happens.
//!
//! Same trust shape as the capability bridge (`skills::handle_capability_request`):
//! the sidecar names an action and passes plain values; every decision about
//! what that action means, and whether it is allowed, is made here on the host
//! side.
//!
//! Stopping and restarting need care rather than exclusion. The turn being
//! served runs INSIDE the process that would go away, so killing it from
//! inside the handler means the answer never reaches anyone — a hang, not an
//! action. Both actions therefore return immediately and schedule the exit
//! after a grace period, so the reply is delivered first.
//!
//! What is deliberately NOT here, and why:
//!
//!   * `uninstall` — `update` overwrites in place, so removing the install is
//!     never the way to fix something, and it is not recoverable by
//!     re-running.
//!   * `setup` — an interactive wizard has no meaning without the person.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::AppState;

/// Serve one `admin_request` from the sidecar.
pub async fn handle(app: AppHandle, action: &str, params: &Value) -> Result<Value, String> {
    match action {
        "update_check" => update_check(&app).await,
        "update_apply" => update_apply(&app).await,
        "model_list" => model_list(&app),
        "model_switch" => model_switch(&app, params).await,
        "gateway_restart" => gateway_exit(&app, feral_core::runtime::PlannedExit::Restart),
        "gateway_stop" => gateway_exit(&app, feral_core::runtime::PlannedExit::Shutdown),
        other => Err(format!("unknown admin action '{other}'")),
    }
}

// ── update ──────────────────────────────────────────────────────────────────

async fn update_check(app: &AppHandle) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(json!({
            "available": true,
            "version": update.version,
            "current": update.current_version,
            "notes": update.body,
        })),
        Ok(None) => Ok(json!({ "available": false, "current": app.package_info().version.to_string() })),
        Err(e) => Err(e.to_string()),
    }
}

async fn update_apply(app: &AppHandle) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(json!({ "applied": false, "reason": "already on the latest version" }));
    };

    let version = update.version.clone();
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // The relaunch is the host's call, not the agent's: the reply has to reach
    // the person BEFORE the process it came from goes away, or the update
    // looks like a crash. The sidecar reports success, and the restart happens
    // on the next launch (or when the user closes the window) rather than
    // yanking the app out from under a conversation.
    Ok(json!({
        "applied": true,
        "version": version,
        "restart_required": true,
    }))
}

// ── models ──────────────────────────────────────────────────────────────────

fn model_list(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();

    let local: Vec<Value> = feral_core::models::scan_models_dir()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| json!({ "source": "local", "id": m.id, "name": m.name, "size_bytes": m.size_bytes }))
        .collect();

    // Only providers with a key are listed. A provider the user has not set up
    // is not a choice the agent can make on their behalf — offering it would
    // produce a switch that 401s.
    let byok = feral_core::byok::load(&state.settings);
    let cloud: Vec<Value> = byok
        .providers
        .iter()
        .filter(|(_, cfg)| cfg.enabled)
        .map(|(id, cfg)| {
            json!({
                "source": "byok",
                "provider_id": id,
                "default_model": cfg.default_model,
                "base_url": cfg.base_url,
            })
        })
        .collect();

    Ok(json!({ "local": local, "cloud": cloud }))
}

async fn model_switch(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let source = params
        .get("source")
        .and_then(|v| v.as_str())
        .ok_or("source is required ('local', 'ollama' or 'byok')")?
        .to_string();
    let model = params
        .get("model")
        .and_then(|v| v.as_str())
        .ok_or("model is required")?
        .to_string();
    let provider_id = params
        .get("provider_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let base_url = params
        .get("base_url")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    crate::commands::models::feral_set_model(
        app.state::<AppState>(),
        source.clone(),
        provider_id.clone(),
        model.clone(),
        base_url,
    )
    .await?;

    Ok(json!({ "switched": true, "source": source, "model": model, "provider_id": provider_id }))
}

// ── gateway lifecycle ───────────────────────────────────────────────────────

/// How long to wait before pulling the process down.
///
/// The tool result still has to travel back to the sidecar, be handed to the
/// model, and become a sentence the person can read. Killing the process the
/// instant the handler returns would land the exit in the middle of that, and
/// the user would see the request vanish rather than be answered.
///
/// ponytail: a fixed grace, not a handshake. If a slow model ever loses its
/// reply to this, the fix is a turn-ended signal from the sidecar, not a
/// bigger number.
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_secs(6);

fn gateway_exit(
    app: &AppHandle,
    planned: feral_core::runtime::PlannedExit,
) -> Result<Value, String> {
    let app = app.clone();
    let restarting = matches!(planned, feral_core::runtime::PlannedExit::Restart);

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(EXIT_GRACE).await;
        let state = app.state::<AppState>();
        // Mark the exit as PLANNED first. Without this the supervisor counts
        // it as a crash, which feeds both the quick-failure backoff and the
        // watchdog that auto-reverts an RSI patch — an intentional restart
        // must not look like the code broke.
        *state.feral_agent_planned_exit.lock() = Some(planned);
        {
            let mut guard = state.feral_agent_process.lock();
            if let Some(ref mut child) = *guard {
                let _ = child.start_kill();
            }
        }
        // Invalidate the stdin channel so an in-flight send fails fast rather
        // than writing into a dead pipe.
        *state.feral_agent_tx.lock() = None;
    });

    Ok(json!({
        "scheduled": true,
        "restarting": restarting,
        "in_seconds": EXIT_GRACE.as_secs(),
    }))
}
