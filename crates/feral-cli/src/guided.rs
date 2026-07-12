//! `feral setup` — the GUIDED flow (default), OpenClaw-parity
//! (2026-07-10 spec, Part 5). Shape: detect what this machine already has →
//! live-test the first candidate with a REAL completion → persist only a
//! verified route → offer chat. ~4 interactions on the happy path, zero
//! questions about ports, models or auth modes.
//!
//! The classic step-by-step wizard stays behind `feral setup --classic`
//! (the Go TUI wizard, `admin::setup`). All detection/verification logic
//! lives server-side in feral-core (`/runtime/setup/*`) so the TUI and the
//! desktop app consume the identical ladder.

#![allow(non_snake_case)]

use serde_json::{json, Value};
use std::io::Write as _;

use crate::admin::{block_on, ensure_gateway, fetch_json, post_json_with_body};
use crate::common::{palette, read_token, Palette};

pub fn run(accept_risk: bool) -> i32 {
    if let Err(code) = ensure_gateway() {
        return code;
    }
    let Some(token) = read_token() else {
        eprintln!("feral: no API token at ~/.feral/api-token — is the gateway healthy? Run `feral doctor`.");
        return 1;
    };
    let Palette { accent: ACCENT, meta: META, ok: OK, fail: FAIL, warn: WARN, bold: BOLD, reset: RESET, .. } =
        palette();

    println!("\n  {ACCENT}{BOLD}◆ Connect your AI{RESET}");
    println!("  {META}For the full step-by-step wizard, run `feral setup --classic`.{RESET}\n");

    print!("  {META}Looking for AI you can already use…{RESET}");
    let _ = std::io::stdout().flush();
    let detect = match block_on(fetch_json(&token, "/runtime/setup/detect")) {
        Ok(v) => v,
        Err(e) => {
            println!();
            eprintln!("{FAIL}feral: detection failed: {e}{RESET}");
            return 1;
        }
    };
    println!();

    // One-time security acknowledgement (persisted in settings.json).
    let acked = !detect
        .get("security_acknowledged_at")
        .map(Value::is_null)
        .unwrap_or(true);
    if !acked && !accept_risk {
        println!("\n  {BOLD}Before we start{RESET}");
        println!("  {META}Feral is personal-by-default: it runs with your permissions, and a bad");
        println!("  prompt can trick it into doing unsafe things. Shared or multi-user setups");
        println!("  need locking down (allowlists, sandboxing, least-privilege).{RESET}");
        if !confirm("I understand — continue?", true) {
            println!("  {META}Setup cancelled. Nothing was changed.{RESET}");
            return 1;
        }
    }
    if !acked {
        let _ = block_on(post_json_with_body(&token, "/runtime/setup/ack", json!({})));
    }

    let candidates: Vec<Value> = detect
        .get("candidates")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    if candidates.is_empty() {
        println!("  {META}No existing AI access was detected on this machine.{RESET}");
    } else {
        for c in &candidates {
            let label = c["label"].as_str().unwrap_or("?");
            let detail = c["detail"].as_str().unwrap_or("");
            let rec = if c["recommended"].as_bool().unwrap_or(false) {
                format!(" {ACCENT}— recommended{RESET}")
            } else {
                String::new()
            };
            println!("  {BOLD}•{RESET} {label} {META}{detail}{RESET}{rec}");
        }
    }
    println!();

    // ── Auto-test ladder ─────────────────────────────────────────────────
    let mut verified: Option<(Value, Value)> = None; // (candidate, outcome)
    for c in &candidates {
        let kind = c["kind"].as_str().unwrap_or("");
        let label = c["label"].as_str().unwrap_or("?").to_string();
        if kind == "hardware_download" {
            // Feral-specific rung: local model a one-click download away.
            // Download needs consent (it's gigabytes); everything after is
            // automatic.
            let size = c["download"]["approx_size"].as_str().unwrap_or("");
            if !confirm(&format!("Download {label} ({size})?"), true) {
                continue;
            }
            match download_and_localize(&token, c) {
                Ok(local_candidate) => {
                    if let Some(outcome) = try_verify(&token, &local_candidate) {
                        verified = Some((local_candidate, outcome));
                        break;
                    }
                }
                Err(e) => {
                    println!("  {FAIL}✗ download failed: {e}{RESET}");
                }
            }
            continue;
        }
        if let Some(outcome) = try_verify(&token, c) {
            activate(&token, c);
            verified = Some((c.clone(), outcome));
            break;
        }
        if kind == "existing_config" {
            // OpenClaw invariant: never silently replace a configured model
            // that fails the probe — it can be a false negative. Stop the
            // ladder and let the user decide in the manual stage.
            println!(
                "  {WARN}Your already-configured model failed the test. Feral will not replace it automatically.{RESET}"
            );
            break;
        }
    }

    // ── Manual stage (only if the ladder produced nothing) ───────────────
    if verified.is_none() {
        verified = manual_stage(&token, &candidates);
    }
    let Some((candidate, outcome)) = verified else {
        // Skip path — say exactly how to resume later (OpenClaw parity).
        println!("\n  {META}To add AI later: set OPENAI_API_KEY or ANTHROPIC_API_KEY, download a");
        println!("  local model in the desktop app, or re-run `feral setup`.{RESET}");
        return 0;
    };

    // ── Applied summary + next steps ─────────────────────────────────────
    let label = candidate["label"].as_str().unwrap_or("your AI");
    let check = outcome["message"].as_str().unwrap_or("replied");
    println!("\n  {OK}✓ {label} is ready{RESET} {META}— AI check: {check}{RESET}");
    println!("\n  {BOLD}Next steps{RESET}");
    println!("  {META}Chat here:        {RESET}feral chat");
    println!("  {META}Desktop app:      {RESET}launch Feral from the Start Menu");
    println!("  {META}Add a connector:  {RESET}feral connectors set discord   (or /connectors add in chat)");
    println!("  {META}Health check:     {RESET}feral doctor");

    if confirm("\nOpen the chat now?", true) {
        crate::chat::run(); // never returns
    }
    println!("  {META}stay feral. ↝{RESET}");
    0
}

/// POST the candidate to `/runtime/setup/verify` (persist on success) and
/// print the running commentary. `None` = failed (already reported).
fn try_verify(token: &str, candidate: &Value) -> Option<Value> {
    try_verify_with_key(token, candidate, None)
}

fn try_verify_with_key(token: &str, candidate: &Value, api_key: Option<&str>) -> Option<Value> {
    let Palette { ok: OK, fail: FAIL, meta: META, reset: RESET, .. } = palette();
    let label = candidate["label"].as_str().unwrap_or("?");
    println!("  {META}Testing {label} — real completion, not a ping…{RESET}");
    let mut body = json!({ "candidate": candidate, "persist": true });
    if let Some(k) = api_key {
        body["api_key"] = json!(k);
    }
    match block_on(post_json_with_body(token, "/runtime/setup/verify", body)) {
        Ok(outcome) if outcome["ok"].as_bool().unwrap_or(false) => {
            println!("  {OK}✓ {}{RESET}", outcome["message"].as_str().unwrap_or("ok"));
            Some(outcome)
        }
        Ok(outcome) => {
            println!("  {FAIL}✗ {}{RESET}", outcome["message"].as_str().unwrap_or("failed"));
            None
        }
        Err(e) => {
            println!("  {FAIL}✗ {e}{RESET}");
            None
        }
    }
}

/// Point the live sidecar at a verified CLOUD route (`provider:model`).
/// Local routes are already active — verify loaded the model in-process.
/// Best-effort: the route is persisted either way; a cold sidecar picks it
/// up on next start.
fn activate(token: &str, candidate: &Value) {
    let kind = candidate["kind"].as_str().unwrap_or("");
    if kind == "local_gguf" {
        return;
    }
    let (Some(pid), Some(model)) = (candidate["provider_id"].as_str(), candidate["model"].as_str())
    else {
        return;
    };
    let body = json!({ "id": format!("{pid}:{model}") });
    if let Err(e) = block_on(post_json_with_body(token, "/runtime/model", body)) {
        let Palette { warn: WARN, reset: RESET, .. } = palette();
        println!("  {WARN}route saved; it becomes active on the next start ({e}){RESET}");
    }
}

/// Kick off the one-click model download and poll progress. On success,
/// returns a synthetic `local_gguf` candidate for the downloaded file.
fn download_and_localize(token: &str, candidate: &Value) -> Result<Value, String> {
    let Palette { meta: META, reset: RESET, .. } = palette();
    let repo = candidate["download"]["repo_id"].as_str().ok_or("no repo_id")?;
    let file = candidate["download"]["filename"].as_str().ok_or("no filename")?;
    let started = block_on(post_json_with_body(
        token,
        "/runtime/models/install",
        json!({ "repo_id": repo, "filename": file }),
    ))?;
    let id = started["id"].as_str().ok_or("no download id")?.to_string();

    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let snap = block_on(fetch_json(token, &format!("/runtime/models/download/{id}")))?;
        let progress = snap["progress"].as_f64().unwrap_or(0.0);
        print!("\r  {META}Downloading… {:>3.0}%{RESET}", progress * 100.0);
        let _ = std::io::stdout().flush();
        match snap["status"].as_str().unwrap_or("") {
            "complete" => {
                println!();
                return Ok(json!({
                    "kind": "local_gguf",
                    "id": format!("local:{file}"),
                    "label": candidate["download"]["label"],
                    "detail": "just downloaded",
                    "model": file,
                }));
            }
            "failed" => {
                println!();
                return Err(snap["error"].as_str().unwrap_or("download failed").to_string());
            }
            "cancelled" => {
                println!();
                return Err("download cancelled".into());
            }
            _ => {}
        }
    }
}

/// Failure → choice, never a dead end. Loops until a route verifies, the
/// user delegates to the classic wizard, or skips.
fn manual_stage(token: &str, candidates: &[Value]) -> Option<(Value, Value)> {
    let Palette { meta: META, bold: BOLD, fail: FAIL, reset: RESET, .. } = palette();
    loop {
        println!("\n  {BOLD}How do you want to connect?{RESET}");
        let mut options: Vec<(String, MenuAction)> = Vec::new();
        for c in candidates {
            let kind = c["kind"].as_str().unwrap_or("");
            if kind == "hardware_download" {
                let size = c["download"]["approx_size"].as_str().unwrap_or("");
                options.push((
                    format!("Download {} ({size})", c["label"].as_str().unwrap_or("?")),
                    MenuAction::Download(c.clone()),
                ));
            } else {
                options.push((
                    format!("Retry {}", c["label"].as_str().unwrap_or("?")),
                    MenuAction::Retry(c.clone()),
                ));
            }
        }
        options.push(("Enter an API key".into(), MenuAction::PasteKey));
        options.push(("Use the classic step-by-step wizard".into(), MenuAction::Classic));
        options.push(("Skip AI setup for now".into(), MenuAction::Skip));

        for (i, (label, _)) in options.iter().enumerate() {
            println!("  {META}{}{RESET}  {label}", i + 1);
        }
        let pick = ask(&format!("Choose 1-{}", options.len()));
        let Ok(n) = pick.trim().parse::<usize>() else {
            println!("  {FAIL}not a number{RESET}");
            continue;
        };
        let Some((_, action)) = options.into_iter().nth(n.saturating_sub(1)) else {
            println!("  {FAIL}out of range{RESET}");
            continue;
        };

        match action {
            MenuAction::Retry(c) => {
                if let Some(outcome) = try_verify(token, &c) {
                    activate(token, &c);
                    return Some((c, outcome));
                }
            }
            MenuAction::Download(c) => match download_and_localize(token, &c) {
                Ok(local) => {
                    if let Some(outcome) = try_verify(token, &local) {
                        return Some((local, outcome));
                    }
                }
                Err(e) => println!("  {FAIL}✗ download failed: {e}{RESET}"),
            },
            MenuAction::PasteKey => {
                if let Some(hit) = paste_key_flow(token) {
                    return Some(hit);
                }
            }
            MenuAction::Classic => {
                std::process::exit(crate::admin::setup());
            }
            MenuAction::Skip => return None,
        }
    }
}

enum MenuAction {
    Retry(Value),
    Download(Value),
    PasteKey,
    Classic,
    Skip,
}

/// "Enter API key" branch: pick a provider from the live catalog, paste a
/// key, run the same real-completion test (persist on success).
fn paste_key_flow(token: &str) -> Option<(Value, Value)> {
    let Palette { meta: META, fail: FAIL, bold: BOLD, reset: RESET, .. } = palette();
    let catalog = match block_on(fetch_json(token, "/runtime/providers/catalog")) {
        Ok(Value::Array(a)) => a,
        _ => {
            println!("  {FAIL}could not load the provider catalog{RESET}");
            return None;
        }
    };
    println!("\n  {BOLD}Which provider?{RESET}");
    for (i, p) in catalog.iter().enumerate() {
        let name = p["name"].as_str().unwrap_or("?");
        let free = p["free_tier_note"].as_str().map(|n| format!(" {META}— {n}{RESET}")).unwrap_or_default();
        println!("  {META}{}{RESET}  {name}{free}", i + 1);
    }
    let pick = ask(&format!("Choose 1-{}", catalog.len()));
    let idx = pick.trim().parse::<usize>().ok()?.checked_sub(1)?;
    let p = catalog.get(idx)?;
    if let Some(console) = p["console_url"].as_str() {
        println!("  {META}Get a key at: {console}{RESET}");
    }
    // ponytail: plain (echoed) stdin read; masked input when a tty-secrets
    // crate is worth the dependency.
    let key = ask(&format!("Paste your {} API key", p["name"].as_str().unwrap_or("provider")));
    if key.trim().is_empty() {
        return None;
    }
    let candidate = json!({
        "kind": "env_key",
        "id": format!("manual:{}", p["id"].as_str().unwrap_or("?")),
        "label": format!("{} ({})", p["name"].as_str().unwrap_or("?"), p["default_model"].as_str().unwrap_or("?")),
        "detail": "manual key",
        "provider_id": p["id"],
        "model": p["default_model"],
        "base_url": p["default_base_url"],
    });
    let outcome = try_verify_with_key(token, &candidate, Some(key.trim()))?;
    activate(token, &candidate);
    Some((candidate, outcome))
}

// ── Tiny prompt helpers ──────────────────────────────────────────────────────

fn ask(prompt: &str) -> String {
    // A crashed/killed TUI can leave the console raw (no echo, no line
    // input) — reset before every read so the prompt is never "dead".
    crate::common::reset_console_mode();
    let Palette { accent: ACCENT, reset: RESET, .. } = palette();
    print!("  {ACCENT}{prompt}:{RESET} ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    line.trim().to_string()
}

fn confirm(prompt: &str, default_yes: bool) -> bool {
    let hint = if default_yes { "[Y/n]" } else { "[y/N]" };
    let answer = ask(&format!("{prompt} {hint}"));
    match answer.to_lowercase().as_str() {
        "" => default_yes,
        "y" | "yes" | "da" => true,
        _ => false,
    }
}
