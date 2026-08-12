//! Text-to-speech via any OpenAI-compatible `/v1/audio/speech` endpoint.
//!
//! One file, several vendors. OpenAI, Groq, and the self-hosted gateways all
//! speak this shape, and they differ only in base URL and model name — both of
//! which the BYOK store already carries per provider. Writing a file per vendor
//! would be four copies of the same twenty lines, each with its own bug.
//!
//! `response_format: "pcm"` is documented as headerless 24 kHz signed 16-bit
//! little-endian — the same contract as `super` and as Azure's raw format, so
//! nothing here converts anything either.
//!
//! The model name is deliberately NOT defaulted per vendor. A wrong-but-plausible
//! default ("gpt-4o-mini-tts" against Groq) fails with a vendor error message
//! that says nothing about where the name came from; an empty one fails saying
//! exactly what is missing.

use anyhow::{bail, Context, Result};
use futures::StreamExt;
use serde::Serialize;
use tokio::sync::mpsc::Sender;

use super::{EngineConfig, SpeechRequest, TtsProvider, Voice};

/// Stable id for settings and `from_id`.
pub const ID: &str = "openai-compat";

/// Where OpenAI itself lives, for the common case.
pub const DEFAULT_BASE_URL: &str = "https://api.openai.com";

/// OpenAI's small speech model. Only correct for OpenAI — anything else must set
/// its own (Groq: `playai-tts`, LocalAI: whatever is loaded).
pub const DEFAULT_MODEL: &str = "gpt-4o-mini-tts";

/// OpenAI's voices are named, not ids; every compatible vendor accepts *some*
/// name here, so it has to be overridable but cannot be empty.
pub const DEFAULT_VOICE: &str = "alloy";

#[derive(Serialize)]
struct SpeechBody<'a> {
    model: &'a str,
    input: &'a str,
    voice: &'a str,
    response_format: &'static str,
}

pub struct OpenAiCompatTts {
    api_key: String,
    base_url: String,
    model: String,
}

impl OpenAiCompatTts {
    pub fn new(cfg: &EngineConfig) -> Self {
        Self {
            api_key: cfg.api_key.to_string(),
            base_url: cfg
                .base_url
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .unwrap_or(DEFAULT_BASE_URL)
                .trim_end_matches('/')
                .to_string(),
            model: cfg
                .model
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .unwrap_or(DEFAULT_MODEL)
                .to_string(),
        }
    }
}

#[async_trait::async_trait]
impl TtsProvider for OpenAiCompatTts {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "OpenAI-compatible"
    }

    /// Hosted by definition — this engine exists to talk to someone else's
    /// endpoint. A local gateway on `127.0.0.1` would technically keep the audio
    /// on the machine, but claiming `true` here would mean the picker's promise
    /// depends on a URL the user can change afterwards, so it stays honest and
    /// pessimistic.
    fn is_local(&self) -> bool {
        false
    }

    /// OpenAI's voices are a fixed, named set with no list endpoint, so this is
    /// the one place a hardcoded list is the honest answer. Locale is empty for
    /// all of them: they are multilingual and follow the text, which is exactly
    /// what a bilingual conversation needs.
    ///
    /// Only correct for OpenAI itself. Another compatible endpoint accepts its own
    /// names, which is why the UI keeps a free-text field alongside the list.
    async fn voices(&self) -> Result<Vec<Voice>> {
        Ok([
            "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer",
            "verse",
        ]
        .into_iter()
        .map(|name| Voice { id: name.to_string(), label: name.to_string(), locale: String::new() })
        .collect())
    }

    async fn speak(&self, req: &SpeechRequest, audio: Sender<Vec<u8>>) -> Result<usize> {
        if self.api_key.trim().is_empty() {
            bail!("no API key configured for the OpenAI-compatible voice — add one on the call screen");
        }
        if req.text.trim().is_empty() {
            return Ok(0);
        }

        let body = SpeechBody {
            model: &self.model,
            input: &req.text,
            voice: req.voice.as_deref().unwrap_or(DEFAULT_VOICE),
            response_format: "pcm",
        };

        let client = reqwest::Client::builder()
            .user_agent("feral/0.1")
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .context("build reqwest client")?;

        let res = client
            .post(format!("{}/v1/audio/speech", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .context("speech request failed")?;

        let status = res.status();
        if !status.is_success() {
            let detail = res.text().await.unwrap_or_default();
            let hint = match status.as_u16() {
                401 => "the key was rejected — check it belongs to the base URL you set",
                404 => "no /v1/audio/speech at that base URL — check the endpoint",
                // The most likely misconfiguration by far: the right key, the
                // wrong vendor's model name.
                400 | 422 => "the request was rejected — usually the model name does not exist at this endpoint",
                429 => "rate limited or out of quota",
                _ => "unexpected response from the speech endpoint",
            };
            bail!(
                "{hint} (HTTP {status}, model {:?}) {}",
                self.model,
                detail.chars().take(200).collect::<String>()
            );
        }

        let mut stream = res.bytes_stream();
        let mut total = 0usize;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("speech stream interrupted")?;
            if chunk.is_empty() {
                continue;
            }
            total += chunk.len();
            // A closed receiver is a barge-in, not an error: stop pulling.
            if audio.send(chunk.to_vec()).await.is_err() {
                break;
            }
        }
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_config_falls_back_to_openai_rather_than_an_empty_url() {
        let e = OpenAiCompatTts::new(&EngineConfig { api_key: "k", base_url: Some("  "), model: Some("") });
        assert_eq!(e.base_url, DEFAULT_BASE_URL);
        assert_eq!(e.model, DEFAULT_MODEL);
    }

    #[test]
    fn a_trailing_slash_does_not_become_a_double_slash() {
        // `https://api.groq.com/openai/` + `/v1/audio/speech` is a 404 that looks
        // like "the vendor does not support TTS".
        let e = OpenAiCompatTts::new(&EngineConfig {
            api_key: "k",
            base_url: Some("https://api.groq.com/openai/"),
            model: Some("playai-tts"),
        });
        assert_eq!(e.base_url, "https://api.groq.com/openai");
    }

    #[tokio::test]
    async fn missing_key_fails_before_any_network_call() {
        let e = OpenAiCompatTts::new(&EngineConfig {
            api_key: "",
            base_url: Some("http://127.0.0.1:1"),
            model: None,
        });
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        let req = SpeechRequest { text: "hello".into(), voice: None };
        let err = e.speak(&req, tx).await.unwrap_err().to_string();
        assert!(err.contains("no API key configured"), "unexpected: {err}");
    }
}
