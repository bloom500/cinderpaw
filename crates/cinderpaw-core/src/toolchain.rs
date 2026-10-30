//! Portable toolchain — git + bun without asking the user to touch a
//! terminal (users-first: the code-RSI loop needs them, a non-tech user
//! will never `winget install` anything).
//!
//! Strategy: PORTABLE copies under `~/.cinderpaw/toolchain/`, not system
//! installers — no UAC/admin, no PATH pollution outside our process
//! tree, uninstall = delete the folder.
//!
//!   - Windows: MinGit (portable git) + bun's official zip.
//!   - Linux/macOS: bun's official zip. Git stays a system concern
//!     (package managers own it; the .deb/.rpm declare it as a
//!     dependency, and macOS auto-offers the CLT dialog on first use).
//!
//! Flow: `activate_portable()` prepends any already-downloaded portable
//! dirs to THIS process's PATH (children inherit — sidecar, rebuild
//! scripts, git calls all pick them up with zero per-callsite wiring).
//! `ensure_background()` quick-probes PATH and, only when a needed tool
//! is missing, downloads + extracts it off the hot path, then activates.
//! Failures log and leave the system exactly as before — the RSI loop
//! simply reports "bun unavailable" at its own stage.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static ENSURE_RUNNING: AtomicBool = AtomicBool::new(false);

fn toolchain_dir() -> PathBuf {
    crate::paths::cinderpaw_dir().join("toolchain")
}

/// Where a portable tool's executables land, when present.
fn portable_bin_dirs() -> Vec<PathBuf> {
    let root = toolchain_dir();
    let mut dirs = Vec::new();
    // MinGit layout: <root>/git/cmd/git.exe
    let git_cmd = root.join("git").join("cmd");
    if git_cmd.join("git.exe").exists() {
        dirs.push(git_cmd);
    }
    // bun zips contain a single folder (bun-<platform>/bun[.exe]); we
    // flatten to <root>/bun/ at extract time.
    let bun_dir = root.join("bun");
    let bun_name = if cfg!(windows) { "bun.exe" } else { "bun" };
    if bun_dir.join(bun_name).exists() {
        dirs.push(bun_dir);
    }
    dirs
}

/// Prepend existing portable dirs to this PROCESS's PATH (idempotent).
/// Children inherit, so one call at supervisor startup covers the
/// sidecar, worktree evals, and rebuild scripts alike.
pub fn activate_portable() {
    let dirs = portable_bin_dirs();
    if dirs.is_empty() {
        return;
    }
    let current = std::env::var_os("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let current_str = current.to_string_lossy();
    let mut prefix = String::new();
    for d in &dirs {
        let ds = d.to_string_lossy();
        if !current_str.contains(ds.as_ref()) {
            prefix.push_str(&ds);
            prefix.push_str(sep);
        }
    }
    if !prefix.is_empty() {
        std::env::set_var("PATH", format!("{prefix}{current_str}"));
        tracing::info!("toolchain: activated portable dirs {:?}", dirs);
    }
}

/// True when `<name> --version` exits 0 (the same probe the sidecar uses).
fn on_path(name: &str) -> bool {
    let mut cmd = std::process::Command::new(name);
    cmd.arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    matches!(cmd.status(), Ok(s) if s.success())
}

/// Locate a Node runtime, or say there is none.
///
/// Node rather than bun, and that is measured, not a preference: the LiveKit
/// agent SDK forks a supervised child process per job, and under bun that fork
/// dies with `process exited before initializing` while the worker itself
/// registers happily. See `docs/voice-livekit.md`.
///
/// PATH is tried first, then the handful of places an installer actually puts
/// it. The absolute paths are not redundancy for its own sake: a GUI app on
/// macOS does not inherit the login shell's PATH, so the machine where a
/// developer just ran `node --version` in a terminal is precisely the machine
/// where PATH-only lookup fails and the report reads "Node is not installed".
pub fn find_node() -> Option<PathBuf> {
    if on_path("node") {
        // Bare name: let the OS resolve it, the same way every child process
        // spawned from this app already does.
        return Some(PathBuf::from("node"));
    }
    let candidates: &[&str] = if cfg!(windows) {
        // Forward slashes: Windows accepts them in paths, and they survive
        // every layer of tooling that eats a backslash on the way here.
        &["C:/Program Files/nodejs/node.exe", "C:/Program Files (x86)/nodejs/node.exe"]
    } else {
        &[
            "/opt/homebrew/bin/node", // Apple silicon homebrew
            "/usr/local/bin/node",    // Intel homebrew, and most installers
            "/usr/bin/node",
        ]
    };
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        // Last: the copy `fetch_node` downloaded on a machine that had none.
        .or_else(|| Some(portable_node()).filter(|p| p.exists()))
}

/// Pinned Node.js LTS for the voice worker, with the SHA-256 nodejs.org
/// publishes for each archive (dist/v24.21.0/SHASUMS256.txt, read 7 Oct 2026).
/// The hash is in the source, not fetched next to the archive, so a tampered
/// download server cannot hand over a matching pair.
const NODE_VERSION: &str = "v24.21.0";

fn node_archive() -> Option<(&'static str, &'static str)> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => ("win-x64.zip", "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"),
        ("windows", "aarch64") => ("win-arm64.zip", "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921"),
        ("macos", "aarch64") => ("darwin-arm64.tar.gz", "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"),
        ("macos", "x86_64") => ("darwin-x64.tar.gz", "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"),
        ("linux", "x86_64") => ("linux-x64.tar.gz", "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"),
        ("linux", "aarch64") => ("linux-arm64.tar.gz", "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5"),
        _ => return None,
    })
}

/// Where `fetch_node` puts node: the archive's own layout, flattened.
fn portable_node() -> PathBuf {
    let root = toolchain_dir().join("node");
    if cfg!(windows) {
        root.join("node.exe")
    } else {
        root.join("bin").join("node")
    }
}

/// Download the pinned Node into `~/.cinderpaw/toolchain/node/` and return
/// node's path. Voice needs it, and a stranger's machine usually has none:
/// this is the difference between a call and "install Node from nodejs.org".
/// npm comes in the same archive, next to node, which is where
/// `livekit::augmented_path` already looks for it.
///
/// `Err("livekit-no-node")` only when nodejs.org has no build for this
/// machine: the call screen turns that code into the install-it-yourself
/// sentence, which is then the right one. Every other error is a sentence.
// ponytail: a later NODE_VERSION bump does not replace a copy already on disk
// (the stamp is written; compare it in find_node when a bump needs to land).
pub async fn fetch_node() -> Result<PathBuf, String> {
    let (asset, sha256) = node_archive().ok_or_else(|| "livekit-no-node".to_string())?;
    let url = format!("https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-{asset}");
    tracing::info!("toolchain: voice needs node, downloading {url}");
    // Bounded like the npm install that follows it: a download that hangs
    // would leave the person on the call screen with a spinner and no reason.
    match tokio::time::timeout(std::time::Duration::from_secs(300), fetch_and_extract(&url, "node", Some(sha256))).await {
        Err(_) => Err("Getting voice ready is taking more than 5 minutes. Check the internet connection, then try the call again.".into()),
        Ok(Err(e)) => Err(format!("Voice needs Node.js, and downloading it failed ({e}). Check the internet connection, then try the call again.")),
        Ok(Ok(())) => Some(portable_node())
            .filter(|p| p.exists())
            .ok_or_else(|| "Voice needs Node.js, and the download did not contain it. Try the call again.".into()),
    }
}

/// Lowercase hex SHA-256, the format of nodejs.org's SHASUMS256.txt.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Pinned MinGit (portable git for Windows). Version bumps are a one-line
/// change; "latest" would require GitHub API JSON + rate limits.
#[cfg(windows)]
const MINGIT_URL: &str =
    "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip";

/// Pinned bun release. Pinned (not `latest`) so every install runs the
/// version we tested against, and so the stamp mechanism below can roll
/// the portable copy forward when a Cinderpaw update bumps this.
const BUN_VERSION: &str = "bun-v1.3.14";

fn bun_url() -> Option<String> {
    let asset = if cfg!(windows) {
        "bun-windows-x64.zip"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "bun-darwin-aarch64.zip" } else { "bun-darwin-x64.zip" }
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") { "bun-linux-aarch64.zip" } else { "bun-linux-x64.zip" }
    } else {
        return None;
    };
    Some(format!(
        "https://github.com/oven-sh/bun/releases/download/{BUN_VERSION}/{asset}"
    ))
}

/// The stamp records which URL produced a portable tool. A Cinderpaw update
/// that bumps a pin makes the stamp mismatch → the tool re-downloads.
/// This is the toolchain's whole update story: portable copies advance
/// WITH Cinderpaw releases, never behind the user's back.
fn stamp_path(name: &str) -> PathBuf {
    toolchain_dir().join(format!("{name}.version"))
}

fn stamp_matches(name: &str, url: &str) -> bool {
    std::fs::read_to_string(stamp_path(name)).is_ok_and(|s| s.trim() == url)
}

/// Ensure git + bun exist, downloading portable copies in the background
/// when missing. Returns immediately; at most one ensure runs at a time.
/// Call only when something actually needs the tools (code-RSI enabled) —
/// a ~90 MB download on machines that never use it would be rude.
pub fn ensure_background() {
    activate_portable();
    // A tool needs (re)installing when it is absent from PATH, or when the
    // PORTABLE copy is the one serving it and its stamp lags the pin (a
    // system-installed tool is the user's/package manager's to update).
    let bun_target = bun_url();
    let need_bun = match &bun_target {
        Some(url) => !on_path("bun") || (portable_serves("bun") && !stamp_matches("bun", url)),
        None => false,
    };
    #[cfg(windows)]
    let need_git = !on_path("git") || (portable_serves("git") && !stamp_matches("git", MINGIT_URL));
    #[cfg(not(windows))]
    let need_git = false; // system concern: deb/rpm depends + macOS CLT
    if !need_bun && !need_git {
        return;
    }
    if ENSURE_RUNNING.swap(true, Ordering::SeqCst) {
        return; // already downloading
    }
    tokio::spawn(async move {
        if need_bun {
            if let Some(url) = bun_target {
                match fetch_and_extract(&url, "bun", None).await {
                    Ok(()) => tracing::info!("toolchain: bun installed portably ({BUN_VERSION})"),
                    Err(e) => tracing::warn!("toolchain: bun install failed ({e}) — RSI stages needing bun will report unavailable"),
                }
            }
        }
        #[cfg(windows)]
        if need_git {
            match fetch_and_extract(MINGIT_URL, "git", None).await {
                Ok(()) => tracing::info!("toolchain: MinGit installed portably"),
                Err(e) => tracing::warn!("toolchain: git install failed ({e})"),
            }
        }
        activate_portable();
        ENSURE_RUNNING.store(false, Ordering::SeqCst);
    });
}

/// True when the portable copy of `name` exists — i.e., updates to it are
/// OUR responsibility, not a system package manager's.
fn portable_serves(name: &str) -> bool {
    let root = toolchain_dir();
    match name {
        "git" => root.join("git").join("cmd").join("git.exe").exists(),
        "bun" => {
            let bin = if cfg!(windows) { "bun.exe" } else { "bun" };
            root.join("bun").join(bin).exists()
        }
        _ => false,
    }
}

/// Download a zip (or, for node on mac/linux, a .tar.gz) and extract it under
/// `~/.cinderpaw/toolchain/<name>/`.
/// Extraction flattens a single top-level folder (bun's zip shape) so the
/// binary lands directly in the tool dir. Zip-slip safety comes from the
/// zip crate's sanitized `extract`. With `sha256`, a download that does not
/// match is refused before anything is unpacked.
pub(crate) async fn fetch_and_extract(url: &str, name: &str, sha256: Option<&str>) -> Result<(), String> {
    let bytes = reqwest::get(url)
        .await
        .map_err(|e| format!("download {url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download {url}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("read body: {e}"))?;
    if let Some(want) = sha256 {
        if sha256_hex(&bytes) != want {
            return Err(format!("{url} is not the file this version of Cinderpaw expects (checksum mismatch)"));
        }
    }

    let dest = toolchain_dir().join(name);
    let staging = toolchain_dir().join(format!(".{name}.staging"));
    let _ = std::fs::remove_dir_all(&staging);

    let staging_clone = staging.clone();
    let tarball = url.ends_with(".tar.gz") || url.ends_with(".tar.xz");
    let xz = url.ends_with(".tar.xz");
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&staging_clone).map_err(|e| format!("mkdir staging: {e}"))?;
        if tarball {
            // `tar` ships with every mac and linux, and keeps node's
            // executable bits and its bin/npm symlink, as `fetch_server` does.
            let file = staging_clone.with_extension(if xz { "tar.xz" } else { "tar.gz" });
            std::fs::write(&file, &bytes).map_err(|e| format!("write archive: {e}"))?;
            let ok = std::process::Command::new("tar")
                .arg(if xz { "xJf" } else { "xzf" })
                .arg(&file)
                .arg("-C")
                .arg(&staging_clone)
                .status()
                .is_ok_and(|s| s.success());
            let _ = std::fs::remove_file(&file);
            return if ok { Ok(()) } else { Err("tar could not unpack the archive".into()) };
        }
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("open zip: {e}"))?;
        archive.extract(&staging_clone).map_err(|e| format!("extract: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    // Flatten a lone top-level folder (bun-windows-x64/ etc.).
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&staging)
        .map_err(|e| format!("read staging: {e}"))?
        .flatten()
        .map(|e| e.path())
        .collect();
    let source = if entries.len() == 1 && entries[0].is_dir() {
        entries.remove(0)
    } else {
        staging.clone()
    };

    let _ = std::fs::remove_dir_all(&dest);
    std::fs::create_dir_all(dest.parent().unwrap_or(&dest)).ok();
    std::fs::rename(&source, &dest).map_err(|e| format!("move into place: {e}"))?;
    let _ = std::fs::remove_dir_all(&staging);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = dest.join("bun");
        if bin.exists() {
            let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
        }
    }
    // Stamp AFTER a fully successful install — a failed/partial extract
    // leaves no stamp, so the next ensure retries.
    let _ = std::fs::write(stamp_path(name), url);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_bin_dirs_empty_when_nothing_downloaded() {
        // No portable toolchain in a fresh test env → no dirs, and
        // activate_portable is a no-op that must not panic.
        let dirs = portable_bin_dirs();
        for d in &dirs {
            assert!(d.exists());
        }
        activate_portable();
    }

    #[test]
    fn bun_url_matches_platform() {
        let url = bun_url().expect("supported platform");
        assert!(url.contains("bun-"));
        assert!(url.ends_with(".zip"));
    }

    #[test]
    fn node_is_pinned_with_a_checksum_for_this_machine() {
        let (asset, sha) = node_archive().expect("every machine we build for has a node download");
        assert!(asset.ends_with(if cfg!(windows) { ".zip" } else { ".tar.gz" }));
        assert_eq!(sha.len(), 64);
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn sha256_hex_is_the_shasums_format() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    /// The whole first-call path on a machine with no Node, against the real
    /// nodejs.org: ~38 MB, free. `cargo test -p cinderpaw-core toolchain -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn fetch_node_gives_a_working_node_and_npm() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CINDERPAW_HOME", home.path());
        let node = fetch_node().await.expect("download, checksum, unpack");
        assert!(node.starts_with(home.path()));
        let ok = std::process::Command::new(&node).arg("--version").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&ok.stdout).trim(), NODE_VERSION);
        let npm = node.parent().unwrap().join(if cfg!(windows) { "npm.cmd" } else { "npm" });
        assert!(npm.exists(), "npm must sit next to node, where livekit looks for it");
        assert_eq!(find_node().map(|p| p == node || p == PathBuf::from("node")), Some(true));
    }
}
