//! Faza 3 — Slice 3: pure-decision watchdog for the
//! "patch kills the sidecar, revert it" loop.
//!
//! The flow (spec: `docs/superpowers/specs/2026-07-02-faza3-stabilizare-design.md` §Slice 3):
//!
//! 1. The host's stdout reader (`feral_agent.rs`), on a
//!    `code_patch_resolved` line with `status: "applied"`, writes a
//!    [`PatchMarker`] to `~/.feral/rsi/last_applied_patch.json`
//!    ([`default_marker_path`]).
//! 2. The Rust supervisor (`#11`) accumulates the timestamps of every
//!    UNPLANNED sidecar exit. On each new exit it calls
//!    [`should_revert`] with the current marker + the exit list.
//! 3. If [`should_revert`] returns `true`, the supervisor performs
//!    `git apply -R` itself, rebuilds the sidecar, restarts it, marks
//!    the patch `reverted` in the store, and emits the toast. THEN it
//!    calls [`clear_marker`].
//! 4. If the post-apply window passes without incident, the supervisor
//!    calls [`clear_marker`] to keep the file from accumulating.
//!
//! **This module is the pure core.** It owns no supervisor state, no
//! timers, no sidecar handles. The decision function is a pure mapping
//! over the marker + the accumulated exit timestamps, so it is
//! exhaustively unit-testable without spinning anything up. Persistence
//! helpers (`load` / `save` / `clear`) live here too because they are
//! mechanically tied to the marker shape, but they only touch the
//! filesystem at the path they're handed — they don't know where that
//! path came from.
//!
//! ## Discipline: "corrupt → start empty, never panic"
//!
//! `load_marker` returns `None` for missing file, malformed JSON, or
//! schema mismatch. The marker is a small diagnostic file, not a source
//! of truth — losing it just means "no recent patch", which is the
//! correct behaviour for the supervisor. Crashing on a bad read would
//! be strictly worse.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Default observation window after `applyPatchLive` (10 minutes).
pub const DEFAULT_WINDOW_MS: u64 = 600_000;

/// Default crash threshold: two sidecar deaths inside the window
/// trigger the revert.
pub const DEFAULT_CRASH_THRESHOLD: usize = 2;

/// Marker written when a patch goes live (the host writes it on the
/// `code_patch_resolved`/`applied` stdout line). Every function here
/// takes the path as an argument so it can be unit-tested against a
/// `tempfile::TempDir`; the canonical location is [`default_marker_path`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchMarker {
    /// Stable identifier of the patch that was applied (commit hash
    /// or L3 patch id — the sidecar picks the shape, this module just
    /// carries it through).
    pub patch_id: String,
    /// Unix-ms timestamp at the moment the patch was applied. The
    /// watchdog window is measured from this moment, inclusive.
    pub applied_at_ms: u64,
}

/// Knobs for the watchdog. Defaults match the spec; tests inject
/// custom values to exercise edge cases without sleeping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchdogOpts {
    /// Observation window starting at `applied_at_ms`. Exit timestamps
    /// inside `[applied_at_ms, applied_at_ms + window_ms]` count toward
    /// the threshold. Default: 10 minutes.
    pub window_ms: u64,
    /// How many sidecar exits inside the window trigger a revert.
    /// Default: 2 (one crash alone is "could be anything"; two in ten
    /// minutes is the patch's fault with overwhelming probability).
    pub crash_threshold: usize,
}

impl Default for WatchdogOpts {
    fn default() -> Self {
        Self {
            window_ms: DEFAULT_WINDOW_MS,
            crash_threshold: DEFAULT_CRASH_THRESHOLD,
        }
    }
}

/// Read the marker from disk. Returns `None` for every error mode
/// (missing file, malformed JSON, schema mismatch) — by design, the
/// watchdog must never panic the supervisor because of a bad marker
/// file. The "start empty" semantics are documented at the module
/// level.
pub fn load_marker(path: &Path) -> Option<PatchMarker> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return None,
    };
    serde_json::from_slice::<PatchMarker>(&bytes).ok()
}

/// Write the marker atomically. The contract is "temp + rename" so a
/// reader either sees the old marker or the new one — never a half
/// written file or a missing file.
///
/// The temp suffix includes PID + a monotonic counter so two writers
/// (e.g. supervisor + a parallel test) don't collide on the same
/// temp file. On Windows, `std::fs::rename` uses `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING`, so it overwrites the destination
/// atomically.
pub fn save_marker(path: &Path, m: &PatchMarker) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create_dir_all {}", parent.display()))?;
        }
    }
    let bytes = serde_json::to_vec(m).context("serialise PatchMarker")?;

    let pid = std::process::id();
    let n = SAVE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("marker");
    let tmp = path.with_file_name(format!("{file_name}.tmp.{pid}.{n}"));

    std::fs::write(&tmp, &bytes)
        .with_context(|| format!("write tmp marker {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| {
        format!("rename tmp marker {} -> {}", tmp.display(), path.display())
    })?;
    Ok(())
}

/// Delete the marker file. Missing-file is not an error (idempotent):
/// if the marker has already been cleared, the operation is a no-op.
/// Any other IO error is swallowed for the same "never panic the
/// supervisor" reason — a stale marker is a benign state.
pub fn clear_marker(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            // Intentionally silent: see module docstring.
        }
    }
}

/// Pure decision: should the supervisor revert the marker'd patch
/// right now?
///
/// Returns `true` iff at least `opts.crash_threshold` exit timestamps
/// fall inside the inclusive window `[marker.applied_at_ms,
/// marker.applied_at_ms + opts.window_ms]`. Exits outside the window
/// do not count; exits before `applied_at_ms` do not count; the
/// `now_ms` argument exists for symmetry / future "no future exits
/// should count" semantics and is currently unused (the supervisor
/// filters timestamps itself before calling).
pub fn should_revert(
    marker: &PatchMarker,
    exit_timestamps_ms: &[u64],
    _now_ms: u64,
    opts: &WatchdogOpts,
) -> bool {
    let window_end = marker.applied_at_ms.saturating_add(opts.window_ms);
    let in_window = exit_timestamps_ms
        .iter()
        .filter(|&&t| t >= marker.applied_at_ms && t <= window_end)
        .count();
    in_window >= opts.crash_threshold
}

/// Has the marker's observation window elapsed? Once true the marker
/// is no longer load-bearing — the supervisor may call `clear_marker`
/// to keep the file tidy. "Expired" is strictly `>` (not `>=`) at the
/// end of the window: at exactly `applied_at_ms + window_ms` the
/// patch is still considered live (a death at that exact instant is
/// counted by `should_revert`).
pub fn marker_expired(marker: &PatchMarker, now_ms: u64, opts: &WatchdogOpts) -> bool {
    let window_end = marker.applied_at_ms.saturating_add(opts.window_ms);
    now_ms > window_end
}

static SAVE_COUNTER: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Host-side helpers (impure). The pure core above never touches canonical
// paths or the TS pending-patch store; the supervisor's revert flow does,
// and these are its only two views into TS-owned state. Rust may write
// `pending-patches.json` ONLY because the sidecar is dead when the revert
// runs — that's the whole premise of the watchdog.

/// Canonical marker path: `~/.feral/rsi/last_applied_patch.json`.
pub fn default_marker_path() -> PathBuf {
    crate::paths::rsi_dir().join("last_applied_patch.json")
}

/// The TS `PendingPatchStore` file: `~/.feral/rsi/pending-patches.json`
/// (TS side: `defaultPendingPatchesPath()` in `pending-patches.ts`).
pub fn default_pending_store_path() -> PathBuf {
    crate::paths::rsi_dir().join("pending-patches.json")
}

/// Read the unified-diff text of an APPLIED patch out of the sidecar's
/// pending-patch store. `None` for a missing/corrupt store, an unknown
/// id, or a patch that isn't in `applied` status — same "corrupt →
/// start empty" discipline as `load_marker`.
pub fn applied_patch_text(store_path: &Path, patch_id: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(store_path).ok()?).ok()?;
    let p = v
        .get("patches")?
        .as_array()?
        .iter()
        .find(|p| p.get("id").and_then(|i| i.as_str()) == Some(patch_id))?;
    if p.get("status")?.as_str()? != "applied" {
        return None;
    }
    Some(p.get("genome")?.get("patch")?.as_str()?.to_string())
}

/// Flip an `applied` patch to `reverted` in the store (mirror of the TS
/// `markReverted`, including its applied-only precondition). Edits the
/// JSON as a `Value` so an evolving TS schema doesn't break us.
pub fn mark_patch_reverted(store_path: &Path, patch_id: &str) -> Result<()> {
    let bytes = std::fs::read(store_path)
        .with_context(|| format!("read pending store {}", store_path.display()))?;
    let mut v: serde_json::Value =
        serde_json::from_slice(&bytes).context("parse pending store")?;
    let p = v
        .get_mut("patches")
        .and_then(|a| a.as_array_mut())
        .and_then(|arr| {
            arr.iter_mut()
                .find(|p| p.get("id").and_then(|i| i.as_str()) == Some(patch_id))
        })
        .with_context(|| format!("patch '{patch_id}' not found in pending store"))?;
    let status = p.get("status").and_then(|s| s.as_str()).unwrap_or("");
    if status != "applied" {
        anyhow::bail!("patch '{patch_id}' is {status}, not applied — nothing to revert");
    }
    p["status"] = serde_json::Value::from("reverted");
    std::fs::write(store_path, serde_json::to_vec_pretty(&v)?)
        .with_context(|| format!("write pending store {}", store_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Marker pinned to a known instant so tests can reason about the
    /// window without re-deriving timestamps.
    fn marker_at(ms: u64) -> PatchMarker {
        PatchMarker {
            patch_id: "patch-abc".to_string(),
            applied_at_ms: ms,
        }
    }

    fn opts(window_ms: u64, crash_threshold: usize) -> WatchdogOpts {
        WatchdogOpts {
            window_ms,
            crash_threshold,
        }
    }

    // -- should_revert ----------------------------------------------------

    #[test]
    fn should_revert_two_exits_in_window() {
        let m = marker_at(1_000);
        let o = opts(600_000, 2);
        // Two exits, both well inside [1000, 601000].
        let exits = [10_000, 20_000];
        assert!(should_revert(&m, &exits, 30_000, &o));
    }

    #[test]
    fn should_revert_only_one_exit_in_window() {
        let m = marker_at(1_000);
        let o = opts(600_000, 2);
        // One exit inside, one outside — under threshold.
        let exits = [10_000, 700_000];
        assert!(!should_revert(&m, &exits, 30_000, &o));
    }

    #[test]
    fn should_revert_two_exits_but_one_before_apply() {
        let m = marker_at(1_000);
        let o = opts(600_000, 2);
        // 500 < applied_at_ms: pre-apply crash, doesn't count.
        // 1100 is in window: only one in-window crash.
        let exits = [500, 1_100];
        assert!(!should_revert(&m, &exits, 2_000, &o));
    }

    #[test]
    fn should_revert_exits_after_window_dont_count() {
        let m = marker_at(1_000);
        let o = opts(600_000, 2);
        // window_end = 601_000. 700_000 is past the window.
        // 1100 is in window: only one in-window crash.
        let exits = [1_100, 700_000];
        assert!(!should_revert(&m, &exits, 800_000, &o));
    }

    #[test]
    fn should_revert_boundary_inclusive() {
        let m = marker_at(1_000);
        let o = opts(600_000, 2);
        // Both endpoints inclusive: exits at exactly applied_at and
        // exactly applied_at + window should both count.
        let exits = [1_000, 601_000];
        assert!(should_revert(&m, &exits, 601_000, &o));
    }

    #[test]
    fn should_revert_empty_exit_list() {
        let m = marker_at(1_000);
        let o = opts(600_000, 2);
        assert!(!should_revert(&m, &[], 2_000, &o));
    }

    #[test]
    fn should_revert_threshold_three_needs_three() {
        let m = marker_at(1_000);
        let o = opts(600_000, 3);
        let exits = [10_000, 20_000, 30_000];
        assert!(should_revert(&m, &exits, 40_000, &o));
        let exits = [10_000, 20_000];
        assert!(!should_revert(&m, &exits, 40_000, &o));
    }

    // -- marker_expired ---------------------------------------------------

    #[test]
    fn marker_expired_only_strictly_after_window() {
        let m = marker_at(1_000);
        let o = opts(600_000, 2);
        // Before: not expired.
        assert!(!marker_expired(&m, 100_000, &o));
        // At applied_at: not expired.
        assert!(!marker_expired(&m, 1_000, &o));
        // At window_end exactly: NOT expired (boundary is strict on >).
        assert!(!marker_expired(&m, 601_000, &o));
        // One ms past: expired.
        assert!(marker_expired(&m, 601_001, &o));
    }

    #[test]
    fn marker_expired_saturating_window_does_not_underflow() {
        // applied_at_ms = u64::MAX-10, window 100: window_end must
        // saturate, not wrap. now = u64::MAX is "after window_end"
        // only if the saturating_add worked — which it does.
        let m = marker_at(u64::MAX - 10);
        let o = opts(100, 2);
        // now == applied_at: not expired.
        assert!(!marker_expired(&m, u64::MAX - 10, &o));
        // now = u64::MAX, window_end saturated at u64::MAX: now ==
        // window_end, still not strictly past.
        assert!(!marker_expired(&m, u64::MAX, &o));
    }

    // -- load_marker / save_marker / clear_marker -------------------------

    #[test]
    fn save_then_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("last_applied_patch.json");
        let m = marker_at(42_000);
        save_marker(&p, &m).unwrap();
        let loaded = load_marker(&p).expect("marker should be present");
        assert_eq!(loaded, m);
    }

    #[test]
    fn load_missing_file_returns_none() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("nope.json");
        assert!(load_marker(&p).is_none());
    }

    #[test]
    fn load_corrupt_json_returns_none_without_panic() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("corrupt.json");
        std::fs::write(&p, b"{ this is not valid json").unwrap();
        assert!(load_marker(&p).is_none());
    }

    #[test]
    fn load_empty_file_returns_none_without_panic() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("empty.json");
        std::fs::write(&p, b"").unwrap();
        assert!(load_marker(&p).is_none());
    }

    #[test]
    fn load_wrong_schema_returns_none() {
        // Serde refuses to deserialise unknown / wrong-type fields by
        // default; we surface that as None per the "corrupt → start
        // empty" discipline.
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("wrong.json");
        // Missing applied_at_ms → schema mismatch.
        std::fs::write(&p, br#"{"patch_id":"x"}"#).unwrap();
        assert!(load_marker(&p).is_none());
        // Wrong type for applied_at_ms → schema mismatch.
        std::fs::write(&p, br#"{"patch_id":"x","applied_at_ms":"not a number"}"#).unwrap();
        assert!(load_marker(&p).is_none());
    }

    #[test]
    fn save_overwrites_existing_marker() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("last_applied_patch.json");
        save_marker(&p, &marker_at(1_000)).unwrap();
        save_marker(&p, &marker_at(2_000)).unwrap();
        let loaded = load_marker(&p).unwrap();
        assert_eq!(loaded.applied_at_ms, 2_000);
    }

    #[test]
    fn save_creates_parent_directory() {
        // Common shape: ~/.feral/rsi/last_applied_patch.json. The
        // first call must not fail just because ~/.feral/rsi/ doesn't
        // exist yet on a fresh box.
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("nested/dir/last_applied_patch.json");
        save_marker(&p, &marker_at(1_000)).unwrap();
        assert_eq!(load_marker(&p), Some(marker_at(1_000)));
    }

    #[test]
    fn save_leaves_no_tmp_files_on_disk() {
        // The atomic rename must clean up after itself: no stale
        // .tmp.* files left in the directory.
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("last_applied_patch.json");
        save_marker(&p, &marker_at(1_000)).unwrap();
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries.len(), 1, "only the final file should remain: {entries:?}");
        assert_eq!(entries[0], "last_applied_patch.json");
    }

    #[test]
    fn clear_marker_removes_file() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("last_applied_patch.json");
        save_marker(&p, &marker_at(1_000)).unwrap();
        assert!(load_marker(&p).is_some());
        clear_marker(&p);
        assert!(load_marker(&p).is_none());
    }

    #[test]
    fn clear_marker_is_idempotent_on_missing_file() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("never_existed.json");
        // Must not panic.
        clear_marker(&p);
        clear_marker(&p);
    }

    // -- applied_patch_text / mark_patch_reverted --------------------------

    /// A minimal TS-store envelope with one patch in the given status.
    fn store_json(status: &str) -> String {
        format!(
            r#"{{"version":1,"patches":[{{"id":"g1","status":"{status}","score":90,"commitHash":"abc","createdAt":1,"genome":{{"patch":"diff text"}}}}]}}"#
        )
    }

    #[test]
    fn applied_patch_text_reads_applied_patch() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("pending-patches.json");
        std::fs::write(&p, store_json("applied")).unwrap();
        assert_eq!(applied_patch_text(&p, "g1").as_deref(), Some("diff text"));
        assert!(applied_patch_text(&p, "nope").is_none());
    }

    #[test]
    fn applied_patch_text_refuses_non_applied_and_corrupt() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("pending-patches.json");
        std::fs::write(&p, store_json("pending")).unwrap();
        assert!(applied_patch_text(&p, "g1").is_none());
        std::fs::write(&p, b"{ not json").unwrap();
        assert!(applied_patch_text(&p, "g1").is_none());
        assert!(applied_patch_text(&dir.path().join("missing.json"), "g1").is_none());
    }

    #[test]
    fn mark_patch_reverted_flips_applied_only() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("pending-patches.json");
        std::fs::write(&p, store_json("applied")).unwrap();
        mark_patch_reverted(&p, "g1").unwrap();
        // Now reverted → a second revert must fail, and the text reader
        // must no longer serve it.
        assert!(applied_patch_text(&p, "g1").is_none());
        assert!(mark_patch_reverted(&p, "g1").is_err());
        // Other fields survive the round-trip.
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(v["patches"][0]["status"], "reverted");
        assert_eq!(v["patches"][0]["score"], 90);
        assert_eq!(v["version"], 1);
    }

    #[test]
    fn mark_patch_reverted_unknown_id_is_an_error() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("pending-patches.json");
        std::fs::write(&p, store_json("applied")).unwrap();
        assert!(mark_patch_reverted(&p, "ghost").is_err());
    }
}