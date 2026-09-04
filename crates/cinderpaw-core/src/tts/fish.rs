//! Text-to-speech via Fish Audio, for voice mode.
//!
//! `POST https://api.fish.audio/v1/tts` returns the audio with
//! `Transfer-Encoding: chunked`, so this streams: the caller gets bytes as they
//! are produced rather than after the whole utterance is synthesised. In a
//! spoken conversation that difference is the whole feature — waiting for a
//! full reply before the first sound arrives is what makes voice assistants
//! feel like walkie-talkies.
//!
//! Two defaults are deliberate:
//!
//! * **PCM, not MP3.** `useAudioPlayer.ts` already decodes through Web Audio
//!   because the HTML `<audio>` element fails on blob URLs in the Tauri
//!   WebView2 runtime. Raw PCM feeds an `AudioBufferSourceNode` with no decode
//!   step at all, which removes both a dependency and a few tens of ms per
//!   chunk. 24 kHz mono 16-bit is the sweet spot: speech has nothing above
//!   ~8 kHz that matters, and 44.1 kHz would be ~2x the bytes for no audible
//!   gain over a network.
//! * **`latency: "low"`.** Fish exposes this precisely for interactive use.
//!
//! The key is never compiled in and never read from an argument: it comes from
//! the BYOK store like every other provider credential.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tokio::sync::mpsc::Sender;

use super::{
    http, pump, SpeechRequest, TtsProvider, Voice, LIST_TIMEOUT_SECS, SAMPLE_RATE,
    SPEAK_TIMEOUT_SECS,
};

/// Where synthesis happens. Overridable for tests and for a self-hosted proxy.
pub const DEFAULT_BASE_URL: &str = "https://api.fish.audio";

/// Fish's model header. `s2.1-pro` is the paid default; `s2.1-pro-free` is the
/// free developer tier, which is what a fresh install should use until someone
/// deliberately pays for the other.
pub const DEFAULT_MODEL: &str = "s2.1-pro-free";

/// Stable id for settings and `from_id`.
pub const ID: &str = "fish";

#[derive(Debug, Clone)]
pub struct TtsOptions {
    /// Voice to speak with. `None` uses the account's default voice.
    pub reference_id: Option<String>,
    pub model: String,
    pub base_url: String,
    /// 0..=1. Fish defaults to 0.7; lower is steadier, which suits an assistant.
    pub temperature: f32,
}

impl Default for TtsOptions {
    fn default() -> Self {
        Self {
            reference_id: None,
            model: DEFAULT_MODEL.to_string(),
            base_url: DEFAULT_BASE_URL.to_string(),
            temperature: 0.6,
        }
    }
}

#[derive(Serialize)]
struct TtsRequest<'a> {
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_id: Option<&'a str>,
    format: &'static str,
    sample_rate: u32,
    latency: &'static str,
    temperature: f32,
    normalize: bool,
}

/// Synthesise `text`, sending raw PCM chunks to `audio` as they arrive.
///
/// Returns the total number of bytes sent. The channel is the back-pressure
/// mechanism: if the consumer stops reading, `send` blocks and the HTTP body is
/// left unread rather than buffered without bound — which matters when a user
/// barges in and the rest of the utterance becomes garbage we must not
/// accumulate.
pub async fn synthesize(
    api_key: &str,
    text: &str,
    opts: &TtsOptions,
    audio: Sender<Vec<u8>>,
) -> Result<usize> {
    if api_key.trim().is_empty() {
        // Not `cinderpaw providers set-key fish`: that command validates the id
        // against the LLM provider catalog, which a speech engine is correctly
        // absent from. The key is entered on the call screen and stored in the
        // same keychain.
        bail!("no Fish Audio API key configured. Add one on the call screen");
    }
    if text.trim().is_empty() {
        return Ok(0);
    }

    let body = TtsRequest {
        text,
        reference_id: opts.reference_id.as_deref(),
        format: "pcm",
        sample_rate: SAMPLE_RATE,
        latency: "low",
        temperature: opts.temperature,
        normalize: true,
    };

    super::assert_key_safe_base_url(&opts.base_url, "fish audio")?;
    let res = http(SPEAK_TIMEOUT_SECS)?
        .post(format!("{}/v1/tts", opts.base_url.trim_end_matches('/')))
        .bearer_auth(api_key)
        .header("model", &opts.model)
        .json(&body)
        .send()
        .await
        .context("fish audio: request failed")?;

    // Map the documented failures to something a user can act on. A bare
    // "401 Unauthorized" in a voice loop tells nobody what to do next.
    let status = res.status();
    if !status.is_success() {
        let detail = res.text().await.unwrap_or_default();
        let hint = match status.as_u16() {
            401 => "the Fish Audio key was rejected. Enter it again on the call screen",
            402 => "the Fish Audio account is out of credit",
            503 => "Fish Audio is overloaded; retry shortly",
            _ => "unexpected response from Fish Audio",
        };
        bail!("{hint} (HTTP {status}) {}", detail.chars().take(200).collect::<String>());
    }

    pump(res, "fish audio", audio).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_text_is_a_no_op_not_a_request() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        let n = synthesize("k", "   ", &TtsOptions::default(), tx).await.unwrap();
        assert_eq!(n, 0);
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn missing_key_fails_before_any_network_call() {
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        // base_url is deliberately unroutable: if this ever reached the network
        // the test would hang instead of failing fast, which is the signal.
        let opts = TtsOptions { base_url: "http://127.0.0.1:1".into(), ..Default::default() };
        let err = synthesize("", "hello", &opts, tx).await.unwrap_err().to_string();
        assert!(err.contains("no Fish Audio API key"), "unexpected: {err}");
    }

}

/// The trait face of the module. Holds the key so the voice loop never has to.
pub struct FishTts {
    api_key: String,
    opts: TtsOptions,
}

impl FishTts {
    pub fn new(api_key: String) -> Self {
        Self { api_key, opts: TtsOptions::default() }
    }
}

#[async_trait::async_trait]
impl TtsProvider for FishTts {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Fish Audio S2.1 Pro"
    }

    /// Hosted. Their terms state requests may be used to improve their models,
    /// so voice mode has to be able to say so before it records anyone.
    fn is_local(&self) -> bool {
        false
    }

    /// `GET /model` — the account's voice models.
    ///
    /// Parsed out of a `Value` rather than a typed struct on purpose: this is the
    /// one endpoint here whose shape is not documented in a form worth trusting,
    /// and a rename of one field should cost a missing label, not an empty list
    /// that looks like "you have no voices".
    async fn voices(&self) -> anyhow::Result<Vec<Voice>> {
        if self.api_key.trim().is_empty() {
            bail!("no Fish Audio API key configured. Add one on the call screen");
        }
        let res = http(LIST_TIMEOUT_SECS)?
            .get(format!("{}/model", self.opts.base_url.trim_end_matches('/')))
            .query(&[("page_size", "100")])
            .bearer_auth(&self.api_key)
            .send()
            .await
            .context("fish audio: voice list request failed")?;
        if !res.status().is_success() {
            bail!("fish audio: voice list returned HTTP {}", res.status());
        }

        let body: serde_json::Value = res.json().await.context("fish audio: voice list not JSON")?;
        let items = body
            .get("items")
            .or_else(|| body.get("data"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let voices = items
            .iter()
            .filter_map(|item| {
                let id = item
                    .get("_id")
                    .or_else(|| item.get("id"))
                    .and_then(|v| v.as_str())?
                    .to_string();
                let label = item
                    .get("title")
                    .or_else(|| item.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(&id)
                    .to_string();
                let locale = item
                    .get("languages")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Some(Voice { id, label, locale })
            })
            .collect::<Vec<_>>();
        tracing::info!(count = voices.len(), "fish audio: voices listed");
        Ok(voices)
    }

    async fn speak(&self, req: &SpeechRequest, audio: Sender<Vec<u8>>) -> anyhow::Result<usize> {
        let opts = TtsOptions {
            reference_id: req.voice.clone().or_else(|| self.opts.reference_id.clone()),
            ..self.opts.clone()
        };
        synthesize(&self.api_key, &req.text, &opts, audio).await
    }
}
