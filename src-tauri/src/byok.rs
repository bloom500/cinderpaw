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
            Provider::Google => "https://generativelanguage.googleapis.com/v1beta",
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

/// Per-provider API key and configuration
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[derive(Default)]
pub struct ProviderConfig {
    pub enabled: bool,
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

/// Load BYOK settings from the settings file
pub fn load(_settings: &crate::settings::Settings) -> ByokSettings {
    // BYOK settings are embedded in the main settings file under "byok" key
    // For simplicity, we store them alongside settings in a separate file
    let path = crate::paths::feral_dir().join("byok.json");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(s) = serde_json::from_slice::<ByokSettings>(&bytes) {
            return s;
        }
    }
    ByokSettings::default()
}

/// Save BYOK settings to disk
pub fn save(settings: &ByokSettings) -> anyhow::Result<()> {
    crate::paths::ensure_dirs()?;
    let path = crate::paths::feral_dir().join("byok.json");
    std::fs::write(path, serde_json::to_vec_pretty(settings)?)?;
    Ok(())
}
