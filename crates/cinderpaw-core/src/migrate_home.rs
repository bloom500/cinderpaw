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
//! 2. **Link rather than duplicate.** Most of this directory is downloaded
//!    models, and a rename has no business copying gigabytes. Files are hard
//!    linked where the filesystem allows and copied where it does not — see
//!    `link_or_copy` for why that keeps the old directory intact.
//! 3. **Verify before committing to it.** The result is counted and measured
//!    against the source. A short migration is a failure, not a smaller
//!    install.
//! 4. **Fail loudly, not quietly.** A partial migration is removed and the
//!    caller gets an error naming what to do. Starting on half a home directory
//!    would present itself as "all my conversations are gone".
//! 5. **Idempotent.** Running twice is a no-op; the marker says it is done.
//! 6. **Never follow symlinks.** A link inside the source would otherwise pull
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
    /// Both homes hold real data and the old one carries no marker.
    ///
    /// The new home wins and NOTHING is touched. This used to be fatal, on the
    /// reasoning that guessing means overwriting one of them — but choosing the
    /// new home overwrites nothing at all, and dying here bricked the app on
    /// the second launch for everyone whose sidecar re-created `~/.feral` after
    /// the host had already migrated. An app that refuses to open is not the
    /// safer app; it is the same lost archive with an extra step. The person is
    /// told on screen that a leftover folder is sitting there.
    LeftoverLegacyHome { legacy: PathBuf },
}

/// Migrate if there is something to migrate. Safe to call on every boot.
pub fn maybe_migrate() -> Result<MigrationOutcome> {
    let home = dirs::home_dir().context("cannot find the home directory")?;
    migrate_between(&home.join(".feral"), &home.join(".cinderpaw"))
}

/// Run the migration exactly once per process, before anybody is told where
/// data lives.
///
/// Putting the call at the top of `build_runtime` was not enough. Roughly
/// twenty places call `ensure_dirs()`, and a single one of them reaching disk
/// first lays down the empty tree that the migration then trips over. That is
/// not a hypothetical ordering problem — it is what happened on the first real
/// boot after the rename, and the app died on a panic before showing a window.
///
/// So the migration hangs off `paths::feral_dir()` instead: every path in the
/// program is built from that function, which makes "before the migration" a
/// state no caller can be in.
///
/// The result is cached rather than recomputed, because the answer cannot
/// change while the process runs and the error must be reported identically to
/// every later caller.
pub fn ensure_migrated() -> &'static Result<MigrationOutcome, String> {
    static ONCE: std::sync::OnceLock<Result<MigrationOutcome, String>> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| maybe_migrate().map_err(|e| format!("{e:#}")))
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
    if new.exists() && !is_empty_skeleton(new) {
        // Both hold real data and the old one is unmarked. Migrating would
        // overwrite the new home, so we do not migrate — but we also do not
        // stop. The new home is the live one by construction: only a build
        // that has already renamed itself ever creates it. Nothing here is
        // deleted or moved; the caller surfaces the leftover as a sentence on
        // screen instead of a window that never appears.
        return Ok(MigrationOutcome::LeftoverLegacyHome { legacy: old.to_path_buf() });
    }

    // A directory tree with no files in it is not data, it is the empty
    // scaffolding that `ensure_dirs` lays down. Refusing to migrate because of
    // it would tell somebody with months of history to "move one aside" over a
    // handful of empty folders — a fatal error message about nothing.
    if new.exists() {
        std::fs::remove_dir_all(new)
            .with_context(|| format!("clearing the empty {}", new.display()))?;
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

/// True when `dir` contains no files at all — only (possibly nested) empty
/// directories. Symlinks count as content: something put them there.
fn is_empty_skeleton(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false; // Cannot tell, so assume it matters.
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { return false };
        if ft.is_dir() {
            if !is_empty_skeleton(&entry.path()) {
                return false;
            }
        } else {
            return false;
        }
    }
    true
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

/// Try a hard link first, fall back to copying the bytes.
///
/// Returns the file's size either way, so the caller's verification is the same
/// in both cases.
///
/// Why link: this directory is mostly downloaded models — gigabytes of them —
/// and a rename has no business duplicating them. On the machine this was
/// written on that is 11 GB of copying for a name change. On a laptop with less
/// free space than the models take, the copy version simply fails and the app
/// does not start, which is a rename bricking an install.
///
/// Why it is safe: a hard link is the same file under two names, and the app
/// only ever replaces these files through write-temp-then-rename. A rename puts
/// a NEW file at the new path and leaves the old name pointing at the old
/// content — so the preserved `~/.feral` keeps exactly what it had, which is the
/// entire point of not deleting it. Nothing here writes in place.
fn link_or_copy(from: &Path, to: &Path) -> Result<u64> {
    let len = std::fs::metadata(from)
        .with_context(|| format!("stat {}", from.display()))?
        .len();
    match std::fs::hard_link(from, to) {
        Ok(()) => Ok(len),
        // Different volume, a filesystem without links, a permission rule, a
        // link count already at its maximum: copy instead. Correctness does not
        // depend on which one happened.
        Err(_) => std::fs::copy(from, to)
            .with_context(|| format!("copy {} -> {}", from.display(), to.display())),
    }
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
            let n = link_or_copy(&from, &to)?;
            // A secret quietly becoming world-readable during a rename is
            // exactly the kind of thing nobody would notice, so the mode is
            // re-applied explicitly rather than trusted to the copy. (A hard
            // link shares the original's mode already; this is for the fallback
            // path, and is harmless either way.)
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
    fn replacing_a_migrated_file_leaves_the_original_alone() {
        // The safety argument for hard-linking, pinned. After migration the two
        // paths may be the same file — so the question that matters is what
        // happens when the app writes. It writes through temp-then-rename, and a
        // rename must leave the preserved copy holding the old content. If this
        // ever fails, the old directory stops being a safety net.
        let dir = tempfile::TempDir::new().unwrap();
        let old = dir.path().join(".feral");
        let new = dir.path().join(".cinderpaw");
        write(&old, "settings.json", b"original");
        migrate_between(&old, &new).unwrap();
        assert_eq!(std::fs::read(new.join("settings.json")).unwrap(), b"original");

        // Exactly what `atomic_file::write_atomic` does.
        crate::atomic_file::write_atomic(&new.join("settings.json"), b"edited").unwrap();

        assert_eq!(std::fs::read(new.join("settings.json")).unwrap(), b"edited");
        assert_eq!(
            std::fs::read(old.join("settings.json")).unwrap(),
            b"original",
            "the preserved folder must keep what it had"
        );
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
    fn keeps_the_new_home_and_touches_nothing_when_both_exist_unmarked() {
        // This used to be fatal. It is the shape every install landed in once
        // the sidecar re-created `~/.feral` after the host had migrated: the
        // app refused to open, and the only instruction was "move one aside".
        // Both folders must survive byte for byte, and the caller must be told
        // WHICH folder is the leftover so it can say so on screen.
        let dir = tempfile::TempDir::new().unwrap();
        let old = dir.path().join(".feral");
        let new = dir.path().join(".cinderpaw");
        write(&old, "settings.json", b"{}");
        write(&new, "settings.json", b"other");
        assert_eq!(
            migrate_between(&old, &new).unwrap(),
            MigrationOutcome::LeftoverLegacyHome { legacy: old.clone() }
        );
        assert_eq!(std::fs::read(new.join("settings.json")).unwrap(), b"other");
        assert_eq!(std::fs::read(old.join("settings.json")).unwrap(), b"{}");
        // And it must stay that way on every later boot, not migrate on the next.
        assert!(matches!(
            migrate_between(&old, &new).unwrap(),
            MigrationOutcome::LeftoverLegacyHome { .. }
        ));
    }

    #[test]
    fn an_empty_new_folder_does_not_block_the_migration() {
        // What actually happened on the first real boot: something asked where
        // things live before the migration ran, `ensure_dirs` created the tree,
        // and the migration then refused because the destination "existed".
        let dir = tempfile::TempDir::new().unwrap();
        let old = dir.path().join(".feral");
        let new = dir.path().join(".cinderpaw");
        write(&old, "conversations/a.json", b"months of history");
        for sub in ["models", "agents", "rsi/meta", "voice"] {
            std::fs::create_dir_all(new.join(sub)).unwrap();
        }

        match migrate_between(&old, &new).unwrap() {
            MigrationOutcome::Migrated { files, .. } => assert_eq!(files, 1),
            other => panic!("expected a migration, got {other:?}"),
        }
        assert_eq!(
            std::fs::read(new.join("conversations/a.json")).unwrap(),
            b"months of history"
        );
    }

    #[test]
    fn one_real_file_anywhere_in_the_new_folder_stops_the_copy() {
        // A single file nested arbitrarily deep still counts as real content:
        // the new home is never overwritten. What changed is the consequence —
        // the copy is skipped and the new home is used, instead of the app
        // refusing to start.
        let dir = tempfile::TempDir::new().unwrap();
        let old = dir.path().join(".feral");
        let new = dir.path().join(".cinderpaw");
        write(&old, "a.json", b"old");
        write(&new, "deep/nested/thing.json", b"new");
        assert_eq!(
            migrate_between(&old, &new).unwrap(),
            MigrationOutcome::LeftoverLegacyHome { legacy: old.clone() }
        );
        assert_eq!(std::fs::read(new.join("deep/nested/thing.json")).unwrap(), b"new");
        assert_eq!(std::fs::read(old.join("a.json")).unwrap(), b"old");
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
