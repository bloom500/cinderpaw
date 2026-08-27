//! One-shot move of `agent/feral.db` to `agent/cinderpaw.db`.
//!
//! `migrate_home` moved the *directory* across the rename. It never touched the
//! names of the files inside it, so a pre-rename install ended up with its
//! whole history sitting in `~/.cinderpaw/agent/feral.db` while the host asked
//! SQLite for `~/.cinderpaw/agent/cinderpaw.db` — a name SQLite is happy to
//! create, empty, on the spot. Nothing failed. The app opened, the agent had no
//! memories, no teammates and no cost history, and said so in the only way it
//! could: by not knowing anything.
//!
//! That is the shape of the bug this module exists to make impossible. The
//! sidecar does carry a fallback of its own (`defaultDbPath()` in `boot.ts`),
//! but the desktop host passes `CINDERPAW_DB` explicitly, and an explicit value
//! wins over a default — so the fallback never ran where it mattered. The
//! decision belongs here, where the path is chosen.
//!
//! The rules, in order of how much they matter:
//!
//! 1. **Never overwrite a database.** If both files exist we do not guess which
//!    one is "the real one" — we open the current name, move nothing, and say
//!    so on screen. Guessing wrong here silently discards someone's archive.
//! 2. **Never silently start empty.** If the legacy file is the only one, it is
//!    renamed into place; if the rename fails, we open the legacy file WHERE IT
//!    IS rather than letting SQLite create a blank one next to it.
//! 3. **Rename, never copy.** These files reach hundreds of megabytes. A rename
//!    inside one directory is atomic and instant; a copy is a long stall on
//!    startup and a second full-size file on a disk that may not have room.
//! 4. **Idempotent.** Once the legacy name is gone, every later boot takes the
//!    first branch and does nothing at all.

use std::path::{Path, PathBuf};

/// Current file name, and the pre-rename one whose data has to keep working.
const CURRENT_DB: &str = "cinderpaw.db";
const LEGACY_DB: &str = "feral.db";

/// SQLite's sidecar files. They belong to the database that names them, so a
/// rename that leaves them behind orphans an unreplayed write-ahead log — which
/// is to say, the most recent work.
const SQLITE_SIDECARS: [&str; 2] = ["-wal", "-shm"];

/// Something the person has to be told, because no automatic answer is safe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbNotice {
    /// Both names exist. We opened the current one and touched nothing.
    ///
    /// Carries what a person needs to decide: which file is being used, which
    /// one is sitting unused, and how big each is — because "the big one is not
    /// the one you are running on" is the entire message.
    BothPresent {
        current: PathBuf,
        current_bytes: u64,
        legacy: PathBuf,
        legacy_bytes: u64,
    },
    /// The legacy file could not be renamed, so it is being opened in place.
    /// Nothing is lost and nothing is at risk; the name is just still the old
    /// one, and the next boot will try again.
    OpenedLegacyInPlace { legacy: PathBuf, reason: String },
}

/// The database to open, plus anything the person needs to hear about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbChoice {
    pub path: PathBuf,
    pub notice: Option<DbNotice>,
}

fn size_of(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Resolve the agent database inside `dir`, migrating the pre-rename file when
/// that can be done without risking anything.
///
/// Split out from [`resolve`] so the whole decision table can be tested against
/// a temp directory instead of the developer's real home.
pub fn resolve_in(dir: &Path) -> DbChoice {
    let current = dir.join(CURRENT_DB);
    let legacy = dir.join(LEGACY_DB);

    // The overwhelmingly common path, and the one every install ends up on:
    // no pre-rename file, so there is nothing to think about. A fresh install
    // takes this branch too — neither file exists and SQLite creates the
    // current one, which is exactly right.
    if !legacy.exists() {
        return DbChoice { path: current, notice: None };
    }

    // Both names exist. This is the state a boot BEFORE this module was
    // written could produce: it opened the current name, SQLite created it
    // empty, and the legacy file has been sitting there full ever since.
    //
    // We still do not guess. The current file may be a stub with one day in
    // it, or it may be the live database of somebody who moved on months ago
    // and kept the old one for safety — and from out here those look alike.
    // Renaming over the current file could destroy either. So: open the
    // current name, as every previous build did, change nothing on disk, and
    // put the two files in front of the person with their sizes. The one
    // outcome we refuse is the old one — being silently wrong about it.
    if current.exists() {
        return DbChoice {
            path: current.clone(),
            notice: Some(DbNotice::BothPresent {
                current_bytes: size_of(&current),
                legacy_bytes: size_of(&legacy),
                current,
                legacy,
            }),
        };
    }

    // Only the legacy file: an install that predates the rename. Move it and
    // its write-ahead log into the current name. Same directory, same
    // filesystem, so this is a metadata operation however large the file is.
    match std::fs::rename(&legacy, &current) {
        Ok(()) => {
            for ext in SQLITE_SIDECARS {
                let from = sibling(&legacy, ext);
                if from.exists() {
                    // Best effort by design. A `-wal` that cannot follow its
                    // database is a lost tail, not a lost database, and SQLite
                    // recovers from a missing one; failing the whole migration
                    // here would strand the person on the old name for good.
                    let _ = std::fs::rename(&from, sibling(&current, ext));
                }
            }
            DbChoice { path: current, notice: None }
        }
        // Locked by another process, a read-only volume, a permission we do not
        // have. Whatever the reason, the database is still perfectly good where
        // it lies — so open it there. The alternative is what this module was
        // written to prevent: a blank database created next to a full one.
        Err(e) => DbChoice {
            path: legacy.clone(),
            notice: Some(DbNotice::OpenedLegacyInPlace { legacy, reason: e.to_string() }),
        },
    }
}

/// `path` with `suffix` appended to its file name (`x.db` + `-wal` = `x.db-wal`).
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Resolve once per process, against the real agent directory.
///
/// Cached for the same reason `migrate_home::ensure_migrated` is: the answer
/// cannot change while we run, and two callers must never be told different
/// things about where the database is.
pub fn resolve() -> &'static DbChoice {
    static ONCE: std::sync::OnceLock<DbChoice> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let dir = crate::paths::cinderpaw_agent_dir();
        // The directory has to exist before `rename` can land in it, and on a
        // fresh install nothing has created it yet.
        let _ = std::fs::create_dir_all(&dir);
        resolve_in(&dir)
    })
}

/// What the host should tell the person, if anything. Cheap to call anywhere.
pub fn notice() -> Option<&'static DbNotice> {
    resolve().notice.as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path, bytes: &[u8]) {
        std::fs::write(p, bytes).unwrap();
    }

    #[test]
    fn fresh_install_uses_the_current_name_and_says_nothing() {
        let d = tempfile::tempdir().unwrap();
        let got = resolve_in(d.path());
        assert_eq!(got.path, d.path().join(CURRENT_DB));
        assert_eq!(got.notice, None);
    }

    #[test]
    fn a_pre_rename_install_is_renamed_into_place() {
        let d = tempfile::tempdir().unwrap();
        touch(&d.path().join(LEGACY_DB), b"the whole history");
        touch(&d.path().join("feral.db-wal"), b"the last few writes");

        let got = resolve_in(d.path());

        assert_eq!(got.path, d.path().join(CURRENT_DB));
        assert_eq!(got.notice, None, "a silent success needs no dialog");
        // The point of the whole module: the data is under the new name, and
        // its write-ahead log came with it.
        assert_eq!(
            std::fs::read(d.path().join(CURRENT_DB)).unwrap(),
            b"the whole history"
        );
        assert_eq!(
            std::fs::read(d.path().join("cinderpaw.db-wal")).unwrap(),
            b"the last few writes"
        );
        assert!(!d.path().join(LEGACY_DB).exists(), "the old name is gone, not duplicated");
    }

    #[test]
    fn running_twice_changes_nothing() {
        let d = tempfile::tempdir().unwrap();
        touch(&d.path().join(LEGACY_DB), b"history");
        let first = resolve_in(d.path());
        let second = resolve_in(d.path());
        assert_eq!(first, second);
        assert_eq!(std::fs::read(&second.path).unwrap(), b"history");
    }

    #[test]
    fn both_files_present_is_reported_and_nothing_is_moved() {
        let d = tempfile::tempdir().unwrap();
        touch(&d.path().join(CURRENT_DB), b"stub");
        touch(&d.path().join(LEGACY_DB), b"a much longer history");

        let got = resolve_in(d.path());

        assert_eq!(got.path, d.path().join(CURRENT_DB), "never guess, never overwrite");
        match got.notice {
            Some(DbNotice::BothPresent { current_bytes, legacy_bytes, .. }) => {
                // The sizes are the message: the file being used is the small one.
                assert_eq!(current_bytes, 4);
                assert_eq!(legacy_bytes, 21);
            }
            other => panic!("expected BothPresent, got {other:?}"),
        }
        // Both files are exactly as they were.
        assert_eq!(std::fs::read(d.path().join(CURRENT_DB)).unwrap(), b"stub");
        assert_eq!(std::fs::read(d.path().join(LEGACY_DB)).unwrap(), b"a much longer history");
    }
}
