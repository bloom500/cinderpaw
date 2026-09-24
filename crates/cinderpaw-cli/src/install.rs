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
use crate::footprint;

const PS_URL: &str = "https://raw.githubusercontent.com/bloom500/cinderpaw/main/scripts/install.ps1";

const ONE_LINER: &str =
    "curl -fsSL https://raw.githubusercontent.com/bloom500/cinderpaw/main/scripts/install.sh | bash";

/// How Cinderpaw got onto this machine.
#[derive(Debug, PartialEq)]
pub enum Kind {
    /// `npm i -g feral-agent` — the binary sits under node_modules.
    Npm,
    /// The one-command install (spec 2026-09-24): binaries in ~/.cinderpaw/bin,
    /// plus the autostart, PATH and shortcut footprint.rs knows how to remove.
    Folder,
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

fn is_folder_install(exe: &Path, data: &Path) -> bool {
    exe.parent() == Some(data.join("bin").as_path())
}

pub fn detect() -> Kind {
    let exe = std::env::current_exe().and_then(|p| p.canonicalize()).unwrap_or_default();
    if let Some(kind) = classify(&exe) {
        return kind;
    }
    let data = cinderpaw_core::paths::cinderpaw_dir();
    let data = data.canonicalize().unwrap_or(data);
    if is_folder_install(&exe, &data) {
        return Kind::Folder;
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
        // The one-liner IS the updater: it replaces the binaries and restarts
        // the engine (self-install). On Windows it renames the running .exe
        // aside first, which Windows allows where overwriting is refused.
        Kind::Folder => {
            let status = if cfg!(windows) {
                std::process::Command::new("powershell")
                    .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &format!("irm {PS_URL} | iex")])
                    .status()
            } else {
                std::process::Command::new("bash").args(["-c", ONE_LINER]).status()
            };
            status.map(|s| s.code().unwrap_or(1)).unwrap_or(1)
        }
        Kind::Dev { tree } => {
            eprintln!("{WARN}cinderpaw: this is a build from {}, not an install.{RESET}", show(&tree));
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
            eprintln!("{FAIL}cinderpaw: the installer failed{RESET} (exit {})", s.code().unwrap_or(-1));
            return s.code().unwrap_or(1);
        }
        Err(e) => {
            eprintln!("{FAIL}cinderpaw: could not run {}{RESET}: {e}", script.display());
            eprintln!("       re-run it by hand:  bash {} --headless", script.display());
            return 1;
        }
    }

    if !was_online {
        println!("{OK}cinderpaw: updated{RESET} — start it with: cinderpaw gateway start");
        return 0;
    }
    println!("  {ACCENT}restarting the gateway{RESET}  {DIM}{META}connectors reconnect on the new build{RESET}");
    match exe {
        // The new binary drives its own restart — same reason the npm launcher
        // re-execs itself after `npm install`.
        Some(exe) => match std::process::Command::new(exe).args(["gateway", "restart"]).status() {
            Ok(s) => s.code().unwrap_or(0),
            Err(e) => {
                eprintln!("{FAIL}cinderpaw: updated, but the restart failed{RESET}: {e}");
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
    let data = cinderpaw_core::paths::cinderpaw_dir();

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
        // Without --purge only the programs go; settings, memory and keys
        // stay so a reinstall resumes. --purge adds the whole folder below.
        Kind::Folder => {
            if !purge {
                targets.push(data.join("bin"));
            }
        }
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
            eprintln!("{WARN}cinderpaw: this is a build tree, not an install{RESET} ({})", show(tree));
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
        println!("{META}cinderpaw: nothing to remove{RESET}");
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
    if kind == Kind::Folder {
        println!("    {FAIL}remove{RESET}        {TEXT}start at login, the PATH entry, the Cinderpaw shortcut{RESET}");
        if purge {
            println!("    {FAIL}remove{RESET}        {TEXT}saved AI keys in the keychain{RESET}");
        }
    }
    if purge {
        println!(
            "\n    {FAIL}{BOLD}--purge{RESET}{FAIL}: removes the profile directory, including settings, memory and models.{RESET}"
        );
        if kind != Kind::Folder {
            println!("    {WARN}OS key-store credentials are retained; remove those separately if needed.{RESET}");
        }
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

    if kind == Kind::Folder {
        if let Some(h) = home() {
            for what in footprint::remove(&h) {
                println!("  {OK}removed{RESET} {DIM}{META}{what}{RESET}");
            }
        }
        if purge {
            for p in cinderpaw_core::byok::provider_catalog() {
                let _ = cinderpaw_core::byok::remove_provider(&p.id);
            }
            println!("  {OK}removed{RESET} {DIM}{META}saved AI keys from the keychain{RESET}");
        }
    }

    let mut failed = 0;
    for t in &targets {
        #[cfg(windows)]
        if kind == Kind::Folder {
            park_running_exe(t);
        }
        let removed = if t.is_dir() { remove_dir_retrying(t, 30) } else { std::fs::remove_file(t) };
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

// ── one-command install (spec 2026-09-24 §3) ─────────────────────────────

pub fn page_url() -> String {
    format!("{}/", crate::common::base_url())
}

fn url_with_code(base: &str, code: &str) -> String {
    format!("{base}#code={code}")
}

fn open_error(status: u16) -> String {
    if status == 404 {
        "The Cinderpaw desktop app is using this computer's Cinderpaw port. Close the desktop app, then open Cinderpaw again.".into()
    } else {
        format!("Cinderpaw couldn't open its page. Run `cinderpaw open` again. (code {status})")
    }
}

/// The page URL with a fresh one-time code (spec §4.2): the browser trades it
/// for a cookie and never sees the bearer token.
fn signed_in_url() -> Result<String, String> {
    let token = crate::common::read_token().ok_or("Cinderpaw is running but its key file is missing. Run `cinderpaw open` again.")?;
    let url = format!("{}/web/code", crate::common::base_url());
    let resp = crate::admin::block_on(async {
        reqwest::Client::new().post(&url).bearer_auth(&token).send().await
    })
    .map_err(|e| format!("Cinderpaw couldn't open its page: {e}"))?;
    if !resp.status().is_success() {
        return Err(open_error(resp.status().as_u16()));
    }
    let body: serde_json::Value = crate::admin::block_on(resp.json()).map_err(|e| e.to_string())?;
    let code = body["code"].as_str().ok_or("Cinderpaw sent an empty sign-in code.")?;
    Ok(url_with_code(&page_url(), code))
}

fn last_line(opened: bool, url: &str) -> String {
    if opened {
        "All set! Your browser just opened. You can close this window.".into()
    } else {
        format!("All set! Open this in your browser: {url}")
    }
}

/// Is the thing on our port a Cinderpaw that answers with our token?
fn is_ours() -> bool {
    crate::common::read_token()
        .map(|t| crate::admin::block_on(crate::admin::fetch_json(&t, "/runtime/status")).is_ok())
        .unwrap_or(false)
}

/// Engine up and ours, or a sentence saying why not. `restart` = the install
/// just replaced the binaries, so a running engine is the OLD build.
fn ensure_engine(restart: bool) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let port = api_port();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let quiet = |args: &[&str]| {
        Command::new(&exe)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if port_in_use(port) {
        if !is_ours() {
            return Err(format!(
                "Something else on this computer is using port {port}, which Cinderpaw needs. Close it and try again."
            ));
        }
        if !restart {
            return Ok(());
        }
        quiet(&["stop"]);
    }
    let home = home().ok_or("I couldn't find your home folder.")?;
    if !footprint::start_with_service(&home) {
        quiet(&["gateway", "start"]);
    }
    for _ in 0..60 {
        if port_in_use(port) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Err(format!(
        "Cinderpaw didn't start. Run the same command again. If it still fails, send us this file: {}",
        cinderpaw_core::paths::cinderpaw_dir().join("gateway.log").display()
    ))
}

fn launch_browser(url: &str) -> bool {
    use std::process::{Command, Stdio};
    if std::env::var_os("CINDERPAW_NO_BROWSER").is_some() {
        return false;
    }
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(url);
        c
    } else {
        // Without a display, xdg-open falls back to a text browser that takes
        // over the terminal. Say the URL instead.
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return false;
        }
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run by install.sh / install.ps1 right after unpacking into ~/.cinderpaw/bin.
/// Prints the last two of the three lines a stranger sees.
pub fn self_install() -> i32 {
    let (Some(home), Ok(exe)) = (home(), std::env::current_exe()) else {
        eprintln!("I couldn't find your home folder.");
        return 1;
    };
    let bin = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    for step in footprint::install(&home, &bin) {
        if let Err(msg) = step {
            println!("{msg}");
        }
    }
    print!("Starting... ");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    if let Err(msg) = ensure_engine(true) {
        println!();
        eprintln!("{msg}");
        return 1;
    }
    println!("✓");
    let url = match signed_in_url() {
        Ok(u) => u,
        Err(msg) => {
            eprintln!("{msg}");
            return 1;
        }
    };
    println!("{}", last_line(launch_browser(&url), &url));
    0
}

/// What the Cinderpaw shortcut runs. Slice 2 adds the one-time code here.
pub fn open() -> i32 {
    if let Err(msg) = ensure_engine(false) {
        eprintln!("{msg}");
        return 1;
    }
    let url = match signed_in_url() {
        Ok(u) => u,
        Err(msg) => {
            eprintln!("{msg}");
            return 1;
        }
    };
    if !launch_browser(&url) {
        println!("Open this in your browser: {url}");
    }
    0
}

/// A just-stopped sidecar can hold its database for a few more seconds.
fn remove_dir_retrying(dir: &Path, secs: u32) -> std::io::Result<()> {
    let mut last = Ok(());
    for _ in 0..=secs {
        last = std::fs::remove_dir_all(dir);
        if last.is_ok() || !dir.exists() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    last
}

/// Windows will not delete the .exe running this command, but it will rename
/// it. Park it in %TEMP% so the folder can go now, in this process, with the
/// outcome on screen. (A detached helper that deleted after we exited never
/// ran on the CI runner, and its failure would reach nobody.)
#[cfg(windows)]
fn park_running_exe(dir: &Path) {
    if let Ok(exe) = std::env::current_exe() {
        if exe.starts_with(dir) {
            let parked = std::env::temp_dir().join(format!("cinderpaw-uninstalled-{}.exe", std::process::id()));
            let _ = std::fs::rename(&exe, parked);
        }
    }
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
    fn the_one_folder_layout_is_recognised() {
        let data = Path::new("/home/ana/.cinderpaw");
        assert!(is_folder_install(Path::new("/home/ana/.cinderpaw/bin/cinderpaw"), data));
        assert!(!is_folder_install(Path::new("/home/ana/.local/bin/cinderpaw"), data));
        assert!(!is_folder_install(Path::new("/home/ana/.cinderpaw/cinderpaw"), data));
    }

    /// The sidecar can hold files for a few seconds after the gateway stops;
    /// one failed attempt must not leave ~/.cinderpaw behind.
    #[cfg(windows)]
    #[test]
    fn removal_waits_out_a_file_still_held_open() {
        let dir = std::env::temp_dir().join(format!("cp-held-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        // Opened the way SQLite opens its database: read/write sharing, no
        // FILE_SHARE_DELETE, so nobody can delete it while it is held.
        use std::os::windows::fs::OpenOptionsExt;
        let held = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .share_mode(0x1 | 0x2)
            .open(dir.join("agent/cinderpaw.db"))
            .unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(2));
            drop(held);
        });
        let removed = remove_dir_retrying(&dir, 10);
        releaser.join().unwrap();
        assert!(removed.is_ok(), "{removed:?}");
        assert!(!dir.exists());
    }

    #[test]
    fn the_code_rides_in_the_fragment_never_the_query() {
        assert_eq!(url_with_code("http://127.0.0.1:11435/", "ab12"), "http://127.0.0.1:11435/#code=ab12");
    }

    #[test]
    fn a_page_less_engine_on_our_port_is_named_not_opened() {
        // 404 on /web/code = something Cinderpaw-shaped with no page: the Desktop app.
        assert_eq!(open_error(404), "The Cinderpaw desktop app is using this computer's Cinderpaw port. Close the desktop app, then open Cinderpaw again.");
        assert!(open_error(500).starts_with("Cinderpaw couldn't open its page."));
    }

    #[test]
    fn the_last_line_never_claims_a_browser_that_did_not_open() {
        assert_eq!(last_line(true, "http://127.0.0.1:11435/"), "All set! Your browser just opened. You can close this window.");
        assert_eq!(last_line(false, "http://127.0.0.1:11435/"), "All set! Open this in your browser: http://127.0.0.1:11435/");
    }

    #[test]
    fn sizes_read_as_sizes() {
        assert_eq!(human(0), "0 B");
        assert_eq!(human(999), "999 B");
        assert_eq!(human(1536), "1.5 KB");
        assert_eq!(human(7 * 1024 * 1024 * 1024), "7.0 GB");
    }
}
