//! BYOK (Bring Your Own Key) — Cloud AI provider integration.
//! Stores API keys and provides a unified proxy for cloud AI models.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Known cloud AI providers
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Anthropic,
    Google,
    Kimi,
    Glm,
    Minimax,
    Groq,
    Mistral,
    Deepseek,
    Openrouter,
    Nvidia,
    Custom,
}

impl Provider {
    /// Returns the default base URL for each provider's API
    pub fn default_base_url(&self) -> &'static str {
        match self {
            Provider::Openai => "https://api.openai.com/v1",
            Provider::Anthropic => "https://api.anthropic.com/v1",
            // Google Gemini's OpenAI-compatible surface lives under
            // /v1beta/openai/. Without the `/openai/` segment, requests to
            // `/chat/completions` hit the native Gemini endpoint and 404 —
            // /v1beta/openai/chat/completions is the path the docs publish.
            Provider::Google => "https://generativelanguage.googleapis.com/v1beta/openai",
            Provider::Kimi => "https://api.kimi.com/coding/v1",
            Provider::Glm => "https://api.z.ai/api/coding/paas/v4",
            Provider::Minimax => "https://api.minimax.io/v1",
            Provider::Groq => "https://api.groq.com/openai/v1",
            Provider::Mistral => "https://api.mistral.ai/v1",
            Provider::Deepseek => "https://api.deepseek.com/v1",
            Provider::Openrouter => "https://openrouter.ai/api/v1",
            // NVIDIA NIM — OpenAI-compatible chat completions API.
            // Trailing /v1 because the API path is /v1/chat/completions.
            Provider::Nvidia => "https://integrate.api.nvidia.com/v1",
            Provider::Custom => "https://api.custom.com/v1",
        }
    }

    /// Returns the API key header name for this provider
    pub fn api_key_header(&self) -> &'static str {
        match self {
            Provider::Openai | Provider::Groq | Provider::Mistral | Provider::Deepseek |
            Provider::Openrouter | Provider::Kimi | Provider::Glm | Provider::Minimax |
            Provider::Nvidia => "Authorization",
            Provider::Anthropic => "x-api-key",
            Provider::Google => "Authorization",
            Provider::Custom => "Authorization",
        }
    }

    /// Returns the API key prefix format (e.g., "Bearer ")
    pub fn api_key_prefix(&self) -> &'static str {
        match self {
            Provider::Anthropic => "",
            Provider::Google => "Bearer ",
            Provider::Custom => "",
            _ => "Bearer ",
        }
    }

    /// Returns the chat completions endpoint path.
    /// Kept for the in-progress per-provider endpoint routing; not wired yet.
    #[allow(dead_code)]
    pub fn chat_endpoint(&self) -> &'static str {
        "/chat/completions"
    }

    /// Returns the path (relative to `default_base_url()`) used for a chat
    /// completion call. Anthropic uses `/v1/messages` — its protocol is
    /// similar to OpenAI but the endpoint is different, so the legacy
    /// `url_join(base_url, "chat/completions")` produced a 404.
    pub fn chat_endpoint_path(&self) -> &'static str {
        match self {
            Provider::Anthropic => "messages",
            _ => "chat/completions",
        }
    }

    /// Extra HTTP headers required by the provider. Anthropic requires
    /// `anthropic-version` on every Messages API request; the others use
    /// OpenAI's standard `Authorization: Bearer …` only.
    pub fn extra_headers(&self) -> Vec<(&'static str, &'static str)> {
        match self {
            Provider::Anthropic => vec![("anthropic-version", "2023-06-01")],
            _ => Vec::new(),
        }
    }

    /// Returns whether this provider uses OpenAI-compatible format.
    /// Kept for the in-progress per-provider request shaping; not wired yet.
    #[allow(dead_code)]
    pub fn is_openai_compatible(&self) -> bool {
        !matches!(self, Provider::Anthropic)
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Provider::Openai => write!(f, "OpenAI"),
            Provider::Anthropic => write!(f, "Anthropic"),
            Provider::Google => write!(f, "Google"),
            Provider::Kimi => write!(f, "Kimi"),
            Provider::Glm => write!(f, "GLM"),
            Provider::Minimax => write!(f, "MiniMax"),
            Provider::Groq => write!(f, "Groq"),
            Provider::Mistral => write!(f, "Mistral"),
            Provider::Deepseek => write!(f, "DeepSeek"),
            Provider::Openrouter => write!(f, "OpenRouter"),
            Provider::Nvidia => write!(f, "NVIDIA NIM"),
            Provider::Custom => write!(f, "Custom"),
        }
    }
}

/// Per-provider API key and configuration.
///
/// V6: `api_key` is NEVER serialized to disk. It lives only in memory (loaded
/// from the OS keychain on `load`, supplied by the UI on `save`). The
/// `skip_serializing` attribute keeps it out of `byok.json`; `default` lets it
/// still deserialize from a legacy plaintext file so existing keys can be
/// migrated into the keychain on first load.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[derive(Default)]
pub struct ProviderConfig {
    pub enabled: bool,
    #[serde(default, skip_serializing)]
    pub api_key: String,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
}


/// BYOK settings — stored in settings.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ByokSettings {
    pub providers: HashMap<String, ProviderConfig>,
}

impl ByokSettings {
    /// Get a list of all supported providers with their current config
    pub fn get_all_providers(&self) -> Vec<ProviderInfo> {
        let defaults = Self::default_provider_configs();
        defaults.into_iter().map(|(id, name, provider)| {
            let config = self.providers.get(&id).cloned().unwrap_or_default();
            ProviderInfo {
                id: id.clone(),
                name,
                provider: provider.clone(),
                enabled: config.enabled,
                has_api_key: !config.api_key.is_empty(),
                base_url: config.base_url.or(Some(provider.default_base_url().to_string())),
                default_model: config.default_model,
            }
        }).collect()
    }

    /// Get default configurations for all known providers
    fn default_provider_configs() -> Vec<(String, String, Provider)> {
        vec![
            ("openai".to_string(), "OpenAI".to_string(), Provider::Openai),
            ("anthropic".to_string(), "Anthropic".to_string(), Provider::Anthropic),
            ("google".to_string(), "Google".to_string(), Provider::Google),
            ("kimi".to_string(), "Kimi".to_string(), Provider::Kimi),
            ("glm".to_string(), "GLM".to_string(), Provider::Glm),
            ("minimax".to_string(), "MiniMax".to_string(), Provider::Minimax),
            ("groq".to_string(), "Groq".to_string(), Provider::Groq),
            ("mistral".to_string(), "Mistral".to_string(), Provider::Mistral),
            ("deepseek".to_string(), "DeepSeek".to_string(), Provider::Deepseek),
            ("openrouter".to_string(), "OpenRouter".to_string(), Provider::Openrouter),
            // NVIDIA NIM — OpenAI-compatible hosted models (Llama, Mistral, etc.).
            ("nvidia".to_string(), "NVIDIA NIM".to_string(), Provider::Nvidia),
        ]
    }

    /// Update config for a specific provider
    pub fn update_provider(&mut self, id: &str, config: ProviderConfig) {
        self.providers.insert(id.to_string(), config);
    }

    /// Get config for a specific provider
    pub fn get_provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.get(id)
    }
}

/// Provider info for the frontend
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub enabled: bool,
    pub has_api_key: bool,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
}

/// Request to test a provider connection.
/// Part of the in-progress "test connection" command; not wired to a handler yet.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct TestProviderRequest {
    pub provider_id: String,
    pub api_key: String,
    pub base_url: Option<String>,
}

/// Response from testing a provider
#[derive(Debug, Serialize, specta::Type)]
pub struct TestProviderResponse {
    pub success: bool,
    pub message: String,
    pub models: Vec<String>,
}

// ── OS keychain storage for API keys (V6) ───────────────────────────────────
//
// API keys are stored in the platform secret store (Windows Credential
// Manager / macOS Keychain / Linux Secret Service) under one service name,
// keyed by provider id. byok.json keeps only non-secret metadata. This means
// a copy of the config file — backed up, synced, or leaked — never carries
// the keys.

/// Keychain service name. Stable across launches so keys persist; namespaced
/// to Feral so it never collides with other apps' credentials.
const KEYCHAIN_SERVICE: &str = "ai.bloom.feral.byok";

/// Create a keyring entry for the given provider id.
fn key_entry(provider_id: &str) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider_id)
}

/// Store a provider's API key in the keychain.
/// Public API: byok_set(provider_id, api_key)
pub fn byok_set(provider_id: &str, key: &str) -> anyhow::Result<()> {
    key_entry(provider_id)?.set_password(key)?;
    Ok(())
}

/// Remove a provider's API key from the keychain. A missing entry is success.
fn clear_key(provider_id: &str) -> anyhow::Result<()> {
    match key_entry(provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Read a provider's API key from the keychain, or `None` if absent.
/// Public API: byok_get(provider_id)
pub fn byok_get(provider_id: &str) -> Option<String> {
    match key_entry(provider_id).ok()?.get_password() {
        Ok(k) => Some(k),
        Err(_) => None,
    }
}

/// Load BYOK settings: non-secret metadata from `byok.json`, API keys from the
/// OS keychain. Migrates any plaintext keys found in a legacy `byok.json` into
/// the keychain, then deletes the legacy file.
pub fn load(_settings: &crate::settings::Settings) -> ByokSettings {
    let path = crate::paths::feral_dir().join("byok.json");
    let mut s = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<ByokSettings>(&bytes).unwrap_or_default(),
        Err(_) => ByokSettings::default(),
    };

    let mut migrated_any = false;
    for (id, cfg) in s.providers.iter_mut() {
        if !cfg.api_key.is_empty() {
            // Legacy plaintext key present in the file → migrate to keychain.
            if let Err(e) = byok_set(id, &cfg.api_key) {
                tracing::warn!(provider = %id, ?e, "byok: failed to migrate key to keychain");
            } else {
                migrated_any = true;
            }
            // Keep it in memory for this load; the rewrite below drops it from disk.
        } else if let Some(k) = byok_get(id) {
            cfg.api_key = k;
        }
    }

    if migrated_any {
        // After migration, remove the legacy plaintext file entirely.
        // The metadata is regenerated on-demand when save() is called.
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(?e, "byok: failed to delete legacy byok.json after migration");
        } else {
            tracing::info!("byok: migrated plaintext API key(s) into the OS keychain and removed byok.json");
        }
    }

    s
}

/// Persist BYOK settings: API keys to the keychain, metadata to `byok.json`.
///
/// An empty `api_key` means "leave the stored key untouched" — the UI sends a
/// blank field to mean "unchanged" (its placeholder reads "Key saved — enter a
/// new key to update"). `save` therefore never deletes on empty; explicit
/// removal goes through [`remove_provider`]. This makes routine edits (toggling
/// `enabled`, changing the default model) safe without re-typing the key.
pub fn save(settings: &ByokSettings) -> anyhow::Result<()> {
    crate::paths::ensure_dirs()?;
    for (id, cfg) in &settings.providers {
        if !cfg.api_key.is_empty() {
            byok_set(id, &cfg.api_key)?;
        }
    }
    write_metadata(settings)
}

/// Explicitly remove a provider's API key and disable it. The metadata row is
/// kept (so the provider still appears in the UI) but its key is purged from
/// the keychain.
pub fn remove_provider(id: &str) -> anyhow::Result<()> {
    clear_key(id)?;
    let mut settings = load_metadata();
    if let Some(cfg) = settings.providers.get_mut(id) {
        cfg.enabled = false;
        cfg.api_key = String::new();
    }
    write_metadata(&settings)
}

/// Read only the on-disk metadata (no keychain access). Used by mutation paths
/// that must not re-trigger migration or key population.
fn load_metadata() -> ByokSettings {
    let path = crate::paths::feral_dir().join("byok.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<ByokSettings>(&bytes).unwrap_or_default(),
        Err(_) => ByokSettings::default(),
    }
}

/// Write only the non-secret metadata to disk (api_key is skip_serializing).
fn write_metadata(settings: &ByokSettings) -> anyhow::Result<()> {
    let path = crate::paths::feral_dir().join("byok.json");
    std::fs::write(path, serde_json::to_vec_pretty(settings)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_default_base_url_uses_openai_compat_path() {
        // The OpenAI-compatible surface for Gemini is published at
        // /v1beta/openai/. The previous default `/v1beta` was the native
        // Gemini endpoint and 404'd on every chat-completions call.
        assert_eq!(
            Provider::Google.default_base_url(),
            "https://generativelanguage.googleapis.com/v1beta/openai"
        );
    }

    #[test]
    fn anthropic_uses_messages_endpoint_and_x_api_key() {
        // Anthropic's protocol is similar to OpenAI but the path is `/v1/messages`
        // (not `/v1/chat/completions`), the auth header is `x-api-key` without a
        // `Bearer ` prefix, and `anthropic-version` is mandatory.
        assert_eq!(Provider::Anthropic.chat_endpoint_path(), "messages");
        assert_eq!(Provider::Anthropic.api_key_header(), "x-api-key");
        assert_eq!(Provider::Anthropic.api_key_prefix(), "");
        assert_eq!(
            Provider::Anthropic.extra_headers(),
            vec![("anthropic-version", "2023-06-01")]
        );
        assert!(!Provider::Anthropic.is_openai_compatible());
    }

    #[test]
    fn openai_uses_chat_completions_and_bearer() {
        // OpenAI and the OpenAI-compatible providers route through
        // `/v1/chat/completions` with `Authorization: Bearer …` and no extra
        // headers.
        for p in [
            Provider::Openai,
            Provider::Kimi,
            Provider::Glm,
            Provider::Minimax,
            Provider::Groq,
            Provider::Mistral,
            Provider::Deepseek,
            Provider::Openrouter,
            Provider::Nvidia,
        ] {
            assert_eq!(p.chat_endpoint_path(), "chat/completions", "endpoint for {p:?}");
            assert_eq!(p.api_key_header(), "Authorization", "header for {p:?}");
            assert_eq!(p.api_key_prefix(), "Bearer ", "prefix for {p:?}");
            assert!(p.extra_headers().is_empty(), "no extras for {p:?}");
            assert!(p.is_openai_compatible(), "{p:?} should be OpenAI-compat");
        }
        // Custom is OpenAI-shaped but sends the key verbatim (empty prefix) so
        // users can paste a full `Bearer …`/`Basic …`/raw token themselves.
        assert_eq!(Provider::Custom.chat_endpoint_path(), "chat/completions");
        assert_eq!(Provider::Custom.api_key_header(), "Authorization");
        assert_eq!(Provider::Custom.api_key_prefix(), "");
        assert!(Provider::Custom.is_openai_compatible());
    }

    #[test]
    fn google_uses_openai_compat_path() {
        // Gemini follows the OpenAI shape (after the /openai/ fix above) —
        // /chat/completions, Bearer, no extras.
        assert_eq!(Provider::Google.chat_endpoint_path(), "chat/completions");
        assert_eq!(Provider::Google.api_key_header(), "Authorization");
        assert_eq!(Provider::Google.api_key_prefix(), "Bearer ");
        assert!(Provider::Google.extra_headers().is_empty());
        assert!(Provider::Google.is_openai_compatible());
    }
}
