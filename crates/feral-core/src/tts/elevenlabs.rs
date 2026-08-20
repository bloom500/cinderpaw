//! Text-to-speech via ElevenLabs.
//!
//! Here because it fits without bending anything: `output_format=pcm_24000` is
//! signed 16-bit little-endian at 24 kHz — the contract in `super`, unchanged —
//! and only the 44.1 kHz PCM variants are gated behind a paid tier, so this
//! works on the plans people actually start on.
//!
//! The `/stream` endpoint is the one used deliberately. The non-streaming one
//! returns the whole utterance, which for a spoken conversation means waiting for
//! the last word before hearing the first.
//!
//! Two ids are needed rather than one, and neither is guessable: a *voice* id
//! (which voice) and a *model* id (which engine). Both are surfaced as normal
//! settings instead of being defaulted to whatever was popular the day this was
//! written — except the voice, which has a stable public default worth using so
//! a fresh setup speaks at all.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tokio::sync::mpsc::Sender;

use super::{
    http, pump, EngineConfig, SpeechRequest, TtsProvider, Voice, LIST_TIMEOUT_SECS,
    SPEAK_TIMEOUT_SECS,
};

/// Stable id for settings and `from_id`.
pub const ID: &str = "elevenlabs";

pub const DEFAULT_BASE_URL: &str = "https://api.elevenlabs.io";

/// "Rachel" — ElevenLabs' long-standing public sample voice. A default so a
/// first call makes sound; the picker's model field overrides it.
pub const DEFAULT_VOICE_ID: &str = "21m00Tcm4TlvDq8ikWAM";

/// Multilingual so a Romanian reply is not read with English phonetics. The
/// flash models are faster but English-first, which is the wrong trade for a
/// product whose user speaks two languages.
pub const DEFAULT_MODEL: &str = "eleven_multilingual_v2";

/// 24 kHz signed 16-bit little-endian — `super`'s contract exactly.
const OUTPUT_FORMAT: &str = "pcm_24000";

#[derive(Serialize)]
struct Body<'a> {
    text: &'a str,
    model_id: &'a str,
}

pub struct ElevenLabsTts {
    api_key: String,
    base_url: String,
    voice_id: String,
    model: String,
}

impl ElevenLabsTts {
    pub fn new(cfg: &EngineConfig) -> Self {
        // One `model` field in the settings has to carry both ids, so it takes
        // `voice_id` or `voice_id:model_id`. Splitting on ':' rather than adding
        // a second settings column keeps this engine inside the same BYOK record
        // shape every other one uses.
        let raw = cfg.model.map(str::trim).filter(|m| !m.is_empty()).unwrap_or("");
        let (voice_id, model) = match raw.split_once(':') {
            Some((v, m)) if !v.trim().is_empty() && !m.trim().is_empty() => (v.trim(), m.trim()),
            _ if !raw.is_empty() => (raw, DEFAULT_MODEL),
            _ => (DEFAULT_VOICE_ID, DEFAULT_MODEL),
        };
        Self {
            api_key: cfg.api_key.to_string(),
            base_url: cfg
                .base_url
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .unwrap_or(DEFAULT_BASE_URL)
                .trim_end_matches('/')
                .to_string(),
            voice_id: voice_id.to_string(),
            model: model.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl TtsProvider for ElevenLabsTts {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "ElevenLabs"
    }

    fn is_local(&self) -> bool {
        false
    }

    /// `GET /v1/voices` — the workspace's voices, including cloned ones.
    async fn voices(&self) -> Result<Vec<Voice>> {
        if self.api_key.trim().is_empty() {
            bail!("no ElevenLabs key configured. Add one on the call screen");
        }
        let res = http(LIST_TIMEOUT_SECS)?
            .get(format!("{}/v1/voices", self.base_url))
            .header("xi-api-key", &self.api_key)
            .send()
            .await
            .context("elevenlabs: voice list request failed")?;
        if !res.status().is_success() {
            bail!("elevenlabs: voice list returned HTTP {}", res.status());
        }

        #[derive(serde::Deserialize)]
        struct Row {
            voice_id: String,
            name: Option<String>,
            #[serde(default)]
            labels: std::collections::HashMap<String, String>,
        }
        #[derive(serde::Deserialize)]
        struct Body {
            voices: Vec<Row>,
        }
        let body: Body = res.json().await.context("elevenlabs: unexpected voice list shape")?;
        Ok(body
            .voices
            .into_iter()
            .map(|r| {
                let name = r.name.unwrap_or_else(|| r.voice_id.clone());
                // Their accent/description labels are the only hint of language.
                let accent = r.labels.get("accent").or_else(|| r.labels.get("language")).cloned();
                Voice {
                    label: match &accent {
                        Some(a) => format!("{name} · {a}"),
                        None => name,
                    },
                    locale: accent.unwrap_or_default(),
                    id: r.voice_id,
                }
            })
            .collect())
    }

    async fn speak(&self, req: &SpeechRequest, audio: Sender<Vec<u8>>) -> Result<usize> {
        if self.api_key.trim().is_empty() {
            bail!("no ElevenLabs key configured. Add one on the call screen");
        }
        if req.text.trim().is_empty() {
            return Ok(0);
        }

        let voice_id = req.voice.as_deref().unwrap_or(&self.voice_id);
        let res = http(SPEAK_TIMEOUT_SECS)?
            .post(format!("{}/v1/text-to-speech/{voice_id}/stream", self.base_url))
            .query(&[("output_format", OUTPUT_FORMAT)])
            // ElevenLabs uses its own header, not bearer auth.
            .header("xi-api-key", &self.api_key)
            .json(&Body { text: &req.text, model_id: &self.model })
            .send()
            .await
            .context("elevenlabs: request failed")?;

        let status = res.status();
        if !status.is_success() {
            let detail = res.text().await.unwrap_or_default();
            let hint = match status.as_u16() {
                401 => "the ElevenLabs key was rejected",
                // Their most common 4xx is an unknown voice id, which reads as a
                // generic validation error unless you know to look for it.
                400 | 422 => "ElevenLabs rejected the request, usually an unknown voice or model id",
                429 => "ElevenLabs rate limit or monthly character quota reached",
                _ => "unexpected response from ElevenLabs",
            };
            bail!(
                "{hint} (HTTP {status}, voice {voice_id:?}, model {:?}) {}",
                self.model,
                detail.chars().take(200).collect::<String>()
            );
        }

        pump(res, "elevenlabs", audio).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_settings_field_carries_both_ids() {
        let both = ElevenLabsTts::new(&EngineConfig {
            api_key: "k",
            base_url: None,
            model: Some("myVoice:eleven_flash_v2_5"),
        });
        assert_eq!(both.voice_id, "myVoice");
        assert_eq!(both.model, "eleven_flash_v2_5");

        // Voice alone is the common case; the model keeps its default.
        let voice_only = ElevenLabsTts::new(&EngineConfig { api_key: "k", base_url: None, model: Some("myVoice") });
        assert_eq!(voice_only.voice_id, "myVoice");
        assert_eq!(voice_only.model, DEFAULT_MODEL);

        // Nothing configured still has to make sound.
        let empty = ElevenLabsTts::new(&EngineConfig { api_key: "k", ..Default::default() });
        assert_eq!(empty.voice_id, DEFAULT_VOICE_ID);
        assert_eq!(empty.model, DEFAULT_MODEL);
    }

    #[test]
    fn a_half_written_pair_does_not_produce_an_empty_id() {
        // "voice:" or ":model" must not become a request with a blank id in the
        // URL — that is a 404 whose message says nothing about the typo.
        let trailing = ElevenLabsTts::new(&EngineConfig { api_key: "k", base_url: None, model: Some("myVoice:") });
        assert_eq!(trailing.voice_id, "myVoice:", "kept whole rather than split into a blank model");
        assert_eq!(trailing.model, DEFAULT_MODEL);
    }

    #[tokio::test]
    async fn missing_key_fails_before_any_network_call() {
        let e = ElevenLabsTts::new(&EngineConfig {
            api_key: "",
            base_url: Some("http://127.0.0.1:1"),
            model: None,
        });
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        let req = SpeechRequest { text: "hello".into(), voice: None };
        let err = e.speak(&req, tx).await.unwrap_err().to_string();
        assert!(err.contains("no ElevenLabs key"), "unexpected: {err}");
    }
}
