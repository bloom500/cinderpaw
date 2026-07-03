//! `feral` management subcommands (Faza 4.5 Slice 4, spec D6):
//! `gateway start|stop|restart|status`, `model`, `doctor`. Everything talks to
//! the same loopback runtime the desktop app and connectors use.

use std::io::Write;

use crate::common::{
    api_port, base_url, port_in_use, read_token, ACCENT, BOLD, DIM, FAIL, META, OK, RESET, TEXT,
    WARN,
};

/// One blocking tokio runtime for the short HTTP calls these commands make.
fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Runtime::new()
        .expect("tokio runtime")
        .block_on(f)
}

// ── gateway status ─────────────────────────────────────────────────────────

pub fn gateway_status() -> i32 {
    let port = api_port();
    if !port_in_use(port) {
        println!("{META}● gateway offline{RESET}  (nothing on port {port})");
        println!("  start it: {ACCENT}feral gateway start{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        println!("{WARN}● port {port} is busy but ~/.feral/api-token is missing{RESET}");
        return 1;
    };
    match block_on(fetch_status_json(&token)) {
        Ok(v) => {
            let model = v
                .get("agent_model")
                .and_then(|m| m.as_str())
                .map(String::from)
                .or_else(|| {
                    v.get("model")
                        .and_then(|m| m.get("name"))
                        .and_then(|n| n.as_str())
                        .map(String::from)
                })
                .unwrap_or_else(|| "—".into());
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
            println!("{WARN}● port {port} busy but /runtime/status failed{RESET}: {e}");
            1
        }
    }
}

async fn fetch_status_json(token: &str) -> Result<serde_json::Value, String> {
    reqwest::Client::new()
        .get(format!("{}/runtime/status", base_url()))
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

// ── gateway start / stop / restart ─────────────────────────────────────────

pub fn gateway_start() -> i32 {
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
    let log_path = feral_core::paths::feral_dir().join("gateway.log");
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
    let _ = std::fs::write(feral_core::paths::feral_dir().join("gateway.pid"), pid.to_string());

    // Wait for the port to come up so `start` reports real readiness.
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
    let port = api_port();
    if !port_in_use(port) {
        println!("{META}gateway not running{RESET}");
        return 0;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}cannot stop: ~/.feral/api-token missing{RESET}");
        return 1;
    };
    // Ask for a graceful D7 drain over HTTP (cross-platform, no signal games).
    if let Err(e) = block_on(post_shutdown(&token)) {
        eprintln!("{FAIL}shutdown request failed{RESET}: {e}");
        return 1;
    }
    print!("{META}stopping gateway{RESET} ");
    let _ = std::io::stdout().flush();
    // The drain waits up to 30s for the sidecar; give it a little more.
    for _ in 0..70 {
        if !port_in_use(port) {
            let _ = std::fs::remove_file(feral_core::paths::feral_dir().join("gateway.pid"));
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

async fn post_shutdown(token: &str) -> Result<(), String> {
    reqwest::Client::new()
        .post(format!("{}/runtime/shutdown", base_url()))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map(|_| ())
        .map_err(|e| e.to_string())
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
    let port = api_port();
    if !port_in_use(port) {
        eprintln!("{META}gateway offline — start it to list models{RESET}");
        return 1;
    }
    let Some(token) = read_token() else {
        eprintln!("{FAIL}~/.feral/api-token missing{RESET}");
        return 1;
    };
    match block_on(fetch_json(&token, "/runtime/models")) {
        Ok(v) => {
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
                    let name = if is_active { format!("{TEXT}{id}{RESET}") } else { format!("{META}{id}{RESET}") };
                    println!("  {mark} {name}");
                }
            }
            0
        }
        Err(e) => {
            eprintln!("{FAIL}could not list models{RESET}: {e}");
            1
        }
    }
}

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

// ── doctor ─────────────────────────────────────────────────────────────────

enum Check {
    Ok(String),
    Warn(String),
    Fail(String),
}

/// Diagnose a headless install: port, token, models, sidecar binary, GPU,
/// connectors config. Exit code: 0 all clear, 1 if any check FAILED (warnings
/// alone don't fail — a missing GPU or connectors file is legitimate).
pub fn doctor() -> i32 {
    println!("\n  {ACCENT}{BOLD}feral{RESET} {ACCENT}▸{RESET} {TEXT}doctor{RESET}\n");
    let checks = vec![
        check_port(),
        check_token(),
        check_models(),
        check_sidecar(),
        check_gpu(),
        check_connectors(),
    ];
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

fn check_port() -> (&'static str, Check) {
    let port = api_port();
    let c = if port_in_use(port) {
        // Busy is fine — it's our gateway. Distinguish from a foreign squatter
        // by whether the token is accepted.
        match read_token().and_then(|t| block_on(fetch_status_json(&t)).ok()) {
            Some(_) => Check::Ok(format!("gateway running on 127.0.0.1:{port}")),
            None => Check::Warn(format!(
                "port {port} is in use but not answering /runtime/status — another app?"
            )),
        }
    } else {
        Check::Ok(format!("port {port} free (gateway can start)"))
    };
    ("api port", c)
}

fn check_token() -> (&'static str, Check) {
    let c = match read_token() {
        Some(t) if !t.is_empty() => Check::Ok("~/.feral/api-token present".into()),
        _ => Check::Warn("~/.feral/api-token missing — created on first gateway boot".into()),
    };
    ("api token", c)
}

fn check_models() -> (&'static str, Check) {
    let c = match feral_core::models::scan_models_dir() {
        Ok(m) if !m.is_empty() => Check::Ok(format!("{} model(s) on disk", m.len())),
        Ok(_) => Check::Warn("no .gguf models in ~/.feral/models — download one or use BYOK".into()),
        Err(e) => Check::Fail(format!("cannot read models dir: {e}")),
    };
    ("models", c)
}

fn check_sidecar() -> (&'static str, Check) {
    let c = match feral_core::feral_agent::find_binary(&[]) {
        Some(p) => Check::Ok(format!("{}", p.display())),
        None => Check::Fail("feral-agent sidecar binary not found next to the executable".into()),
    };
    ("sidecar", c)
}

fn check_gpu() -> (&'static str, Check) {
    let info = feral_core::gpu_detect::detect();
    let c = if info.name.is_empty() || info.name.eq_ignore_ascii_case("none") {
        Check::Warn("no GPU detected — inference runs on CPU".into())
    } else {
        Check::Ok(format!(
            "{} ({} MB, vulkan: {})",
            info.name, info.vram_mb, info.supports_vulkan
        ))
    };
    ("gpu", c)
}

fn check_connectors() -> (&'static str, Check) {
    let path = feral_core::paths::feral_dir().join("connectors.json");
    let c = if !path.exists() {
        Check::Warn("no connectors.json — Discord/Slack/etc. not configured".into())
    } else {
        match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(_) => Check::Ok("connectors.json is valid JSON".into()),
                Err(e) => Check::Fail(format!("connectors.json is invalid JSON: {e}")),
            },
            Err(e) => Check::Fail(format!("cannot read connectors.json: {e}")),
        }
    };
    ("connectors", c)
}
