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
use std::time::Duration;

use crate::common::{self, Palette};

/// Entry point for `feral-cli chat`. Never returns — exits the process.
pub fn run() -> ! {
    let port = common::api_port();
    if !common::port_in_use(port) {
        let Palette { meta: META, reset: RESET, .. } = common::palette();
        println!("\n  {META}Runtime not running. Starting...{RESET}");
        let code = crate::admin::gateway_start();
        if code != 0 {
            eprintln!("feral: could not start the runtime — run `feral doctor` to diagnose.");
            std::process::exit(code);
        }
        // gateway_start spawns a process — wait for the port to actually bind
        for _ in 0..20 {
            if common::port_in_use(port) {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if !common::port_in_use(port) {
            eprintln!("feral: runtime started but not listening on port {port} after 4s");
            std::process::exit(1);
        }
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let tui_bin = exe_dir.join("feral-tui.exe");

    if !tui_bin.exists() {
        eprintln!(
            "feral: TUI binary not found at {}",
            tui_bin.display()
        );
        eprintln!("       build it with: cd tui && go build -o feral-tui.exe .");
        std::process::exit(1);
    }

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
    let Palette { meta: META, reset: RESET, .. } = common::palette();
    let _ = writeln!(std::io::stderr(), "\n  {META}stay feral. ↝{RESET}");
    std::process::exit(code);
}
