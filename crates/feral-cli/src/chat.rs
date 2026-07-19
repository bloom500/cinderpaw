//! `feral chat` — launches the Go/Bubble Tea TUI (feral-tui).
//!
//! The Rust side handles runtime auto-start; the Go binary (`feral-tui.exe`)
//! does all the TUI rendering via Bubble Tea + Lip Gloss + Glamour.
//!
//! The Go binary sits next to the Rust binary in the target dir and is
//! built by `cd tui && go build -o ../target/debug/feral-tui.exe .`

#![allow(non_snake_case)]

use std::io::Write as _;
use std::process::{Command, Stdio};

use crate::common::{self, Palette};

/// Path to the bundled Go TUI binary sitting next to this executable, if it's
/// present. CLI-only installs (npm shards, the headless install.sh) don't ship
/// it — only the desktop app bundles it — so callers must treat `None` as
/// "interactive TUI unavailable on this install" rather than a hard error.
pub(crate) fn tui_binary_path() -> Option<std::path::PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))?;
    let bin = exe_dir.join(if cfg!(windows) { "feral-tui.exe" } else { "feral-tui" });
    bin.exists().then_some(bin)
}

/// Entry point for `feral-cli chat`. Never returns — exits the process.
pub fn run() -> ! {
    if let Err(code) = crate::admin::ensure_gateway() {
        std::process::exit(code);
    }

    let Some(tui_bin) = tui_binary_path() else {
        eprintln!("feral: the interactive TUI isn't part of this CLI-only build.");
        eprintln!("       connect a provider:   feral setup");
        eprintln!("       add Discord/Slack:    feral connectors set discord --secret TOKEN=… --enable");
        std::process::exit(1);
    };

    let status = match Command::new(&tui_bin)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("feral: could not launch TUI ({e})");
            std::process::exit(1);
        }
    };

    let code = status.code().unwrap_or(1);
    // If the TUI died without restoring the terminal (crash, kill), put the
    // console back in cooked mode so the parent shell isn't left mute.
    common::reset_console_mode();
    let Palette { meta: META, reset: RESET, .. } = common::palette();
    let _ = writeln!(std::io::stderr(), "\n  {META}stay feral. ↝{RESET}");
    std::process::exit(code);
}
