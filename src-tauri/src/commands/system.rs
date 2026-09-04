//! System info snapshot, the local API bearer token, and the onboarding
//! record persisted under `~/.cinderpaw/`.

use crate::*;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_system_info(state: State<'_, AppState>) -> Result<SystemInfo, String> {
    // Return cached value immediately if background thread has finished
    if let Some(info) = state.system_info_cache.lock().clone() {
        return Ok(info);
    }
    // Cache not ready yet — compute now, store for future calls
    let cache = state.system_info_cache.clone();
    tokio::task::spawn_blocking(move || {
        let info = sysinfo_mod::collect();
        *cache.lock() = Some(info.clone());
        info
    })
    .await
    .map_err(|e| e.to_string())
}

/// Returns the per-launch bearer token external apps must send as
/// `Authorization: Bearer <token>` to use the local HTTP API (V4). The in-app
/// agent path receives it automatically; this command exists so the user can
/// copy it for their own integrations. The token rotates every launch.
#[tauri::command]
#[specta::specta]
pub(crate) fn get_local_api_token(state: State<'_, AppState>) -> String {
    state.local_api_token.to_string()
}

// ---------- Onboarding record (persisted in ~/.cinderpaw/) ----------

/// Path of the onboarding JSON written/read by `get_onboarding_record` /
/// `set_onboarding_record`. The file lives in the user's home dir, NOT in
/// the Tauri app data dir, so it survives:
///   - WebView reload (Ctrl+R)
///   - Tauri auto-updates
///   - Uninstall + reinstall (the app data dir is wiped, but `~/.cinderpaw/`
///     lives outside the app and persists as long as the user account does)
///
/// We use plain `std::fs` rather than the `tauri-plugin-fs` plugin because:
///   1. The plugin's scope-based permissions make `~/` awkward to access
///   2. We only need 2 ops (read whole file, write whole file) — a plugin
///      is overkill
fn onboarding_path() -> Option<std::path::PathBuf> {
    // USERPROFILE on Windows, HOME elsewhere. Fall back to dirs::cache_dir
    // only as a last resort — home is what we want.
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok());
    // The home folder moved with the rename. Left hard-coded, this read the
    // onboarding record from the OLD folder while everything else wrote to the
    // new one — so a person who had finished onboarding was asked to do it
    // again, on a machine where the answer was sitting one directory over.
    home.map(|h| {
        std::path::PathBuf::from(h)
            .join(cinderpaw_core::brand::APP_HOME_DIR_NAME)
            .join("onboarding.json")
    })
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OnboardingRecord {
    completed: bool,
    completed_at: u64,
    user_name: String,
    agent_name: String,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_onboarding_record() -> Option<OnboardingRecord> {
    let path = onboarding_path()?;
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_onboarding_record(record: OnboardingRecord) -> Result<(), String> {
    let path = onboarding_path().ok_or_else(|| {
        "could not resolve home directory (USERPROFILE / HOME unset)".to_string()
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
    }
    let pretty = serde_json::to_string_pretty(&record)
        .map_err(|e| format!("serialize failed: {}", e))?;
    cinderpaw_core::atomic_file::write_atomic(&path, pretty.as_bytes())
        .map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}
