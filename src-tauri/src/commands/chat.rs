//! What is left of the chat-mode commands now that Cinderpaw only talks
//! through the agent: the stop guard voice synthesis shares, and the one-shot
//! cloud completion that names conversations.

use crate::*;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Releases a session's stop flag when its generation returns — on every exit
/// path (clean finish, error, user stop), which is why this is a guard and not
/// a call at the end of the happy path.
/// `pub(crate)` because `speak_text` needs the same guarantee: a TTS stream has
/// the same set of exit paths, and a leaked flag there means the next utterance
/// starts already stopped.
pub(crate) struct StopSlot {
    pub(crate) registry: Arc<StopRegistry>,
    pub(crate) session_id: String,
    pub(crate) flag: Arc<AtomicBool>,
}

impl Drop for StopSlot {
    fn drop(&mut self) {
        self.registry.end(&self.session_id, &self.flag);
    }
}

/// Append a path segment to a base URL that may already contain a query string.
/// e.g. url_join("https://api.minimax.chat/v1?GroupId=123", "chat/completions")
///      → "https://api.minimax.chat/v1/chat/completions?GroupId=123"
fn url_join(base: &str, path: &str) -> String {
    match base.find('?') {
        Some(q) => {
            let (base_path, query) = base.split_at(q);
            format!("{}/{}{}", base_path.trim_end_matches('/'), path.trim_start_matches('/'), query)
        }
        None => format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/')),
    }
}

/// One-shot, non-streaming completion from a BYOK cloud provider. Used to
/// name a conversation after its first answer (`lib/chatTitle.ts`).
#[tauri::command]
#[specta::specta]
pub(crate) async fn chat_cloud_complete(
    provider_id: String,
    model: String,
    messages: Vec<Message>,
    params: InferParams,
) -> Result<String, String> {
    let byok = byok::load(&settings::load());
    let cfg = byok.get_provider(&provider_id).cloned().unwrap_or_default();
    if !cfg.enabled {
        return Err(format!("Provider '{}' is not enabled", provider_id));
    }
    if cfg.api_key.is_empty() {
        return Err(format!("No API key configured for provider '{}'", provider_id));
    }

    let provider = byok::Provider::from_id(&provider_id);
    let base_url = cfg.base_url.unwrap_or_else(|| provider.default_base_url().to_string());
    let endpoint = url_join(&base_url, provider.chat_endpoint_path());
    let auth_value = format!("{}{}", provider.api_key_prefix(), cfg.api_key);

    let client = reqwest::Client::builder()
        .user_agent("cinderpaw/0.1")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    // Anthropic's Messages API expects `system` as a top-level field, not
    // inside the messages array. Split it out so OpenAI-shaped callers keep
    // working unchanged while Anthropic gets the right shape.
    let (system, ctx): (Option<String>, Vec<serde_json::Value>) = if !provider.is_openai_compatible() {
        let mut ctx: Vec<serde_json::Value> = Vec::new();
        let mut sys: Option<String> = None;
        for m in &messages {
            if m.role == "system" && sys.is_none() {
                sys = Some(m.content.clone());
            } else {
                ctx.push(serde_json::json!({ "role": m.role, "content": m.content }));
            }
        }
        (sys, ctx)
    } else {
        let mut ctx: Vec<serde_json::Value> = Vec::new();
        if let Some(sys) = &params.system_prompt {
            if !sys.is_empty() {
                ctx.push(serde_json::json!({ "role": "system", "content": sys }));
            }
        }
        for m in &messages {
            ctx.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
        (None, ctx)
    };

    let mut body = serde_json::json!({
        "model": model,
        "messages": ctx,
        "stream": false,
        "temperature": params.temperature,
        "max_tokens": params.max_tokens,
    });
    if let Some(sys) = system {
        body["system"] = serde_json::Value::String(sys);
    }

    let mut req = client
        .post(&endpoint)
        .header(provider.api_key_header(), &auth_value)
        .header("Content-Type", "application/json")
        .json(&body);
    for (name, value) in provider.extra_headers() {
        req = req.header(name, value);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body_text));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    // Anthropic responses live under `content[0].text` (not `choices[0].message.content`).
    if !provider.is_openai_compatible() {
        let text = v["content"]
            .as_array()
            .and_then(|arr| arr.iter().find(|c| c.get("type").and_then(|t| t.as_str()) == Some("text")))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        return Ok(text.to_string());
    }
    Ok(v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string())
}
