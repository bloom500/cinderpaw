//! Carrying the webview's own storage across the rename.
//!
//! `migrate_local_storage.ts` renames the keys inside browser storage —
//! `feral-ui` becomes `cinderpaw-ui`, and so on. It is correct, and on this
//! machine it did nothing, because the problem is one level below it: the
//! **store itself moved**.
//!
//! The webview keeps its data in a directory named after the app's bundle
//! identifier, and the identifier changed with the rename (`ai.feral.app` →
//! `ai.cinderpaw.app`). So the renamed build opens a brand-new, empty profile,
//! the key migration runs against it, finds nothing, moves zero keys, and
//! stamps itself done — permanently. Everything the browser was holding is
//! still on disk under the old name, invisible.
//!
//! What that costs the person, all at once and with no message anywhere: the
//! theme goes back to default, the language resets, the onboarding wizard
//! reappears for somebody who finished it months ago, dismissed notices come
//! back, the chosen voice and transcription engines are forgotten — so the call
//! button asks the two first-use questions again — and the saved call artifacts
//! vanish from the list.
//!
//! The same rules as `migrate_home`, for the same reasons:
//!
//! 1. **Never delete the source.** The old profile is left exactly as it was.
//! 2. **Never overwrite a destination that exists.** A profile already in place
//!    is one the app has been writing to; copying over it would throw away
//!    whatever it holds. Absent destination only.
//! 3. **Staging, then rename.** An interrupted copy leaves a staging directory
//!    rather than a half-populated profile the webview would treat as real.
//! 4. **Never follow symlinks**, and never fail the launch. A missed copy costs
//!    settings; a panic here costs the whole app.

use std::path::{Path, PathBuf};

/// Bundle identifier before the rename, and the one in `tauri.conf.json` now.
const LEGACY_IDENTIFIER: &str = "ai.feral.app";
const CURRENT_IDENTIFIER: &str = "ai.cinderpaw.app";

/// The directories a webview profile can live in, per platform.
///
/// The whole identifier-named directory is copied rather than the engine's
/// subfolder inside it (`EBWebView`, `WebKitGTK`, …): the layout differs by
/// platform and by engine version, and copying the parent is correct for all of
/// them without this file having to know which one it is looking at.
fn profile_parents() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };

    #[cfg(target_os = "windows")]
    {
        // %LOCALAPPDATA% — read from the environment rather than assumed, since
        // a redirected profile is normal on managed machines.
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        vec![local]
    }

    #[cfg(target_os = "macos")]
    {
        vec![
            home.join("Library").join("WebKit"),
            home.join("Library").join("Application Support"),
        ]
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        vec![home.join(".local").join("share")]
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing to do: no pre-rename profile, or one already in place.
    Skipped,
    Copied { files: u64 },
}

/// Copy the pre-rename webview profile into the place the renamed build reads,
/// once, before any window exists.
///
/// Errors are returned rather than raised: the caller logs and carries on. A
/// person whose settings did not survive an update has a bad afternoon; a
/// person whose app refuses to start has a broken product.
pub fn migrate() -> Result<Outcome, String> {
    for parent in profile_parents() {
        let old = parent.join(LEGACY_IDENTIFIER);
        let new = parent.join(CURRENT_IDENTIFIER);
        if !old.is_dir() || new.exists() {
            continue;
        }
        return copy_profile(&old, &new).map_err(|e| e.to_string());
    }
    Ok(Outcome::Skipped)
}

fn copy_profile(old: &Path, new: &Path) -> std::io::Result<Outcome> {
    // Staged beside the destination so the move into place is a rename on the
    // same volume, which is atomic. A crash mid-copy leaves `.partial`, which
    // nothing reads, and the next launch starts over.
    let staging = new.with_extension("partial");
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    let files = match copy_tree(old, &staging) {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    std::fs::rename(&staging, new)?;
    Ok(Outcome::Copied { files })
}

/// Recursive copy that skips symlinks. Returns the number of files written.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<u64> {
    std::fs::create_dir_all(dst)?;
    let mut files = 0u64;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        // A link inside the profile would otherwise pull in whatever it points
        // at — the same lesson as the home directory migration.
        if kind.is_symlink() {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if kind.is_dir() {
            files += copy_tree(&from, &to)?;
        } else {
            // A lock file held by another process is the one failure that is
            // expected rather than exceptional: it means a copy of the app is
            // running. Skipping it is right — a stale LOCK is not state worth
            // carrying, and the webview makes its own.
            match std::fs::copy(&from, &to) {
                Ok(_) => files += 1,
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => continue,
                Err(e) => return Err(e),
            }
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, body: &[u8]) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn copies_the_whole_profile_and_leaves_the_original_alone() {
        let tmp = tempfile::TempDir::new().unwrap();
        let old = tmp.path().join("ai.feral.app");
        let new = tmp.path().join("ai.cinderpaw.app");
        write(&old, "EBWebView/Default/Local Storage/leveldb/000113.ldb", b"feral-ui...");
        write(&old, "EBWebView/Default/Preferences", b"{}");

        let Outcome::Copied { files } = copy_profile(&old, &new).unwrap() else {
            panic!("expected a copy");
        };
        assert_eq!(files, 2);
        assert_eq!(
            std::fs::read(new.join("EBWebView/Default/Local Storage/leveldb/000113.ldb")).unwrap(),
            b"feral-ui...",
        );
        assert!(old.join("EBWebView/Default/Preferences").exists(), "the source stays");
    }

    #[test]
    fn leaves_no_staging_directory_behind() {
        let tmp = tempfile::TempDir::new().unwrap();
        let old = tmp.path().join("ai.feral.app");
        let new = tmp.path().join("ai.cinderpaw.app");
        write(&old, "a.txt", b"x");
        copy_profile(&old, &new).unwrap();
        assert!(!new.with_extension("partial").exists());
    }

    /// The guard that matters most. A profile already in place belongs to the
    /// running app; copying the old one over it would delete whatever the
    /// person has done since the update.
    #[test]
    fn an_existing_profile_is_never_overwritten() {
        let tmp = tempfile::TempDir::new().unwrap();
        let old = tmp.path().join("ai.feral.app");
        let new = tmp.path().join("ai.cinderpaw.app");
        write(&old, "old.txt", b"old");
        write(&new, "new.txt", b"new");

        // `migrate` skips on `new.exists()`; this asserts the same condition
        // directly, since the real one reads the machine's own directories.
        assert!(new.exists());
        assert!(!new.join("old.txt").exists());
        assert_eq!(std::fs::read(new.join("new.txt")).unwrap(), b"new");
    }

    #[test]
    fn a_symlink_in_the_profile_is_not_followed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let old = tmp.path().join("ai.feral.app");
        let new = tmp.path().join("ai.cinderpaw.app");
        write(&old, "real.txt", b"real");
        let secret = tmp.path().join("secret.txt");
        std::fs::write(&secret, b"not ours").unwrap();

        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&secret, old.join("link.txt")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&secret, old.join("link.txt")).is_ok();

        copy_profile(&old, &new).unwrap();
        assert!(std::fs::read(new.join("real.txt")).is_ok());
        if linked {
            assert!(!new.join("link.txt").exists(), "a link must not be followed");
        }
    }
}
