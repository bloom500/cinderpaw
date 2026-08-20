//! BYOK (bring-your-own-key) cloud provider settings.

use crate::*;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub(crate) fn get_byok_settings() -> Vec<byok::ProviderInfo> {
    let settings = byok::load(&settings::load());
    settings.get_all_providers()
}

/// Return the canonical provider catalog (Phase 1 — Decision C).
/// The desktop OnboardingWizard consumes this to render provider cards
/// instead of a hardcoded list, closing the three-source drift surface.
#[tauri::command]
#[specta::specta]
pub(crate) fn provider_catalog() -> Vec<byok::ProviderCatalogEntry> {
    byok::provider_catalog()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn save_byok_provider(
    state: State<AppState>,
    provider_id: String,
    enabled: bool,
    api_key: String,
    base_url: Option<String>,
    default_model: Option<String>,
) -> Result<(), String> {
    // An enabled provider needs a key. Saving one with an empty key stored a
    // configuration that looks complete in the UI and fails on the first
    // request with an authentication error from the vendor — which reads as
    // "my key is wrong" rather than "there is no key". Whitespace counts as
    // empty: a pasted key with a stray newline is the common way this happens.
    let api_key = api_key.trim().to_string();
    if enabled && api_key.is_empty() {
        return Err(format!(
            "{provider_id} cannot be enabled without an API key — paste the key, or leave the provider off"
        ));
    }
    let mut settings = byok::load(&state.settings);
    let config = byok::ProviderConfig {
        enabled,
        api_key,
        base_url,
        default_model,
    };
    settings.update_provider(&provider_id, config);
    byok::save(&settings).map_err(|e| e.to_string())?;

    Ok(())
}

/// Remove a BYOK provider's API key from the OS keychain and disable it.
/// The provider stays listed in the UI (so it can be re-enabled) but its
/// secret is purged.
#[tauri::command]
#[specta::specta]
pub(crate) fn remove_byok_provider(provider_id: String) -> Result<(), String> {
    byok::remove_provider(&provider_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn test_byok_provider(provider_id: String, api_key: String, base_url: Option<String>) -> Result<byok::TestProviderResponse, String> {
    // Sprint 2 / audit C-2 — delegate to cinderpaw-core so the headless gateway
    // route `/providers/test` can serve the same probe. The previous local
    // implementation is gone; behavior is identical (OpenAI-compatible
    // providers get a GET /v1/models probe, Anthropic skips straight to a
    // chat-completion probe). See `crates/cinderpaw-core/src/byok.rs`.
    Ok(byok::test_provider(&provider_id, &api_key, base_url.as_deref()).await)
}
