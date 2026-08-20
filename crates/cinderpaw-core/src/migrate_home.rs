//! One-shot move of `~/.feral` to `~/.cinderpaw`.
//!
//! This directory is everything the person has: conversations, agents,
//! connector tokens, downloaded models, the RSI git substrate, the memory
//! database. A rename that loses it is not a rename, it is a wipe with a new
//! logo on it.
//!
//! The rules this follows, in order of how much they matter:
//!
//! 1. **Never delete the source.** The old directory is left exactly as it was
//!    and marked as migrated. If anything goes wrong afterwards, the data is
//!    still sitting where it always was.
//! 2. **Verify before committing to it.** The copy is counted and measured
//!    against the source. A short copy is a failure, not a smaller install.
//! 3. **Fail loudly, not quietly.** A partial migration is removed and the
//!    caller gets an error naming what to do. Starting on half a home directory
//!    would present itself as "all my conversations are gone".
//! 4. **Idempotent.** Running twice is a no-op; the marker says it is done.
//! 5. **Never follow symlinks.** A link inside the source would otherwise pull
//!    in whatever it points at, the same lesson as the self-source bundle.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// Written into the OLD directory once its contents are safely copied.
pub const MIGRATION_MARKER: &str = ".migrated-to-cinderpaw";

#[derive(Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// No `~/.feral` at all: a fresh install, or already cleaned up.
    NoLegacyHome,
    /// The marker is present; nothing to do.
    AlreadyMigrated,
    /// Copied this many files.
    Migrated { files: u64, bytes: u64 },
}

/// Migrate if there is something to migrate. Safe to call on every boot.
pub fn maybe_migrate() -> Result<MigrationOutcome> {
    let home = dirs::home_dir().context("cannot find the home directory")?;
    migrate_between(&home.join(".feral"), &home.join(".cinderpaw"))
}

/// The body of [`maybe_migrate`], with both paths given, so it can be tested
/// without touching the real home directory.
pub fn migrate_between(old: &Path, new: &Path) -> Result<MigrationOutcome> {
    if !old.exists() {
        return Ok(MigrationOutcome::NoLegacyHome);
    }
    if old.join(MIGRATION_MARKER).exists() {
        return Ok(MigrationOutcome::AlreadyMigrated);
    }
    if new.exists() {
        // Both present and the old one not marked done. Ambiguous, and guessing
        // means overwriting one of them. Ask the person instead.
        bail!(
            "both {} and {} exist, and the older one is not marked as migrated. \
             Cinderpaw will not overwrite either. Move one aside and start again.",
            old.display(),
            new.display()
        );
    }

    // Copy into a temporary sibling first: an interrupted copy then leaves a
    // staging directory rather than a half-populated home treated as real.
    let staging = {
        let mut s = new.as_os_str().to_owned();
        s.push(".migrating");
        PathBuf::from(s)
    };
    if staging.exists() {
        std::fs::remove_dir_all(&staging).ok();
    }

    let copied = match copy_tree(old, &staging) {
        Ok(c) => c,
        Err(e) => {
            std::fs::remove_dir_all(&staging).ok();
            return Err(e).context("copying your data to the new location");
        }
    };
    let expected = measure(old)?;
    if copied != expected {
        std::fs::remove_dir_all(&staging).ok();
        bail!(
            "the copy of {} came out different from the original ({} files / {} bytes \
             vs {} files / {} bytes). Nothing was changed and your data is untouched. \
             Please report this before starting again.",
            old.display(),
            copied.0,
            copied.1,
            expected.0,
            expected.1
        );
    }

    std::fs::rename(&staging, new).with_context(|| {
        format!("moving {} into place at {}", staging.display(), new.display())
    })?;

    // Only now is the old one marked. If the process dies before this line, the
    // next boot sees an unmarked old directory and a present new one, and stops
    // to ask, which is the right answer for an interrupted migration.
    let note = "This folder was copied to ~/.cinderpaw when the app was renamed.\n\
                Nothing here was deleted. You can remove this folder once you are\n\
                satisfied everything moved across.\n";
    std::fs::write(old.join(MIGRATION_MARKER), note.as_bytes()).ok();

    Ok(MigrationOutcome::Migrated { files: copied.0, bytes: copied.1 })
}

/// Files and total bytes under `dir`, not following symlinks.
fn measure(dir: &Path) -> Result<(u64, u64)> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            let (f, b) = measure(&entry.path())?;
            files += f;
            bytes += b;
        } else {
            files += 1;
            bytes += entry.metadata()?.len();
        }
    }
    Ok((files, bytes))
}

/// Recursive copy that skips symlinks. Returns (files, bytes) written.
fn copy_tree(src: &Path, dst: &Path) -> Result<(u64, u64)> {
    std::fs::create_dir_all(dst).with_context(|| format!("mkdir {}", dst.display()))?;
    let mut files = 0u64;
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(src).with_context(|| format!("read {}", src.display()))? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_symlink() {
            tracing::warn!(path = %from.display(), "migration: skipping a symlink");
            continue;
        }
        if ft.is_dir() {
            let (f, b) = copy_tree(&from, &to)?;
            files += f;
            bytes += b;
        } else {
            let n = std::fs::copy(&from, &to)
                .with_context(|| format!("copy {} -> {}", from.display(), to.display()))?;
            // A secret quietly becoming world-readable during a rename is
            // exactly the kind of thing nobody would notice, so the mode is
            // re-applied explicitly rather than trusted to the copy.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                if let Ok(meta) = entry.metadata() {
                    let mode = meta.permissions().mode() & 0o777;
                    let _ = std::fs::set_permissions(&to, std::fs::Permissions::from_mode(mode));
                }
            }
            files += 1;
            bytes += n;
        }
    }
    Ok((files, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, body: &[u8]) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn no_legacy_home_is_a_no_op() {
        let dir = tempfile::TempDir::new().unwrap();
        let out = migrate_between(&dir.path().join("nope"), &dir.path().join("new")).unwrap();
        assert_eq!(out, MigrationOutcome::NoLegacyHome);
    }

    #[test]
    fn copies_everything_and_leaves_the_original_alone() {
        let dir = tempfile::TempDir::new().unwrap();
        let old = dir.path().join(".feral");
        let new = dir.path().join(".cinderpaw");
        write(&old, "settings.json", b"{}");
        write(&old, "conversations/a.json", b"hello");
        write(&old, "rsi/PLAN.md", b"# plan");
        write(&old, "models/m.gguf", &vec![7u8; 4096]);

        match migrate_between(&old, &new).unwrap() {
            MigrationOutcome::Migrated { files, bytes } => {
                assert_eq!(files, 4);
                assert_eq!(bytes, 2 + 5 + 6 + 4096);
            }
            other => panic!("expected a migration, got {other:?}"),
        }
        assert_eq!(std::fs::read(new.join("conversations/a.json")).unwrap(), b"hello");
        assert_eq!(std::fs::read(new.join("models/m.gguf")).unwrap().len(), 4096);
        assert!(old.join("conversations/a.json").exists(), "source must survive");
        assert!(old.join(MIGRATION_MARKER).exists(), "source must be marked");
    }

    #[test]
    fn running_twice_does_nothing_the_second_time() {
        let dir = tempfile::TempDir::new().unwrap();
        let old = dir.path().join(".feral");
        let new = dir.path().join(".cinderpaw");
        write(&old, "settings.json", b"{}");
        migrate_between(&old, &new).unwrap();
        assert_eq!(
            migrate_between(&old, &new).unwrap(),
            MigrationOutcome::AlreadyMigrated
        );
    }

    #[test]
    fn refuses_when_both_exist_and_the_old_one_is_not_marked() {
        let dir = tempfile::TempDir::new().unwrap();
        let old = dir.path().join(".feral");
        let new = dir.path().join(".cinderpaw");
        write(&old, "settings.json", b"{}");
        write(&new, "settings.json", b"other");
        let err = migrate_between(&old, &new).unwrap_err().to_string();
        assert!(err.contains("will not overwrite"), "got: {err}");
        assert_eq!(std::fs::read(new.join("settings.json")).unwrap(), b"other");
    }

    #[test]
    fn leaves_no_staging_directory_behind() {
        let dir = tempfile::TempDir::new().unwrap();
        let old = dir.path().join(".feral");
        let new = dir.path().join(".cinderpaw");
        write(&old, "a.txt", b"x");
        migrate_between(&old, &new).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".migrating"))
            .collect();
        assert!(leftovers.is_empty(), "staging directory was left behind");
    }
}
