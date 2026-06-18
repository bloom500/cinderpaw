//! Path validation for the RSI substrate.
//!
//! Every Rust entry point that touches the filesystem under
//! `~/.feral/rsi/` MUST go through a containment check here. The agent
//! itself has no filesystem permission to write under that tree — the
//! sandbox already blocks it — but the API surface in this module is the
//! last line of defence against a future Rust-side bug that would let a
//! path slip through. Pattern follows `skills::skill_path`: canonicalise
//! both the base and the candidate, then `starts_with` the canonical base.
//!
//! Tier values are constrained to 0/1/2. Anything else is a programmer
//! error; we reject explicitly rather than silently accepting an
//! unrecognised tier because Tier 2 in particular has a different
//! governance story (human-gated) and the wrong directory would silently
//! route eval traffic.

use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};

use crate::paths::{rsi_dir, rsi_eval_dir, rsi_genomes_dir, rsi_meta_dir, rsi_plan_path};

/// Valid RSI tier identifiers. Tier 0 frozen permanently, Tier 1 frozen
/// per epoch, Tier 2 human-gated. Any other value is rejected.
pub const VALID_TIERS: &[u8] = &[0, 1, 2];

/// `true` if `tier` is one of the three recognised eval tiers.
pub fn is_valid_tier(tier: u8) -> bool {
    VALID_TIERS.contains(&tier)
}

/// `true` if `path` resolves under (or is equal to) `base` after both
/// are canonicalised. If `path` does not exist yet (a common case
/// for write paths about to be created), we canonicalise the closest
/// existing ancestor instead — the syntactic remainder must still be
/// `..`-free, which `safe_join` enforces before calling in.
pub fn is_under(base: &Path, path: &Path) -> Result<bool> {
    let base_canon = base
        .canonicalize()
        .with_context(|| format!("canonicalize base: {}", base.display()))?;

    let path_canon = if path.exists() {
        path.canonicalize()
            .with_context(|| format!("canonicalize candidate: {}", path.display()))?
    } else {
        // Walk up to the closest existing ancestor, canonicalise
        // that, then re-attach the syntactic suffix. The suffix was
        // already verified to be free of `..` by the caller (typically
        // `safe_join`).
        let mut anchor = path;
        let mut suffix_parts: Vec<std::ffi::OsString> = Vec::new();
        while let Some(parent) = anchor.parent() {
            if parent.exists() {
                let canon_parent = parent
                    .canonicalize()
                    .with_context(|| format!("canonicalize parent: {}", parent.display()))?;
                let file_name = path
                    .strip_prefix(parent)
                    .unwrap_or(path)
                    .as_os_str()
                    .to_owned();
                return Ok(canon_parent.join(file_name).starts_with(&base_canon));
            }
            if let Some(name) = anchor.file_name() {
                suffix_parts.insert(0, name.to_owned());
            }
            anchor = parent;
        }
        // No existing ancestor at all — fall back to treating the
        // whole path as a syntactic remainder under base.
        return Ok(base_canon.join(path.as_os_str()).starts_with(&base_canon));
    };

    Ok(path_canon.starts_with(&base_canon))
}

/// Same as `is_under`, but returns an Err with a descriptive message on
/// failure. Use this in every command that accepts a path argument
/// before doing anything with it.
pub fn require_under(base: &Path, path: &Path) -> Result<()> {
    if !is_under(base, path)? {
        bail!(
            "path '{}' is outside of the allowed base '{}'",
            path.display(),
            base.display()
        );
    }
    Ok(())
}

/// Validate a relative path (as supplied by the sidecar) and return its
/// canonicalised absolute form, anchored under `base`. Rejects absolute
/// paths (would imply an arbitrary read), `..` components (traversal),
/// and symlinks that resolve outside the base.
pub fn safe_join(base: &Path, rel: &Path) -> Result<PathBuf> {
    if rel.is_absolute() {
        bail!("absolute path '{}' is not allowed", rel.display());
    }
    for comp in rel.components() {
        if matches!(comp, Component::ParentDir) {
            bail!("path component '..' is not allowed in '{}'", rel.display());
        }
    }
    let joined = base.join(rel);
    require_under(base, &joined)
        .with_context(|| format!("safe_join: {} under {}", rel.display(), base.display()))?;
    Ok(joined)
}

/// Resolve the eval dir for a tier and confirm it lives under the RSI
/// root. Always returns the same directory; the `Result` is here for
/// symmetry with the rest of the API and to surface IO errors early.
pub fn eval_dir(tier: u8) -> Result<PathBuf> {
    if !is_valid_tier(tier) {
        bail!("invalid eval tier: {} (must be 0, 1, or 2)", tier);
    }
    let dir = rsi_eval_dir(tier);
    let root = rsi_dir();
    require_under(&root, &dir)
        .with_context(|| format!("eval_dir({}) containment check", tier))?;
    Ok(dir)
}

/// Resolve the genome-snapshot dir and confirm containment.
pub fn genomes_dir() -> Result<PathBuf> {
    let dir = rsi_genomes_dir();
    let root = rsi_dir();
    require_under(&root, &dir)?;
    Ok(dir)
}

/// Resolve the meta dir and confirm containment.
pub fn meta_dir() -> Result<PathBuf> {
    let dir = rsi_meta_dir();
    let root = rsi_dir();
    require_under(&root, &dir)?;
    Ok(dir)
}

/// The on-disk PLAN.md location, with containment check.
pub fn plan_path() -> Result<PathBuf> {
    let p = rsi_plan_path();
    let root = rsi_dir();
    require_under(&root, &p)?;
    Ok(p)
}

/// Look up the genome snapshot file for a given commit hash. The
/// canonical file name is `<commit>.json` under `rsi_genomes_dir()`. The
/// commit hash is sanity-checked (40-char lowercase hex) before being
/// joined to the path — this blocks both `..` injection and accidental
/// glob expansion by downstream code that may use the hash as a filename.
pub fn genome_snapshot_path(commit_hash: &str) -> Result<PathBuf> {
    if !is_valid_commit_hash(commit_hash) {
        bail!("invalid commit hash '{}'", commit_hash);
    }
    let dir = genomes_dir()?;
    let p = dir.join(format!("{}.json", commit_hash));
    require_under(&dir, &p)?;
    Ok(p)
}

/// 40-character lowercase hex. Standard git SHA-1 shape; matches what
/// `git2::Oid::to_string()` produces so we don't have to massage the
/// hash on its way through the IPC boundary.
pub fn is_valid_commit_hash(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// Resolve a sidecar-supplied relative path (a "key" into the eval
/// tier's task tree) under the given tier dir. Used by the eval loader
/// before returning task content to the sidecar — the sidecar itself
/// never sees an absolute path.
pub fn eval_task_path(tier: u8, task_rel: &Path) -> Result<PathBuf> {
    let dir = eval_dir(tier)?;
    safe_join(&dir, task_rel)
}

/// Marker error for paths that look like they might escape but pass the
/// syntactic checks. We only use this as a tiebreaker for ambiguous
/// containment cases; today every ambiguous case is caught by the
/// canonicalize + starts_with combo above, so this is reserved for
/// future expansion (e.g. allowed list of symlinks).
#[allow(dead_code)]
pub(crate) fn path_validation_disabled() -> anyhow::Error {
    anyhow!("path validation has been bypassed — this is a bug")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_under(base: &Path, rel: &str) -> PathBuf {
        let p = base.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"x").unwrap();
        p
    }

    #[test]
    fn valid_tiers_are_zero_one_two() {
        assert!(is_valid_tier(0));
        assert!(is_valid_tier(1));
        assert!(is_valid_tier(2));
        assert!(!is_valid_tier(3));
        assert!(!is_valid_tier(255));
    }

    #[test]
    fn is_under_rejects_escape() {
        let base = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let in_base = write_under(base.path(), "a/b.txt");
        let out_base = write_under(outside.path(), "c.txt");
        assert!(is_under(base.path(), &in_base).unwrap());
        assert!(!is_under(base.path(), &out_base).unwrap());
    }

    #[test]
    fn safe_join_rejects_absolute() {
        let base = TempDir::new().unwrap();
        assert!(safe_join(base.path(), Path::new("/etc/passwd")).is_err());
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let base = TempDir::new().unwrap();
        assert!(safe_join(base.path(), Path::new("../escape")).is_err());
        assert!(safe_join(base.path(), Path::new("a/../../escape")).is_err());
    }

    #[test]
    fn safe_join_allows_nested_relative() {
        let base = TempDir::new().unwrap();
        std::fs::create_dir_all(base.path().join("a/b")).unwrap();
        let p = safe_join(base.path(), Path::new("a/b/c.json")).unwrap();
        assert!(p.ends_with("a/b/c.json"));
    }

    #[test]
    fn is_valid_commit_hash_accepts_git_sha1_shape() {
        assert!(is_valid_commit_hash(
            "0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(!is_valid_commit_hash("deadbeef")); // too short
        assert!(!is_valid_commit_hash(
            "0123456789ABCDEF0123456789ABCDEF01234567"
        )); // uppercase
        assert!(!is_valid_commit_hash(
            "0123456789abcdef0123456789abcdef0123456g"
        )); // non-hex
    }
}
