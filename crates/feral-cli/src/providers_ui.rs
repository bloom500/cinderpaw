//! Interactive provider picker for `feral providers`.
//!
//! Running `feral providers` on a terminal drops into a numbered menu: pick a
//! provider, paste the key, and the route is set. Piped or redirected, it falls
//! back to the plain listing so `feral providers | grep` and every script that
//! already parses it keep working.
//!
//! HuggingFace sits in the same menu but takes a different path. It is not a
//! BYOK provider — there is no key and nothing to route to until a file exists
//! on disk — so choosing it downloads a GGUF instead, which is how a user gets
//! a working agent with no account anywhere.
//!
//! ponytail: a numbered `read_line` menu, not an arrow-key selector. This crate
//! carries no TUI dependency, and the rest of its prompts (guided.rs,
//! install.rs) already read this way. Arrow keys would cost a dependency plus a
//! raw-mode cleanup path this file would then have to own.

use crate::admin::{providers_list, providers_set_key, split_route};
use crate::common::{palette, Palette};
use std::io::{IsTerminal, Write};
use std::sync::atomic::AtomicBool;
use tokio::sync::mpsc::channel;
use std::sync::Arc;

/// Curated GGUFs offered when the user picks HuggingFace: small enough to run
/// on an ordinary machine. Anything else is entered by hand as repo + filename.
const HF_SUGGESTED: &[(&str, &str, &str)] = &[
    (
        "bartowski/Llama-3.2-3B-Instruct-GGUF",
        "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        "Llama 3.2 3B   ~2.0 GB   light and quick, fine on 8 GB RAM",
    ),
    (
        "Qwen/Qwen2.5-7B-Instruct-GGUF",
        "qwen2.5-7b-instruct-q4_k_m.gguf",
        "Qwen2.5 7B     ~4.7 GB   good general default",
    ),
    (
        "bartowski/Mistral-7B-Instruct-v0.3-GGUF",
        "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf",
        "Mistral 7B     ~4.4 GB   solid all-rounder",
    ),
];

fn ask(prompt: &str) -> Option<String> {
    eprint!("{prompt}");
    let _ = std::io::stderr().flush();
    let mut s = String::new();
    match std::io::stdin().read_line(&mut s) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(s.trim().to_string()),
    }
}

/// `feral providers` with no subcommand.
pub fn providers_pick() -> i32 {
    let Palette { accent, text, meta, bold, dim, reset, fail, .. } = palette();

    if !std::io::stdin().is_terminal() {
        return providers_list();
    }

    let catalog = feral_core::byok::provider_catalog();
    let settings = feral_core::settings::load();
    let byok = feral_core::byok::load(&settings);
    let (active, _) = split_route(&settings.active_route.clone().unwrap_or_default());

    eprintln!();
    eprintln!("  {bold}{accent}Providers{reset}");
    eprintln!("  {dim}pick a number, or q to quit{reset}");
    eprintln!();
    for (i, e) in catalog.iter().enumerate() {
        let configured = byok.providers.contains_key(&e.id);
        let (mark, state) = if e.id == active {
            (format!("{accent}*{reset}"), format!(" {accent}active{reset}"))
        } else if configured {
            (format!("{meta}o{reset}"), format!(" {meta}key set{reset}"))
        } else {
            (" ".to_string(), String::new())
        };
        let free = e
            .free_tier_note
            .as_deref()
            .map(|n| format!("  {dim}{n}{reset}"))
            .unwrap_or_default();
        eprintln!("  {mark} {bold}{:>2}{reset}  {text}{}{reset}{state}{free}", i + 1, e.name);
    }
    let hf = catalog.len() + 1;
    eprintln!(
        "    {bold}{hf:>2}{reset}  {text}HuggingFace{reset}  {dim}download a local model — no key, no account{reset}"
    );
    eprintln!();

    let Some(choice) = ask(&format!("  {meta}> {reset}")) else { return 0 };
    if choice.is_empty() || choice.eq_ignore_ascii_case("q") {
        return 0;
    }
    let Ok(n) = choice.parse::<usize>() else {
        eprintln!("{fail}not a number: {choice}{reset}");
        return 1;
    };
    if n == hf {
        return huggingface_install();
    }
    let Some(entry) = catalog.get(n.wrapping_sub(1)) else {
        eprintln!("{fail}pick a number between 1 and {hf}{reset}");
        return 1;
    };

    eprintln!();
    eprintln!("  {bold}{}{reset}", entry.name);
    if let Some(url) = entry.console_url.as_deref() {
        eprintln!("  {meta}get a key at {url}{reset}");
    }
    if let Some(hint) = entry.key_format_hint.as_deref() {
        eprintln!("  {dim}{hint}{reset}");
    }
    // Asked, not assumed. Passing `None` here meant the catalog default won
    // silently — and for OpenRouter that default is `openai/gpt-4o`, which is a
    // reasonable fallback and the wrong answer for almost everyone, since
    // reaching one specific model is most of why anyone picks OpenRouter at all.
    // The default stays one Enter away for whoever does not care.
    eprintln!();
    eprintln!("  {dim}model id, or Enter for {}{reset}", entry.default_model);
    let model = ask(&format!("  {meta}model> {reset}")).filter(|s| !s.is_empty());

    // Reuse the audited path rather than re-implementing it: stdin-only key
    // (never argv, where `ps` and shell history would see it), a live
    // verification call, then storage. Choosing a provider here means the user
    // wants to use it, so activate on success.
    providers_set_key(&entry.id.clone(), model, false, true)
}

/// Download a GGUF so the agent runs with no key at all.
pub fn huggingface_install() -> i32 {
    let Palette { accent, text, meta, bold, dim, reset, fail, ok, .. } = palette();

    eprintln!();
    eprintln!("  {bold}{accent}Local models{reset}  {dim}from HuggingFace{reset}");
    eprintln!();
    for (i, (repo, _, label)) in HF_SUGGESTED.iter().enumerate() {
        eprintln!("  {bold}{:>2}{reset}  {text}{label}{reset}", i + 1);
        eprintln!("      {dim}{repo}{reset}");
    }
    let other = HF_SUGGESTED.len() + 1;
    eprintln!("  {bold}{other:>2}{reset}  {text}something else{reset}  {dim}enter a repo and filename{reset}");
    eprintln!();

    let Some(choice) = ask(&format!("  {meta}> {reset}")) else { return 0 };
    if choice.is_empty() || choice.eq_ignore_ascii_case("q") {
        return 0;
    }
    let Ok(n) = choice.parse::<usize>() else {
        eprintln!("{fail}not a number: {choice}{reset}");
        return 1;
    };

    let (repo, file) = if n == other {
        let Some(r) = ask(&format!("  {meta}repo (e.g. bartowski/Model-GGUF): {reset}")) else { return 0 };
        let Some(f) = ask(&format!("  {meta}file (e.g. Model-Q4_K_M.gguf): {reset}")) else { return 0 };
        if r.is_empty() || f.is_empty() {
            eprintln!("{fail}a repo and a filename are both needed{reset}");
            return 1;
        }
        (r, f)
    } else {
        match HF_SUGGESTED.get(n.wrapping_sub(1)) {
            Some((r, f, _)) => ((*r).to_string(), (*f).to_string()),
            None => {
                eprintln!("{fail}pick a number between 1 and {other}{reset}");
                return 1;
            }
        }
    };

    eprintln!();
    eprintln!("  {meta}downloading {repo} / {file}{reset}");
    eprintln!("  {dim}this takes a while; Ctrl-C is safe — the partial file is cleaned up{reset}");

    let cancel = Arc::new(AtomicBool::new(false));
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("{fail}could not start the async runtime: {e}{reset}");
            return 1;
        }
    };

    // Progress drains in its own task so a slow terminal never stalls the
    // download, and the sender is dropped with the download future so the
    // printer ends on its own.
    let result = rt.block_on(async move {
        let (tx, mut rx) = channel::<f32>(64);
        let printer = tokio::spawn(async move {
            let mut last = -1i32;
            while let Some(p) = rx.recv().await {
                let pct = (p * 100.0).round() as i32;
                if pct != last {
                    last = pct;
                    eprint!("\r  {pct:>3}%");
                    let _ = std::io::stderr().flush();
                }
            }
            eprintln!();
        });
        let r = feral_core::models::download_hf_model(repo, file, tx, cancel).await;
        let _ = printer.await;
        r
    });

    match result {
        Ok(path) => {
            eprintln!("  {ok}done{reset}  {dim}{}{reset}", path.display());
            eprintln!("  {meta}start the gateway and it will be picked up, or choose it with `feral model use`.{reset}");
            0
        }
        Err(e) => {
            eprintln!("{fail}download failed: {e}{reset}");
            1
        }
    }
}
