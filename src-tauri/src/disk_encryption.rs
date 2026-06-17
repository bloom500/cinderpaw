//! Full-disk encryption detection (H-1).
//!
//! Episodic/conversation text is FTS-indexed and can't be column-encrypted
//! without breaking recall, so its at-rest protection relies on the OS:
//! BitLocker (Windows), FileVault (macOS), or LUKS/dm-crypt (Linux). This
//! module reports the host's status so onboarding can warn an EU pro (lawyer,
//! doctor) handling client data if their disk is unencrypted. Detection is
//! best-effort and never elevates — when it can't determine the state it says
//! so ("unknown") rather than guessing.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DiskEncryptionStatus {
    /// "on" | "off" | "unknown".
    pub state: String,
    /// Human-readable detail for the onboarding UI.
    pub detail: String,
}

impl DiskEncryptionStatus {
    fn new(state: &str, detail: impl Into<String>) -> Self {
        Self { state: state.into(), detail: detail.into() }
    }
}

#[tauri::command]
#[specta::specta]
pub fn disk_encryption_status() -> DiskEncryptionStatus {
    detect()
}

#[cfg(windows)]
fn detect() -> DiskEncryptionStatus {
    use std::os::windows::process::CommandExt;
    let drive = std::env::var("SYSTEMDRIVE").unwrap_or_else(|_| "C:".into());
    let out = std::process::Command::new("manage-bde")
        .args(["-status", &drive])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).to_lowercase();
            if s.contains("protection on") {
                DiskEncryptionStatus::new("on", format!("BitLocker protection is on for {drive}"))
            } else if s.contains("protection off") || s.contains("fully decrypted") {
                DiskEncryptionStatus::new(
                    "off",
                    format!("BitLocker is off for {drive} — enable it to protect data at rest"),
                )
            } else {
                DiskEncryptionStatus::new(
                    "unknown",
                    "Could not determine BitLocker status (it may require administrator rights)",
                )
            }
        }
        Err(e) => DiskEncryptionStatus::new("unknown", format!("manage-bde unavailable: {e}")),
    }
}

#[cfg(target_os = "macos")]
fn detect() -> DiskEncryptionStatus {
    let out = std::process::Command::new("fdesetup").arg("status").output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).to_lowercase();
            if s.contains("filevault is on") {
                DiskEncryptionStatus::new("on", "FileVault is on")
            } else if s.contains("filevault is off") {
                DiskEncryptionStatus::new(
                    "off",
                    "FileVault is off — enable it to protect data at rest",
                )
            } else {
                DiskEncryptionStatus::new("unknown", "Could not determine FileVault status")
            }
        }
        Err(e) => DiskEncryptionStatus::new("unknown", format!("fdesetup unavailable: {e}")),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn detect() -> DiskEncryptionStatus {
    // Heuristic: a `crypt`-type device anywhere in the tree means LUKS/dm-crypt
    // is in use. We can't cheaply prove the root fs sits on it without elevation,
    // so a positive is reported as "on" and the absence as "unknown".
    let out = std::process::Command::new("lsblk").args(["-o", "TYPE"]).output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).to_lowercase();
            if s.lines().any(|line| line.trim() == "crypt") {
                DiskEncryptionStatus::new("on", "A LUKS/dm-crypt volume was detected")
            } else {
                DiskEncryptionStatus::new(
                    "unknown",
                    "No dm-crypt volume detected; verify full-disk encryption manually",
                )
            }
        }
        Err(e) => DiskEncryptionStatus::new("unknown", format!("lsblk unavailable: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_a_valid_state() {
        let s = disk_encryption_status();
        assert!(
            matches!(s.state.as_str(), "on" | "off" | "unknown"),
            "unexpected state: {} ({})",
            s.state,
            s.detail
        );
        assert!(!s.detail.is_empty());
    }
}
