//! Engine-state persistence — Pathway 4 PR-B Task B.1.
//!
//! On-disk format for the running RSI engine. The state file
//! `<dataDir>/rsi/engine-state.json` lets the engine resume from the
//! same iteration + best score + candidate queue after an app restart
//! — without it, every boot starts at iteration 0 with an empty queue.
//!
//! # Atomic write
//!
//! `save` writes to `<file>.tmp` first, then renames over the
//! destination. Rename on the same filesystem is atomic on POSIX
//! (Windows: MoveFileEx with REPLACE_EXISTING), so a crash mid-write
//! either leaves the previous file intact or produces the new one —
//! never a torn file. This is the standard "write-then-rename"
//! pattern; libgit2 uses the same shape.
//!
//! # Corrupt-file recovery
//!
//! `load` returns `Ok(None)` only when the file is absent (first
//! boot). A file that exists but contains invalid JSON returns
//! `Err(...)` so the caller can decide whether to log + ignore or
//! surface the corruption. We do NOT silently treat a corrupt file as
//! "absent" because that would mask real disk corruption / accidental
//! overwrites — the caller must be told.
//!
//! # Test helpers
//!
//! `save_to` / `load_from` take an explicit path so tests don't depend
//! on the production path resolver (`engine_state_path()` reads
//! `FERAL_HOME` via `crate::paths::feral_dir`). Tests use
//! `tempfile::tempdir` + explicit paths for hermeticity; the
//! production helpers route through the real resolver.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// On-disk shape of the running engine's resumable state.
///
/// Serialised to JSON at `<dataDir>/rsi/engine-state.json`. Fields are
/// flat (no nested objects) so the file stays readable in a text
/// editor and trivially diff-able across runs. `last_updated_at` is a
/// `u64` Unix-millis timestamp so the resume path can detect stale
/// state (Task B.3 uses 7 days as the freshness threshold).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PersistedEngineState {
    /// Engine iteration count at the time of the last save.
    pub iteration: u32,
    /// Best score seen so far, if any. `None` until the first
    /// champion emerges.
    pub best_score: Option<f64>,
    /// Commit hash of the genome that produced `best_score`, if known.
    /// `None` when no champion yet or when the score came from a
    /// non-ratcheted source.
    pub best_commit: Option<String>,
    /// Candidate queue — genome IDs awaiting evaluation. Survives
    /// restart so an in-flight population isn't lost.
    pub candidate_queue: Vec<String>,
    /// Unix-millis timestamp of the last save. Used by the resume path
    /// to ignore state older than `maxPersistedAgeMs` (7 days default).
    pub last_updated_at: u64,
}

impl Default for PersistedEngineState {
    fn default() -> Self {
        Self {
            iteration: 0,
            best_score: None,
            best_commit: None,
            candidate_queue: Vec::new(),
            last_updated_at: 0,
        }
    }
}

/// Canonical on-disk location for the persisted state.
///
/// `<dataDir>/rsi/engine-state.json`. Honoured `FERAL_HOME` env var
/// for test hermeticity (see `crate::paths::feral_dir`).
pub fn engine_state_path() -> PathBuf {
    crate::paths::rsi_dir().join("engine-state.json")
}

/// Save `state` to `path` atomically: write `<path>.tmp`, fsync,
/// rename over `path`. Returns `Err` if any step fails — the caller
/// (Tauri command) decides whether to bubble the error to the UI or
/// log + swallow (B.3's resume path swallows; the sidecar's per-iter
/// save swallows). The write is best-effort by design.
pub fn save_to(state: &PersistedEngineState, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!("create parent dir for engine-state.json: {}", parent.display())
        })?;
    }
    let json = serde_json::to_string_pretty(state)
        .context("serialize PersistedEngineState to JSON")?;
    let tmp = tmp_path(path);
    {
        let mut f = fs::File::create(&tmp)
            .with_context(|| format!("create tmp file {}", tmp.display()))?;
        f.write_all(json.as_bytes())
            .with_context(|| format!("write engine-state.json tmp at {}", tmp.display()))?;
        f.sync_all()
            .with_context(|| format!("fsync engine-state.json tmp at {}", tmp.display()))?;
    }
    // Atomic rename. On Windows, std::fs::rename uses MoveFileEx with
    // MOVEFILE_REPLACE_EXISTING since Rust 1.5 — the destination is
    // atomically replaced. On POSIX, rename(2) within the same
    // filesystem is atomic by definition.
    fs::rename(&tmp, path).with_context(|| {
        format!(
            "rename {} -> {}",
            tmp.display(),
            path.display()
        )
    })?;
    Ok(())
}

/// Load state from `path`.
///
/// Returns:
/// - `Ok(Some(state))` on a valid file.
/// - `Ok(None)` when the file is absent (first boot / fresh state).
/// - `Err(...)` when the file exists but is not valid JSON — the
///   caller MUST be told, not silently treated as absent.
pub fn load_from(path: &Path) -> Result<Option<PersistedEngineState>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .with_context(|| format!("read engine-state.json at {}", path.display()))?;
    let state: PersistedEngineState = serde_json::from_str(&raw)
        .with_context(|| format!("parse engine-state.json at {}", path.display()))?;
    Ok(Some(state))
}

/// Production helper — save to the canonical location.
pub fn save(state: &PersistedEngineState) -> Result<()> {
    save_to(state, &engine_state_path())
}

/// Production helper — load from the canonical location.
pub fn load() -> Result<Option<PersistedEngineState>> {
    load_from(&engine_state_path())
}

/// Helper used by `save_to` to compute the sibling tmp path. Public
/// for test inspection (the "no .tmp left behind" assertion reads it).
fn tmp_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".tmp");
    PathBuf::from(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_state() -> PersistedEngineState {
        PersistedEngineState {
            iteration: 42,
            best_score: Some(78.5),
            best_commit: Some("abc123def".into()),
            candidate_queue: vec!["g1".into(), "g2".into()],
            last_updated_at: 1_700_000_000,
        }
    }

    #[test]
    fn save_then_load_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("engine-state.json");
        let original = sample_state();
        save_to(&original, &path).unwrap();
        let loaded = load_from(&path).unwrap().expect("file present");
        assert_eq!(loaded, original);
    }

    #[test]
    fn load_returns_none_when_file_absent() {
        let dir = tempdir().unwrap();
        let loaded = load_from(&dir.path().join("does-not-exist.json"))
            .expect("absent file must not error");
        assert!(loaded.is_none());
    }

    #[test]
    fn load_returns_err_on_corrupt_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("engine-state.json");
        fs::write(&path, b"{ not json").unwrap();
        // Must ERR — silently returning None would mask real
        // corruption / accidental overwrite of the state file.
        let result = load_from(&path);
        assert!(
            result.is_err(),
            "corrupt engine-state.json must surface as Err, got Ok({:?})",
            result.ok()
        );
    }

    #[test]
    fn save_is_atomic_writes_via_tmp_then_rename() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("engine-state.json");
        save_to(&sample_state(), &path).unwrap();
        // After save: .tmp must be gone, .json must be present.
        assert!(
            path.exists(),
            "destination file must exist after save: {}",
            path.display()
        );
        assert!(
            !tmp_path(&path).exists(),
            "tmp file must be cleaned up after rename: {}",
            tmp_path(&path).display()
        );
    }

    #[test]
    fn save_creates_parent_dir_if_missing() {
        // The first save on a fresh install may not have
        // `<dataDir>/rsi/` yet — `rsi_init` creates it, but we don't
        // want to depend on init ordering. `save` must mkdir -p.
        let dir = tempdir().unwrap();
        let nested = dir.path().join("rsi/engine-state.json");
        assert!(!nested.parent().unwrap().exists());
        save_to(&sample_state(), &nested).unwrap();
        assert!(nested.exists(), "save must create parent dir on demand");
    }

    #[test]
    fn default_state_is_iteration_zero_no_champion() {
        let s = PersistedEngineState::default();
        assert_eq!(s.iteration, 0);
        assert_eq!(s.best_score, None);
        assert_eq!(s.best_commit, None);
        assert!(s.candidate_queue.is_empty());
        assert_eq!(s.last_updated_at, 0);
    }
}