//! Self-source provisioning — code-RSI in PRODUCTION installs (option A).
//!
//! A shipped install is a compiled binary; without sources on disk the
//! whole L3 loop (propose → worktree eval → ratchet → approve → apply →
//! rebuild) is structurally impossible for a real user. The bundle now
//! carries the sidecar sources as Tauri resources; this module copies
//! them to `~/.feral/self-src/` on first spawn, turns that copy into a
//! git repo (the substrate/worktree machinery requires one), and hands
//! the path back so the supervisor can export `FERAL_CODE_RSI_REPO`.
//!
//! Fail-open by design: any miss (no bundled sources — e.g. a dev run,
//! no git on PATH) returns Err with a named reason and the caller logs
//! it; code-RSI simply stays off, exactly as before this module existed.
//!
//! Toolchain reality the user still needs for the loop to complete:
//! `git` (provisioning + worktrees), `bun` (worktree eval + rebuild) and
//! network on the first worktree `bun install`. Absent those, the loop
//! stops at the corresponding stage with a journaled reason — never a
//! crash.

use std::path::{Path, PathBuf};

/// Directory name under `~/.feral` that holds the provisioned sources.
pub const SELF_SRC_DIR: &str = "self-src";

/// Locate the bundled source tree under the host-supplied resource dirs:
/// a directory containing `FeralAgent/package.json`. Tauri flattens
/// `../` resource paths under `_up_/`, so those two documented layouts are
/// checked directly. Never recurse from a resource directory: in a Tauri dev
/// run it can be `target/debug`, whose Cargo artifact tree contains thousands
/// of directories and used to delay the sidecar spawn by minutes.
///
/// Beyond the host-supplied dirs, two exe-relative locations are always
/// probed so pure-CLI installs (no Tauri resource_dir) get code-RSI too:
/// `<exe_dir>/../share/feral` — where `scripts/install.sh --headless`
/// places the bundle (XDG layout: `~/.local/bin` + `~/.local/share/feral`)
/// — and `<exe_dir>` itself, which also covers a CLI binary dropped next
/// to a desktop install (resources live beside the exe on Windows).
pub fn find_bundled_src(search_dirs: &[PathBuf]) -> Option<PathBuf> {
    if let Some(hit) = find_in_dirs(search_dirs) {
        return Some(hit);
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    find_in_dirs(&[exe_dir.join("..").join("share").join("feral"), exe_dir])
}

fn find_in_dirs(search_dirs: &[PathBuf]) -> Option<PathBuf> {
    search_dirs.iter().find_map(|dir| {
        [dir.clone(), dir.join("_up_")]
            .into_iter()
            .find(|root| root.join("FeralAgent").join("package.json").is_file())
    })
}

/// Read `"version"` out of a package.json without a JSON dependency walk.
fn package_version(pkg_json: &Path) -> Option<String> {
    let text = std::fs::read_to_string(pkg_json).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(|s| s.to_string())
}

/// Copy `src` into `dst` recursively, skipping build artifacts. Existing
/// files are overwritten (provisioning a new version replaces the tree;
/// the git history in `.git` survives because we never touch it here).
fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    const SKIP: [&str; 4] = ["node_modules", "dist", ".git", "target"];
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if SKIP.contains(&name_str.as_ref()) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map(|_| ())
                .map_err(|e| format!("copy {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

fn run_git(repo: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(repo);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("git not available: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&"?"),
            String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("").trim()
        ))
    }
}

/// Provision `~/.feral/self-src` from the bundled sources. Idempotent:
/// when the provisioned version matches the bundle and the repo exists,
/// this is a no-op returning the existing path. A version change
/// re-copies the tree and commits it on top of the existing history —
/// the substrate keeps its lineage across app updates.
pub fn provision(search_dirs: &[PathBuf]) -> Result<PathBuf, String> {
    let bundled = find_bundled_src(search_dirs)
        .ok_or_else(|| "no bundled FeralAgent sources in resource dirs".to_string())?;
    let version = package_version(&bundled.join("FeralAgent").join("package.json"))
        .ok_or_else(|| "bundled package.json has no version".to_string())?;

    let target = crate::paths::feral_dir().join(SELF_SRC_DIR);
    let provisioned_version =
        package_version(&target.join("FeralAgent").join("package.json"));
    if provisioned_version.as_deref() == Some(version.as_str()) && target.join(".git").exists() {
        return Ok(target);
    }

    // Copy FeralAgent/ + scripts/ (the rebuild scripts live there).
    copy_tree(&bundled.join("FeralAgent"), &target.join("FeralAgent"))?;
    let scripts = bundled.join("scripts");
    if scripts.is_dir() {
        copy_tree(&scripts, &target.join("scripts"))?;
    }

    if !target.join(".git").exists() {
        run_git(&target, &["init"])?;
    }
    run_git(&target, &["add", "-A"])?;
    // Identity flags keep this independent of the user's git config; an
    // empty diff (re-run after a failed later step) must not error.
    let msg = format!("self-src {version}");
    let _ = run_git(
        &target,
        &[
            "-c", "user.name=feral", "-c", "user.email=feral@local",
            "commit", "--allow-empty", "-m", &msg,
        ],
    );

    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, content: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn find_bundled_src_handles_tauri_up_nesting() {
        let tmp = tempfile::tempdir().unwrap();
        // Simulate resource_dir/_up_/FeralAgent/package.json
        let nested = tmp.path().join("_up_");
        write(&nested.join("FeralAgent").join("package.json"), "{\"version\":\"1.2.3\"}");
        let hit = find_bundled_src(&[tmp.path().to_path_buf()]).unwrap();
        assert_eq!(hit, nested);
        // Nothing there → None.
        let empty = tempfile::tempdir().unwrap();
        assert!(find_bundled_src(&[empty.path().to_path_buf()]).is_none());
    }

    #[test]
    fn bundled_src_lookup_never_crawls_unrelated_build_trees() {
        let tmp = tempfile::tempdir().unwrap();
        // `resource_dir` is target/debug in a Tauri dev run. Descending from
        // there walks thousands of Cargo artifact directories before the
        // sidecar can even spawn. Only documented resource layouts belong in
        // this lookup; an arbitrary nested match must be ignored.
        write(
            &tmp.path()
                .join("build")
                .join("dependency")
                .join("FeralAgent")
                .join("package.json"),
            "{\"version\":\"1.2.3\"}",
        );

        assert!(find_in_dirs(&[tmp.path().to_path_buf()]).is_none());
    }

    #[test]
    fn copy_tree_skips_artifacts_and_overwrites() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        write(&src.path().join("a.ts"), "one");
        write(&src.path().join("node_modules").join("x.js"), "no");
        write(&src.path().join("sub").join("b.ts"), "two");
        copy_tree(src.path(), dst.path()).unwrap();
        assert!(dst.path().join("a.ts").exists());
        assert!(dst.path().join("sub").join("b.ts").exists());
        assert!(!dst.path().join("node_modules").exists());
        // Overwrite on re-copy.
        write(&src.path().join("a.ts"), "changed");
        copy_tree(src.path(), dst.path()).unwrap();
        assert_eq!(std::fs::read_to_string(dst.path().join("a.ts")).unwrap(), "changed");
    }

    #[test]
    fn package_version_reads_version() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("package.json");
        write(&p, "{\"name\":\"feral-agent\",\"version\":\"2026.7.17\"}");
        assert_eq!(package_version(&p).as_deref(), Some("2026.7.17"));
        assert!(package_version(&tmp.path().join("missing.json")).is_none());
    }
}
