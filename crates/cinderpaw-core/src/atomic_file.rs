//! Writing a file so a crash cannot destroy what was already there, and so a
//! secret is never briefly readable by everyone on the machine.
//!
//! Two mistakes kept being made independently across the codebase:
//!
//! 1. `std::fs::write` truncates the target before it writes a byte. A crash,
//!    an OOM kill or a pulled plug between those two moments leaves a
//!    half-file — and for a config file that means the next boot reads garbage
//!    and falls back to defaults, silently discarding everything the user set.
//! 2. Writing a secret and *then* `chmod 0600` leaves it world-readable for the
//!    length of the write. Any local process that opens it in that window keeps
//!    a descriptor that no later permission change can take away.
//!
//! Both are fixed the same way: create the temp file with the final mode
//! already on it, write, fsync, rename. Rename is atomic on POSIX and
//! `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` on Windows, so a reader sees the
//! whole old file or the whole new one, never a mixture.

use std::io::Write as _;
use std::path::Path;

/// Atomically replace `path` with `bytes`. Ordinary (non-secret) permissions.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_inner(path, bytes, false)
}

/// Atomically replace `path` with `bytes`, owner-only from the instant the file
/// exists. For anything holding a token, key or password.
pub fn write_secret_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_inner(path, bytes, true)
}

fn write_inner(path: &Path, bytes: &[u8], private: bool) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    // The temp file must be a sibling: rename is only atomic within one
    // filesystem, and a temp dir can easily be on another one.
    let tmp = {
        let mut p = path.as_os_str().to_owned();
        p.push(format!(".tmp.{}", std::process::id()));
        std::path::PathBuf::from(p)
    };

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    // Windows has no mode bits to set here; the file inherits the ACL of a
    // per-user directory, which is where all of these live.
    #[cfg(not(unix))]
    let _ = private;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }

    let result = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        // An existing target may predate this helper and still be 0644, and
        // rename keeps the SOURCE's mode — so the mode above is what survives.
        std::fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Read a JSON config, and if it is there but unreadable, say so and KEEP it.
///
/// The pattern this replaces was `serde_json::from_slice(..).unwrap_or_default()`:
/// a single stray byte in `byok.json` or `mcp.json` and every provider, every
/// installed extension, every key the user had configured was replaced by the
/// defaults — silently, on boot, with the broken file then overwritten by the
/// first save. The data was recoverable right up to the moment we threw it away.
///
/// Now the file is moved aside as `<name>.corrupt-<timestamp>` so it can be
/// repaired by hand, and the failure is printed rather than swallowed.
///
/// ponytail: the message goes to stderr and the tracing log. A desktop user
/// with no terminal open still will not see it — surfacing this in the UI needs
/// an event channel this layer does not have.
pub fn read_json_or_report<T>(path: &Path, what: &str) -> T
where
    T: serde::de::DeserializeOwned + Default,
{
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        // No file at all is the ordinary first-run case, not a problem.
        Err(_) => return T::default(),
    };
    match serde_json::from_slice::<T>(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let mut kept = path.as_os_str().to_owned();
            kept.push(format!(".corrupt-{stamp}"));
            let kept = std::path::PathBuf::from(kept);
            let saved = std::fs::rename(path, &kept).is_ok();
            let where_ = if saved {
                format!("The unreadable file was kept at {}.", kept.display())
            } else {
                "The unreadable file could not be moved aside.".to_string()
            };
            eprintln!(
                "[feral] WARNING: {} ({}) could not be parsed ({e}) — starting from                  defaults, so anything configured there is not in effect. {where_}",
                what,
                path.display()
            );
            tracing::error!(path = %path.display(), error = %e, "{what}: unreadable, using defaults");
            T::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_content_and_leaves_no_temp_behind() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("cfg.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "a temp file was left behind");
    }

    #[test]
    fn creates_missing_parent_dirs() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("nested/deeper/secrets.json");
        write_secret_atomic(&path, b"x").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"x");
    }

    #[test]
    fn a_corrupt_config_is_kept_aside_not_thrown_away() {
        #[derive(Default, serde::Deserialize, PartialEq, Debug)]
        struct Cfg {
            a: u32,
        }
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("cfg.json");
        std::fs::write(&path, b"{ this is not json").unwrap();
        let got: Cfg = read_json_or_report(&path, "test config");
        assert_eq!(got, Cfg::default());
        let kept: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1, "the unreadable file must be recoverable");
    }

    #[cfg(unix)]
    #[test]
    fn a_secret_is_owner_only_from_the_start() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("token");
        write_secret_atomic(&path, b"sekrit").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "secret must not be group/world readable");
    }
}
