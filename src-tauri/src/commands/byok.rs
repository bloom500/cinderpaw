//! BYOK (bring-your-own-key) cloud provider settings.

use crate::*;

// async: each provider's key is read from the OS keychain (Credential Manager on
// Windows), and a synchronous command runs on the window's main thread, so the
// whole app froze until every read returned. Settings took 2-3 s to appear.
#[tauri::command]
#[specta::specta]
pub(crate) async fn get_byok_settings() -> Vec<byok::ProviderInfo> {
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

// async for the same reason as get_byok_settings: it reads and writes the keychain.
#[tauri::command]
#[specta::specta]
pub(crate) async fn save_byok_provider(
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
    //
    // An enabled provider needs a key. Saving one with an empty key stored a
    // configuration that looks complete in the UI and fails on the first
    // request with an authentication error from the vendor — which reads as
    // "my key is wrong" rather than "there is no key". Whitespace counts as
    // empty: a pasted key with a stray newline is the common way this happens.
    //
    // "Empty" means empty EVERYWHERE, not just in this request. The key field
    // in the UI is never pre-filled with the stored secret, so someone who
    // opens an already-configured provider to change only its model or base
    // URL sends an empty api_key with enabled=true. Rejecting that was the
    // "Save Failed on OpenRouter / NVIDIA NIM" report (Darius, 2026-08-22):
    // the providers that failed were exactly the ones already set up. An
    // empty key here means "leave the stored one alone" — `save_provider`
    // already skips the keychain write in that case.
    //
    // The guard above is about a HOSTED vendor, and it locked out the engines
    // that are not one. A local voice engine (Kokoro, Piper) has no API key on
    // any machine, ever, and still writes a BYOK record because that is where
    // its chosen voice is stored. So on a fresh install, picking Kokoro and
    // pressing Save was refused with "paste the key" for a key that does not
    // exist and never will. It only worked on a machine where some record had
    // already been written by hand.
    let mut api_key = api_key.trim().to_string();
    // A ChatGPT plan has a sign-in, not a key: its card saves only the model.
    let keyless = cinderpaw_core::tts::needs_api_key(&provider_id) == Some(false)
        || provider_id == cinderpaw_core::chatgpt_signin::PROVIDER_ID;
    // A voice engine that sends another record's key (OpenRouter's TTS row
    // sends the `openrouter` chat key). A key pasted on that row goes to the
    // keychain entry the engine actually reads, and the row itself keeps only
    // its voice and model; otherwise the paste lands under a name nothing
    // reads and the call echoes with "no key" on screen.
    let key_owner = cinderpaw_core::tts::key_provider(&provider_id).to_string();
    if key_owner != provider_id && !api_key.is_empty() {
        byok::byok_set(&key_owner, &api_key).map_err(|e| e.to_string())?;
        api_key.clear();
    }
    if enabled && !keyless && api_key.is_empty() && byok::byok_get(&key_owner).is_none() {
        return Err(format!(
            "{provider_id} cannot be enabled without an API key — paste the key, or leave the provider off"
        ));
    }
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
    // Sprint 2 / audit C-2 — delegate to cinderpaw-core so the headless gateway
    // route `/providers/test` can serve the same probe. The previous local
    // implementation is gone; behavior is identical (OpenAI-compatible
    // providers get a GET /v1/models probe, Anthropic skips straight to a
    // chat-completion probe). See `crates/cinderpaw-core/src/byok.rs`.
    Ok(byok::test_provider(&provider_id, &api_key, base_url.as_deref()).await)
}

/// Whether a key is stored for this provider id. The secret never leaves the
/// keychain; a row that only needs "saved or not" (the call screen's Jev
/// field, which is not in the chat catalog and so not in `get_byok_settings`)
/// asks this instead of reading the key.
#[tauri::command]
#[specta::specta]
pub(crate) async fn byok_has_key(provider_id: String) -> bool {
    byok::byok_get(&provider_id).is_some_and(|k| !k.trim().is_empty())
}

/// Sign in with OpenRouter instead of pasting a key (OAuth PKCE). The flow
/// lives in `cinderpaw_core::openrouter_signin`, shared with the browser app;
/// this only opens the browser and waits.
#[tauri::command]
#[specta::specta]
pub(crate) async fn openrouter_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    let (auth_url, finish) = cinderpaw_core::openrouter_signin::start(None).await?;
    {
        use tauri_plugin_shell::ShellExt;
        // The same call browser.rs makes; the opener plugin is not a dependency.
        #[allow(deprecated)]
        let opened = app.shell().open(auth_url.as_str(), None);
        opened.map_err(|e| format!("Could not open your browser: {e}"))?;
    }
    finish.await
}

/// Who is signed in with ChatGPT, for the OpenAI Subscription card.
#[derive(serde::Serialize, specta::Type)]
pub(crate) struct ChatgptAccount {
    email: Option<String>,
    name: Option<String>,
}

/// A model a provider offers: its id, and the provider's own name for it when
/// it gives one (the picker shows a readable name either way).
#[derive(serde::Serialize, specta::Type)]
pub(crate) struct ProviderModel {
    id: String,
    name: Option<String>,
}

// async: the account is read from the keychain, as in get_byok_settings.
#[tauri::command]
#[specta::specta]
pub(crate) async fn chatgpt_account() -> Option<ChatgptAccount> {
    cinderpaw_core::chatgpt_signin::account().map(|a| ChatgptAccount { email: a.email, name: a.name })
}

/// Sign in with ChatGPT in the browser, so model calls are spent from the
/// person's ChatGPT plan (`cinderpaw_core::chatgpt_signin`). Then the
/// account's models are listed and its row is written with one of them, so
/// the picker offers it at once. Returns the model that will answer.
#[tauri::command]
#[specta::specta]
pub(crate) async fn chatgpt_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    use cinderpaw_core::chatgpt_signin::{self as signin, PROVIDER_ID};
    let (auth_url, finish) = signin::start().await?;
    {
        use tauri_plugin_shell::ShellExt;
        #[allow(deprecated)]
        let opened = app.shell().open(auth_url.as_str(), None);
        opened.map_err(|e| format!("Could not open your browser: {e}"))?;
    }
    finish.await?;
    let models = cinderpaw_core::chatgpt_gateway::models(&signin::access_token().await?).await?;
    // The model chosen before a sign-out comes back, if the account still has it.
    let kept = byok::load(&settings::load())
        .get_provider(PROVIDER_ID)
        .and_then(|c| c.default_model.clone())
        .filter(|m| models.iter().any(|(id, _)| id == m));
    let model = kept
        .or_else(|| models.first().map(|(id, _)| id.clone()))
        .ok_or("Signed in, but ChatGPT lists no model this account may use in Cinderpaw.")?;
    let config = byok::ProviderConfig { enabled: true, api_key: String::new(), base_url: None, default_model: Some(model.clone()) };
    byok::save_provider(PROVIDER_ID, config).map_err(|e| e.to_string())?;
    Ok(model)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn chatgpt_models() -> Result<Vec<ProviderModel>, String> {
    let token = cinderpaw_core::chatgpt_signin::access_token().await?;
    let models = cinderpaw_core::chatgpt_gateway::models(&token).await?;
    Ok(models.into_iter().map(|(id, name)| ProviderModel { id, name: Some(name) }).collect())
}

/// Every chat model a connected provider offers, for the model picker's
/// provider page: pick one by its name, no id typed (1 Nov, Darius). The key
/// stays here; the page gets ids and names.
#[tauri::command]
#[specta::specta]
pub(crate) async fn provider_models(provider_id: String) -> Result<Vec<ProviderModel>, String> {
    if provider_id == cinderpaw_core::chatgpt_signin::PROVIDER_ID {
        return chatgpt_models().await;
    }
    let key = byok::byok_get(&provider_id)
        .filter(|k| !k.trim().is_empty())
        .ok_or("No key is saved for this provider. Add it in Models > Cloud.")?;
    let base = byok::load(&settings::load())
        .get_all_providers()
        .into_iter()
        .find(|p| p.id == provider_id)
        .and_then(|p| p.base_url);
    let models = byok::list_models(&provider_id, &key, base.as_deref()).await?;
    Ok(models.into_iter().map(|(id, name)| ProviderModel { id, name }).collect())
}

/// Sign out here and ask OpenAI to end the session. `Err` means it is signed
/// out on this computer but OpenAI could not confirm, and says where to finish.
#[tauri::command]
#[specta::specta]
pub(crate) async fn chatgpt_sign_out() -> Result<(), String> {
    let _ = byok::remove_provider(cinderpaw_core::chatgpt_signin::PROVIDER_ID);
    cinderpaw_core::chatgpt_signin::disconnect().await
}

/// One System One request to Jev (TypeSafe), with the key from the keychain.
///
/// The JS side builds `state` and `questions` (the closed sets the call can
/// act on) and gets `answers` back; it never sees the key. The route was
/// stored with the key: OpenRouter (`https://openrouter.ai/api`) or TypeSafe
/// (`https://api.typesafe.ai`), both `POST {base}/v1/systemone` with the same
/// body and the same answer shape.
#[tauri::command]
#[specta::specta]
pub(crate) async fn jev_decide(state: serde_json::Value, questions: serde_json::Value) -> Result<serde_json::Value, String> {
    let key = byok::byok_get("jev").filter(|k| !k.trim().is_empty()).ok_or("jev-no-key")?;
    let cfg = byok::load(&settings::load()).providers.get("jev").cloned().unwrap_or_default();
    let base = cfg.base_url.unwrap_or_else(|| "https://api.typesafe.ai".into());
    let model = cfg.default_model.unwrap_or_else(|| "jev-latest".into());
    let url = format!("{}/v1/systemone", base.trim_end_matches('/'));
    // A 429/529 answers fast, so one or two short backoffs usually land: the
    // sentence survives a busy moment instead of dying on it. Anything else
    // (401/422/unreachable) is final the first time. `ms` counts the whole
    // wait, backoffs included, so the call log keeps honest latencies.
    let started = std::time::Instant::now();
    let mut attempt = 0u32;
    loop {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .post(&url)
            .bearer_auth(key.trim())
            .header("HTTP-Referer", "https://cinderpaw.ai")
            .header("X-Title", "Cinderpaw")
            .json(&serde_json::json!({ "model": model, "state": state, "questions": questions }))
            .send()
            .await
            .map_err(|e| format!("jev-unreachable: {e}"))?;
        let status = resp.status();
        if jev_retryable(status.as_u16()) && attempt < 2 {
            let wait = jev_retry_delay_ms(
                attempt,
                resp.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()),
            );
            tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            attempt += 1;
            continue;
        }
        let body: serde_json::Value = resp.json().await.map_err(|e| format!("jev-bad-reply: {e}"))?;
        if !status.is_success() {
            let msg = body.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("");
            return Err(format!("jev-http-{}: {msg}", status.as_u16()));
        }
        return Ok(serde_json::json!({
            "answers": body.get("answers").cloned().unwrap_or(serde_json::Value::Null),
            "usage": body.get("usage").cloned().unwrap_or(serde_json::Value::Null),
            "ms": started.elapsed().as_millis() as u64,
        }));
    }
}

/// Worth one more try, after a backoff: rate-limit and overload answers arrive
/// fast, so waiting a beat usually lands. Anything else is final outright.
fn jev_retryable(status: u16) -> bool {
    status == 429 || status == 529
}

/// Backoff before retry number `n` (0-based): 500ms, 1s, 2s. A Retry-After in
/// whole seconds wins when the server names one, capped at 5s for a voice
/// budget; anything else (HTTP-date, garbage) falls back to the doubling.
fn jev_retry_delay_ms(retry: u32, retry_after: Option<&str>) -> u64 {
    if let Some(s) = retry_after.and_then(|v| v.trim().parse::<u64>().ok()) {
        return s.min(5) * 1000;
    }
    (500 * 2u64.pow(retry.min(4))).min(8000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_rate_limit_and_overload_retry() {
        assert!(jev_retryable(429));
        assert!(jev_retryable(529));
        for s in [200, 400, 401, 402, 422, 500, 503] {
            assert!(!jev_retryable(s), "{s} must be final");
        }
    }

    #[test]
    fn backoff_doubles_and_honors_retry_after() {
        assert_eq!(jev_retry_delay_ms(0, None), 500);
        assert_eq!(jev_retry_delay_ms(1, None), 1000);
        assert_eq!(jev_retry_delay_ms(2, None), 2000);
        assert_eq!(jev_retry_delay_ms(0, Some("2")), 2000);
        assert_eq!(jev_retry_delay_ms(0, Some("30")), 5000);
        assert_eq!(jev_retry_delay_ms(0, Some("garbage")), 500);
    }
}
