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
    let keyless = cinderpaw_core::tts::needs_api_key(&provider_id) == Some(false);
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

/// The model a fresh OpenRouter sign-in answers with. Cheap, tool-capable, and
/// the one every benchmark in this repo was measured on.
pub(crate) const OPENROUTER_DEFAULT_MODEL: &str = "z-ai/glm-5.3-flash";

/// Sign in with OpenRouter instead of pasting a key (OAuth PKCE).
///
/// A stranger's first five minutes used to be: find a provider, make an
/// account, find the keys page, copy a secret, paste it here. This is one
/// button: the browser opens OpenRouter's consent page, OpenRouter sends the
/// browser back to a one-shot listener on 127.0.0.1 with a code, and the code
/// is exchanged for a key that goes straight to the keychain. The key never
/// passes through the webview.
///
/// Flow per https://openrouter.ai/docs/use-cases/oauth-pkce: localhost
/// callbacks are allowed on any port, codes are single-use and expire in 10
/// minutes, exchange is `POST /api/v1/auth/keys {code, code_verifier,
/// code_challenge_method}` -> `{key}`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn openrouter_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    use base64::Engine as _;
    use sha2::Digest as _;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).map_err(|e| format!("Could not start sign-in: {e}"))?;
    let verifier = b64.encode(raw);
    let challenge = b64.encode(sha2::Sha256::digest(verifier.as_bytes()));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not start sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let callback = format!("http://localhost:{port}/callback");
    let auth_url = format!(
        "https://openrouter.ai/auth?callback_url={}&code_challenge={}&code_challenge_method=S256&key_label=Cinderpaw",
        urlencoding::encode(&callback),
        challenge
    );
    {
        use tauri_plugin_shell::ShellExt;
        // The same call browser.rs makes; the opener plugin is not a dependency.
        #[allow(deprecated)]
        let opened = app.shell().open(auth_url.as_str(), None);
        opened.map_err(|e| format!("Could not open your browser: {e}"))?;
    }

    // One request is all this listener ever serves. Anything that is not the
    // callback (a favicon probe) is answered and skipped. Ten minutes matches
    // the code's own lifetime; after that the person has walked away.
    let code = tokio::time::timeout(std::time::Duration::from_secs(600), async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
            let parsed = url::Url::parse(&format!("http://localhost{path}")).ok();
            let code = parsed
                .as_ref()
                .filter(|u| u.path() == "/callback")
                .and_then(|u| u.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.to_string()));
            let page = if code.is_some() {
                "<h2 style=\"font-family:system-ui\">Signed in. You can close this tab and go back to Cinderpaw.</h2>"
            } else {
                "<h2 style=\"font-family:system-ui\">Waiting for OpenRouter...</h2>"
            };
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                page.len()
            );
            let _ = sock.write_all(reply.as_bytes()).await;
            if let Some(c) = code {
                return Ok::<String, String>(c);
            }
        }
    })
    .await
    .map_err(|_| "Sign-in timed out. Press the button again when you're ready.".to_string())??;

    let resp = reqwest::Client::new()
        .post("https://openrouter.ai/api/v1/auth/keys")
        .json(&serde_json::json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" }))
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenRouter: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let key = body
        .get("key")
        .and_then(|k| k.as_str())
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| format!("OpenRouter did not return a key (HTTP {}). Try again.", status.as_u16()))?
        .to_string();

    // Keep a model the person already chose on this provider; only a blank
    // one gets the default.
    let existing = byok::load(&settings::load()).providers.get("openrouter").and_then(|c| c.default_model.clone());
    let model = existing.unwrap_or_else(|| OPENROUTER_DEFAULT_MODEL.to_string());
    let config = byok::ProviderConfig { enabled: true, api_key: key, base_url: None, default_model: Some(model.clone()) };
    byok::save_provider("openrouter", config).map_err(|e| e.to_string())?;
    Ok(model)
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
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
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("jev-bad-reply: {e}"))?;
    if !status.is_success() {
        let msg = body.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("");
        return Err(format!("jev-http-{}: {msg}", status.as_u16()));
    }
    Ok(serde_json::json!({
        "answers": body.get("answers").cloned().unwrap_or(serde_json::Value::Null),
        "usage": body.get("usage").cloned().unwrap_or(serde_json::Value::Null),
        "ms": started.elapsed().as_millis() as u64,
    }))
}
