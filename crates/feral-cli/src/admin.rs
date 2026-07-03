//! `feral` management subcommands (Faza 4.5 Slice 4/4b, spec D6):
//! `gateway start|stop|restart|status`, `model`, `doctor`, `logs`,
//! `connectors`, `dreams`, `config`. Everything talks to the same loopback
//! runtime the desktop app and connectors use.

use std::io::{Read, Seek, Write};

use futures_util::StreamExt;

use crate::common::{api_port, base_url, json, palette, port_in_use, read_token, Palette};

/// One blocking tokio runtime for the short HTTP calls these commands make.
fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Runtime::new()
        .expect("tokio runtime")
        .block_on(f)
}

fn feral_file(name: &str) -> std::path::PathBuf {
    feral_core::paths::feral_dir().join(name)
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
            println!("  start it: {ACCENT}feral gateway start{RESET}");
        }
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{WARN}● port {port} busy but ~/.feral/api-token is missing{RESET}");
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
            eprintln!("feral: cannot locate own binary: {e}");
            return 1;
        }
    };
    // Detach from this terminal: logs go to a file, not the console, so the
    // gateway outlives the shell that launched it.
    let log_path = feral_file("gateway.log");
    let log = match std::fs::File::create(&log_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("feral: cannot open {}: {e}", log_path.display());
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
            eprintln!("feral: failed to start gateway: {e}");
            return 1;
        }
    };
    let pid = child.id();
    let _ = std::fs::write(feral_file("gateway.pid"), pid.to_string());

    print!("{META}starting gateway{RESET} ");
    let _ = std::io::stdout().flush();
    for _ in 0..40 {
        if port_in_use(port) {
            println!("\r{OK}● gateway started{RESET}  {DIM}{META}pid {pid} · port {port}{RESET}   ");
            println!("  logs: {DIM}{META}{}{RESET}", log_path.display());
            return 0;
        }
        print!(".");
        let _ = std::io::stdout().flush();
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    eprintln!(
        "\n{FAIL}gateway did not bind port {port} within 20s{RESET} — see {}",
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
        eprintln!("{FAIL}cannot stop: ~/.feral/api-token missing{RESET}");
        return 1;
    };
    if let Err(e) = block_on(post(&token, "/runtime/shutdown")) {
        eprintln!("{FAIL}shutdown request failed{RESET}: {e}");
        return 1;
    }
    print!("{META}stopping gateway{RESET} ");
    let _ = std::io::stdout().flush();
    for _ in 0..70 {
        if !port_in_use(port) {
            let _ = std::fs::remove_file(feral_file("gateway.pid"));
            println!("\r{OK}● gateway stopped{RESET}                 ");
            return 0;
        }
        print!(".");
        let _ = std::io::stdout().flush();
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    eprintln!("\n{WARN}gateway still up after 35s — it may be mid-drain{RESET}");
    1
}

pub fn gateway_restart() -> i32 {
    if port_in_use(api_port()) {
        let code = gateway_stop();
        if code != 0 {
            return code;
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
        eprintln!("{}~/.feral/api-token missing{}", palette().fail, RESET);
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
            println!("{BOLD}{TEXT}models{RESET} {DIM}{META}(~/.feral/models){RESET}");
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
            eprintln!("{}no gateway.log yet — start the gateway with `feral gateway start`{}",
                palette().meta, palette().reset);
            return 1;
        }
    };
    let mut buf = String::new();
    let _ = file.read_to_string(&mut buf);
    print!("{buf}");
    let _ = std::io::stdout().flush();
    if !follow {
        return 0;
    }
    // Tail: seek to EOF, poll for appends. Ctrl+C stops it.
    let mut pos = file.stream_position().unwrap_or(0);
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > pos {
                let _ = file.seek(std::io::SeekFrom::Start(pos));
                let mut chunk = String::new();
                if file.read_to_string(&mut chunk).is_ok() {
                    print!("{chunk}");
                    let _ = std::io::stdout().flush();
                    pos += chunk.len() as u64;
                }
            }
        }
    }
}

// ── connectors ─────────────────────────────────────────────────────────────

pub fn connectors_list() -> i32 {
    let Palette { accent: ACCENT, text: TEXT, meta: META, ok: OK, bold: BOLD, dim: DIM, reset: RESET, .. } =
        palette();
    let path = feral_file("connectors.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            if json() {
                println!("{}", serde_json::json!({ "connectors": [] }));
            } else {
                println!("{META}no connectors configured{RESET} {DIM}{META}(~/.feral/connectors.json){RESET}");
            }
            return 0;
        }
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{}connectors.json is invalid JSON{}: {e}", palette().fail, RESET);
            return 1;
        }
    };
    if json() {
        println!("{v}");
        return 0;
    }
    // connectors.json shape: { "connectors": [ { "id": "discord", "enabled": … } ] }.
    let rows = v.get("connectors").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    if rows.is_empty() {
        println!("{META}no connectors configured{RESET} {DIM}{META}(~/.feral/connectors.json){RESET}");
        return 0;
    }
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
        println!("  {dot}●{RESET} {TEXT}{id}{RESET} {DIM}{META}{label}{ch}{RESET}");
    }
    let _ = ACCENT;
    0
}

pub fn connectors_reload() -> i32 {
    let Palette { ok: OK, meta: META, fail: FAIL, reset: RESET, .. } = palette();
    if !port_in_use(api_port()) {
        eprintln!("{META}gateway offline — nothing to reload{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}~/.feral/api-token missing{RESET}");
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
        eprintln!("{}~/.feral/api-token missing{}", palette().fail, RESET);
        return 1;
    };
    if !json() {
        println!("  {ACCENT}✦ dreams{RESET} {DIM}{META}watching the Dream Cycle — Ctrl+C to stop{RESET}\n");
    }
    block_on(async move {
        let resp = match reqwest::Client::new()
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
        while let Some(chunk) = stream.next().await {
            let Ok(bytes) = chunk else { break };
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(nl) = buf.find('\n') {
                let line: String = buf.drain(..=nl).collect();
                let Some(data) = line.trim_end().strip_prefix("data:") else { continue };
                let Ok(env) = serde_json::from_str::<serde_json::Value>(data.trim()) else { continue };
                // /events payload: { event: "feral://agent-output", data: { data: "<json line>" } }
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
        ("gpu", check_gpu()),
        ("connectors", check_connectors()),
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

    println!("\n  {ACCENT}{BOLD}feral{RESET} {ACCENT}▸{RESET} {TEXT}doctor{RESET}\n");
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
            Some(_) => Check::Ok(format!("gateway running on 127.0.0.1:{port}")),
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
        Some(t) if !t.is_empty() => Check::Ok("~/.feral/api-token present".into()),
        _ => Check::Warn("~/.feral/api-token missing — created on first gateway boot".into()),
    }
}

/// `feral setup` — first-run wizard. The rich wizard currently lives in the
/// TS sidecar (`feral-agent setup`); we delegate to it so the user sees one
/// `feral setup` regardless of where it's implemented. This is the command
/// router pattern: when the wizard is rewritten in Rust (SP1), the user-facing
/// `feral setup` is unchanged. Delegation is invisible — no "launching sidecar"
/// wording leaks to the user; the wizard just runs.
pub fn setup() -> i32 {
    let Palette { fail: FAIL, reset: RESET, .. } = palette();
    let sidecar = match feral_core::feral_agent::find_binary(&[]) {
        Some(p) => p,
        None => {
            eprintln!("{FAIL}feral: runtime component not found — reinstall feral-agent{RESET}");
            return 1;
        }
    };
    // Inherit stdio (default) so the interactive wizard reads the user's answers.
    match std::process::Command::new(&sidecar).arg("setup").status() {
        Ok(s) => s.code().unwrap_or(0),
        Err(e) => {
            eprintln!("{FAIL}feral: setup failed to start: {e}{RESET}");
            1
        }
    }
}

fn check_models() -> Check {
    match feral_core::models::scan_models_dir() {
        Ok(m) if !m.is_empty() => Check::Ok(format!("{} model(s) on disk", m.len())),
        Ok(_) => Check::Warn("no .gguf models in ~/.feral/models — download one or use BYOK".into()),
        Err(e) => Check::Fail(format!("cannot read models dir: {e}")),
    }
}

/// Validate `brain.json` against the contract the sidecar's `loadBrainConfig()`
/// enforces: `{ enabled: bool, mode: string, registry: array }`. This is the
/// one check that would have caught the P0 where the old `feral setup` wrote
/// `{ primary, fallback, capabilities }` — a shape the runtime rejects, so
/// `feral chat` / `FERAL_BRAIN=1` threw on first run. Doctor runs offline
/// (no sidecar), so it parses the file itself rather than asking the gateway.
///
/// Absent brain.json is a WARN, not a FAIL: Brain Stack is opt-in.
fn check_brain() -> Check {
    let path = feral_file("brain.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Check::Warn("no brain.json — Brain Stack off (run `feral setup`)".into()),
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
            "old shape (found: {}) — expected: enabled, mode, registry. Re-run `feral setup`.",
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

fn check_sidecar() -> Check {
    match feral_core::feral_agent::find_binary(&[]) {
        Some(p) => Check::Ok(format!("{}", p.display())),
        None => Check::Fail("feral-agent sidecar binary not found next to the executable".into()),
    }
}

fn check_gpu() -> Check {
    let info = feral_core::gpu_detect::detect();
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

async fn fetch_json(token: &str, path: &str) -> Result<serde_json::Value, String> {
    reqwest::Client::new()
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

async fn post(token: &str, path: &str) -> Result<(), String> {
    reqwest::Client::new()
        .post(format!("{}{}", base_url(), path))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
