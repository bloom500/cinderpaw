//! Shared bits for the `feral` CLI: the brand palette (color-gated for
//! `--no-color`) and the loopback endpoint helpers every subcommand needs.

use std::sync::OnceLock;

/// The brand palette as ANSI escapes. Every field is `&'static str` so callers
/// can destructure it into locals named like the old consts and keep using
/// `{ACCENT}`-style interpolation unchanged:
///
/// ```ignore
/// let common::Palette { accent: ACCENT, reset: RESET, .. } = common::palette();
/// println!("{ACCENT}hi{RESET}");
/// ```
#[derive(Clone, Copy)]
pub struct Palette {
    pub accent: &'static str,
    #[allow(dead_code)]
    pub accent_hi: &'static str,
    pub text: &'static str,
    pub meta: &'static str,
    pub ok: &'static str,
    pub warn: &'static str,
    pub fail: &'static str,
    pub bold: &'static str,
    pub dim: &'static str,
    pub reset: &'static str,
}

// Softened from the brand orange #ff6600, per "portocaliu mai moale".
const COLOR: Palette = Palette {
    accent: "\x1b[38;2;236;140;76m",
    accent_hi: "\x1b[38;2;242;164;102m",
    text: "\x1b[38;2;228;221;210m",
    meta: "\x1b[38;2;122;116;107m",
    ok: "\x1b[38;2;143;183;122m",
    warn: "\x1b[38;2;214;169;90m",
    fail: "\x1b[38;2;209;107;90m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    reset: "\x1b[0m",
};

const PLAIN: Palette = Palette {
    accent: "", accent_hi: "", text: "", meta: "", ok: "", warn: "", fail: "",
    bold: "", dim: "", reset: "",
};

static PALETTE: OnceLock<Palette> = OnceLock::new();

/// Fix the palette for the process. `color=false` (from `--no-color`, the
/// `NO_COLOR` env var, or a non-tty stdout) blanks every escape so output is
/// clean when piped. Call once at startup; later calls are ignored.
pub fn init_color(color: bool) {
    let _ = PALETTE.set(if color { COLOR } else { PLAIN });
}

/// The active palette (defaults to color if `init_color` was never called).
pub fn palette() -> Palette {
    *PALETTE.get().unwrap_or(&COLOR)
}

static JSON: OnceLock<bool> = OnceLock::new();

/// Fix machine-readable (`--json`) output for the process. Call once at startup.
pub fn init_json(on: bool) {
    let _ = JSON.set(on);
}

/// Whether the read commands should print JSON instead of styled text.
pub fn json() -> bool {
    *JSON.get().unwrap_or(&false)
}

/// The loopback API port the gateway binds (same source every host uses).
pub fn api_port() -> u16 {
    feral_core::settings::load().api_port
}

pub fn base_url() -> String {
    format!("http://127.0.0.1:{}", api_port())
}

/// Read the per-launch bearer token the gateway persists to `~/.feral/api-token`.
pub fn read_token() -> Option<String> {
    let path = feral_core::paths::feral_dir().join("api-token");
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

/// True when something is listening on the loopback API port — the gateway's
/// single-instance lock means that "something" is a live Feral host.
pub fn port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Restore cooked console input (echo + line buffering) on Windows before a
/// `read_line` prompt. A TUI that died without cleanup (force-kill, crash)
/// leaves the console in raw/VT mode — every later `read_line` in that window
/// looks dead: keys neither echo nor submit. No-op on non-Windows and when
/// stdin isn't a console (pipes keep working untouched).
#[cfg(windows)]
pub fn reset_console_mode() {
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleMode(handle: isize, mode: *mut u32) -> i32;
        fn SetConsoleMode(handle: isize, mode: u32) -> i32;
    }
    const ENABLE_PROCESSED_INPUT: u32 = 0x0001;
    const ENABLE_LINE_INPUT: u32 = 0x0002;
    const ENABLE_ECHO_INPUT: u32 = 0x0004;
    const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x0200;
    let handle = std::io::stdin().as_raw_handle() as isize;
    unsafe {
        let mut mode = 0u32;
        if GetConsoleMode(handle, &mut mode) != 0 {
            let cooked = (mode | ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT)
                & !ENABLE_VIRTUAL_TERMINAL_INPUT;
            SetConsoleMode(handle, cooked);
        }
    }
}

#[cfg(not(windows))]
pub fn reset_console_mode() {}
