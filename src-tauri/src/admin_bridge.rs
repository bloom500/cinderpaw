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
//! What is deliberately NOT here, and why:
//!
//!   * `uninstall` — destroying the installation on an agent's judgement is
//!     not a recoverable mistake, and no phrasing of a user's request should
//!     be able to reach it.
//!   * `gateway stop` / `restart` — the request being served is running inside
//!     the thing that would be stopped. It would kill its own answer mid
//!     sentence and report nothing, which is indistinguishable from a hang.
//!     Restarting is the host's job, after an update, not an errand.
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
