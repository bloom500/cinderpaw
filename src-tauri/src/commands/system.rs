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

// ---------- Bug report (Settings > About) ----------

/// Where reports go. The URL is public by design; the Discord webhook it
/// forwards to lives in the worker's secrets. See `workers/bug-report/`.
const BUG_REPORT_URL: &str = "https://cinderpaw-bug-report.bloommediacorporation.workers.dev/";

/// How much of the log travels with a report. Enough to see the last turn
/// fail, small enough that the person can read what leaves their machine.
const LOG_TAIL_LINES: usize = 200;

/// Last `n` lines of the file, or an empty string when it does not exist.
/// A missing log is not an error: a fresh install that crashed before the
/// first line was written still has a description worth sending.
fn tail_lines(path: &std::path::Path, n: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

fn log_path() -> std::path::PathBuf {
    cinderpaw_core::paths::cinderpaw_dir().join("logs").join("cinderpaw.log")
}

/// The log lines a report would carry, so the UI can show them before
/// anything is sent. Paths in here contain the user's name; they decide.
#[tauri::command]
#[specta::specta]
pub(crate) fn bug_report_log_preview() -> String {
    tail_lines(&log_path(), LOG_TAIL_LINES)
}

/// Sends a report. Errors are short codes the UI turns into sentences:
/// `rate_limited` (too many from this address) or `network` (anything else).
#[tauri::command]
#[specta::specta]
pub(crate) async fn submit_bug_report(description: String, include_log: bool) -> Result<(), String> {
    let log = if include_log { tail_lines(&log_path(), LOG_TAIL_LINES) } else { String::new() };
    let body = serde_json::json!({
        "description": description,
        "version": env!("CARGO_PKG_VERSION"),
        "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "log": log,
    });
    let resp = reqwest::Client::new()
        .post(BUG_REPORT_URL)
        .timeout(std::time::Duration::from_secs(15))
        .json(&body)
        .send()
        .await
        .map_err(|_| "network".to_string())?;
    match resp.status().as_u16() {
        204 => Ok(()),
        429 => Err("rate_limited".into()),
        _ => Err("network".into()),
    }
}

#[cfg(test)]
mod bug_report_tests {
    use super::tail_lines;

    #[test]
    fn tail_lines_handles_missing_short_and_long_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("cinderpaw.log");

        assert_eq!(tail_lines(&p, 3), "", "missing file is empty, not an error");

        std::fs::write(&p, "a\nb\n").unwrap();
        assert_eq!(tail_lines(&p, 3), "a\nb", "shorter than n returns everything");

        std::fs::write(&p, "1\n2\n3\n4\n5\n").unwrap();
        assert_eq!(tail_lines(&p, 3), "3\n4\n5", "longer than n keeps the last n");
    }
}
