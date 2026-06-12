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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            models_dir: paths::models_dir(),
            default_gpu_layers: -1,
            api_server_enabled: false,
            api_port: 11435,
            version: env!("CARGO_PKG_VERSION").to_string(),
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
