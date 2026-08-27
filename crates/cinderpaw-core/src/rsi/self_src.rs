//! Self-source provisioning — code-RSI in PRODUCTION installs (option A).
//!
//! A shipped install is a compiled binary; without sources on disk the
//! whole L3 loop (propose → worktree eval → ratchet → approve → apply →
//! rebuild) is structurally impossible for a real user. The bundle now
//! carries the sidecar sources as Tauri resources; this module copies
//! them to `~/.feral/self-src/` on first spawn, turns that copy into a
//! git repo (the substrate/worktree machinery requires one), and hands
//! the path back so the supervisor can export `CINDERPAW_CODE_RSI_REPO`.
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
/// a directory containing `CinderpawAgent/package.json`. Tauri flattens
/// `../` resource paths under `_up_/`, so those two documented layouts are
/// checked directly. Never recurse from a resource directory: in a Tauri dev
/// run it can be `target/debug`, whose Cargo artifact tree contains thousands
/// of directories and used to delay the sidecar spawn by minutes.
///
/// Beyond the host-supplied dirs, two exe-relative locations are always
/// probed so pure-CLI installs (no Tauri resource_dir) get code-RSI too:
/// `<exe_dir>/../share/cinderpaw` — where `scripts/install.sh --headless`
/// places the bundle (XDG layout: `~/.local/bin` + `~/.local/share/cinderpaw`)
/// — and `<exe_dir>` itself, which also covers a CLI binary dropped next
/// to a desktop install (resources live beside the exe on Windows).
///
/// `share/feral` is still probed after it: an install from before the rename
/// has the bundle under the old name, and silently losing code-RSI on upgrade
/// is a capability disappearing with nothing on screen to explain it.
pub fn find_bundled_src(search_dirs: &[PathBuf]) -> Option<PathBuf> {
    if let Some(hit) = find_in_dirs(search_dirs) {
        return Some(hit);
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let share = exe_dir.join("..").join("share");
    find_in_dirs(&[share.join("cinderpaw"), share.join("feral"), exe_dir])
}

fn find_in_dirs(search_dirs: &[PathBuf]) -> Option<PathBuf> {
    search_dirs.iter().find_map(|dir| {
        [dir.clone(), dir.join("_up_")]
            .into_iter()
            .find(|root| root.join("CinderpawAgent").join("package.json").is_file())
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
        // Symlinks are skipped, never followed.
        //
        // `is_dir()` and `fs::copy` both resolve the target, so a link inside
        // the bundle pulled in whatever it pointed at ON THIS MACHINE — a
        // `docs/notes -> /etc/shadow` would arrive in the copied tree as the
        // file's contents, and the copied tree is then committed into the RSI
        // git substrate. A link pointing back at an ancestor recursed until the
        // stack ran out.
        let file_type = entry
            .file_type()
            .map_err(|e| format!("file type {}: {e}", from.display()))?;
        if file_type.is_symlink() {
            tracing::warn!(path = %from.display(), "self-src: skipping symlink — not copied into the bundle");
            continue;
        }
        if file_type.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map(|_| ())
                .map_err(|e| format!("copy {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

/// Keep obvious secrets out of the self-source git substrate.
///
/// Written once and then left alone, so a user who edits it keeps their edit.
fn ensure_gitignore(target: &Path) -> Result<(), String> {
    let path = target.join(".gitignore");
    if path.exists() {
        return Ok(());
    }
    let content = "# Written by Cinderpaw when provisioning the RSI self-source tree.
# Anything staged here becomes a permanent git object in the RSI substrate.

# Secrets, wherever they land
.env
.env.*
.envrc
.npmrc
*.pem
*.key
*.p12
id_rsa*
id_ed25519*
credentials*
*.credentials
.aws/
.ssh/
.gnupg/

# Build outputs (copy_tree already skips these; belt and braces)
node_modules/
dist/
target/
";
    std::fs::write(&path, content).map_err(|e| format!("write .gitignore: {e}"))
}

fn run_git(repo: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    // Config overrides FIRST, before the subcommand: the user's own gitconfig
    // is not a safe input for a command running unattended inside a sidecar.
    //
    // `commit.gpgsign = true` — a common, reasonable setting — makes `git
    // commit` invoke gpg, which asks for a passphrase. With no terminal and no
    // stdin, that is a provisioning step that hangs forever at app start, with
    // no window, no prompt and nothing in the UI to say why nothing works.
    // `init.defaultBranch` is pinned for a different reason: the rest of the
    // RSI code assumes `main`, and a user still defaulting to `master` got a
    // substrate whose branch nothing else could find.
    cmd.arg("-c").arg("commit.gpgsign=false");
    cmd.arg("-c").arg("tag.gpgsign=false");
    cmd.arg("-c").arg("init.defaultBranch=main");
    cmd.args(args).current_dir(repo);
    // Nothing may read from the terminal: closed stdin turns any interactive
    // prompt into an immediate failure instead of a silent wait.
    cmd.stdin(std::process::Stdio::null());
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env_remove("EDITOR");
    cmd.env_remove("VISUAL");
    cmd.env_remove("GIT_EDITOR");
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
        .ok_or_else(|| "no bundled CinderpawAgent sources in resource dirs".to_string())?;
    let version = package_version(&bundled.join("CinderpawAgent").join("package.json"))
        .ok_or_else(|| "bundled package.json has no version".to_string())?;

    let target = crate::paths::feral_dir().join(SELF_SRC_DIR);
    let provisioned_version =
        package_version(&target.join("CinderpawAgent").join("package.json"));
    if provisioned_version.as_deref() == Some(version.as_str()) && target.join(".git").exists() {
        return Ok(target);
    }

    // Copy CinderpawAgent/ + scripts/ (the rebuild scripts live there).
    copy_tree(&bundled.join("CinderpawAgent"), &target.join("CinderpawAgent"))?;
    let scripts = bundled.join("scripts");
    if scripts.is_dir() {
        copy_tree(&scripts, &target.join("scripts"))?;
    }

    if !target.join(".git").exists() {
        run_git(&target, &["init"])?;
    }
    // A .gitignore BEFORE `git add -A`, which otherwise stages whatever happens
    // to be in the tree. Anything a person drops into this directory while
    // testing — a .env, an API key in a scratch config — becomes a git object
    // inside the RSI substrate, and from there it is in the lineage, the diffs,
    // and anything that publishes them. Git objects are not easy to un-write.
    ensure_gitignore(&target)?;
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
        // Simulate resource_dir/_up_/CinderpawAgent/package.json
        let nested = tmp.path().join("_up_");
        write(&nested.join("CinderpawAgent").join("package.json"), "{\"version\":\"1.2.3\"}");
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
                .join("CinderpawAgent")
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
