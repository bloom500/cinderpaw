//! First-run setup: the detection ladder + verified activation
//! (2026-07-10 OpenClaw onboarding-parity spec, Part 5/6).
//!
//! One place, consumed by every surface (CLI `cinderpaw setup`, Go TUI, desktop
//! React onboarding) via `GET /runtime/setup/detect` + `POST
//! /runtime/setup/verify`. The load-bearing invariant, copied verbatim from
//! OpenClaw's `setup-inference.ts`: *a candidate is persisted as the default
//! model only after a real completion round-trips. A failing candidate must
//! never leave config pointing at a broken model.* Persistence therefore
//! lives inside `verify` (`persist: true` is honored only on success) — no
//! client can write an unverified route through this surface.
//!
//! Ladder order (local-first — Cinderpaw's differentiator; OpenClaw has no
//! local-model story at all):
//!   a. existing config — enabled BYOK provider with a keychain key
//!   b. local GGUF models already on disk
//!   c. hardware tier → recommended one-click download (Cinderpaw-specific rung)
//!   d. env API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, …)
//!   e. a running Ollama on :11434
//!   f. an OpenClaw config on this machine (Hermes-style migration rung)

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

use crate::byok::{self, Provider};
use crate::runtime::RuntimeState;

/// Verbatim from OpenClaw's guided onboarding — a real completion, not a ping.
pub const VERIFY_PROMPT: &str = "Reply with the single word OK. Do not use tools.";
pub const VERIFY_MAX_TOKENS: u32 = 32;
pub const VERIFY_TIMEOUT_SECS: u64 = 90;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CandidateKind {
    /// An enabled BYOK provider with a stored key — "already configured".
    ExistingConfig,
    /// A .gguf already in ~/.cinderpaw/models.
    LocalGguf,
    /// Nothing local yet, but the hardware can run a recommended model —
    /// a one-click download away. Not verifiable until downloaded.
    HardwareDownload,
    /// A provider API key found in the environment.
    EnvKey,
    /// A running Ollama server on 127.0.0.1:11434.
    Ollama,
    /// An OpenClaw install whose config carries a usable provider key.
    /// The key itself never leaves this process — `verify` re-reads it
    /// from the OpenClaw config file server-side.
    OpenclawImport,
}

/// The one-click download attached to a `HardwareDownload` candidate.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DownloadSpec {
    pub repo_id: String,
    pub filename: String,
    pub label: String,
    pub approx_size: String,
}

/// One rung result. Everything a client needs to render the row and to POST
/// the candidate back to `/runtime/setup/verify` unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Candidate {
    pub kind: CandidateKind,
    /// Stable id, e.g. `byok:minimax`, `local:Qwen3.5-4B.gguf`, `env:openai`.
    pub id: String,
    pub label: String,
    /// Human detail line ("found in ~/.cinderpaw/models", "env OPENAI_API_KEY").
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// For `EnvKey`: which env var carried the key (the key value itself is
    /// never serialized — verify re-reads it server-side).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_var: Option<String>,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download: Option<DownloadSpec>,
}

/// Typed failure taxonomy — OpenClaw's `auth | rate_limit | billing |
/// timeout | format | unavailable | unknown`, plus `ok`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum VerifyStatus {
    Ok,
    Auth,
    RateLimit,
    Billing,
    Timeout,
    Format,
    Unavailable,
    Unknown,
}

impl VerifyStatus {
    /// Human copy per failure class (mirrors OpenClaw's guided-flow strings).
    pub fn human(&self) -> &'static str {
        match self {
            VerifyStatus::Ok => "The model replied.",
            VerifyStatus::Auth => "The API key was rejected. Check the key (or generate a new one).",
            VerifyStatus::RateLimit => "Rate limited right now — the key works, try again in a moment.",
            VerifyStatus::Billing => "Billing is not active for this model or account.",
            VerifyStatus::Timeout => "No reply within 90 seconds.",
            VerifyStatus::Format => "The endpoint answered, but not with a usable completion.",
            VerifyStatus::Unavailable => "The service is unreachable or the model id does not exist.",
            VerifyStatus::Unknown => "The test failed for an unrecognized reason.",
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct VerifyOutcome {
    pub ok: bool,
    pub status: VerifyStatus,
    pub message: String,
    /// Round-trip time of the completion, when one was attempted.
    pub latency_ms: Option<u64>,
    /// The model's (trimmed) reply on success — the "AI check: replied" proof.
    pub reply: Option<String>,
    /// Set when `persist: true` was requested and the route was written.
    pub persisted: bool,
}

impl VerifyOutcome {
    pub fn fail(status: VerifyStatus, message: impl Into<String>) -> Self {
        Self { ok: false, status, message: message.into(), latency_ms: None, reply: None, persisted: false }
    }
}

// ── Detection ladder ─────────────────────────────────────────────────────────

/// Env var → provider id. Order matters: it is the ladder order within the
/// env-key rung (OpenAI and Anthropic first, matching OpenClaw).
const ENV_KEY_PROVIDERS: &[(&str, &str)] = &[
    ("OPENAI_API_KEY", "openai"),
    ("ANTHROPIC_API_KEY", "anthropic"),
    ("GEMINI_API_KEY", "google"),
    ("GOOGLE_API_KEY", "google"),
    ("GROQ_API_KEY", "groq"),
    ("MISTRAL_API_KEY", "mistral"),
    ("DEEPSEEK_API_KEY", "deepseek"),
    ("OPENROUTER_API_KEY", "openrouter"),
    ("NVIDIA_API_KEY", "nvidia"),
];

/// Run the full ladder. Network rung (Ollama) uses a 1.5s probe so a cold
/// machine answers fast. `recommended` is stamped on the first candidate —
/// ladder order IS the recommendation order (local-first).
pub async fn detect() -> Vec<Candidate> {
    let mut out = Vec::new();

    // a. existing config — never silently replaced; shown first.
    let settings = crate::settings::load();
    let byok_settings = byok::load(&settings);
    for p in byok_settings.get_all_providers() {
        if !p.enabled || byok::byok_get(&p.id).is_none() {
            continue;
        }
        let Some(model) = p.default_model.clone() else { continue };
        out.push(Candidate {
            kind: CandidateKind::ExistingConfig,
            id: format!("byok:{}", p.id),
            label: format!("{} ({model})", p.name),
            detail: "already configured".into(),
            provider_id: Some(p.id),
            model: Some(model),
            base_url: p.base_url,
            env_var: None,
            recommended: false,
            download: None,
        });
    }

    // b. local GGUFs on disk (spawn_blocking: directory scan).
    let local = tokio::task::spawn_blocking(crate::models::scan_models_dir)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    // The FMS embedding model lives in the same dir but is not a chat
    // model — same exclusion `discover_active_model` applies.
    let local: Vec<_> = local
        .into_iter()
        .filter(|m| m.id != crate::paths::EMBED_FILENAME)
        .collect();
    let has_local = !local.is_empty();
    for m in &local {
        out.push(Candidate {
            kind: CandidateKind::LocalGguf,
            id: format!("local:{}", m.id),
            label: m.name.clone(),
            detail: format!("on disk — {:.1} GB, runs 100% locally", m.size_bytes as f64 / 1e9),
            provider_id: None,
            model: Some(m.id.clone()),
            base_url: None,
            env_var: None,
            recommended: false,
            download: None,
        });
    }

    // c. hardware tier → one-click download, only when no GGUF exists yet.
    if !has_local {
        let info = tokio::task::spawn_blocking(crate::sysinfo_mod::collect)
            .await
            .ok();
        if let Some(info) = info {
            let spec = recommend_download(&info);
            out.push(Candidate {
                kind: CandidateKind::HardwareDownload,
                id: format!("download:{}", spec.repo_id),
                label: format!("{} — your machine can run this", spec.label),
                detail: format!(
                    "one-time download {}, then 100% local and private",
                    spec.approx_size
                ),
                provider_id: None,
                model: Some(spec.filename.clone()),
                base_url: None,
                env_var: None,
                recommended: false,
                download: Some(spec),
            });
        }
    }

    // d. env API keys. Skip providers the existing config already covers.
    out.extend(env_key_candidates(|name| std::env::var(name).ok(), &out));

    // e. Ollama on :11434.
    if let Some(c) = detect_ollama().await {
        out.push(c);
    }

    // f. OpenClaw config (the Hermes migration rung) — providers not
    // already covered by an env key or existing config.
    out.extend(openclaw_candidates(&out));

    if let Some(first) = out.first_mut() {
        first.recommended = true;
    }
    out
}

/// The env-key rung, with the env reader injected so tests don't have to
/// mutate process env. `existing` suppresses duplicates for providers a
/// prior rung already surfaced.
fn env_key_candidates(
    get: impl Fn(&str) -> Option<String>,
    existing: &[Candidate],
) -> Vec<Candidate> {
    let covered = |pid: &str| {
        existing
            .iter()
            .any(|c| c.provider_id.as_deref() == Some(pid))
    };
    let catalog = byok::provider_catalog();
    let mut out = Vec::new();
    for (var, pid) in ENV_KEY_PROVIDERS {
        if covered(pid) || out.iter().any(|c: &Candidate| c.provider_id.as_deref() == Some(*pid)) {
            continue;
        }
        let Some(val) = get(var) else { continue };
        if val.trim().is_empty() {
            continue;
        }
        let Some(entry) = catalog.iter().find(|e| e.id == *pid) else { continue };
        out.push(Candidate {
            kind: CandidateKind::EnvKey,
            id: format!("env:{pid}"),
            label: format!("{} ({})", entry.name, entry.default_model),
            detail: format!("API key found in env {var}"),
            provider_id: Some(pid.to_string()),
            model: Some(entry.default_model.clone()),
            base_url: Some(entry.default_base_url.clone()),
            env_var: Some(var.to_string()),
            recommended: false,
            download: None,
        });
    }
    out
}

/// Probe a local Ollama. 1.5s timeout — either it's there or it isn't.
async fn detect_ollama() -> Option<Candidate> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .ok()?;
    let resp = client.get("http://127.0.0.1:11434/api/tags").send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    #[derive(Deserialize)]
    struct Tags { models: Option<Vec<TagModel>> }
    #[derive(Deserialize)]
    struct TagModel { name: String }
    let tags: Tags = resp.json().await.ok()?;
    let models = tags.models.unwrap_or_default();
    let first = models.first()?.name.clone();
    Some(Candidate {
        kind: CandidateKind::Ollama,
        id: "ollama".into(),
        label: format!("Ollama ({first})"),
        detail: format!("running on :11434 with {} model(s)", models.len()),
        // ponytail: Ollama persists into the single `custom` BYOK slot; a
        // dedicated `ollama` provider id when someone needs custom AND ollama.
        provider_id: Some("custom".into()),
        model: Some(first),
        base_url: Some("http://127.0.0.1:11434/v1".into()),
        env_var: None,
        recommended: false,
        download: None,
    })
}

/// Where an OpenClaw install keeps its config.
fn openclaw_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".openclaw")
        .join("openclaw.json")
}

/// The OpenClaw migration rung: if `~/.openclaw/openclaw.json` exists and its
/// `env` block carries a provider key we know, offer it — the same move
/// Hermes Agent makes ("detects ~/.openclaw and offers to migrate"). The key
/// value stays on the server; `verify` re-reads it from the file.
fn openclaw_candidates(existing: &[Candidate]) -> Vec<Candidate> {
    let path = openclaw_config_path();
    let Ok(raw) = std::fs::read_to_string(&path) else { return Vec::new() };
    openclaw_candidates_from_json(&raw, existing)
}

fn openclaw_candidates_from_json(raw: &str, existing: &[Candidate]) -> Vec<Candidate> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return Vec::new() };
    let Some(env) = v.get("env").and_then(|e| e.as_object()) else { return Vec::new() };
    let covered = |pid: &str| {
        existing
            .iter()
            .any(|c| c.provider_id.as_deref() == Some(pid))
    };
    let catalog = byok::provider_catalog();
    let mut out = Vec::new();
    for (var, pid) in ENV_KEY_PROVIDERS {
        if covered(pid) || out.iter().any(|c: &Candidate| c.provider_id.as_deref() == Some(*pid)) {
            continue;
        }
        let has_key = env
            .get(*var)
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty());
        if !has_key {
            continue;
        }
        let Some(entry) = catalog.iter().find(|e| e.id == *pid) else { continue };
        out.push(Candidate {
            kind: CandidateKind::OpenclawImport,
            id: format!("openclaw:{pid}"),
            label: format!("{} ({})", entry.name, entry.default_model),
            detail: format!("API key found in your OpenClaw config ({var})"),
            provider_id: Some(pid.to_string()),
            model: Some(entry.default_model.clone()),
            base_url: Some(entry.default_base_url.clone()),
            env_var: Some(var.to_string()),
            recommended: false,
            download: None,
        });
    }
    out
}

/// Read a provider key back out of the OpenClaw config for verification.
pub fn openclaw_key(env_var: &str) -> Option<String> {
    let raw = std::fs::read_to_string(openclaw_config_path()).ok()?;
    let v = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let key = v.get("env")?.get(env_var)?.as_str()?.trim().to_string();
    (!key.is_empty()).then_some(key)
}

// ── Hardware tier recommendation ────────────────────────────────────────────

/// Mirror of the desktop `hardwareRecommendation.ts` thresholds + the pinned
/// `TIER_MODELS` table (all repos + Q4_K_M filenames verified live on HF
/// 2026-07-10). Keep the two in sync when swapping models.
pub fn recommend_download(info: &crate::sysinfo_mod::SystemInfo) -> DownloadSpec {
    let has_gpu = info.supports_vulkan && info.vram_total_mb > 0;
    let budget_mb = if has_gpu {
        (info.vram_total_mb as f64 * 0.8) as u64
    } else {
        info.ram_total_mb / 2
    };
    let (repo, file, label, size) = if budget_mb >= 18_000 {
        ("bartowski/Qwen_Qwen3.5-27B-GGUF", "Qwen_Qwen3.5-27B-Q4_K_M.gguf", "Qwen3.5 27B", "~16.5 GB")
    } else if budget_mb >= 9_000 {
        ("bartowski/Qwen_Qwen3.5-9B-GGUF", "Qwen_Qwen3.5-9B-Q4_K_M.gguf", "Qwen3.5 9B", "~5.5 GB")
    } else if budget_mb >= 4_500 {
        ("bartowski/Qwen_Qwen3.5-4B-GGUF", "Qwen_Qwen3.5-4B-Q4_K_M.gguf", "Qwen3.5 4B", "~2.5 GB")
    } else {
        ("bartowski/Qwen_Qwen3.5-2B-GGUF", "Qwen_Qwen3.5-2B-Q4_K_M.gguf", "Qwen3.5 2B", "~1.5 GB")
    };
    DownloadSpec {
        repo_id: repo.into(),
        filename: file.into(),
        label: label.into(),
        approx_size: size.into(),
    }
}

// ── Verification (real completion) ───────────────────────────────────────────

/// Request-shape problems vs. runtime problems — the HTTP handler maps
/// these to 400/500; the Tauri command maps both to a thrown string.
#[derive(Debug)]
pub enum VerifyError {
    BadRequest(String),
    Internal(String),
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::BadRequest(m) | VerifyError::Internal(m) => write!(f, "{m}"),
        }
    }
}

/// The whole verify flow for any candidate — shared verbatim by the HTTP
/// endpoint (`POST /runtime/setup/verify`) and the desktop Tauri command,
/// so the invariant (persist only after a real completion round-trips)
/// lives in exactly one place.
pub async fn verify_candidate(
    runtime: &Arc<RuntimeState>,
    candidate: &Candidate,
    api_key: Option<&str>,
    model_override: Option<&str>,
    persist: bool,
) -> Result<VerifyOutcome, VerifyError> {
    match candidate.kind {
        CandidateKind::HardwareDownload => Err(VerifyError::BadRequest(
            "this candidate must be downloaded first, then verified as a local model".into(),
        )),
        CandidateKind::LocalGguf => verify_local(runtime, candidate, persist).await,
        _ => {
            let Some(provider_id) = candidate.provider_id.clone() else {
                return Err(VerifyError::BadRequest("candidate has no provider_id".into()));
            };
            let model = model_override
                .map(str::to_string)
                .or_else(|| candidate.model.clone());
            let Some(model) = model else {
                return Err(VerifyError::BadRequest("candidate has no model".into()));
            };
            let Some(key) = resolve_key(candidate, api_key) else {
                return Ok(VerifyOutcome::fail(
                    VerifyStatus::Auth,
                    "no API key available for this candidate — paste one",
                ));
            };
            let mut outcome =
                verify_cloud(&provider_id, &key, candidate.base_url.as_deref(), &model).await;
            if outcome.ok && persist {
                persist_cloud_route(&provider_id, &key, candidate.base_url.as_deref(), &model)
                    .map_err(|e| {
                        VerifyError::Internal(format!(
                            "verified, but persisting the route failed: {e}"
                        ))
                    })?;
                outcome.persisted = true;
            }
            Ok(outcome)
        }
    }
}

/// Local-model verification: load the GGUF (if not already active) and run
/// the same real completion through the in-process engine. On `persist`,
/// re-point the sidecar at loopback — the model is already loaded, so no
/// second load like `/runtime/model` would do.
async fn verify_local(
    runtime: &Arc<RuntimeState>,
    candidate: &Candidate,
    persist: bool,
) -> Result<VerifyOutcome, VerifyError> {
    let Some(model_id) = candidate.model.clone() else {
        return Err(VerifyError::BadRequest("candidate has no model".into()));
    };

    let already = runtime
        .manager
        .current()
        .is_some_and(|m| m.name == model_id);
    if !already {
        let manager = runtime.manager.clone();
        let wanted = model_id.clone();
        let loaded = tokio::task::spawn_blocking(move || {
            let models = crate::models::scan_models_dir().unwrap_or_default();
            let Some(m) = models.into_iter().find(|m| m.id == wanted || m.name == wanted) else {
                return Err(anyhow::anyhow!("model '{wanted}' not found on disk"));
            };
            manager.load(m.path, -1, None)
        })
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!(e)));
        if let Err(e) = loaded {
            return Ok(VerifyOutcome::fail(
                VerifyStatus::Unavailable,
                format!("model failed to load: {e}"),
            ));
        }
    }

    let messages = vec![crate::inference::Message {
        role: "user".into(),
        content: VERIFY_PROMPT.into(),
        images: None,
    }];
    let params = crate::inference::InferParams {
        max_tokens: VERIFY_MAX_TOKENS,
        ..Default::default()
    };
    let started = std::time::Instant::now();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(VERIFY_TIMEOUT_SECS), async {
        use futures::StreamExt;
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut out = String::new();
        let mut stream = Box::pin(runtime.manager.stream_chat(messages, params, stop, None));
        while let Some(tok) = stream.next().await {
            match tok {
                Ok(t) => out.push_str(&t),
                Err(e) => {
                    tracing::warn!("setup verify token error: {}", e);
                    break;
                }
            }
        }
        out
    })
    .await;
    let latency_ms = started.elapsed().as_millis() as u64;

    let mut outcome = match reply {
        Err(_) => VerifyOutcome::fail(VerifyStatus::Timeout, VerifyStatus::Timeout.human()),
        Ok(text) if text.trim().is_empty() => {
            VerifyOutcome::fail(VerifyStatus::Format, VerifyStatus::Format.human())
        }
        Ok(text) => VerifyOutcome {
            ok: true,
            status: VerifyStatus::Ok,
            message: format!("replied in {:.1}s", latency_ms as f64 / 1000.0),
            latency_ms: Some(latency_ms),
            reply: Some(text.trim().to_string()),
            persisted: false,
        },
    };

    if outcome.ok && persist {
        if let Some(loaded) = runtime.manager.current() {
            if let Some(tx) = runtime.cinderpaw_agent_tx.lock().as_ref().cloned() {
                let msg = serde_json::json!({
                    "type": "set_model",
                    "provider": "openai_compatible",
                    "model": loaded.name,
                    "baseUrl": format!("http://127.0.0.1:{}", runtime.settings.api_port),
                    "apiKey": runtime.local_api_token.to_string(),
                    "contextWindow": loaded.ctx_len,
                })
                .to_string();
                let _ = tx.try_send(msg);
            }
            *runtime.active_agent_model.lock() = Some(loaded.name.clone());
            // Same env mirror as the /runtime/model local path, so
            // runtime_status reports the verified route.
            unsafe {
                std::env::set_var("CINDERPAW_PROVIDER", "openai_compatible");
                std::env::set_var(
                    "CINDERPAW_BASE_URL",
                    format!("http://127.0.0.1:{}", runtime.settings.api_port),
                );
                std::env::set_var("CINDERPAW_MODEL", &loaded.name);
                std::env::remove_var("CINDERPAW_BYOK_PROVIDER");
            }
            // Persist the boot route so a restart keeps the verified local
            // model (and clears any stale cloud route).
            let mut s = crate::settings::load();
            s.active_route = Some(format!("local:{}", loaded.name));
            if let Err(e) = crate::settings::save(&s) {
                tracing::warn!(error = %e, "could not persist active_route");
            }
            outcome.persisted = true;
        }
    }
    Ok(outcome)
}

// ── Cloud verification (real completion) ─────────────────────────────────────

/// Resolve the API key for a cloud candidate, server-side, in ladder order:
/// explicit override → OS keychain → env var → OpenClaw config. Ollama
/// (`base_url` on loopback :11434) needs none — "ollama" is the convention.
pub fn resolve_key(candidate: &Candidate, override_key: Option<&str>) -> Option<String> {
    if let Some(k) = override_key {
        if !k.trim().is_empty() {
            return Some(k.trim().to_string());
        }
    }
    if candidate.kind == CandidateKind::Ollama {
        return Some("ollama".into());
    }
    if let Some(pid) = &candidate.provider_id {
        if candidate.kind == CandidateKind::ExistingConfig {
            if let Some(k) = byok::byok_get(pid) {
                return Some(k);
            }
        }
    }
    if let Some(var) = &candidate.env_var {
        match candidate.kind {
            CandidateKind::OpenclawImport => {
                if let Some(k) = openclaw_key(var) {
                    return Some(k);
                }
            }
            _ => {
                if let Ok(k) = std::env::var(var) {
                    if !k.trim().is_empty() {
                        return Some(k.trim().to_string());
                    }
                }
            }
        }
    }
    None
}

/// Run the real completion against a cloud endpoint. Never persists —
/// the caller persists on `Ok` only.
pub async fn verify_cloud(
    provider_id: &str,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
) -> VerifyOutcome {
    let provider = Provider::from_id(provider_id);
    let base = base_url
        .map(str::to_string)
        .unwrap_or_else(|| provider.default_base_url().to_string());
    let endpoint = format!(
        "{}/{}",
        base.trim_end_matches('/'),
        provider.chat_endpoint_path()
    );

    let client = match reqwest::Client::builder()
        .user_agent("cinderpaw/0.1")
        .timeout(std::time::Duration::from_secs(VERIFY_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => return VerifyOutcome::fail(VerifyStatus::Unknown, format!("client build: {e}")),
    };

    let body = if provider.is_openai_compatible() {
        serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": VERIFY_PROMPT }],
            "max_tokens": VERIFY_MAX_TOKENS,
            "stream": false,
        })
    } else {
        serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": VERIFY_PROMPT }],
            "max_tokens": VERIFY_MAX_TOKENS,
        })
    };

    let mut req = client
        .post(&endpoint)
        .header(provider.api_key_header(), format!("{}{}", provider.api_key_prefix(), api_key))
        .header("Content-Type", "application/json")
        .json(&body);
    for (name, value) in provider.extra_headers() {
        req = req.header(name, value);
    }

    let started = std::time::Instant::now();
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => {
            return VerifyOutcome::fail(VerifyStatus::Timeout, VerifyStatus::Timeout.human())
        }
        Err(e) => {
            return VerifyOutcome::fail(VerifyStatus::Unavailable, format!("request failed: {e}"))
        }
    };
    let latency_ms = started.elapsed().as_millis() as u64;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();

    if !(200..300).contains(&status) {
        let class = classify_http(status, &text);
        return VerifyOutcome {
            ok: false,
            status: class,
            message: format!("{} (HTTP {status})", class.human()),
            latency_ms: Some(latency_ms),
            reply: None,
            persisted: false,
        };
    }

    match extract_reply(&provider, &text) {
        Some(reply) if !reply.trim().is_empty() => VerifyOutcome {
            ok: true,
            status: VerifyStatus::Ok,
            message: format!("replied in {:.1}s", latency_ms as f64 / 1000.0),
            latency_ms: Some(latency_ms),
            reply: Some(reply.trim().to_string()),
            persisted: false,
        },
        _ => VerifyOutcome {
            ok: false,
            status: VerifyStatus::Format,
            message: VerifyStatus::Format.human().to_string(),
            latency_ms: Some(latency_ms),
            reply: None,
            persisted: false,
        },
    }
}

/// Pull the assistant text out of a chat-completion response for either
/// protocol family.
fn extract_reply(provider: &Provider, body: &str) -> Option<String> {
    let v = serde_json::from_str::<serde_json::Value>(body).ok()?;
    if provider.is_openai_compatible() {
        let msg = v.get("choices")?.get(0)?.get("message")?;
        let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
        if !content.trim().is_empty() {
            return Some(content.to_string());
        }
        // Reasoning models (DeepSeek R1 style) may spend all 32 tokens in
        // `reasoning_content`, leaving `content` empty — that is still a
        // successful round-trip, not a format failure.
        msg.get("reasoning_content")?.as_str().map(str::to_string)
    } else {
        // Anthropic Messages API: { content: [{ type: "text", text: "…" }] }
        v.get("content")?
            .get(0)?
            .get("text")?
            .as_str()
            .map(str::to_string)
    }
}

/// HTTP status + body → failure class. Body sniffing matters for the
/// providers that put billing failures behind 429 ("insufficient_quota").
pub fn classify_http(status: u16, body: &str) -> VerifyStatus {
    let lower = body.to_lowercase();
    match status {
        401 | 403 => VerifyStatus::Auth,
        402 => VerifyStatus::Billing,
        429 if lower.contains("quota") || lower.contains("billing") || lower.contains("credit") => {
            VerifyStatus::Billing
        }
        429 => VerifyStatus::RateLimit,
        404 => VerifyStatus::Unavailable,
        s if s >= 500 => VerifyStatus::Unavailable,
        _ => VerifyStatus::Unknown,
    }
}

/// Persist a verified cloud route: key → OS keychain, metadata → byok.json
/// (enabled + default_model + base_url). Called only after `verify_cloud`
/// returned Ok — see the module invariant.
pub fn persist_cloud_route(
    provider_id: &str,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
) -> anyhow::Result<()> {
    byok::byok_set(provider_id, api_key)?;
    byok::save_provider(
        provider_id,
        byok::ProviderConfig {
            enabled: true,
            api_key: String::new(), // keychain already holds it
            base_url: base_url.map(str::to_string),
            default_model: Some(model.to_string()),
        },
    )?;
    // Mark this as the boot route — without it the sidecar reverts to the
    // local CPU model on the next gateway restart even though setup just
    // verified the cloud route (2026-07-11).
    let mut s = crate::settings::load();
    s.active_route = Some(format!("{provider_id}:{model}"));
    crate::settings::save(&s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sysinfo_mod::SystemInfo;

    fn sysinfo(vram_mb: u64, ram_mb: u64, vulkan: bool) -> SystemInfo {
        SystemInfo {
            os: "windows".into(),
            cpu: "test".into(),
            cores: 8,
            ram_total_mb: ram_mb,
            ram_used_mb: 0,
            gpu_name: "test-gpu".into(),
            vram_total_mb: vram_mb,
            vram_used_mb: 0,
            supports_vulkan: vulkan,
        }
    }

    #[test]
    fn tier_thresholds_mirror_desktop() {
        // 12 GB VRAM * 0.8 = 9830 MB → 9B tier.
        assert_eq!(recommend_download(&sysinfo(12_288, 32_768, true)).label, "Qwen3.5 9B");
        // 24 GB VRAM → 27B tier.
        assert_eq!(recommend_download(&sysinfo(24_576, 32_768, true)).label, "Qwen3.5 27B");
        // No GPU, 16 GB RAM / 2 = 8192 → 4B tier.
        assert_eq!(recommend_download(&sysinfo(0, 16_384, false)).label, "Qwen3.5 4B");
        // No GPU, 8 GB RAM → 2B tier.
        assert_eq!(recommend_download(&sysinfo(0, 8_192, false)).label, "Qwen3.5 2B");
    }

    #[test]
    fn env_key_rung_maps_and_dedupes() {
        let get = |name: &str| match name {
            "OPENAI_API_KEY" => Some("sk-test".to_string()),
            "GEMINI_API_KEY" => Some("AIza-test".to_string()),
            "GOOGLE_API_KEY" => Some("AIza-test2".to_string()), // dup provider → dropped
            _ => None,
        };
        let got = env_key_candidates(get, &[]);
        let pids: Vec<_> = got.iter().filter_map(|c| c.provider_id.as_deref()).collect();
        assert_eq!(pids, vec!["openai", "google"]);
        assert_eq!(got[0].env_var.as_deref(), Some("OPENAI_API_KEY"));
        assert!(got[0].model.is_some(), "env candidate carries a default model");
    }

    #[test]
    fn env_key_rung_skips_already_configured_provider() {
        let existing = vec![Candidate {
            kind: CandidateKind::ExistingConfig,
            id: "byok:openai".into(),
            label: "OpenAI".into(),
            detail: String::new(),
            provider_id: Some("openai".into()),
            model: Some("gpt-4o".into()),
            base_url: None,
            env_var: None,
            recommended: false,
            download: None,
        }];
        let get = |name: &str| (name == "OPENAI_API_KEY").then(|| "sk-test".to_string());
        assert!(env_key_candidates(get, &existing).is_empty());
    }

    #[test]
    fn openclaw_env_block_yields_import_candidates() {
        let raw = r#"{ "env": { "ANTHROPIC_API_KEY": "sk-ant-test", "UNRELATED": "x" } }"#;
        let got = openclaw_candidates_from_json(raw, &[]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, CandidateKind::OpenclawImport);
        assert_eq!(got[0].provider_id.as_deref(), Some("anthropic"));
        assert_eq!(got[0].env_var.as_deref(), Some("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn openclaw_invalid_or_empty_config_is_no_candidates() {
        assert!(openclaw_candidates_from_json("not json", &[]).is_empty());
        assert!(openclaw_candidates_from_json(r#"{ "env": { "OPENAI_API_KEY": " " } }"#, &[]).is_empty());
        assert!(openclaw_candidates_from_json("{}", &[]).is_empty());
    }

    #[test]
    fn classify_http_taxonomy() {
        assert_eq!(classify_http(401, ""), VerifyStatus::Auth);
        assert_eq!(classify_http(403, ""), VerifyStatus::Auth);
        assert_eq!(classify_http(402, ""), VerifyStatus::Billing);
        assert_eq!(classify_http(429, r#"{"error":"insufficient_quota"}"#), VerifyStatus::Billing);
        assert_eq!(classify_http(429, "slow down"), VerifyStatus::RateLimit);
        assert_eq!(classify_http(404, ""), VerifyStatus::Unavailable);
        assert_eq!(classify_http(503, ""), VerifyStatus::Unavailable);
        assert_eq!(classify_http(418, ""), VerifyStatus::Unknown);
    }

    #[test]
    fn extract_reply_both_families() {
        let openai = r#"{"choices":[{"message":{"content":"OK"}}]}"#;
        assert_eq!(extract_reply(&Provider::Openai, openai).as_deref(), Some("OK"));
        let anthropic = r#"{"content":[{"type":"text","text":"OK"}]}"#;
        assert_eq!(extract_reply(&Provider::Anthropic, anthropic).as_deref(), Some("OK"));
        assert!(extract_reply(&Provider::Openai, "{}").is_none());
    }
}
