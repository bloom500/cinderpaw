//! `cinderpaw chat` — launches the Go/Bubble Tea TUI (cinderpaw-tui).
//!
//! The Rust side handles runtime auto-start; the Go binary (`cinderpaw-tui.exe`)
//! does all the TUI rendering via Bubble Tea + Lip Gloss + Glamour.
//!
//! The Go binary sits next to the Rust binary in the target dir and is
//! built by `cd tui && go build -o ../target/debug/cinderpaw-tui.exe .`

#![allow(non_snake_case)]

use std::io::Write as _;
use std::process::{Command, Stdio};

use crate::common::{self, Palette};

/// Path to the bundled Go TUI binary sitting next to this executable, if it's
/// present. CLI-only installs (npm shards, the headless install.sh) don't ship
/// it — only the desktop app bundles it — so callers must treat `None` as
/// "interactive TUI unavailable on this install" rather than a hard error.
///
/// Both names are tried. The binary is called `cinderpaw-tui` from this release
/// on, but an install (or a developer's target dir) from before the rename has
/// `feral-tui` sitting there instead, and answering "the TUI isn't in this
/// build" to somebody who can see the file is worse than looking twice.
pub(crate) fn tui_binary_path() -> Option<std::path::PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))?;
    let ext = if cfg!(windows) { ".exe" } else { "" };
    ["cinderpaw-tui", "feral-tui"]
        .into_iter()
        .map(|name| exe_dir.join(format!("{name}{ext}")))
        .find(|p| p.exists())
}

/// Entry point for `cinderpaw-cli chat`. Never returns — exits the process.
pub fn run() -> ! {
    if let Err(code) = crate::admin::ensure_gateway() {
        std::process::exit(code);
    }

    let Some(tui_bin) = tui_binary_path() else {
        eprintln!("cinderpaw: interactive chat (the TUI) isn't bundled with this CLI-only install.");
        eprintln!("       You can still run Cinderpaw headless:");
        eprintln!("         • connect a provider:      cinderpaw setup");
        eprintln!("         • chat via Discord/Slack:  cinderpaw connectors set discord --secret TOKEN=… --enable");
        eprintln!("       Want the full interactive app? Install the desktop build:");
        eprintln!("         https://github.com/bloom500/feral/releases/latest");
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
            eprintln!("cinderpaw: could not launch TUI ({e})");
            std::process::exit(1);
        }
    };

    let code = status.code().unwrap_or(1);
    // If the TUI died without restoring the terminal (crash, kill), put the
    // console back in cooked mode so the parent shell isn't left mute.
    common::reset_console_mode();
    let Palette { meta: META, reset: RESET, .. } = common::palette();
    let _ = writeln!(std::io::stderr(), "\n  {META}stay wild. ↝{RESET}");
    std::process::exit(code);
}
