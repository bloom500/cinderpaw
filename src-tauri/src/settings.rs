use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Settings {
    pub models_dir: PathBuf,
    pub default_gpu_layers: i32,
    pub api_server_enabled: bool,
    pub api_port: u16,
    pub version: String,
    /// Opt-in for OS-level desktop control (the `control_app` tool). Gated
    /// exactly like `shell_exec`: OFF by default. When true, the host process
    /// exports `FERAL_ENABLE_DESKTOP_CONTROL=true` before spawning the sidecar,
    /// which both registers the tool in the sidecar AND opens the Rust command
    /// gate (the two must agree). `#[serde(default)]` keeps older settings.json
    /// files (written before this field existed) loading cleanly.
    #[serde(default)]
    pub desktop_control_enabled: bool,
    /// "YOLO mode" for desktop control: when true, state-changing actions
    /// (click/type/send_keys/perform_action) run WITHOUT the per-action
    /// confirmation prompt. False (default) = Safe mode = confirm each action.
    /// Maps to `FERAL_DESKTOP_CONTROL_CONFIRM=false` in the sidecar env.
    /// `launch` still always confirms (process creation) regardless.
    #[serde(default)]
    pub desktop_control_yolo: bool,
    /// Per-conversation token budget passed to the sidecar as
    /// `FERAL_BUDGET_CONVERSATION`. `None` = unlimited (Infinity); `Some(n)`
    /// caps the conversation at n tokens and surfaces a `budget_exceeded` event
    /// when reached. Default: None (unlimited — the user is responsible for
    /// their own inference costs on a local/BYOK setup).
    #[serde(default)]
    pub token_budget_conversation: Option<u64>,
    /// USD spend cap for the passive RSI background engine, exported to the
    /// sidecar as `FERAL_RSI_MAX_COST_USD`. `Some(0.0)` (default) = local-only:
    /// the free loopback engine runs forever, any paid cloud spend halts. A
    /// positive value allows bounded cloud spend. `None` = no cap (advanced).
    #[serde(default = "default_rsi_budget")]
    pub rsi_max_cost_usd: Option<f64>,
    /// Path of the last successfully loaded local model. Written on every
    /// successful load; cleared on unload. Used by the startup task to
    /// auto-reload the model so the user doesn't have to pick it again.
    #[serde(default)]
    pub last_loaded_model: Option<String>,
}

fn default_rsi_budget() -> Option<f64> { Some(0.0) }

impl Default for Settings {
    fn default() -> Self {
        Self {
            models_dir: paths::models_dir(),
            default_gpu_layers: -1,
            api_server_enabled: false,
            api_port: 11435,
            version: env!("CARGO_PKG_VERSION").to_string(),
            desktop_control_enabled: false,
            desktop_control_yolo: false,
            token_budget_conversation: None,
            rsi_max_cost_usd: Some(0.0),
            last_loaded_model: None,
        }
    }
}

pub fn load() -> Settings {
    let path = paths::settings_path();
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(s) = serde_json::from_slice::<Settings>(&bytes) {
            return s;
        }
    }
    Settings::default()
}

pub fn save(s: &Settings) -> anyhow::Result<()> {
    paths::ensure_dirs()?;
    let path = paths::settings_path();
    std::fs::write(path, serde_json::to_vec_pretty(s)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_rsi_budget_is_local_only_zero() {
        let s = Settings::default();
        assert_eq!(s.rsi_max_cost_usd, Some(0.0));
    }
}
