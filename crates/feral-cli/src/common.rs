//! Shared bits for the `feral` CLI: the brand palette and the loopback
//! endpoint helpers every subcommand needs.

// ── Brand palette (truecolor ANSI) — softened from brand orange #ff6600 ────
pub const ACCENT: &str = "\x1b[38;2;236;140;76m"; // soft orange
pub const ACCENT_HI: &str = "\x1b[38;2;242;164;102m"; // brighter orange
pub const TEXT: &str = "\x1b[38;2;228;221;210m"; // warm off-white
pub const META: &str = "\x1b[38;2;122;116;107m"; // dim
pub const OK: &str = "\x1b[38;2;143;183;122m"; // soft green
pub const WARN: &str = "\x1b[38;2;214;169;90m"; // amber
pub const FAIL: &str = "\x1b[38;2;209;107;90m"; // soft red
pub const BOLD: &str = "\x1b[1m";
pub const DIM: &str = "\x1b[2m";
pub const RESET: &str = "\x1b[0m";

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
