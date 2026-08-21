//! Install provenance — the one fact `cinderpaw update` and `cinderpaw uninstall` both
//! need and neither can guess.
//!
//! Cinderpaw arrives four different ways (npm, a from-source headless build, a
//! .deb/.rpm desktop package, a macOS .app) and every one of them updates and
//! removes differently. Assuming npm is not a harmless default: it told a
//! from-source VPS to `npm install -g cinderpaw-agent@latest`, which would have put
//! a SECOND, unrelated `cinderpaw` earlier on PATH and left the real one to rot.
//!
//! Two rules the rest of this module exists to keep:
//!
//! 1. We only ever delete a layout WE created (scripts/install.sh's). npm, apt
//!    and dnf own their files and know how to remove them; we print the command
//!    instead of racing the package manager.
//! 2. `~/.cinderpaw` — settings, memory, keys, models — survives an uninstall
//!    unless `--purge` says otherwise. Reinstalling should resume, not restart.

// Palette fields destructure into SCREAMING locals so `{ACCENT}`-style
// interpolation reads the same here as in admin.rs / chat.rs / guided.rs.
#![allow(non_snake_case)]

use std::path::{Path, PathBuf};

use crate::common::{api_port, palette, port_in_use, Palette};

const ONE_LINER: &str =
    "curl -fsSL https://raw.githubusercontent.com/bloom500/feral/main/scripts/install.sh | bash";

/// How Cinderpaw got onto this machine.
#[derive(Debug, PartialEq)]
pub enum Kind {
    /// `npm i -g feral-agent` — the binary sits under node_modules.
    Npm,
    /// Built by scripts/install.sh: binaries in ~/.local/bin, checkout in
    /// ~/src/feral. `script` is the installer that can redo it (it git-pulls
    /// and rebuilds, so it doubles as the updater).
    Source { script: Option<PathBuf>, checkout: Option<PathBuf> },
    /// Running out of a git checkout — a developer's build tree, not an
    /// install. Never removed, never auto-updated: `tree` is someone's work.
    Dev { tree: PathBuf },
    /// .deb / .rpm desktop package.
    SystemPackage,
    /// /Applications/Cinderpaw.app
    MacApp,
    Unknown,
}

/// The kinds a path alone settles. Pure, so the rules stay testable without an
/// install of each flavor on the machine running the tests.
fn classify(exe: &Path) -> Option<Kind> {
    let s = exe.to_string_lossy().replace('\\', "/");
    if s.contains("/node_modules/") {
        return Some(Kind::Npm);
    }
    if s.contains("/Cinderpaw.app/") {
        return Some(Kind::MacApp);
    }
    if s.starts_with("/usr/") {
        return Some(Kind::SystemPackage);
    }
    None
}

pub fn detect() -> Kind {
    let exe = std::env::current_exe().and_then(|p| p.canonicalize()).unwrap_or_default();
    if let Some(kind) = classify(&exe) {
        return kind;
    }
    // Sitting inside a checkout means this is `target/release/cinderpaw-cli`, i.e.
    // a build tree. Bail before anything below can offer to delete it.
    if let Some(tree) = exe.ancestors().find(|d| d.join("crates").join("cinderpaw-cli").is_dir()) {
        return Kind::Dev { tree: tree.to_path_buf() };
    }
    // install.sh copies the binaries to ~/.local/bin, so the checkout is NOT on
    // the exe path — look where the installer puts it, and for the scripts/
    // bundle it drops next to the self-sources for exactly this case.
    let checkout = home()
        .map(|h| h.join("src").join("feral"))
        .filter(|p| p.join(".git").exists());
    let script = [
        checkout.as_ref().map(|c| c.join("scripts").join("install.sh")),
        // Both share dirs: the bundle moved to `share/cinderpaw` with the
        // rename, and an install from before it still has `share/feral`.
        // Missing this is not cosmetic — the install classifies as Unknown and
        // `cinderpaw update` tells the person to update it by hand.
        home().map(|h| h.join(".local").join("share").join("cinderpaw").join("scripts").join("install.sh")),
        home().map(|h| h.join(".local").join("share").join("feral").join("scripts").join("install.sh")),
    ]
    .into_iter()
    .flatten()
    .find(|p| p.is_file());

    if script.is_some() || checkout.is_some() {
        Kind::Source { script, checkout }
    } else {
        Kind::Unknown
    }
}

/// `canonicalize` returns Windows' `\\?\` extended-length form — correct for
/// the filesystem, wrong inside a command we ask someone to paste into a shell.
fn show(p: &Path) -> String {
    p.display().to_string().trim_start_matches(r"\\?\").to_string()
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

// ── update ─────────────────────────────────────────────────────────────────

pub fn update() -> i32 {
    let Palette { accent: ACCENT, meta: META, warn: WARN, dim: DIM, reset: RESET, .. } = palette();
    match detect() {
        // The npm launcher (bin/cinderpaw.js) intercepts `update` and never reaches
        // this binary: it is the file npm has to replace, and Windows will not
        // overwrite a running .exe. Getting here means direct invocation.
        Kind::Npm => {
            eprintln!("cinderpaw: `update` is handled by the npm launcher, not this binary.");
            eprintln!("       run:  npm install -g cinderpaw-agent@latest");
            1
        }
        Kind::Dev { tree } => {
            eprintln!("{WARN}feral: this is a build from {}, not an install.{RESET}", show(&tree));
            eprintln!("       update it the way you built it:");
            eprintln!("         git -C {} pull && cargo build --release -p cinderpaw-cli", show(&tree));
            1
        }
        Kind::Source { script: Some(script), .. } => {
            println!("  {ACCENT}updating from source{RESET}  {DIM}{META}{}{RESET}", script.display());
            run_installer(&script)
        }
        _ => {
            eprintln!("cinderpaw: this install is managed by its packaging — re-run the installer:");
            if cfg!(windows) {
                eprintln!("       see the PowerShell one-liner in the README (or: npm install -g cinderpaw-agent@latest)");
            } else {
                eprintln!("       {ONE_LINER}");
            }
            1
        }
    }
}

/// scripts/install.sh IS the updater: it git-pulls the checkout, rebuilds the
/// CLI + sidecar + TUI and re-installs all three. Replacing a running binary is
/// safe here because `install(1)` unlinks the target first — but that also
/// means our own `/proc/self/exe` is a deleted inode afterwards, so the restart
/// below must spawn the PATH we were invoked as, not `current_exe()`.
fn run_installer(script: &Path) -> i32 {
    let Palette { accent: ACCENT, meta: META, ok: OK, fail: FAIL, dim: DIM, reset: RESET, .. } =
        palette();
    // Sampled BEFORE the build: an update must never start a gateway the user
    // did not already have running — but it MUST restart one they did, or the
    // Discord/Slack connector keeps serving the old build indefinitely.
    let was_online = port_in_use(api_port());
    let exe = std::env::current_exe().ok();

    match std::process::Command::new("bash").arg(script).arg("--headless").status() {
        Ok(s) if s.success() => {}
        Ok(s) => {
            eprintln!("{FAIL}feral: the installer failed{RESET} (exit {})", s.code().unwrap_or(-1));
            return s.code().unwrap_or(1);
        }
        Err(e) => {
            eprintln!("{FAIL}feral: could not run {}{RESET}: {e}", script.display());
            eprintln!("       re-run it by hand:  bash {} --headless", script.display());
            return 1;
        }
    }

    if !was_online {
        println!("{OK}feral: updated{RESET} — start it with: cinderpaw gateway start");
        return 0;
    }
    println!("  {ACCENT}restarting the gateway{RESET}  {DIM}{META}connectors reconnect on the new build{RESET}");
    match exe {
        // The new binary drives its own restart — same reason the npm launcher
        // re-execs itself after `npm install`.
        Some(exe) => match std::process::Command::new(exe).args(["gateway", "restart"]).status() {
            Ok(s) => s.code().unwrap_or(0),
            Err(e) => {
                eprintln!("{FAIL}feral: updated, but the restart failed{RESET}: {e}");
                eprintln!("       run:  cinderpaw gateway restart");
                1
            }
        },
        None => crate::admin::gateway_restart(),
    }
}

// ── uninstall ──────────────────────────────────────────────────────────────

pub fn uninstall(purge: bool, yes: bool) -> i32 {
    let Palette {
        accent: ACCENT, text: TEXT, meta: META, ok: OK, warn: WARN, fail: FAIL, bold: BOLD,
        dim: DIM, reset: RESET, ..
    } = palette();
    let kind = detect();
    let data = cinderpaw_core::paths::feral_dir();

    // Paths we remove ourselves, and commands only the package manager can run.
    let mut targets: Vec<PathBuf> = Vec::new();
    let mut manual: Vec<&str> = Vec::new();

    match &kind {
        Kind::Source { checkout, .. } => {
            // The find_binary contract puts the sidecar and TUI next to the CLI,
            // so the install is exactly these three files plus the self-source
            // bundle and the checkout they were built from.
            if let Ok(exe) = std::env::current_exe().and_then(|p| p.canonicalize()) {
                if let Some(dir) = exe.parent() {
                    // Both generations of names: an install from before the
                    // rename has the old ones, and an uninstall that leaves
                    // binaries behind is not an uninstall.
                    for sib in
                        ["cinderpaw-agent", "cinderpaw-tui", "feral-agent", "feral-tui", "feral"]
                    {
                        let p = dir.join(sib);
                        if p.exists() {
                            targets.push(p);
                        }
                    }
                }
                targets.push(exe);
            }
            for name in ["cinderpaw", "feral"] {
                if let Some(share) = home().map(|h| h.join(".local").join("share").join(name)) {
                    if share.exists() {
                        targets.push(share);
                    }
                }
            }
            if let Some(c) = checkout {
                targets.push(c.clone());
            }
        }
        Kind::Npm => manual.push("npm uninstall -g cinderpaw-agent"),
        // The package was called `feral` before the rename, and this machine
        // may still be holding that one — naming only the new package would
        // print a command that reports "not installed" and leaves the install
        // exactly where it was.
        Kind::SystemPackage => manual.push(if Path::new("/usr/bin/dpkg").exists() {
            "sudo apt-get remove cinderpaw    (or `feral`, if installed before the rename)"
        } else {
            "sudo dnf remove cinderpaw        (or `feral`, if installed before the rename)"
        }),
        Kind::MacApp => manual.push("rm -rf /Applications/Cinderpaw.app"),
        Kind::Dev { tree } => {
            eprintln!("{WARN}feral: this is a build tree, not an install{RESET} ({})", show(tree));
            eprintln!("       nothing here was installed, so nothing is removed — delete the");
            eprintln!("       checkout yourself if that is what you meant.");
            if !purge {
                return 1;
            }
        }
        Kind::Unknown => manual.push("(unrecognized layout — remove the `cinderpaw` binary by hand)"),
    }

    if purge && data.exists() {
        targets.push(data.clone());
    }
    // Both name generations are collected above, so a machine holding only one
    // of them can list the same path twice — and the second removal would fail
    // and be reported as an error on a file that IS gone.
    targets.sort();
    targets.dedup();
    if targets.is_empty() && manual.is_empty() {
        println!("{META}feral: nothing to remove{RESET}");
        return 0;
    }

    println!("\n  {BOLD}{ACCENT}cinderpaw uninstall{RESET}");
    for t in &targets {
        println!(
            "    {FAIL}remove{RESET}        {TEXT}{}{RESET}  {DIM}{META}{}{RESET}",
            show(t),
            human(size_of(t))
        );
    }
    for m in &manual {
        println!("    {WARN}run yourself{RESET}  {TEXT}{m}{RESET}");
    }
    if purge {
        println!(
            "\n    {FAIL}{BOLD}--purge{RESET}{FAIL}: settings, memory, API keys and models go with it.{RESET}"
        );
        println!("    {FAIL}Not recoverable. A reinstall starts from zero.{RESET}");
    } else {
        println!(
            "\n    {OK}kept{RESET}          {TEXT}{}{RESET}  {DIM}{META}{}{RESET}",
            data.display(),
            human(size_of(&data))
        );
        println!("    {DIM}{META}settings, memory, keys, models — a reinstall picks up where you left off.{RESET}");
        println!("    {DIM}{META}add --purge to delete that too.{RESET}");
    }

    if !yes && !confirm("proceed?") {
        println!("  {DIM}cancelled{RESET}");
        return 1;
    }

    if port_in_use(api_port()) {
        println!("\n  {META}stopping the gateway first…{RESET}");
        crate::admin::gateway_stop();
    }

    let mut failed = 0;
    for t in &targets {
        let removed = if t.is_dir() { std::fs::remove_dir_all(t) } else { std::fs::remove_file(t) };
        match removed {
            Ok(()) => println!("  {OK}removed{RESET} {DIM}{META}{}{RESET}", show(t)),
            Err(e) => {
                failed += 1;
                eprintln!("  {FAIL}could not remove {}{RESET}: {e}", show(t));
            }
        }
    }
    if strip_path_line() {
        println!("  {OK}removed{RESET} {DIM}{META}the PATH line from ~/.bashrc{RESET}");
    }

    if !manual.is_empty() {
        println!("\n  {WARN}still to run yourself:{RESET}");
        for m in &manual {
            println!("    {TEXT}{m}{RESET}");
        }
    }
    if !purge && data.exists() {
        println!("\n  {OK}kept{RESET} {TEXT}{}{RESET} — reinstall to resume.", data.display());
        println!("  {DIM}{META}delete it later with:  rm -rf {}{RESET}", data.display());
    }
    if failed > 0 {
        if cfg!(windows) {
            eprintln!("\n{WARN}Windows cannot delete a running .exe — close Cinderpaw and remove the rest by hand.{RESET}");
        }
        return 1;
    }
    0
}

fn confirm(prompt: &str) -> bool {
    let Palette { meta: META, reset: RESET, .. } = palette();
    crate::common::reset_console_mode();
    eprint!("\n  {META}{prompt}{RESET} [y/N] ");
    let _ = std::io::Write::flush(&mut std::io::stderr());
    let mut answer = String::new();
    // A closed/piped stdin reads 0 bytes → empty → "no". Destructive default.
    if std::io::stdin().read_line(&mut answer).is_err() {
        return false;
    }
    matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

/// The exact two lines scripts/install.sh appends to ~/.bashrc, and nothing
/// else. Matched literally: a line the user edited is a line we leave alone.
fn without_path_line(text: &str) -> Option<String> {
    const BLOCK: &str = "\n# Added by Cinderpaw installer\nexport PATH=\"$HOME/.local/bin:$PATH\"\n";
    text.contains(BLOCK).then(|| text.replace(BLOCK, ""))
}

fn strip_path_line() -> bool {
    let Some(rc) = home().map(|h| h.join(".bashrc")) else { return false };
    let Ok(text) = std::fs::read_to_string(&rc) else { return false };
    match without_path_line(&text) {
        Some(stripped) => std::fs::write(&rc, stripped).is_ok(),
        None => false,
    }
}

/// `symlink_metadata` (not `metadata`) keeps a symlinked directory from being
/// walked — no cycles, and no counting bytes that live outside the tree.
fn size_of(p: &Path) -> u64 {
    let Ok(md) = std::fs::symlink_metadata(p) else { return 0 };
    if md.is_dir() {
        std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| size_of(&e.path())).sum()
    } else {
        md.len()
    }
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_packaged_installs() {
        let cases = [
            ("/home/d/.npm-global/lib/node_modules/feral-agent/vendor/cinderpaw-cli", Some(Kind::Npm)),
            (r"C:\Users\d\AppData\Roaming\npm\node_modules\feral-agent\vendor\cinderpaw-cli.exe", Some(Kind::Npm)),
            ("/Applications/Cinderpaw.app/Contents/MacOS/feral", Some(Kind::MacApp)),
            ("/usr/bin/feral", Some(Kind::SystemPackage)),
            // The two that must fall through to the filesystem probes.
            ("/home/d/.local/bin/feral", None),
            ("/home/d/src/feral/target/release/cinderpaw-cli", None),
        ];
        for (path, want) in cases {
            assert_eq!(classify(Path::new(path)), want, "{path}");
        }
    }

    /// The rule that keeps `cinderpaw uninstall` from eating a developer's work:
    /// running from inside a checkout is `Dev`, and `Dev` deletes nothing.
    #[test]
    fn a_build_tree_is_never_an_install() {
        let dir = std::env::temp_dir().join("feral-uninstall-test/crates/cinderpaw-cli");
        std::fs::create_dir_all(&dir).unwrap();
        let tree = dir.parent().unwrap().parent().unwrap();
        let exe = tree.join("target/release/cinderpaw-cli");
        assert!(classify(&exe).is_none());
        assert!(exe.ancestors().any(|d| d.join("crates").join("cinderpaw-cli").is_dir()));
        let _ = std::fs::remove_dir_all(tree);
    }

    #[test]
    fn strips_only_the_line_the_installer_wrote() {
        let rc = "export EDITOR=vim\n\n# Added by Cinderpaw installer\nexport PATH=\"$HOME/.local/bin:$PATH\"\nalias k=kubectl\n";
        assert_eq!(
            without_path_line(rc).unwrap(),
            "export EDITOR=vim\nalias k=kubectl\n"
        );
        // A user-edited variant is not ours to touch.
        assert!(without_path_line("export PATH=\"$HOME/.local/bin:$PATH\"\n").is_none());
    }

    #[test]
    fn sizes_read_as_sizes() {
        assert_eq!(human(0), "0 B");
        assert_eq!(human(999), "999 B");
        assert_eq!(human(1536), "1.5 KB");
        assert_eq!(human(7 * 1024 * 1024 * 1024), "7.0 GB");
    }
}
