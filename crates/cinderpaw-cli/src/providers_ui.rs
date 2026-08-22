//! Interactive provider picker for `cinderpaw providers`.
//!
//! Running `cinderpaw providers` on a terminal drops into a list: pick a
//! provider, pick a model, and the route is set. Piped or redirected, it falls
//! back to the plain listing so `cinderpaw providers | grep` and every script
//! that already parses it keep working.
//!
//! HuggingFace sits in the same list but takes a different path. It is not a
//! BYOK provider — there is no key and nothing to route to until a file exists
//! on disk — so choosing it downloads a GGUF instead, which is how a user gets
//! a working agent with no account anywhere.
//!
//! The list is arrow-driven now (see `select.rs`). It used to be a numbered
//! `read_line` prompt, on the argument that arrows cost a dependency — which
//! held right up until the catalogue outgrew a screen. A numbered list you
//! cannot scroll is a list where the only reachable rows are the ones that
//! happen to fit, and no amount of not-adding-a-dependency fixes that.

use crate::admin::{providers_list, providers_set_key, providers_use, split_route};
use crate::common::{palette, Palette};
use crate::select::{select, Item};
use std::io::{IsTerminal, Write};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::mpsc::channel;

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

/// `cinderpaw providers` with no subcommand.
pub fn providers_pick() -> i32 {
    let Palette { accent, meta, bold, dim, reset, .. } = palette();

    if !std::io::stdin().is_terminal() {
        return providers_list();
    }

    let catalog = cinderpaw_core::byok::provider_catalog();
    let settings = cinderpaw_core::settings::load();
    let byok = cinderpaw_core::byok::load(&settings);
    let (active, _) = split_route(&settings.active_route.clone().unwrap_or_default());

    // One row per provider, carrying the two facts a person needs before
    // choosing: whether a key is already stored, and which one is answering now.
    let mut rows: Vec<Item> = catalog
        .iter()
        .map(|e| {
            let badge = if e.id == active {
                format!("{accent}active{reset}")
            } else if byok.providers.contains_key(&e.id) {
                format!("{meta}key set{reset}")
            } else {
                String::new()
            };
            Item::new(e.name.clone())
                .badge(badge)
                .hint(e.free_tier_note.clone().unwrap_or_default())
        })
        .collect();
    rows.push(Item::new("HuggingFace").hint("download a local model — no key, no account"));

    let Some(picked) = select("Providers", &rows) else { return 0 };
    if picked == catalog.len() {
        return huggingface_install();
    }
    let entry = &catalog[picked];

    eprintln!();
    eprintln!("  {bold}{}{reset}", entry.name);

    // A key already on disk is not asked for again.
    //
    // It used to be, every single time, because choosing a provider went
    // straight to `set-key` — so the one step a returning user never needs was
    // the only step they could not skip. Saying WHICH key was found matters as
    // much as skipping the prompt: "it went straight through" and "it forgot my
    // key and used a blank one" are indistinguishable otherwise.
    let Some(key) = cinderpaw_core::byok::byok_get(&entry.id) else {
        if let Some(url) = entry.console_url.as_deref() {
            eprintln!("  {meta}get a key at {url}{reset}");
        }
        if let Some(hint) = entry.key_format_hint.as_deref() {
            eprintln!("  {dim}{hint}{reset}");
        }
        // No key yet, so no model list either — the provider will not answer
        // `/models` without one. Asked by hand, then verified and stored by the
        // audited path: stdin-only key (never argv, where `ps` and shell
        // history would see it), a live verification call, then storage.
        let model = ask_model(entry);
        return providers_set_key(&entry.id.clone(), model, false, true);
    };

    eprintln!("  {meta}key found ({}){reset}", masked(&key));
    let model = choose_model(entry, &key);
    providers_use(&entry.id.clone(), model)
}

/// Enough of a key to recognise, never enough to use.
///
/// Printed because a key that is silently reused is a key the user cannot tell
/// apart from no key at all — and the first suspicion when a provider bills
/// wrongly is that the wrong account is on file.
fn masked(key: &str) -> String {
    let n = key.chars().count();
    if n <= 8 {
        return "•".repeat(n.max(3));
    }
    let head: String = key.chars().take(4).collect();
    let tail: String = key.chars().skip(n - 4).collect();
    format!("{head}…{tail}")
}

/// Pick a model: from the provider's own list when it publishes one, by hand
/// when it does not.
fn choose_model(entry: &cinderpaw_core::byok::ProviderCatalogEntry, key: &str) -> Option<String> {
    let Palette { meta, dim, reset, .. } = palette();

    let models = fetch_models(&entry.default_base_url, key);
    if models.is_empty() {
        eprintln!("  {dim}this provider publishes no model list — type an id{reset}");
        return ask_model(entry);
    }

    let mut rows: Vec<Item> = models
        .iter()
        .map(|m| {
            Item::new(m.clone()).badge(if *m == entry.default_model {
                format!("{meta}default{reset}")
            } else {
                String::new()
            })
        })
        .collect();
    // Last, not first: a list of real models should not be headed by an escape
    // hatch most people never need.
    rows.push(Item::new("type a model id by hand"));
    let by_hand = rows.len() - 1;

    match select(&format!("{} models", entry.name), &rows) {
        Some(i) if i == by_hand => ask_model(entry),
        Some(i) => Some(models[i].clone()),
        // Backing out keeps whatever model the provider is already configured
        // with, rather than silently resetting it to the catalog default.
        None => None,
    }
}

/// Asked, not assumed. Passing `None` meant the catalog default won silently —
/// and for OpenRouter that default is `openai/gpt-4o`, a reasonable fallback
/// and the wrong answer for almost everyone, since reaching one specific model
/// is most of why anyone picks OpenRouter at all. The default stays one Enter
/// away for whoever does not care.
fn ask_model(entry: &cinderpaw_core::byok::ProviderCatalogEntry) -> Option<String> {
    let Palette { meta, dim, reset, .. } = palette();
    eprintln!();
    eprintln!("  {dim}model id, or Enter for {}{reset}", entry.default_model);
    ask(&format!("  {meta}model> {reset}")).filter(|s| !s.is_empty())
}

/// Ask the provider what it serves, over the OpenAI-compatible `/models` route.
///
/// Best effort on purpose: a provider that does not answer, answers slowly, or
/// answers in another shape falls back to typing an id. A model picker is a
/// convenience, and a convenience must never become the reason a key cannot be
/// set.
fn fetch_models(base_url: &str, key: &str) -> Vec<String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let key = key.to_string();
    let Ok(rt) = tokio::runtime::Runtime::new() else { return Vec::new() };
    rt.block_on(async move {
        let Ok(client) =
            reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build()
        else {
            return Vec::new();
        };
        let Ok(res) = client.get(&url).bearer_auth(&key).send().await else { return Vec::new() };
        if !res.status().is_success() {
            return Vec::new();
        }
        let Ok(body) = res.json::<serde_json::Value>().await else { return Vec::new() };
        let mut ids: Vec<String> = body
            .get("data")
            .and_then(|d| d.as_array())
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| r.get("id").and_then(|i| i.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        ids.sort();
        ids
    })
}

/// Download a GGUF so the agent runs with no key at all.
pub fn huggingface_install() -> i32 {
    let Palette { accent, meta, bold, dim, reset, fail, ok, .. } = palette();

    eprintln!();
    eprintln!("  {bold}{accent}Local models{reset}  {dim}from HuggingFace{reset}");

    let mut rows: Vec<Item> = HF_SUGGESTED
        .iter()
        .map(|(repo, _, label)| Item::new(*label).hint(*repo))
        .collect();
    rows.push(Item::new("something else").hint("enter a repo and filename"));
    let other = rows.len() - 1;

    let Some(picked) = select("Local models", &rows) else { return 0 };

    let (repo, file) = if picked == other {
        let Some(r) = ask(&format!("  {meta}repo (e.g. bartowski/Model-GGUF): {reset}")) else {
            return 0;
        };
        let Some(f) = ask(&format!("  {meta}file (e.g. Model-Q4_K_M.gguf): {reset}")) else {
            return 0;
        };
        if r.is_empty() || f.is_empty() {
            eprintln!("{fail}a repo and a filename are both needed{reset}");
            return 1;
        }
        (r, f)
    } else {
        let (r, f, _) = HF_SUGGESTED[picked];
        (r.to_string(), f.to_string())
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
        let r = cinderpaw_core::models::download_hf_model(repo, file, tx, cancel).await;
        let _ = printer.await;
        r
    });

    match result {
        Ok(path) => {
            eprintln!("  {ok}done{reset}  {dim}{}{reset}", path.display());
            eprintln!("  {meta}start the gateway and it will be picked up, or choose it with `cinderpaw model use`.{reset}");
            0
        }
        Err(e) => {
            eprintln!("{fail}download failed: {e}{reset}");
            1
        }
    }
}
