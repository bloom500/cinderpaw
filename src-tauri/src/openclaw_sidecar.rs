//! Bundled OpenClaw sidecar: binary discovery and process lifecycle.
//!
//! Discovery order:
//!   1. PATH  — user's existing OpenClaw installation takes priority.
//!   2. Tauri resource dir — bundled binary shipped with the installer.
//!
//! The process is started once on app launch and killed on app exit.
//! Start failure is non-fatal: agents fall back to local llama.cpp.

use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

/// Platform-specific binary filename.
pub fn sidecar_binary_name() -> &'static str {
    if cfg!(windows) { "openclaw.exe" } else { "openclaw" }
}

/// Generate a random UUID token for the sidecar gateway.
pub fn generate_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Check PATH for an `openclaw` binary synchronously.
/// Returns the full path if found.
pub fn probe_path(name: &str) -> Option<PathBuf> {
    let (program, arg) = if cfg!(windows) {
        ("where", name)
    } else {
        ("which", name)
    };
    let output = std::process::Command::new(program)
        .arg(arg)
        .output()
        .ok()?;
    if output.status.success() {
        let line = String::from_utf8_lossy(&output.stdout);
        let first = line.lines().next()?.trim();
        if first.is_empty() { None } else { Some(PathBuf::from(first)) }
    } else {
        None
    }
}

/// Resolve the bundled binary from the Tauri resource directory.
/// Returns `None` during `cargo tauri dev` (resource dir won't have it).
pub fn bundled_binary_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let binary = resource_dir.join(sidecar_binary_name());
    if binary.exists() { Some(binary) } else { None }
}

/// Find the OpenClaw binary. PATH has priority over bundled.
pub fn find_binary(app: &AppHandle) -> Option<PathBuf> {
    probe_path("openclaw").or_else(|| bundled_binary_path(app))
}

/// Start the OpenClaw gateway sidecar. Returns the child process on success.
///
/// Passes `OPENCLAW_GATEWAY_TOKEN` so all callers that read from
/// `openclaw_connection::load()` authenticate correctly.
pub fn start_sidecar(
    binary: &Path,
    token: &str,
) -> Result<tokio::process::Child, String> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(["gateway", "run"])
        .env("OPENCLAW_GATEWAY_TOKEN", token)
        .kill_on_drop(true);

    // Suppress console window on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(|e| format!("Failed to start OpenClaw sidecar: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openclaw_binary_name_windows() {
        let name = sidecar_binary_name();
        #[cfg(windows)]
        assert_eq!(name, "openclaw.exe");
        #[cfg(not(windows))]
        assert_eq!(name, "openclaw");
    }

    #[test]
    fn probe_path_returns_none_for_fake_binary() {
        assert!(probe_path("openclaw-feral-test-nonexistent").is_none());
    }

    #[test]
    fn generate_token_is_nonempty_and_unique() {
        let t1 = generate_token();
        let t2 = generate_token();
        assert!(!t1.is_empty());
        assert_ne!(t1, t2);
    }
}
