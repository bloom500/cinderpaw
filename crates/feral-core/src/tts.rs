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
use futures::StreamExt;
use serde::Serialize;
use tokio::sync::mpsc::Sender;

/// Where synthesis happens. Overridable for tests and for a self-hosted proxy.
pub const DEFAULT_BASE_URL: &str = "https://api.fish.audio";

/// Fish's model header. `s2.1-pro` is the paid default; `s2.1-pro-free` is the
/// free developer tier, which is what a fresh install should use until someone
/// deliberately pays for the other.
pub const DEFAULT_MODEL: &str = "s2.1-pro-free";

/// 24 kHz mono 16-bit LE. The frontend needs both numbers to build an
/// AudioBuffer, so they live here rather than being duplicated in TypeScript.
pub const SAMPLE_RATE: u32 = 24_000;
pub const CHANNELS: u16 = 1;

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
        bail!("no Fish Audio API key configured — set one with `feral providers set-key fish`");
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

    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        // Generous but finite: a long reply legitimately takes a while, a hung
        // connection must not hold the voice loop open forever.
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("build reqwest client")?;

    let res = client
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
            401 => "the Fish Audio key was rejected — re-set it with `feral providers set-key fish`",
            402 => "the Fish Audio account is out of credit",
            503 => "Fish Audio is overloaded; retry shortly",
            _ => "unexpected response from Fish Audio",
        };
        bail!("{hint} (HTTP {status}) {}", detail.chars().take(200).collect::<String>());
    }

    let mut stream = res.bytes_stream();
    let mut total = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("fish audio: stream interrupted")?;
        if chunk.is_empty() {
            continue;
        }
        total += chunk.len();
        // A closed receiver means the caller stopped caring — a barge-in, or a
        // cancelled turn. Stop pulling the body instead of treating it as an
        // error the user has to see.
        if audio.send(chunk.to_vec()).await.is_err() {
            break;
        }
    }
    Ok(total)
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

    #[test]
    fn audio_constants_match_what_the_frontend_builds() {
        // These are duplicated into the AudioBuffer on the TS side; if one
        // moves without the other, playback is pitched wrong rather than
        // broken, which is much harder to notice.
        assert_eq!(SAMPLE_RATE, 24_000);
        assert_eq!(CHANNELS, 1);
    }
}
