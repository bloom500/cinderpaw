//! `cinderpaw` management subcommands (Faza 4.5 Slice 4/4b, spec D6):
//! `gateway start|stop|restart|status`, `model`, `doctor`, `logs`,
//! `connectors`, `dreams`, `config`. Everything talks to the same loopback
//! runtime the desktop app and connectors use.

#![allow(non_snake_case)]

use std::io::{Read, Seek, Write};
use std::path::PathBuf;

use clap::Subcommand;
use futures_util::StreamExt;
use serde_json::json;

use crate::common::{api_port, base_url, json, palette, port_in_use, read_token, Palette};

/// Operations mirrored 1:1 from spec §13. Note: `Approve`, `Reject`,
/// `Freeze`, `Unfreeze` accept `-m <reason>` (an optional note); `Approve`
/// additionally fetches the proposal to confirm interactively before
/// POSTing (per brief §3 — CLI doesn't recompute the sha256 itself, the
/// sidecar handler in `index.ts` does that when `documentHash` is absent).
///
/// Lives in `admin` (not `main`) so `governance()` can pattern-match on
/// the variants without crossing module boundaries in the other
/// direction. `main.rs` references this via `crate::admin::GovernanceAction`.
#[derive(Subcommand)]
pub enum GovernanceAction {
    /// Show the active policy + frozen-layer flags + pending proposals
    Status,
    /// Print the append-only policy transition history
    History,
    /// List pending proposals awaiting human approval
    Proposals,
    /// Verify all hash-chained files (policy_history + audit + approvals)
    /// plus the last 7 UTC days of journal. Exit 0 = clean.
    Verify,
    /// Propose a new policy read from a JSON file on disk
    Propose { file: PathBuf },
    /// Approve a pending proposal — fetches the doc + asks to confirm,
    /// then POSTs to the gateway (sidecar computes the sha256 if absent)
    Approve { id: String },
    /// Reject a pending proposal with an optional reason
    Reject {
        id: String,
        /// Optional note attached to the rejection row in `policy_history.jsonl`
        #[arg(short = 'm', long)]
        message: Option<String>,
    },
    /// Roll the active policy back one step to its parent's document
    Rollback,
    /// Freeze one or more layers (l1/l2/l3/l4/l6). Refuses l6 evolution
    /// while any layer is frozen.
    Freeze {
        layers: Vec<String>,
        #[arg(short = 'm', long)]
        message: Option<String>,
    },
    /// Unfreeze one or more layers. Always human-only (G-INV-6).
    Unfreeze {
        layers: Vec<String>,
        #[arg(short = 'm', long)]
        message: Option<String>,
    },
}

/// Phase B (L4 Architecture Evolution, spec §10) — `cinderpaw modules …`.
/// Mirrors the `governance` surface: reads via GET, mutations via POST,
/// `--json` honored, exit 0 on `ok:true`.
#[derive(Subcommand)]
pub enum ModulesAction {
    /// List seams + candidate/promoted modules with their states
    List,
    /// Show one module (state, eval summary)
    Show { id: String },
    /// Approve a candidate awaiting approval — THE human promotion record
    Approve {
        id: String,
        /// Optional note attached to the approval
        #[arg(short = 'm', long)]
        message: Option<String>,
    },
    /// Reject a candidate awaiting approval
    Reject {
        id: String,
        #[arg(short = 'm', long)]
        message: Option<String>,
    },
    /// Demote a SEAM back to its builtin (instant rollback, no approval)
    Demote {
        seam: String,
        #[arg(short = 'm', long)]
        message: Option<String>,
    },
    /// Run the paired shadow eval for a module candidate (slow: the full
    /// suite runs twice on the live model)
    Evaluate { id: String },
    /// Ask the LOCAL model to author a module candidate for a seam (slow:
    /// one full local completion; the result still needs `evaluate` +
    /// `approve` to promote)
    Propose {
        /// Seam id to target (omitted = proposer picks from the catalog)
        #[arg(long)]
        seam: Option<String>,
    },
}

/// Faza 4 (L2 LoRA) — `cinderpaw lora …`: the personal-adaptation loop,
/// headless. Mirrors the desktop Training card: train fires a cycle,
/// reviews lists the human inbox, approve/reject is THE promotion gate.
#[derive(Subcommand)]
pub enum LoraAction {
    /// Registry summary: champions per domain + the active adapter
    Status,
    /// Run one training cycle (dataset → trainer → paired eval → review
    /// card). Fire-and-forget; watch `cinderpaw logs -f` or `cinderpaw lora reviews`
    Train {
        /// Adapter domain (general, coding, research, writing, planning)
        #[arg(long, default_value = "general")]
        domain: String,
    },
    /// List pending review cards (+ champions and stats)
    Reviews,
    /// Approve an adapter candidate — THE human promotion record
    Approve { id: String },
    /// Reject an adapter candidate
    Reject { id: String },
}

/// One blocking tokio runtime for the short HTTP calls these commands make.
pub(crate) fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Runtime::new()
        .expect("tokio runtime")
        .block_on(f)
}

/// Auto-start the gateway if the loopback port is free, then wait for it to
/// bind. Shared by `cinderpaw chat`, `cinderpaw setup` (guided + classic). Returns a
/// non-zero exit code on failure.
pub(crate) fn ensure_gateway() -> Result<(), i32> {
    let port = api_port();
    if port_in_use(port) {
        return Ok(());
    }
    let Palette { meta: META, reset: RESET, .. } = palette();
    println!("\n  {META}Gateway not running. Starting...{RESET}");
    let code = gateway_start();
    if code != 0 {
        eprintln!("cinderpaw: could not start the gateway — run `cinderpaw doctor` to diagnose.");
        return Err(code);
    }
    for _ in 0..20 {
        if port_in_use(port) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    eprintln!("cinderpaw: gateway started but not listening on port {port} after 4s");
    Err(1)
}

fn feral_file(name: &str) -> std::path::PathBuf {
    cinderpaw_core::paths::feral_dir().join(name)
}

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// One frame of an animated wait: a braille spinner + elapsed seconds when
/// the palette is colored (an interactive tty); a plain trailing dot
/// otherwise, so piped output/log files stay append-only instead of filling
/// with carriage returns.
fn tick(label: &str, i: usize, elapsed_ms: u64) {
    let Palette { accent: ACCENT, text: TEXT, meta: META, dim: DIM, reset: RESET, .. } = palette();
    if ACCENT.is_empty() {
        print!(".");
    } else {
        print!(
            "\r{ACCENT}{}{RESET} {TEXT}{label}{RESET}  {DIM}{META}{:.1}s{RESET}   ",
            SPINNER[i % SPINNER.len()],
            elapsed_ms as f32 / 1000.0
        );
    }
    let _ = std::io::stdout().flush();
}

/// Clears the spinner line before printing the final result — a no-op (just
/// a newline) when color is off, since the plain path never used `\r`.
fn tick_done() {
    if !palette().accent.is_empty() {
        print!("\r\x1b[2K");
    } else {
        println!();
    }
}

// ── gateway status ─────────────────────────────────────────────────────────

pub fn gateway_status() -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, ok: OK, warn: WARN, dim: DIM, reset: RESET, .. } =
        palette();
    let port = api_port();
    if !port_in_use(port) {
        if json() {
            println!("{}", serde_json::json!({ "online": false, "port": port }));
        } else {
            println!("{META}● gateway offline{RESET}  (nothing on port {port})");
            println!("  start it: {ACCENT}cinderpaw gateway start{RESET}");
        }
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{WARN}● port {port} busy but ~/.cinderpaw/api-token is missing{RESET}");
        return 1;
    };
    match block_on(fetch_json(&token, "/runtime/status")) {
        Ok(v) => {
            if json() {
                println!("{v}");
                return 0;
            }
            let model = agent_model(&v);
            let lora = v.get("lora").and_then(|l| l.as_str()).unwrap_or("none");
            let backend = v.get("backend").and_then(|b| b.as_str()).unwrap_or("—");
            let sidecar = v.get("sidecar_alive").and_then(|b| b.as_bool()).unwrap_or(false);
            let sc = if sidecar { OK } else { WARN };
            println!("{OK}● gateway online{RESET}  {DIM}{META}127.0.0.1:{port}{RESET}");
            println!("  {META}model{RESET}   {TEXT}{model}{RESET}");
            println!("  {META}lora{RESET}    {TEXT}{lora}{RESET}");
            println!("  {META}backend{RESET} {TEXT}{backend}{RESET}");
            println!("  {META}sidecar{RESET} {sc}{}{RESET}", if sidecar { "alive" } else { "down" });
            0
        }
        Err(e) => {
            eprintln!("{WARN}● port {port} busy but /runtime/status failed{RESET}: {e}");
            1
        }
    }
}

fn agent_model(v: &serde_json::Value) -> String {
    v.get("agent_model")
        .and_then(|m| m.as_str())
        .map(String::from)
        .or_else(|| {
            v.get("model")
                .and_then(|m| m.get("name"))
                .and_then(|n| n.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "—".into())
}

// ── gateway start / stop / restart ─────────────────────────────────────────

pub fn gateway_start() -> i32 {
    let Palette { accent: ACCENT, meta: META, ok: OK, fail: FAIL, dim: DIM, reset: RESET, .. } =
        palette();
    let _ = ACCENT;
    let port = api_port();
    if port_in_use(port) {
        println!("{OK}gateway already running{RESET} on port {port}");
        return 0;
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("cinderpaw: cannot locate own binary: {e}");
            return 1;
        }
    };
    // Detach from this terminal: logs go to a file, not the console, so the
    // gateway outlives the shell that launched it.
    let log_path = feral_file("gateway.log");
    let log = match std::fs::File::create(&log_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("cinderpaw: cannot open {}: {e}", log_path.display());
            return 1;
        }
    };
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("gateway")
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().unwrap_or_else(|_| std::fs::File::create(&log_path).unwrap()))
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — no inherited console,
        // and Ctrl+C in this shell won't propagate to the daemon.
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cinderpaw: failed to start gateway: {e}");
            return 1;
        }
    };
    let pid = child.id();
    let _ = std::fs::write(feral_file("gateway.pid"), pid.to_string());

    for i in 0..40 {
        if port_in_use(port) {
            tick_done();
            println!("{OK}● gateway started{RESET}  {DIM}{META}pid {pid} · port {port}{RESET}   ");
            println!("  logs: {DIM}{META}{}{RESET}", log_path.display());
            return 0;
        }
        tick("starting gateway", i, i as u64 * 500);
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    tick_done();
    // The pid file is written before we know the gateway came up. Leaving it
    // behind after a failed start means `cinderpaw status` reports a pid with no
    // port, and the next `cinderpaw gateway stop` sends a signal to whatever the
    // OS has since given that number to — someone else's process.
    let _ = std::fs::remove_file(feral_file("gateway.pid"));
    eprintln!(
        "{FAIL}gateway did not bind port {port} within 20s{RESET} — see {}",
        log_path.display()
    );
    1
}

pub fn gateway_stop() -> i32 {
    let Palette { meta: META, ok: OK, warn: WARN, fail: FAIL, reset: RESET, .. } = palette();
    let port = api_port();
    if !port_in_use(port) {
        println!("{META}gateway not running{RESET}");
        return 0;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}cannot stop: ~/.cinderpaw/api-token missing{RESET}");
        return 1;
    };
    if let Err(e) = block_on(post(&token, "/runtime/shutdown")) {
        eprintln!("{FAIL}shutdown request failed{RESET}: {e}");
        return 1;
    }
    for i in 0..70 {
        if !port_in_use(port) {
            let _ = std::fs::remove_file(feral_file("gateway.pid"));
            tick_done();
            println!("{OK}● gateway stopped{RESET}                 ");
            return 0;
        }
        tick("stopping gateway", i, i as u64 * 500);
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    tick_done();
    eprintln!("{WARN}gateway still up after 35s — it may be mid-drain{RESET}");
    1
}

pub fn gateway_restart() -> i32 {
    let port = api_port();
    if port_in_use(port) && gateway_stop() != 0 {
        // A stop that ran out of patience is NOT a failed restart. The drain
        // routinely finishes seconds after `gateway_stop` stops watching, and
        // bailing here left the gateway down for good — whatever it was serving
        // (a Discord or Slack connector, most of the time) simply vanished, with
        // the CLI reporting a restart it never performed. `cinderpaw update` rides
        // this path, so the failure landed exactly where nobody was watching.
        //
        // Keep waiting for the port instead. Only a port still bound after the
        // extra minute is a real failure: starting a second gateway on a live
        // one gets us two agents answering the same channel.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while std::time::Instant::now() < deadline {
            if !port_in_use(port) {
                let _ = std::fs::remove_file(feral_file("gateway.pid"));
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        if port_in_use(port) {
            let Palette { fail: FAIL, reset: RESET, .. } = palette();
            eprintln!(
                "{FAIL}gateway still bound to port {port} after 95s — not starting a second one.{RESET}"
            );
            eprintln!("       inspect it with `cinderpaw status`, or kill the process and run `cinderpaw gateway start`.");
            return 1;
        }
    }
    gateway_start()
}

// ── model ──────────────────────────────────────────────────────────────────

pub fn model_list() -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, bold: BOLD, dim: DIM, reset: RESET, .. } =
        palette();
    let port = api_port();
    if !port_in_use(port) {
        eprintln!("{META}gateway offline — start it to list models{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{}~/.cinderpaw/api-token missing{}", palette().fail, RESET);
        return 1;
    };
    match block_on(fetch_json(&token, "/runtime/models")) {
        Ok(v) => {
            if json() {
                println!("{v}");
                return 0;
            }
            let active = v.get("active").and_then(|a| a.as_str());
            let empty = vec![];
            let models = v.get("models").and_then(|m| m.as_array()).unwrap_or(&empty);
            if models.is_empty() {
                println!("{META}no models on disk{RESET}");
                return 0;
            }
            println!("{BOLD}{TEXT}models{RESET} {DIM}{META}(~/.cinderpaw/models){RESET}");
            for m in models {
                if let Some(id) = m.as_str() {
                    let is_active = Some(id) == active;
                    let mark = if is_active { format!("{ACCENT}◆{RESET}") } else { " ".into() };
                    let name =
                        if is_active { format!("{TEXT}{id}{RESET}") } else { format!("{META}{id}{RESET}") };
                    println!("  {mark} {name}");
                }
            }
            0
        }
        Err(e) => {
            eprintln!("{}could not list models{}: {e}", palette().fail, RESET);
            1
        }
    }
}

// ── logs ───────────────────────────────────────────────────────────────────

pub fn logs(follow: bool) -> i32 {
    let path = feral_file("gateway.log");
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => {
            eprintln!("{}no gateway.log yet — start the gateway with `cinderpaw gateway start`{}",
                palette().meta, palette().reset);
            return 1;
        }
    };
    let mut raw = Vec::new();
    let _ = file.read_to_end(&mut raw);
    // Bytes, not `read_to_string`: a single non-UTF-8 byte — and panic
    // backtraces and raw pointers produce them — made the read return Err, so
    // the whole chunk was dropped and `pos` never advanced. The tail then sat
    // there printing nothing, forever, looking like a quiet gateway.
    let mut decoder = cinderpaw_core::utf8_stream::Utf8Stream::new();
    print!("{}", decoder.push(&raw));
    let _ = std::io::stdout().flush();
    if !follow {
        return 0;
    }
    // Tail: poll for appends. Ctrl+C stops it.
    let mut pos = raw.len() as u64;
    drop(file);
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        // Rotation: `gateway restart` re-creates gateway.log, so the handle we
        // held pointed at an unlinked inode while `metadata` described the new
        // file. Size then looked like it had grown, the read returned nothing,
        // and the tail was stuck on a file nobody was writing to any more. A
        // file shorter than where we are means it was replaced — start over.
        if meta.len() < pos {
            pos = 0;
            decoder = cinderpaw_core::utf8_stream::Utf8Stream::new();
        }
        if meta.len() == pos {
            continue;
        }
        // Re-open every time rather than keeping a handle, so the tail follows
        // the NAME the way `tail -F` does, not the inode it first saw.
        let Ok(mut f) = std::fs::File::open(&path) else { continue };
        if f.seek(std::io::SeekFrom::Start(pos)).is_err() {
            continue;
        }
        let mut chunk = Vec::new();
        // Count the BYTES read, not the characters decoded: those differ the
        // moment the file holds anything that is not plain ASCII, and the
        // difference used to reprint the tail of every chunk forever.
        let Ok(n) = f.read_to_end(&mut chunk) else { continue };
        if n == 0 {
            continue;
        }
        pos += n as u64;
        print!("{}", decoder.push(&chunk));
        let _ = std::io::stdout().flush();
    }
}

// ── connectors ─────────────────────────────────────────────────────────────

pub fn connectors_list() -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, ok: OK, fail: FAIL, bold: BOLD, dim: DIM, reset: RESET, .. } =
        palette();
    let path = feral_file("connectors.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            if json() {
                println!("{}", serde_json::json!({ "connectors": [] }));
            } else {
                println!("{META}no connectors configured{RESET} {DIM}{META}(~/.cinderpaw/connectors.json){RESET}");
            }
            return 0;
        }
    };
    let mut v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{}connectors.json is invalid JSON{}: {e}", palette().fail, RESET);
            return 1;
        }
    };
    // R6: redact secret values in place — replace `secrets: {KEY: VALUE}`
    // with `filled: [KEY]` so this file's own real secrets are never printed,
    // in JSON mode or otherwise. Reads the file directly (no gateway
    // required, matching this command's existing offline-friendly design)
    // but must never echo what it reads verbatim.
    if let Some(rows) = v.get_mut("connectors").and_then(|c| c.as_array_mut()) {
        for row in rows.iter_mut() {
            if let Some(obj) = row.as_object_mut() {
                let filled: Vec<serde_json::Value> = obj
                    .get("secrets")
                    .and_then(|s| s.as_object())
                    .map(|m| {
                        m.iter()
                            .filter(|(_, val)| val.as_str().is_some_and(|s| !s.trim().is_empty()))
                            .map(|(k, _)| serde_json::Value::String(k.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                obj.remove("secrets");
                obj.remove("token"); // legacy single-token field, same rule
                obj.insert("filled".into(), serde_json::Value::Array(filled));
            }
        }
    }
    if json() {
        println!("{v}");
        return 0;
    }
    // connectors.json shape: { "connectors": [ { "id": "discord", "enabled": … } ] }.
    let rows = v.get("connectors").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    if rows.is_empty() {
        println!("{META}no connectors configured{RESET} {DIM}{META}(~/.cinderpaw/connectors.json){RESET}");
        return 0;
    }
    // What actually connected, published by the sidecar's connector supervisor.
    // Only meaningful while the gateway is up: the file outlives the process
    // that wrote it, and reporting a bot as live when the runtime holding the
    // connection is gone is the same lie in the opposite direction.
    let health = if port_in_use(api_port()) { read_connector_health() } else { None };

    println!("{BOLD}{TEXT}connectors{RESET}");
    for row in &rows {
        let id = row.get("id").and_then(|i| i.as_str()).unwrap_or("?");
        let enabled = row.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
        let channels = row
            .get("channels")
            .and_then(|c| c.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let (dot, label) = if enabled { (OK, "on ") } else { (META, "off") };
        let ch = if channels > 0 { format!(" · {channels} channel(s)") } else { String::new() };

        // "on" only ever meant "enabled in this file". An invalid Discord token
        // left the bot dead while every surface reported it running, so a
        // connector the supervisor could not start now says so, here, in red.
        let state = health.as_ref().and_then(|h| h.get(id));
        let live = state.and_then(|s| s.get("live").and_then(|l| l.as_bool()));
        let (dot, note): (&str, String) = match (enabled, live) {
            (true, Some(false)) => {
                let why = state
                    .and_then(|s| s.get("error").and_then(|e| e.as_str()))
                    .unwrap_or("failed to start");
                (FAIL, format!("  {FAIL}└ NOT CONNECTED{RESET} {DIM}{META}{why}{RESET}"))
            }
            _ => (dot, String::new()),
        };
        println!("  {dot}●{RESET} {TEXT}{id}{RESET} {DIM}{META}{label}{ch}{RESET}");
        if !note.is_empty() {
            println!("{note}");
        }
    }
    let _ = ACCENT;
    0
}

/// `connector-health.json`, written by the sidecar on every reconcile: which
/// connectors actually connected, as opposed to which are switched on in the
/// config. Absent (old sidecar, never reloaded) → no claim either way.
fn read_connector_health() -> Option<serde_json::Map<String, serde_json::Value>> {
    let raw = std::fs::read_to_string(feral_file("connector-health.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("connectors")?.as_object().cloned()
}

pub fn connectors_reload() -> i32 {
    let Palette { ok: OK, meta: META, fail: FAIL, reset: RESET, .. } = palette();
    if !port_in_use(api_port()) {
        eprintln!("{META}gateway offline — nothing to reload{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}~/.cinderpaw/api-token missing{RESET}");
        return 1;
    };
    match block_on(post(&token, "/runtime/connectors/reload")) {
        Ok(_) => {
            println!("{OK}● connectors reloaded{RESET}");
            0
        }
        Err(e) => {
            eprintln!("{FAIL}reload failed{RESET}: {e}");
            1
        }
    }
}

/// `cinderpaw connectors set <id> --secret KEY=VALUE [--enable|--disable] [--allow ID]
/// [--channel ID]` — configures one connector against a running gateway via
/// `POST /runtime/connectors` (R6). Same in-process-vs-remote posture as
/// `reload`: requires a live gateway, no local-file fallback. Never echoes a
/// raw secret value to stdout — only the `filled` flags the route returns.
/// Read one secret from stdin, prompting only when there is a person there.
///
/// Visible while typed — masking needs a tty dependency this crate does not
/// carry — but never in `ps aux` and never in shell history, which is where the
/// value actually persisted before.
fn read_secret_from_stdin(key: &str) -> Option<String> {
    let Palette { meta: META, reset: RESET, .. } = palette();
    if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        eprintln!("{META}paste the value for {key}, then Enter (input is visible):{RESET}");
    }
    let mut value = String::new();
    if std::io::stdin().read_line(&mut value).is_err() {
        return None;
    }
    let value = value.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub fn connectors_set(
    id: &str,
    secrets: Vec<String>,
    enable: bool,
    disable: bool,
    allowlist: Vec<String>,
    channels: Vec<String>,
    persona: Option<String>,
    persona_tools: Vec<String>,
) -> i32 {
    let Palette { ok: OK, fail: FAIL, meta: META, reset: RESET, .. } = palette();
    if !port_in_use(api_port()) {
        eprintln!("{META}gateway offline — start it first (`cinderpaw gateway start`){RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}~/.cinderpaw/api-token missing{RESET}");
        return 1;
    };

    // `--secret KEY=VALUE` puts a bot token in argv, where it is readable by
    // every other account on the machine for as long as the process lives
    // (`ps aux`), and lands in shell history besides. `--secret KEY` with no
    // value reads it from stdin instead — the same way `providers set-key`
    // already takes an API key — so the token never appears in either place.
    let mut secret_map = serde_json::Map::new();
    for kv in &secrets {
        let (k, value) = match kv.split_once('=') {
            // `KEY=@stdin` is the explicit form, for scripts that want to pipe.
            Some((k, "@stdin")) | Some((k, "-")) => (k.to_string(), read_secret_from_stdin(k)),
            Some((k, v)) => {
                eprintln!(
                    "{META}warning: the value of {k} was passed on the command line, where other users on this machine can read it from the process list and where your shell will record it in its history. Use `--secret {k}` on its own next time and paste it when asked, then rotate this one.{RESET}"
                );
                (k.to_string(), Some(v.to_string()))
            }
            None => (kv.to_string(), read_secret_from_stdin(kv)),
        };
        let Some(value) = value else {
            eprintln!("{FAIL}no value given for {k}{RESET}");
            return 1;
        };
        secret_map.insert(k, serde_json::Value::String(value));
    }

    let mut body = serde_json::json!({ "id": id });
    let obj = body.as_object_mut().unwrap();
    if !secret_map.is_empty() {
        obj.insert("secrets".into(), serde_json::Value::Object(secret_map));
    }
    if enable {
        obj.insert("enabled".into(), serde_json::Value::Bool(true));
    } else if disable {
        obj.insert("enabled".into(), serde_json::Value::Bool(false));
    }
    if !allowlist.is_empty() {
        obj.insert("allowlist".into(), serde_json::json!(allowlist));
    }
    if !channels.is_empty() {
        obj.insert("channels".into(), serde_json::json!(channels));
    }
    if let Some(p) = persona {
        obj.insert("persona".into(), serde_json::Value::String(p));
    }
    if !persona_tools.is_empty() {
        obj.insert("personaTools".into(), serde_json::json!(persona_tools));
    }

    match block_on(post_json_with_body(&token, "/runtime/connectors", body)) {
        Ok(v) => {
            if json() {
                println!("{v}");
                return 0;
            }
            let filled = v.get("filled").and_then(|f| f.as_array()).cloned().unwrap_or_default();
            let enabled = v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
            let (dot, label) = if enabled { (OK, "on ") } else { (META, "off") };
            let fields: Vec<&str> = filled.iter().filter_map(|f| f.as_str()).collect();
            let filled_str = if fields.is_empty() { String::new() } else { format!(" · filled: {}", fields.join(", ")) };
            println!("{dot}●{RESET} {id} {label}{filled_str}");
            0
        }
        Err(e) => {
            eprintln!("{FAIL}connectors set failed{RESET}: {e}");
            1
        }
    }
}

// ── dreams (live) ──────────────────────────────────────────────────────────

/// Watch the Dream Cycle live off the `/events` stream. There is no dream-state
/// snapshot endpoint yet, so this tails the observability bus and prints dream
/// events as they happen. Ctrl+C to stop.
pub fn dreams() -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, dim: DIM, reset: RESET, .. } = palette();
    if !port_in_use(api_port()) {
        eprintln!("{META}gateway offline — start it to watch dreams{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{}~/.cinderpaw/api-token missing{}", palette().fail, RESET);
        return 1;
    };
    if !json() {
        println!("  {ACCENT}✦ dreams{RESET} {DIM}{META}watching the Dream Cycle — Ctrl+C to stop{RESET}\n");
    }
    block_on(async move {
        // A live SSE stream must not carry a whole-request deadline — it is
        // meant to stay open. Only the connect and the wait for headers are
        // bounded, which is the failure a timeout is here for.
        let resp = match stream_client()
            .get(format!("{}/events", base_url()))
            .bearer_auth(&token)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("{}/events failed{}: {e}", palette().fail, RESET);
                return 1;
            }
        };
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        // Same split-character problem as the desktop stream: decode across
        // chunk boundaries, not inside each one.
        let mut decoder = cinderpaw_core::utf8_stream::Utf8Stream::new();
        while let Some(chunk) = stream.next().await {
            let Ok(bytes) = chunk else { break };
            buf.push_str(&decoder.push(&bytes));
            while let Some(nl) = buf.find('\n') {
                let line: String = buf.drain(..=nl).collect();
                let Some(data) = line.trim_end().strip_prefix("data:") else { continue };
                let Ok(env) = serde_json::from_str::<serde_json::Value>(data.trim()) else { continue };
                // /events payload: { event: "cinderpaw://agent-output", data: { data: "<json line>" } }
                let inner = env.get("data").and_then(|d| d.get("data")).and_then(|s| s.as_str());
                let Some(inner) = inner else { continue };
                let Ok(ev) = serde_json::from_str::<serde_json::Value>(inner) else { continue };
                let ty = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if ty == "dream_cycle" {
                    if json() {
                        println!("{ev}");
                    } else {
                        let stage = ev.get("stage").and_then(|s| s.as_str()).unwrap_or("");
                        let phase = ev.get("phase").and_then(|p| p.as_str()).unwrap_or("");
                        let what = if !phase.is_empty() { phase } else { stage };
                        let trig = ev.get("trigger").and_then(|t| t.as_str()).unwrap_or("");
                        println!("  {ACCENT}✦{RESET} {TEXT}{what}{RESET} {DIM}{META}{trig}{RESET}");
                    }
                }
            }
        }
        0
    })
}

// ── meta (L6 Meta Evolution) ───────────────────────────────────────────────

/// Drive one L6 meta op through the gateway. `op` is the sidecar message
/// type; the route + method are derived here so main.rs stays declarative.
pub fn meta(op: &str) -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, dim: DIM, fail: FAIL, reset: RESET, .. } =
        palette();
    if !port_in_use(api_port()) {
        eprintln!("{META}gateway offline — start it with `cinderpaw gateway start`{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}~/.cinderpaw/api-token missing{RESET}");
        return 1;
    };
    let result = block_on(async {
        match op {
            "meta_status" => fetch_json(&token, "/meta/current").await,
            "meta_history" => fetch_json(&token, "/meta/history").await,
            "meta_evolve" => post_json(&token, "/meta/evolve").await,
            "meta_rollback" => post_json(&token, "/meta/rollback").await,
            _ => Err(format!("unknown meta op {op}")),
        }
    });
    let v = match result {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{FAIL}meta request failed{RESET}: {e}");
            return 1;
        }
    };
    if json() {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) { 0 } else { 1 };
    }
    if !v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
        let reason = v.get("reason").and_then(|r| r.as_str()).unwrap_or("unknown error");
        eprintln!("{FAIL}✗ {reason}{RESET}");
        return 1;
    }
    match op {
        "meta_history" => {
            println!("  {ACCENT}✦ meta history{RESET}");
            for row in v.get("history").and_then(|h| h.as_array()).into_iter().flatten() {
                let gen = row.get("generation").and_then(|g| g.as_u64()).unwrap_or(0);
                let event = row.get("event").and_then(|e| e.as_str()).unwrap_or("");
                let diff = row.get("diff").and_then(|d| d.as_str()).unwrap_or("");
                let score = row
                    .get("score")
                    .and_then(|s| s.as_f64())
                    .map(|s| format!("{s:.4}"))
                    .unwrap_or_else(|| "-".into());
                println!("  {TEXT}g{gen:<4}{RESET} {ACCENT}{event:<10}{RESET} {TEXT}{score:<8}{RESET} {DIM}{META}{diff}{RESET}");
            }
        }
        _ => {
            let gen = v.get("generation").and_then(|g| g.as_u64()).unwrap_or(0);
            println!("  {ACCENT}✦ meta{RESET} {TEXT}generation {gen}{RESET}");
            if let Some(diff) = v.get("diff").and_then(|d| d.as_str()) {
                println!("  {TEXT}proposed{RESET} {DIM}{META}{diff}{RESET}");
            }
            if let Some(pending) = v.get("pendingCandidate").and_then(|p| p.as_bool()) {
                println!("  {TEXT}pending candidate{RESET} {DIM}{META}{pending}{RESET}");
            }
            if let Some(fit) = v.get("fitness").filter(|f| !f.is_null()) {
                let score = fit.get("score").and_then(|s| s.as_f64()).unwrap_or(0.0);
                let cycles = fit.get("cycles").and_then(|c| c.as_u64()).unwrap_or(0);
                println!("  {TEXT}fitness{RESET} {ACCENT}{score:.4}{RESET} {DIM}{META}over {cycles} cycles{RESET}");
            } else if op == "meta_status" {
                println!("  {TEXT}fitness{RESET} {DIM}{META}insufficient cycles under this genome{RESET}");
            }
            if let Some(genome) = v.get("genome").and_then(|g| g.as_object()) {
                for (k, val) in genome {
                    println!("    {DIM}{META}{k:<20}{RESET} {TEXT}{val}{RESET}");
                }
            }
        }
    }
    0
}

// ── Slice A5 (L5 Governance CLI — spec §13) ───────────────────────────────
//
// Mirrors `meta(op)` for surface + JSON plumbing. Reads (`status`,
// `history`, `proposals`, `verify`) call `fetch_json`; mutations
// (`propose`, `approve`, `reject`, `freeze`, `unfreeze`) call
// `post_json_with_body` with the op-specific payload. `rollback` is a
// mutation that takes no body in practice (the sidecar's handler
// defaults `reason` to `"operator rollback"` if absent).
//
// `approve` is the one op that the brief asks us to make interactive —
// fetch the proposal from `/governance/proposals`, render its diff, ask
// for a y/N confirm, then POST. The CLI does NOT recompute the
// documentHash; the sidecar handler computes it server-side when the
// field is absent (brief §3 "simplest correct path").
pub fn governance(action: GovernanceAction) -> i32 {
    let pal = palette();
    let Palette { accent: ACCENT, text: TEXT, meta: META, dim: DIM, fail: FAIL, reset: RESET, .. } = pal;
    if !port_in_use(api_port()) {
        eprintln!("{META}gateway offline — start it with `cinderpaw gateway start`{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}~/.cinderpaw/api-token missing{RESET}");
        return 1;
    };

    // Reads use `fetch_json` against the four GET routes; mutations build an
    // op-specific JSON body and use `post_json_with_body` against the six
    // POST routes. The dispatch is a flat match — reads and mutations own
    // their respective op variants so no state has to leak across arms.
    match action {
        // ── Reads ────────────────────────────────────────────────────────
        GovernanceAction::Status => {
            let result = block_on(fetch_json(&token, "/governance/policy"));
            render_governance_read(&result, &GovernanceAction::Status, &pal)
        }
        GovernanceAction::Proposals => {
            let result = block_on(fetch_json(&token, "/governance/proposals"));
            render_governance_read(&result, &GovernanceAction::Proposals, &pal)
        }
        GovernanceAction::History => {
            let result = block_on(fetch_json(&token, "/governance/history?limit=50"));
            render_governance_read(&result, &GovernanceAction::History, &pal)
        }
        GovernanceAction::Verify => {
            let result = block_on(fetch_json(&token, "/governance/verify"));
            // Verify op drives the exit code (AC 8/11: exit 0 iff every
            // chain + journal row verified). The renderer prints the same
            // shape; we just translate the boolean into the shell exit.
            let code = render_governance_read(&result, &GovernanceAction::Verify, &pal);
            match &result {
                Ok(v) => {
                    let chains_ok = v.get("chains").and_then(|c| c.get("ok")).and_then(|b| b.as_bool()).unwrap_or(false);
                    let journal_ok = v.get("journal").and_then(|j| j.as_array())
                        .map(|a| a.iter().all(|e| e.get("ok").and_then(|b| b.as_bool()).unwrap_or(false)))
                        .unwrap_or(false);
                    if chains_ok && journal_ok { 0 } else { code.max(1) }
                }
                Err(_) => code,
            }
        }

        // ── Mutations ────────────────────────────────────────────────────
        // Propose: reads the policy JSON from disk, validates it's an object,
        // POSTs the document as-is (the gateway roundtrip flattens it onto
        // the governance_propose message envelope).
        GovernanceAction::Propose { file } => {
            let raw = match std::fs::read_to_string(&file) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{FAIL}cannot read {}{RESET}: {e}", file.display());
                    return 1;
                }
            };
            let document: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{FAIL}invalid JSON in {}{RESET}: {e}", file.display());
                    return 1;
                }
            };
            if !document.is_object() {
                eprintln!("{FAIL}proposal must be a JSON object (got {}){RESET}", document_kind(&document));
                return 1;
            }
            let result = block_on(post_json_with_body(&token, "/governance/propose", document));
            render_governance_mutation(result, "propose", &pal)
        }

        // Approve: fetch the proposal (status + proposals endpoints both
        // carry the pending list), render its diff, ask for a y/N confirm,
        // POST. We deliberately omit `documentHash` — the sidecar handler
        // computes it server-side and echoes it back in the result so the
        // caller can see what was recorded.
        GovernanceAction::Approve { id } => {
            let status = match block_on(fetch_json(&token, "/governance/proposals")) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{FAIL}governance proposals fetch failed{RESET}: {e}");
                    return 1;
                }
            };
            let pending: Vec<&serde_json::Value> = status
                .get("pending")
                .and_then(|p| p.as_array())
                .map(|a| {
                    a.iter()
                        .filter(|row| row.get("policyId").and_then(|v| v.as_str()) == Some(&id))
                        .collect()
                })
                .unwrap_or_default();
            if pending.is_empty() {
                eprintln!("{FAIL}no pending proposal with id '{id}' (already approved? check `cinderpaw governance proposals`){RESET}");
                return 1;
            }
            println!("  {ACCENT}approve proposal {id}{RESET}");
            for row in &pending {
                let dir = row.get("direction").and_then(|v| v.as_str()).unwrap_or("?");
                let req = row.get("requiredApproval").and_then(|v| v.as_bool()).unwrap_or(true);
                println!(
                    "    direction: {TEXT}{dir}{RESET}    required approval: {TEXT}{}{RESET}",
                    if req { "yes" } else { "no (auto)" }
                );
            }
            crate::common::reset_console_mode();
            eprint!("  {META}proceed?{RESET} [y/N] ");
            let _ = std::io::Write::flush(&mut std::io::stderr());
            let mut answer = String::new();
            if std::io::stdin().read_line(&mut answer).is_err() {
                eprintln!("{FAIL}could not read confirmation{RESET}");
                return 1;
            }
            let answer = answer.trim().to_ascii_lowercase();
            if answer != "y" && answer != "yes" {
                println!("  {DIM}cancelled{RESET}");
                return 1;
            }
            // No documentHash — the sidecar handler in index.ts computes it
            // via sha256Canonical(gl.proposalDocument(msg.id)) and echoes the
            // hash in the result. See brief §3.
            let body = json!({ "policyId": id });
            let result = block_on(post_json_with_body(&token, "/governance/approve", body));
            render_governance_mutation(result, "approve", &pal)
        }

        GovernanceAction::Reject { id, message } => {
            let body = json!({
                "policyId": id,
                "reason": message.unwrap_or_default(),
            });
            let result = block_on(post_json_with_body(&token, "/governance/reject", body));
            render_governance_mutation(result, "reject", &pal)
        }

        GovernanceAction::Rollback => {
            let result = block_on(post_json_with_body(&token, "/governance/rollback", json!({})));
            render_governance_mutation(result, "rollback", &pal)
        }

        GovernanceAction::Freeze { layers, message } => {
            let body = json!({
                "layers": layers,
                "reason": message.unwrap_or_default(),
            });
            let result = block_on(post_json_with_body(&token, "/governance/freeze", body));
            render_governance_mutation(result, "freeze", &pal)
        }

        GovernanceAction::Unfreeze { layers, message } => {
            let body = json!({
                "layers": layers,
                "reason": message.unwrap_or_default(),
            });
            let result = block_on(post_json_with_body(&token, "/governance/unfreeze", body));
            render_governance_mutation(result, "unfreeze", &pal)
        }
    }
}

/// Phase B (L4) — `cinderpaw modules …`. Same plumbing as `governance`:
/// gateway must be up, token from `~/.cinderpaw/api-token`, one HTTP call per
/// op. `evaluate` waits for the paired suite to finish (minutes on local
/// hardware) — it uses a long-timeout client + the spinner.
pub fn modules(action: ModulesAction) -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, dim: DIM, fail: FAIL, ok: OK, reset: RESET, .. } =
        palette();
    if !port_in_use(api_port()) {
        eprintln!("{META}gateway offline — start it with `cinderpaw gateway start`{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}~/.cinderpaw/api-token missing{RESET}");
        return 1;
    };

    let note = |m: &Option<String>| json!({ "note": m.clone().unwrap_or_default() });
    let result = match &action {
        ModulesAction::List => block_on(fetch_json(&token, "/modules")),
        ModulesAction::Show { id } => block_on(fetch_json(&token, &format!("/modules/{id}"))),
        ModulesAction::Approve { id, message } => {
            block_on(post_json_with_body(&token, &format!("/modules/{id}/approve"), note(message)))
        }
        ModulesAction::Reject { id, message } => {
            block_on(post_json_with_body(&token, &format!("/modules/{id}/reject"), note(message)))
        }
        ModulesAction::Demote { seam, message } => {
            block_on(post_json_with_body(&token, &format!("/modules/{seam}/demote"), note(message)))
        }
        ModulesAction::Evaluate { id } => {
            println!("{META}running paired eval (the suite runs twice on the live model — this takes a while)…{RESET}");
            block_on(post_json_slow(&token, "/modules/evaluate", json!({ "moduleId": id })))
        }
        ModulesAction::Propose { seam } => {
            println!("{META}asking the local model for a module candidate (one full completion — this takes a while)…{RESET}");
            let body = match seam {
                Some(s) => json!({ "seam": s }),
                None => json!({}),
            };
            block_on(post_json_slow(&token, "/modules/propose", body))
        }
    };

    let v = match result {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{FAIL}modules request failed{RESET}: {e}");
            return 1;
        }
    };
    if json() {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(v.get("id").is_some()) { 0 } else { 1 };
    }
    match &action {
        ModulesAction::List => {
            let empty = vec![];
            let rows = v.get("modules").and_then(|m| m.as_array()).unwrap_or(&empty);
            // Seams always print, even with zero modules — the operator
            // sees what CAN evolve, not just what has.
            if let Some(seams) = v.get("seams").and_then(|s| s.as_object()) {
                for (seam, entry) in seams {
                    let active = entry.get("active").and_then(|a| a.as_str()).unwrap_or("builtin");
                    println!("{ACCENT}{seam}{RESET}  {TEXT}active: {active}{RESET}");
                }
            }
            if rows.is_empty() {
                println!("{DIM}no module candidates{RESET}");
            }
            for r in rows {
                let id = r.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                let seam = r.get("seam").and_then(|x| x.as_str()).unwrap_or("?");
                let state = r.get("state").and_then(|x| x.as_str()).unwrap_or("?");
                let name = r.get("displayName").and_then(|x| x.as_str()).unwrap_or("");
                println!("  {TEXT}{id}{RESET}  {META}{seam} · {state}{RESET}  {DIM}{name}{RESET}");
            }
            0
        }
        ModulesAction::Show { .. } => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            0
        }
        _ => {
            let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
            if ok {
                let state = v.get("state").and_then(|s| s.as_str()).unwrap_or("done");
                println!("{OK}✓ {state}{RESET}");
                if let Some(mid) = v.get("moduleId").and_then(|m| m.as_str()) {
                    println!("  {META}candidate:{RESET} {TEXT}{mid}{RESET}  {DIM}next: cinderpaw modules evaluate {mid}{RESET}");
                }
                if let Some(rep) = v.get("report") {
                    let accept = rep.get("accept").and_then(|b| b.as_bool()).unwrap_or(false);
                    let reason = rep.get("reason").and_then(|r| r.as_str()).unwrap_or("");
                    println!("  {META}eval: {}{RESET} {DIM}{reason}{RESET}", if accept { "accept" } else { "reject" });
                }
                0
            } else {
                let reason = v.get("reason").and_then(|r| r.as_str()).unwrap_or("unknown error");
                eprintln!("{FAIL}✗ {reason}{RESET}");
                // An eval that ran but REJECTED the candidate still carries
                // the report — show why.
                if let Some(rep) = v.get("report") {
                    let reason = rep.get("reason").and_then(|r| r.as_str()).unwrap_or("");
                    eprintln!("  {META}eval detail:{RESET} {DIM}{reason}{RESET}");
                }
                1
            }
        }
    }
}

/// Faza 4 (L2 LoRA) — `cinderpaw lora …`. Same plumbing as `modules`: gateway
/// up, token, one HTTP call per op, `--json` honored.
pub fn lora(action: LoraAction) -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, dim: DIM, fail: FAIL, ok: OK, reset: RESET, .. } =
        palette();
    if !port_in_use(api_port()) {
        eprintln!("{META}gateway offline — start it with `cinderpaw gateway start`{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}~/.cinderpaw/api-token missing{RESET}");
        return 1;
    };

    let result = match &action {
        LoraAction::Status => block_on(fetch_json(&token, "/runtime/lora")),
        LoraAction::Train { domain } => {
            block_on(post_json_with_body(&token, "/runtime/lora/train", json!({ "domain": domain })))
        }
        LoraAction::Reviews => block_on(fetch_json(&token, "/runtime/lora/reviews")),
        LoraAction::Approve { id } => block_on(post_json_with_body(
            &token,
            "/runtime/lora/reviews/resolve",
            json!({ "id": id, "action": "approve" }),
        )),
        LoraAction::Reject { id } => block_on(post_json_with_body(
            &token,
            "/runtime/lora/reviews/resolve",
            json!({ "id": id, "action": "reject" }),
        )),
    };

    let v = match result {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{FAIL}lora request failed{RESET}: {e}");
            return 1;
        }
    };
    if json() {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return match &action {
            LoraAction::Status | LoraAction::Reviews => 0,
            _ => {
                let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or_else(|| {
                    v.get("status").and_then(|s| s.as_str()).map(|s| s != "error").unwrap_or(false)
                });
                if ok { 0 } else { 1 }
            }
        };
    }
    match &action {
        LoraAction::Status => {
            let active = v.get("active").and_then(|a| a.as_str()).unwrap_or("none");
            println!("{ACCENT}active adapter{RESET}  {TEXT}{active}{RESET}");
            0
        }
        LoraAction::Train { domain } => {
            println!("{OK}✓ training cycle started{RESET} {META}(domain={domain}){RESET}");
            println!("  {DIM}takes minutes to hours — follow with `cinderpaw logs -f`; the result lands in `cinderpaw lora reviews`{RESET}");
            0
        }
        LoraAction::Reviews => {
            let empty = vec![];
            let cards = v.get("reviews").and_then(|r| r.as_array()).unwrap_or(&empty);
            if cards.is_empty() {
                println!("{DIM}no pending review cards{RESET}");
            }
            for c in cards {
                let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                let domain = c.get("domain").and_then(|x| x.as_str()).unwrap_or("?");
                let status = c.get("status").and_then(|x| x.as_str()).unwrap_or("?");
                println!("  {TEXT}{id}{RESET}  {META}{domain} · {status}{RESET}");
            }
            let champs = v.get("champions").and_then(|c| c.as_array()).unwrap_or(&empty);
            for ch in champs {
                let domain = ch.get("domain").and_then(|x| x.as_str()).unwrap_or("?");
                let id = ch.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                println!("{ACCENT}champion{RESET}  {META}{domain}{RESET}  {TEXT}{id}{RESET}");
            }
            0
        }
        LoraAction::Approve { .. } | LoraAction::Reject { .. } => {
            // `lora_review_resolved` carries {id, status, error?} — status is
            // the card's new state ("approved"/"rejected") or "error".
            let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("error");
            if status != "error" {
                println!("{OK}✓ {status}{RESET}");
                0
            } else {
                let reason = v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error");
                eprintln!("{FAIL}✗ {reason}{RESET}");
                1
            }
        }
    }
}

/// Shared pretty-printer for the four read ops (status / history /
/// proposals / verify). Honors `--json`. The verify op also drives the
/// exit code (AC 8/11): exit 0 iff every chain + journal row verified.
///
/// Takes `&Result` so callers don't have to pre-handle the network
/// failure case (printing a one-line error and returning 1). On `Err` we
/// mirror what the mutation renderer does — surface the message + 1.
fn render_governance_read(
    result: &Result<serde_json::Value, String>,
    action: &GovernanceAction,
    p: &Palette,
) -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, dim: DIM, ok: OK, fail: FAIL, reset: RESET, .. } = *p;
    let v = match result {
        Ok(v) => v,
        Err(e) => {
            let op = match action {
                GovernanceAction::Status => "status",
                GovernanceAction::Proposals => "proposals",
                GovernanceAction::History => "history",
                GovernanceAction::Verify => "verify",
                _ => "read",
            };
            eprintln!("{FAIL}governance {op} request failed{RESET}: {e}");
            return 1;
        }
    };
    if json() {
        println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
        return if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) { 0 } else { 1 };
    }
    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
    // A failed verify carries its detail in `chains`/`journal`, not a
    // top-level `reason` — let it reach its renderer so the user sees
    // WHICH file/row failed instead of "unknown error".
    if !ok && !matches!(action, GovernanceAction::Verify) {
        let reason = v.get("reason").and_then(|r| r.as_str()).unwrap_or("unknown error");
        eprintln!("{FAIL}\u{2717} {reason}{RESET}");
        return 1;
    }
    match action {
        GovernanceAction::Status => render_governance_status(v, ACCENT, TEXT, META, DIM, RESET),
        GovernanceAction::Proposals => render_governance_status(v, ACCENT, TEXT, META, DIM, RESET),
        GovernanceAction::History => render_governance_history(v, ACCENT, TEXT, META, DIM, RESET),
        GovernanceAction::Verify => render_governance_verify(v, OK, FAIL, TEXT, DIM, RESET),
        _ => unreachable!("non-read action reached render_governance_read"),
    }
    0
}

/// Shared pretty-printer for mutation results. Mirrors `meta`'s `ok / reason`
/// banner; on success prints `policyId / direction / status` when present
/// (useful after `propose`).
fn render_governance_mutation(
    result: Result<serde_json::Value, String>,
    op: &str,
    p: &Palette,
) -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, dim: DIM, ok: OK, fail: FAIL, reset: RESET, .. } = *p;
    let v = match result {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{FAIL}governance {op} failed{RESET}: {e}");
            return 1;
        }
    };
    if json() {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) { 0 } else { 1 };
    }
    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
    if !ok {
        let reason = v.get("reason").and_then(|r| r.as_str()).unwrap_or("unknown error");
        eprintln!("{FAIL}\u{2717} {op}: {reason}{RESET}");
        return 1;
    }
    println!("{OK}\u{2713}{RESET} {TEXT}{op}{RESET} {OK}ok{RESET}");
    if let Some(pid) = v.get("policyId").and_then(|p| p.as_str()) {
        let dir = v.get("direction").and_then(|d| d.as_str()).unwrap_or("");
        let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
        println!("    {META}policyId  {RESET}{TEXT}{pid}{RESET}");
        if !dir.is_empty() {
            println!("    {META}direction {RESET}{TEXT}{dir}{RESET}");
        }
        if !status.is_empty() {
            println!("    {META}status    {RESET}{TEXT}{status}{RESET}");
        }
    }
    if let Some(hash) = v.get("documentHash").and_then(|h| h.as_str()) {
        println!("    {META}documentHash {RESET}{TEXT}{}{RESET}", &hash[..16.min(hash.len())]);
    }
    let _ = (ACCENT, DIM); // suppress unused warnings on minimal renderers
    0
}

fn render_governance_status(
    v: &serde_json::Value,
    ACCENT: &str,
    TEXT: &str,
    META: &str,
    DIM: &str,
    RESET: &str,
) {
    let source = v.get("source").and_then(|s| s.as_str()).unwrap_or("?");
    let fail_closed = v.get("failClosed").and_then(|b| b.as_bool()).unwrap_or(false);
    let head_hash = v.get("headHash").and_then(|h| h.as_str());
    println!("  {ACCENT}\u{2726} governance{RESET}  {META}source={source}{RESET}  {DIM}failClosed={fail_closed}{RESET}");
    if let Some(h) = head_hash {
        println!("    {META}headHash  {RESET}{TEXT}{}{RESET}", &h[..16.min(h.len())]);
    }
    if let Some(policy) = v.get("policy").and_then(|p| p.as_object()) {
        if let Some(pid) = policy.get("policyId").and_then(|p| p.as_str()) {
            println!("    {META}policyId  {RESET}{TEXT}{pid}{RESET}");
        }
        if let Some(parent) = policy.get("parentId").and_then(|p| p.as_str()) {
            println!("    {META}parentId  {RESET}{TEXT}{parent}{RESET}");
        }
        if let Some(frozen) = policy.get("frozen").and_then(|f| f.as_object()) {
            let active: Vec<String> = frozen
                .iter()
                .filter_map(|(k, v)| v.as_bool().filter(|b| *b).map(|_| k.clone()))
                .collect();
            if active.is_empty() {
                println!("    {META}frozen    {RESET}{DIM}none{RESET}");
            } else {
                println!("    {META}frozen    {RESET}{TEXT}{}{RESET}", active.join(", "));
            }
        }
    }
    if let Some(pending) = v.get("pending").and_then(|p| p.as_array()) {
        if pending.is_empty() {
            println!("    {META}pending   {RESET}{DIM}none{RESET}");
        } else {
            println!("    {META}pending   {RESET}{TEXT}{} proposal(s){RESET}", pending.len());
            for row in pending {
                let pid = row.get("policyId").and_then(|p| p.as_str()).unwrap_or("?");
                let dir = row.get("direction").and_then(|d| d.as_str()).unwrap_or("?");
                let req = row.get("requiredApproval").and_then(|b| b.as_bool()).unwrap_or(true);
                println!(
                    "      {TEXT}{pid:<10}{RESET} {META}direction={dir:<11}{RESET} {META}required={}{RESET}",
                    if req { "yes" } else { "no (auto)" }
                );
            }
        }
    }
}

fn render_governance_history(
    v: &serde_json::Value,
    ACCENT: &str,
    TEXT: &str,
    META: &str,
    DIM: &str,
    RESET: &str,
) {
    println!("  {ACCENT}\u{2726} governance history{RESET}");
    let rows = v
        .get("history")
        .and_then(|h| h.as_array())
        .into_iter()
        .flatten();
    for row in rows {
        let pid = row.get("policyId").and_then(|p| p.as_str()).unwrap_or("?");
        let event = row.get("event").and_then(|e| e.as_str()).unwrap_or("?");
        let actor = row.get("actor").and_then(|a| a.as_str()).unwrap_or("?");
        let reason = row.get("reason").and_then(|r| r.as_str()).unwrap_or("");
        println!(
            "    {TEXT}{pid:<14}{RESET} {META}{event:<11}{RESET} {META}actor={actor:<8}{RESET} {DIM}{reason}{RESET}"
        );
    }
}

fn render_governance_verify(
    v: &serde_json::Value,
    OK: &str,
    FAIL: &str,
    TEXT: &str,
    DIM: &str,
    RESET: &str,
) {
    println!("  {TEXT}governance verify{RESET}");
    if let Some(chains) = v.get("chains") {
        if chains.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
            let h = chains.get("historyRows").and_then(|n| n.as_u64()).unwrap_or(0);
            let a = chains.get("auditRows").and_then(|n| n.as_u64()).unwrap_or(0);
            let p = chains.get("approvalRows").and_then(|n| n.as_u64()).unwrap_or(0);
            println!(
                "    {OK}\u{2713}{RESET} {TEXT}chains  {RESET}history={h} audit={a} approvals={p}"
            );
        } else {
            let file = chains.get("file").and_then(|s| s.as_str()).unwrap_or("?");
            let row = chains.get("badRow").and_then(|n| n.as_u64()).unwrap_or(0);
            let reason = chains.get("reason").and_then(|s| s.as_str()).unwrap_or("?");
            println!(
                "    {FAIL}\u{2717}{RESET} {TEXT}chains  {RESET}file={file} row={row} {DIM}{reason}{RESET}"
            );
        }
    }
    if let Some(journal) = v.get("journal").and_then(|j| j.as_array()) {
        for entry in journal {
            let file = entry.get("file").and_then(|s| s.as_str()).unwrap_or("?");
            if entry.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
                println!("    {OK}\u{2713}{RESET} {TEXT}journal  {RESET}{DIM}{file}{RESET}");
            } else {
                let row = entry.get("badRow").and_then(|n| n.as_u64()).unwrap_or(0);
                let reason = entry.get("reason").and_then(|s| s.as_str()).unwrap_or("?");
                println!(
                    "    {FAIL}\u{2717}{RESET} {TEXT}journal  {RESET}{DIM}{file} row={row} {RESET}{DIM}{reason}{RESET}"
                );
            }
        }
    }
}

/// Returns a short noun describing a `serde_json::Value` for error messages.
fn document_kind(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

// ── config ─────────────────────────────────────────────────────────────────

pub fn config_get(key: Option<&str>) -> i32 {
    let path = feral_file("settings.json");
    let v: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    match key {
        None => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
        Some(k) => match v.get(k) {
            Some(val) => println!("{val}"),
            None => {
                eprintln!("{}no such key: {k}{}", palette().meta, palette().reset);
                return 1;
            }
        },
    }
    0
}

/// Set a top-level key in `settings.json`. Values that parse as JSON (numbers,
/// booleans, null, arrays, objects) are stored as such; anything else as a
/// string. This writes the file directly — a power-user knob — so a running
/// gateway needs a restart to pick most keys up.
pub fn config_set(key: &str, value: &str) -> i32 {
    let Palette { ok: OK, meta: META, fail: FAIL, dim: DIM, reset: RESET, .. } = palette();
    let path = feral_file("settings.json");
    let mut v: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !v.is_object() {
        v = serde_json::json!({});
    }
    let parsed: serde_json::Value =
        serde_json::from_str(value).unwrap_or_else(|_| serde_json::Value::String(value.to_string()));
    v[key] = parsed.clone();
    match std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default()) {
        Ok(_) => {
            println!("{OK}✓{RESET} {key} = {parsed}");
            println!("  {DIM}{META}restart the gateway to apply{RESET}");
            0
        }
        Err(e) => {
            eprintln!("{FAIL}could not write settings.json{RESET}: {e}");
            1
        }
    }
}

// ── doctor ─────────────────────────────────────────────────────────────────

enum Check {
    Ok(String),
    Warn(String),
    Fail(String),
}

pub fn doctor() -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, ok: OK, warn: WARN, fail: FAIL, bold: BOLD, dim: DIM, reset: RESET, .. } =
        palette();
    let checks = vec![
        ("api port", check_port()),
        ("api token", check_token()),
        ("models", check_models()),
        ("brain config", check_brain()),
        ("sidecar", check_sidecar()),
        ("keychain", check_keychain()),
        ("gpu", check_gpu()),
        ("connectors", check_connectors()),
        ("governance", check_governance()),
    ];

    if json() {
        let items: Vec<serde_json::Value> = checks
            .iter()
            .map(|(label, c)| {
                let (status, detail) = match c {
                    Check::Ok(d) => ("ok", d),
                    Check::Warn(d) => ("warn", d),
                    Check::Fail(d) => ("fail", d),
                };
                serde_json::json!({ "check": label, "status": status, "detail": detail })
            })
            .collect();
        let fails = checks.iter().filter(|(_, c)| matches!(c, Check::Fail(_))).count();
        println!("{}", serde_json::json!({ "healthy": fails == 0, "checks": items }));
        return if fails == 0 { 0 } else { 1 };
    }

    println!("\n  {ACCENT}{BOLD}cinderpaw{RESET} {ACCENT}▸{RESET} {TEXT}doctor{RESET}\n");
    let mut fails = 0;
    let mut warns = 0;
    for (label, c) in &checks {
        match c {
            Check::Ok(d) => println!("  {OK}✓{RESET} {TEXT}{label}{RESET} {DIM}{META}{d}{RESET}"),
            Check::Warn(d) => {
                warns += 1;
                println!("  {WARN}⚠{RESET} {TEXT}{label}{RESET} {META}{d}{RESET}");
            }
            Check::Fail(d) => {
                fails += 1;
                println!("  {FAIL}✗{RESET} {TEXT}{label}{RESET} {META}{d}{RESET}");
            }
        }
    }
    println!();
    if fails > 0 {
        println!("  {FAIL}{fails} problem(s){RESET}{META}, {warns} warning(s){RESET}");
        1
    } else if warns > 0 {
        println!("  {OK}healthy{RESET}{META}, {warns} warning(s){RESET}");
        0
    } else {
        println!("  {OK}all clear{RESET}");
        0
    }
}

fn check_port() -> Check {
    let port = api_port();
    if port_in_use(port) {
        match read_token().and_then(|t| block_on(fetch_json(&t, "/runtime/status")).ok()) {
            Some(v) => {
                // Surface the supervised sidecar state from the gateway's own
                // report: the CLI's `check_sidecar` only knew the binary was
                // on disk, which lied when the process had crashed silently
                // (the 503-everywhere symptom on Linux headless + broken
                // self-src bundle). The gateway is the source of truth — its
                // `/runtime/status` returns `sidecar_alive: false` when the
                // supervisor lost the child.
                let sidecar_alive = v
                    .get("sidecar_alive")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false);
                if sidecar_alive {
                    Check::Ok(format!("gateway running on 127.0.0.1:{port} (sidecar alive)"))
                } else {
                    Check::Warn(format!(
                        "gateway running on 127.0.0.1:{port} but sidecar is DOWN — \
                         check ~/.cinderpaw/gateway.log"
                    ))
                }
            }
            None => Check::Warn(format!(
                "port {port} is in use but not answering /runtime/status — another app?"
            )),
        }
    } else {
        Check::Ok(format!("port {port} free (gateway can start)"))
    }
}

fn check_token() -> Check {
    match read_token() {
        Some(t) if !t.is_empty() => Check::Ok("~/.cinderpaw/api-token present".into()),
        _ => Check::Warn("~/.cinderpaw/api-token missing — created on first gateway boot".into()),
    }
}

/// `cinderpaw setup` — launches the Go/Bubble Tea onboarding wizard
/// (cinderpaw-tui). Replaces the old Bun sidecar path. The Rust side handles
/// runtime auto-start so the TUI connects immediately. The TUI binary sits next
/// to the CLI binary; build it with `cd tui && go build -o cinderpaw-tui.exe .`.
pub fn setup() -> i32 {
    // Auto-start the gateway if not already running (same as `cinderpaw chat`).
    if let Err(code) = ensure_gateway() {
        return code;
    }

    // Same resolver `cinderpaw chat` uses — including the pre-rename name, so
    // one of the two commands cannot find a TUI the other one launches.
    let Some(tui_bin) = crate::chat::tui_binary_path() else {
        // CLI-only installs don't ship the Go TUI — steer to the native guided
        // flow (which needs no TUI) rather than the developer build command.
        eprintln!("cinderpaw: the classic wizard needs the interactive TUI, which isn't in this CLI-only build.");
        eprintln!("           run the guided setup instead:  cinderpaw setup");
        return 1;
    };

	let code = match std::process::Command::new(&tui_bin)
		.arg("--wizard")
		.stdin(std::process::Stdio::inherit())
		.stdout(std::process::Stdio::inherit())
		.stderr(std::process::Stdio::inherit())
		.status()
    {
        Ok(s) => s.code().unwrap_or(0),
        Err(e) => {
            let Palette { fail: FAIL, reset: RESET, .. } = palette();
            eprintln!("{FAIL}cinderpaw: setup failed to start: {e}{RESET}");
            1
        }
    };
    // Un-poison the console if the TUI exited without restoring it.
    crate::common::reset_console_mode();
    code
}

fn check_models() -> Check {
    match cinderpaw_core::models::scan_models_dir() {
        Ok(m) if !m.is_empty() => Check::Ok(format!("{} model(s) on disk", m.len())),
        Ok(_) => Check::Warn("no .gguf models in ~/.cinderpaw/models — download one or use BYOK".into()),
        Err(e) => Check::Fail(format!("cannot read models dir: {e}")),
    }
}

/// Validate `brain.json` against the contract the sidecar's `loadBrainConfig()`
/// enforces: `{ enabled: bool, mode: string, registry: array }`. This is the
/// one check that would have caught the P0 where the old `cinderpaw setup` wrote
/// `{ primary, fallback, capabilities }` — a shape the runtime rejects, so
/// `cinderpaw chat` / `FERAL_BRAIN=1` threw on first run. Doctor runs offline
/// (no sidecar), so it parses the file itself rather than asking the gateway.
///
/// Absent brain.json is a WARN, not a FAIL: Brain Stack is opt-in.
fn check_brain() -> Check {
    let path = feral_file("brain.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Check::Warn("no brain.json — Brain Stack off (run `cinderpaw setup`)".into()),
    };
    let obj = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(o)) => o,
        Ok(_) => return Check::Fail("brain.json must be a JSON object".into()),
        Err(e) => return Check::Fail(format!("brain.json invalid JSON: {e}")),
    };

    let has_enabled = obj.get("enabled").is_some_and(|v| v.is_boolean());
    let has_mode = obj.get("mode").is_some_and(|v| v.is_string());
    let has_registry = obj.get("registry").is_some_and(|v| v.is_array());

    if has_enabled && has_mode && has_registry {
        let n = obj["registry"].as_array().map_or(0, |a| a.len());
        let mode = obj["mode"].as_str().unwrap_or("?");
        let state = if obj["enabled"].as_bool().unwrap_or(false) { "enabled" } else { "disabled" };
        return Check::Ok(format!("valid — {state}, mode={mode}, {n} model(s)"));
    }

    // Keys the user actually has (drop `//comment` keys the example file uses).
    let found: Vec<&str> = obj
        .keys()
        .map(String::as_str)
        .filter(|k| !k.starts_with("//"))
        .collect();

    // Name the legacy shape explicitly so the fix ("re-run setup") is obvious.
    if obj.contains_key("primary") || obj.contains_key("capabilities") {
        return Check::Fail(format!(
            "old shape (found: {}) — expected: enabled, mode, registry. Re-run `cinderpaw setup`.",
            found.join(", ")
        ));
    }

    let mut missing = Vec::new();
    if !has_enabled { missing.push("enabled"); }
    if !has_mode { missing.push("mode"); }
    if !has_registry { missing.push("registry"); }
    Check::Fail(format!(
        "missing/invalid: {} (found: {})",
        missing.join(", "),
        found.join(", "),
    ))
}

/// Slice A5 (L5 Governance) — verifies the policy FSM is reachable, the
/// active policy is loaded from disk (not the fail-closed builtin), and
/// the hash chains + last 7 UTC days of journal all verify. The brief
/// (spec §15 doctor check) says "one check" so this single function
/// surfaces all three sub-results joined with ` · `.
///
/// Gate choice: this is WARN, not FAIL, when the gateway is offline or
/// the policy hasn't been seeded yet — first-run users without a
/// `~/.cinderpaw/governance/policy.json` shouldn't see a red row. It becomes
/// FAIL when the gateway is reachable AND the policy is the builtin
/// (G-INV-5 fail-closed is still functional but operators need to know
/// they're on the safety default) or when the verify report says any
/// chain or journal file is broken.
fn check_governance() -> Check {
    let Some(token) = read_token() else {
        return Check::Warn("no api-token — gateway offline; skipping governance check".into());
    };
    if !port_in_use(api_port()) {
        return Check::Warn("gateway offline; skipping governance check".into());
    }
    let policy = block_on(fetch_json(&token, "/governance/policy"));
    let verify = block_on(fetch_json(&token, "/governance/verify"));
    let policy_ok = policy.as_ref().map(|v| v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false)).unwrap_or(false);
    let source = policy.as_ref().ok().and_then(|v| v.get("source").and_then(|s| s.as_str())).unwrap_or("");
    let verify_ok = verify.as_ref().map(|v| v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false)).unwrap_or(false);
    let chains_ok = verify.as_ref().ok()
        .and_then(|v| v.get("chains").and_then(|c| c.get("ok")).and_then(|b| b.as_bool()))
        .unwrap_or(false);
    let journal_ok = verify.as_ref().ok()
        .and_then(|v| v.get("journal").and_then(|j| j.as_array()))
        .map(|a| a.iter().all(|e| e.get("ok").and_then(|b| b.as_bool()).unwrap_or(false)))
        .unwrap_or(false);
    if source == "builtin" {
        return Check::Fail(
            "policy is the fail-closed builtin (no user policy on disk) — propose one with `cinderpaw governance propose <file>`".into(),
        );
    }
    if !policy_ok {
        return Check::Fail(format!(
            "/governance/policy returned {policy_err}",
            policy_err = policy.as_ref().err().cloned().unwrap_or_else(|| "ok:false".into())
        ));
    }
    if !verify_ok || !chains_ok || !journal_ok {
        let why: String = match verify.as_ref() {
            Err(e) => e.clone(),
            Ok(v) => {
                if !chains_ok {
                    let file = v.get("chains").and_then(|c| c.get("file")).and_then(|s| s.as_str()).unwrap_or("?");
                    format!("chain broken in {file}")
                } else if !journal_ok {
                    let bad = v.get("journal").and_then(|j| j.as_array())
                        .into_iter()
                        .flatten()
                        .find(|e| !e.get("ok").and_then(|b| b.as_bool()).unwrap_or(true))
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let file = bad.get("file").and_then(|s| s.as_str()).unwrap_or("?");
                    let reason = bad.get("reason").and_then(|s| s.as_str()).unwrap_or("?");
                    format!("journal broken in {file}: {reason}")
                } else {
                    "unknown verify failure".into()
                }
            }
        };
        return Check::Fail(format!("verify not clean: {why}"));
    }
    Check::Ok(format!("source={source} · chains ok · last 7 UTC days ok"))
}

fn check_sidecar() -> Check {
    match cinderpaw_core::cinderpaw_agent::find_binary(&[]) {
        Some(p) => {
            // This check owns exactly one fact: the binary is where the CLI
            // expects it. Liveness belongs to `check_port`, which asks the
            // gateway's own /runtime/status — the only source that knows
            // whether the supervisor still has its child.
            //
            // It used to second-guess that with a PID file, and the guess was
            // wrong on two of the three platforms: `pid_file_alive` was
            // Linux-only and returned `false` everywhere else by design, but
            // this caller turned "cannot tell" into the positive claim "the
            // supervised sidecar is DOWN". Every healthy Windows and macOS
            // gateway was told its sidecar had died, in the same `doctor`
            // output where `api port` said it was alive.
            if port_in_use(api_port()) {
                Check::Ok(format!("{}", p.display()))
            } else {
                Check::Warn(format!(
                    "{} on disk; gateway not running — start with `cinderpaw gateway start`",
                    p.display()
                ))
            }
        }
        None => Check::Fail("feral-agent sidecar binary not found next to the executable".to_string()),
    }
}

/// Probe the OS keychain so we can warn a Linux-headless user BEFORE they
/// type their first API key that byok will fall back to the file store.
/// On Windows/macOS this always reports OK (Credential Manager / Keychain
/// are present on every SKU Cinderpaw ships to). On Linux we do a real probe
/// — `set` + `delete` round-trip under a reserved probe user — so a
/// missing `gnome-keyring-daemon` or `libsecret` shows up as `⚠` here,
/// not as `✗ byok_save_failed` on the next `setup verify` round-trip.
/// If we've already fallen back (file store in use), report that
/// explicitly so the user knows where their keys live.
fn check_keychain() -> Check {
    if cinderpaw_core::byok::file_fallback_used() {
        return Check::Ok(
            "file store at ~/.cinderpaw/byok.keys (OS keychain unavailable on this host)".to_string(),
        );
    }
    match cinderpaw_core::byok::keychain_probe() {
        Ok(()) => Check::Ok("OS keychain".to_string()),
        Err(e) => {
            let kind = cinderpaw_core::byok::keychain_error_kind(&e);
            Check::Warn(format!(
                "OS keychain unavailable ({kind}); byok will fall back to ~/.cinderpaw/byok.keys on first save"
            ))
        }
    }
}

fn check_gpu() -> Check {
    let info = cinderpaw_core::gpu_detect::detect();
    if info.name.is_empty() || info.name.eq_ignore_ascii_case("none") {
        Check::Warn("no GPU detected — inference runs on CPU".into())
    } else {
        Check::Ok(format!("{} ({} MB, vulkan: {})", info.name, info.vram_mb, info.supports_vulkan))
    }
}

fn check_connectors() -> Check {
    let path = feral_file("connectors.json");
    if !path.exists() {
        Check::Warn("no connectors.json — Discord/Slack/etc. not configured".into())
    } else {
        match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(_) => Check::Ok("connectors.json is valid JSON".into()),
                Err(e) => Check::Fail(format!("connectors.json is invalid JSON: {e}")),
            },
            Err(e) => Check::Fail(format!("cannot read connectors.json: {e}")),
        }
    }
}

// ── shared HTTP helpers ────────────────────────────────────────────────────

/// The client every CLI call uses.
///
/// `reqwest::Client::new()` has NO timeout — a gateway that accepts the
/// connection and then never answers left `cinderpaw status`, `cinderpaw doctor`,
/// `cinderpaw connectors list` and `cinderpaw providers use` hanging with no output and
/// no way out but Ctrl-C. A command that returns an error in 30 seconds is a
/// far better answer than one that never returns at all.
///
/// ponytail: one shared ceiling. The single long call (`/modules/evaluate`,
/// which really does run for half an hour) keeps its own client below.
fn stream_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        // A client with default settings cannot fail to build; if it somehow
        // did, an untimed client still beats aborting the command.
        .unwrap_or_else(|_| reqwest::Client::new())
}


pub(crate) async fn fetch_json(token: &str, path: &str) -> Result<serde_json::Value, String> {
    client()
        .get(format!("{}{}", base_url(), path))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn post_json(token: &str, path: &str) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{}{}", base_url(), path))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// `POST` with a JSON body. Mirrors `post_json` but serialises the body and
/// sets `Content-Type: application/json`. Used by `/governance/propose`,
/// `/approve`, `/reject`, `/freeze`, `/unfreeze` — the legacy `post_json`
/// stays for `/meta/evolve` and `/meta/rollback` which carry no body.
pub(crate) async fn post_json_with_body(
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{}{}", base_url(), path))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// POST with a long client timeout — `/modules/evaluate` runs the paired
/// eval suite twice on the live model (the gateway side waits 30min).
async fn post_json_slow(
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(31 * 60))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{}{}", base_url(), path))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn post(token: &str, path: &str) -> Result<(), String> {
    client()
        .post(format!("{}{}", base_url(), path))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/* ------------------------------------------------------------ providers */
// `cinderpaw providers` — the management surface for cloud providers.
//
// `cinderpaw model` only ever listed local .gguf files, and `cinderpaw setup` is a
// wizard. On a headless box with no TTY there was no way to see which
// providers were configured, switch between them, or add a key without
// hand-rolling a curl against /runtime/setup/verify.
//
// Reads and writes byok.json + settings.json through cinderpaw-core, so it works
// with the gateway offline — which is exactly when you need it most.

/// Actions for `cinderpaw providers`.
#[derive(Subcommand)]
pub enum ProvidersAction {
    /// List providers, which have a key, and which one is active (default)
    List,
    /// Make a provider the active route
    Use {
        /// Provider id, e.g. `nvidia`, `minimax`, `openai`
        id: String,
        /// Model to route to. Defaults to the provider's configured model.
        #[arg(long)]
        model: Option<String>,
    },
    /// Store an API key for a provider. The key is read from STDIN, never
    /// from an argument — a key in argv is visible to every process on the
    /// box via `ps` and lands in shell history.
    SetKey {
        /// Provider id, e.g. `nvidia`
        id: String,
        /// Also set this as the provider's default model
        #[arg(long)]
        model: Option<String>,
        /// Skip the live completion check and save the key unverified
        #[arg(long)]
        no_verify: bool,
        /// Also make this provider the active route on success
        #[arg(long)]
        activate: bool,
    },
}

/// Split `provider:model` into its two halves. A route with no colon is
/// provider-only, which is how a local-model route reads.
pub fn split_route(route: &str) -> (String, String) {
    match route.split_once(':') {
        Some((p, m)) => (p.to_string(), m.to_string()),
        None => (route.to_string(), String::new()),
    }
}

/// `cinderpaw providers` — one row per provider the user has actually touched.
pub fn providers_list() -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, bold: BOLD, dim: DIM, reset: RESET, .. } =
        palette();
    let settings = cinderpaw_core::settings::load();
    let byok = cinderpaw_core::byok::load(&settings);
    let active = settings.active_route.clone().unwrap_or_default();
    let (active_provider, _) = split_route(&active);

    if json() {
        let rows: Vec<serde_json::Value> = cinderpaw_core::byok::provider_catalog()
            .into_iter()
            .map(|entry| {
                let cfg = byok.providers.get(&entry.id);
                json!({
                    "id": entry.id,
                    "name": entry.name,
                    "configured": cfg.is_some(),
                    "enabled": cfg.map(|c| c.enabled).unwrap_or(false),
                    "has_key": cinderpaw_core::byok::byok_get(&entry.id).is_some(),
                    "model": cfg.and_then(|c| c.default_model.clone()),
                    "base_url": cfg
                        .and_then(|c| c.base_url.clone())
                        .unwrap_or_else(|| entry.default_base_url.clone()),
                    "active": entry.id == active_provider,
                })
            })
            .collect();
        println!("{}", json!({ "active_route": active, "providers": rows }));
        return 0;
    }

    println!("{BOLD}{TEXT}providers{RESET} {DIM}{META}(~/.cinderpaw/byok.json){RESET}");
    for entry in cinderpaw_core::byok::provider_catalog() {
        let cfg = byok.providers.get(&entry.id);
        let has_key = cinderpaw_core::byok::byok_get(&entry.id).is_some();
        // Only rows the user has touched, plus anything holding a key. The
        // catalog is long, and a wall of unconfigured providers buries the
        // two lines that matter.
        if cfg.is_none() && !has_key {
            continue;
        }
        let is_active = entry.id == active_provider;
        let marker = if is_active { "*" } else { " " };
        let name_color = if is_active { ACCENT } else { TEXT };
        let key_note = if has_key { "key stored" } else { "NO KEY" };
        let model = cfg
            .and_then(|c| c.default_model.clone())
            .unwrap_or_else(|| "-".into());
        println!(
            "{ACCENT}{marker}{RESET} {name_color}{:<12}{RESET} {DIM}{META}{:<26}{RESET} {META}{}{RESET}",
            entry.id, model, key_note
        );
    }
    if active.is_empty() {
        println!("\n{META}no active route set - cinderpaw providers use <id>{RESET}");
    } else {
        println!("\n{META}active route: {ACCENT}{active}{RESET}");
    }
    0
}

/// `cinderpaw providers use <id>` — repoint `active_route`.
pub fn providers_use(id: &str, model: Option<String>) -> i32 {
    let Palette { accent: ACCENT, meta: META, reset: RESET, fail: FAIL, .. } = palette();
    let mut settings = cinderpaw_core::settings::load();
    let byok = cinderpaw_core::byok::load(&settings);

    let Some(cfg) = byok.providers.get(id) else {
        eprintln!("{FAIL}provider {id} is not configured - run cinderpaw providers to see what is{RESET}");
        return 1;
    };
    let Some(model) = model.or_else(|| cfg.default_model.clone()) else {
        eprintln!("{FAIL}provider {id} has no default model - pass --model{RESET}");
        return 1;
    };
    // Refuse to route at a provider that cannot answer. Without this the
    // switch "succeeds" and every completion afterwards fails with an auth
    // error that points nowhere near this command.
    if cinderpaw_core::byok::byok_get(id).is_none() {
        eprintln!("{FAIL}provider {id} has no stored key - cinderpaw providers set-key {id} first{RESET}");
        return 1;
    }

    settings.active_route = Some(format!("{id}:{model}"));
    if let Err(e) = cinderpaw_core::settings::save(&settings) {
        eprintln!("{FAIL}could not write settings.json: {e}{RESET}");
        return 1;
    }
    println!("{ACCENT}active route -> {id}:{model}{RESET}");
    println!("{META}restart the gateway for it to take effect: cinderpaw gateway restart{RESET}");
    0
}

/// `cinderpaw providers set-key <id>` — read a key from stdin, verify it with a
/// real completion, then persist.
///
/// Verify-then-save is the invariant the setup wizard already holds: a key
/// that cannot complete never reaches disk, so a typo cannot silently break
/// the active route.
pub fn providers_set_key(id: &str, model: Option<String>, no_verify: bool, activate: bool) -> i32 {
    let Palette { accent: ACCENT, meta: META, reset: RESET, fail: FAIL, .. } = palette();

    let catalog = cinderpaw_core::byok::provider_catalog();
    let llm_entry = catalog.iter().find(|e| e.id == id);
    // A voice engine is not in the LLM catalog and correctly never will be — that
    // catalog is the list of chat backends. Without this branch,
    // `cinderpaw providers set-key fish` reported "unknown provider" for an engine the
    // app ships, and there was no supported way to store a TTS key from a script.
    let tts_entry = cinderpaw_core::tts::catalog().into_iter().find(|e| e.id == id && e.needs_key);
    let display_name = match (llm_entry, &tts_entry) {
        (Some(e), _) => e.name.clone(),
        (None, Some(e)) => e.label.clone(),
        (None, None) => {
            eprintln!("{FAIL}unknown provider {id}{RESET}");
            eprintln!(
                "{META}known: {}{RESET}",
                catalog
                    .iter()
                    .map(|e| e.id.clone())
                    .chain(
                        cinderpaw_core::tts::catalog()
                            .into_iter()
                            .filter(|e| e.needs_key)
                            .map(|e| e.id)
                    )
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            return 1;
        }
    };

    // stdin, never argv. Works piped (`printf %s "$KEY" | cinderpaw providers
    // set-key nvidia`) and typed. ponytail: plain echoed read, same as the
    // wizard at guided.rs:353 - masked input needs a tty-secrets dependency
    // this crate does not carry.
    if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        eprintln!("{META}paste the {display_name} API key, then Enter (input is visible):{RESET}");
    }
    let mut key = String::new();
    if let Err(e) = std::io::stdin().read_line(&mut key) {
        eprintln!("{FAIL}could not read the key from stdin: {e}{RESET}");
        return 1;
    }
    let key = key.trim().to_string();
    if key.is_empty() {
        eprintln!("{FAIL}no key on stdin{RESET}");
        return 1;
    }

    let settings = cinderpaw_core::settings::load();
    let byok = cinderpaw_core::byok::load(&settings);
    let existing = byok.providers.get(id);
    // A voice engine has no LLM base URL or default model to fall back on: each
    // one carries its own defaults in `cinderpaw_core::tts`, and inventing values
    // here would overwrite a working region with a blank.
    let base_url = existing
        .and_then(|c| c.base_url.clone())
        .or_else(|| llm_entry.map(|e| e.default_base_url.clone()));
    let model = model
        .or_else(|| existing.and_then(|c| c.default_model.clone()))
        .or_else(|| llm_entry.map(|e| e.default_model.clone()));

    // Verification runs a chat completion, which a speech endpoint cannot answer.
    // Skipping it for a voice engine is not a shortcut — the alternative is
    // refusing every correct key with a message about completions. The key is
    // proved by the first thing spoken instead.
    let no_verify = no_verify || tts_entry.is_some();
    if !no_verify {
        eprintln!("{META}checking the key with a real completion...{RESET}");
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("{FAIL}could not start a runtime to verify: {e}{RESET}");
                return 1;
            }
        };
        let res = rt.block_on(cinderpaw_core::byok::test_provider(id, &key, base_url.as_deref()));
        if !res.success {
            // Nothing is written on failure - the key never touches disk.
            eprintln!("{FAIL}key rejected: {}{RESET}", res.message);
            eprintln!("{META}nothing was saved. --no-verify stores it anyway.{RESET}");
            return 1;
        }
        eprintln!("{ACCENT}key works{RESET}");
    }

    if let Err(e) = cinderpaw_core::byok::byok_set(id, &key) {
        eprintln!("{FAIL}could not store the key: {e}{RESET}");
        return 1;
    }
    let cfg = cinderpaw_core::byok::ProviderConfig {
        enabled: true,
        // Never persisted in byok.json - the keychain (or the encrypted file
        // fallback on headless Linux) is the only place the secret lives.
        api_key: String::new(),
        base_url,
        default_model: model.clone(),
    };
    if let Err(e) = cinderpaw_core::byok::save_provider(id, cfg) {
        eprintln!("{FAIL}could not write byok.json: {e}{RESET}");
        return 1;
    }
    println!("{ACCENT}{display_name} key stored{RESET}");
    if tts_entry.is_some() {
        println!("{META}voice engine — pick it on the call screen to use it{RESET}");
        // `--activate` routes chat inference; a voice engine is not a chat backend.
        if activate {
            eprintln!("{FAIL}--activate applies to chat providers, not voice engines{RESET}");
            return 1;
        }
        return 0;
    }

    if activate {
        let Some(model) = model else {
            eprintln!("{FAIL}--activate needs a model - pass --model{RESET}");
            return 1;
        };
        return providers_use(id, Some(model));
    }
    println!("{META}make it the active route: cinderpaw providers use {id}{RESET}");
    0
}
