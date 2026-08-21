//! BYOK (bring-your-own-key) cloud provider settings.

use crate::*;

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
    provider_id: String,
    enabled: bool,
    api_key: String,
    base_url: Option<String>,
    default_model: Option<String>,
) -> Result<(), String> {
    // Route through `save_provider` (single-provider write path) instead of
    // `load` + `save(&settings)` (all-providers rewrite path).
    //
    // The old code loaded ALL providers into memory (populating api_key from
    // the keychain for every one of them), updated just the one the UI edited,
    // then called `save(&settings)` — which iterates every provider and
    // re-writes its keychain entry. On macOS (Cinderpaw isn't Apple-notarized
    // yet, see README) each keychain write can prompt for the login password;
    // if the user dismisses the prompt for ANY provider — including ones they
    // never touched in this edit — the whole call fails with a generic
    // keychain error. This is what the "Save Failed on OpenRouter / NVIDIA
    // NIM" report (Darius, 2026-08-22) actually was: the user was editing one
    // row, but the save touched the OS keychain for every previously-saved
    // provider, and one prompt got dismissed.
    //
    // `save_provider` only writes THIS provider's keychain entry (when the
    // api_key field is non-empty) and updates just its row in byok.json. The
    // rest of the keychain is untouched — no unrelated prompts, no unrelated
    // failures. `save_provider` reads the on-disk metadata directly, so we
    // no longer need `State<AppState>` here (removed from the arg list; the
    // other read/remove/test commands in this file already had no state).
    let config = byok::ProviderConfig {
        enabled,
        api_key,
        base_url,
        default_model,
    };
    byok::save_provider(&provider_id, config).map_err(|e| e.to_string())?;
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
    // Sprint 2 / audit C-2 — delegate to feral-core so the headless gateway
    // route `/providers/test` can serve the same probe. The previous local
    // implementation is gone; behavior is identical (OpenAI-compatible
    // providers get a GET /v1/models probe, Anthropic skips straight to a
    // chat-completion probe). See `crates/feral-core/src/byok.rs`.
    Ok(byok::test_provider(&provider_id, &api_key, base_url.as_deref()).await)
}
