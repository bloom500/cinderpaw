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
use serde::Serialize;
use tokio::sync::mpsc::Sender;

use super::{http, pump, EngineConfig, SpeechRequest, TtsProvider, Voice, SAMPLE_RATE, SPEAK_TIMEOUT_SECS};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    voice: Option<&'a str>,
    response_format: &'static str,
}

/// OpenRouter's audio API is this same shape at a fixed base, with Fish Audio's
/// S2.1 Pro as the sensible default model. Its `voice` is a Fish reference id
/// (a voice cloned or picked on fish.audio), not an OpenAI name, so this flavour
/// carries no default voice: an omitted `voice` lets the vendor pick, and a
/// wrong-but-plausible "alloy" would be a 400 that reads like a dead engine.
pub const OPENROUTER_ID: &str = "openrouter-tts";
pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api";
/// With the `:free` suffix: without it OpenRouter answers 404 "No endpoints
/// found" (measured 14 Sep 2026), which reads as a dead engine.
pub const OPENROUTER_MODEL: &str = "fish-audio/s2.1-pro-free:free";

pub struct OpenAiCompatTts {
    api_key: String,
    base_url: String,
    model: String,
    id: &'static str,
    label: &'static str,
    /// `None` = omit the field and let the vendor choose.
    default_voice: Option<&'static str>,
    /// The fixed, named voices to list; empty when the vendor's voices are ids
    /// the person types (OpenRouter's Fish reference ids).
    voices: &'static [&'static str],
}

impl OpenAiCompatTts {
    pub fn new(cfg: &EngineConfig) -> Self {
        Self::flavour(cfg, ID, "OpenAI-compatible", DEFAULT_BASE_URL, DEFAULT_MODEL, Some(DEFAULT_VOICE), OPENAI_VOICES)
    }

    /// OpenRouter: the same wire, a fixed base URL, Fish's model by default.
    pub fn openrouter(cfg: &EngineConfig) -> Self {
        Self::flavour(cfg, OPENROUTER_ID, "OpenRouter", OPENROUTER_BASE_URL, OPENROUTER_MODEL, None, &[])
    }

    fn flavour(
        cfg: &EngineConfig,
        id: &'static str,
        label: &'static str,
        default_base: &str,
        default_model: &str,
        default_voice: Option<&'static str>,
        voices: &'static [&'static str],
    ) -> Self {
        Self {
            api_key: cfg.api_key.to_string(),
            base_url: cfg
                .base_url
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .unwrap_or(default_base)
                .trim_end_matches('/')
                .to_string(),
            model: cfg
                .model
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .unwrap_or(default_model)
                .to_string(),
            id,
            label,
            default_voice,
            voices,
        }
    }
}

const OPENAI_VOICES: &[&str] = &[
    "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
];

#[async_trait::async_trait]
impl TtsProvider for OpenAiCompatTts {
    fn id(&self) -> &'static str {
        self.id
    }

    fn label(&self) -> &'static str {
        self.label
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
        Ok(self
            .voices
            .iter()
            .map(|name| Voice { id: name.to_string(), label: name.to_string(), locale: String::new() })
            .collect())
    }

    async fn speak(&self, req: &SpeechRequest, audio: Sender<Vec<u8>>) -> Result<usize> {
        if self.api_key.trim().is_empty() {
            bail!("no API key configured for the {} voice. Add one on the call screen", self.label);
        }
        if req.text.trim().is_empty() {
            return Ok(0);
        }

        let body = SpeechBody {
            model: &self.model,
            input: &req.text,
            voice: req.voice.as_deref().map(str::trim).filter(|v| !v.is_empty()).or(self.default_voice),
            response_format: "pcm",
        };

        super::assert_key_safe_base_url(&self.base_url, "openai-compatible tts")?;
        let res = http(SPEAK_TIMEOUT_SECS)?
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
                401 => "the key was rejected. Check it belongs to the base URL you set",
                404 => "no /v1/audio/speech at that base URL. Check the endpoint",
                // The most likely misconfiguration by far: the right key, the
                // wrong vendor's model name.
                400 | 422 => "the request was rejected, usually the model name does not exist at this endpoint",
                429 => "rate limited or out of quota",
                _ => "unexpected response from the speech endpoint",
            };
            bail!(
                "{hint} (HTTP {status}, model {:?}) {}",
                self.model,
                detail.chars().take(200).collect::<String>()
            );
        }

        // The wire says 24 kHz and most vendors comply, but not all: Fish Audio
        // through OpenRouter answers `audio/pcm;rate=44100` and ignores any
        // sample-rate field (measured 14 Sep 2026). Forwarding that as 24 kHz
        // plays the voice fast and high while looking like a working feature,
        // the exact Piper bug from `sample_rate()`'s doc. So the rate is read
        // from the response, and anything else is resampled to the contract.
        let rate = rate_from_content_type(
            res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
        )
        .unwrap_or(SAMPLE_RATE);
        if rate == SAMPLE_RATE {
            return pump(res, "speech", audio).await;
        }
        tracing::info!(from = rate, to = SAMPLE_RATE, model = %self.model, "tts: resampling vendor pcm");
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
        let pumped = tokio::spawn(pump(res, "speech", tx));
        let mut rs = Resampler::new(rate, SAMPLE_RATE);
        let mut total = 0usize;
        while let Some(chunk) = rx.recv().await {
            let out = rs.push(&chunk);
            if out.is_empty() {
                continue;
            }
            total += out.len();
            if audio.send(out).await.is_err() {
                break;
            }
        }
        pumped.await.context("resample task")??;
        Ok(total)
    }
}

/// `rate=` out of `audio/pcm;rate=44100;channels=1`, when the vendor says.
fn rate_from_content_type(ct: Option<&str>) -> Option<u32> {
    ct?.split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("rate="))
        .and_then(|r| r.parse().ok())
}

/// Linear resampler for signed 16-bit mono PCM, streaming: chunks may split a
/// sample in half and the interpolation position carries across them.
///
/// ponytail: linear, no anti-alias filter. Going 44.1k -> 24k on speech that
/// is the vendor's own low-pass output, the aliasing is inaudible next to the
/// alternative (a chipmunk). Swap for a windowed-sinc the day a vendor sends
/// music.
struct Resampler {
    step: f64,
    /// Fractional read position within `buf`.
    pos: f64,
    /// Unconsumed input samples, plus one carried for interpolation.
    buf: Vec<i16>,
    /// A dangling byte from a chunk that ended mid-sample.
    half: Option<u8>,
}

impl Resampler {
    fn new(from: u32, to: u32) -> Self {
        Self { step: from as f64 / to as f64, pos: 0.0, buf: Vec::new(), half: None }
    }

    fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut bytes = bytes;
        if let Some(h) = self.half.take() {
            if let Some((&lo, rest)) = bytes.split_first() {
                self.buf.push(i16::from_le_bytes([h, lo]));
                bytes = rest;
            } else {
                self.half = Some(h);
                return Vec::new();
            }
        }
        let mut it = bytes.chunks_exact(2);
        self.buf.extend(it.by_ref().map(|b| i16::from_le_bytes([b[0], b[1]])));
        if let [b] = it.remainder() {
            self.half = Some(*b);
        }
        let mut out = Vec::with_capacity(self.buf.len() * 2);
        while (self.pos.floor() as usize) + 1 < self.buf.len() {
            let i = self.pos.floor() as usize;
            let frac = self.pos - i as f64;
            let a = self.buf[i] as f64;
            let b = self.buf[i + 1] as f64;
            let v = (a + (b - a) * frac).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            out.extend_from_slice(&v.to_le_bytes());
            self.pos += self.step;
        }
        // Drop what every future position is past, keeping the sample before
        // the position for the interpolation.
        let consumed = self.pos.floor() as usize;
        if consumed > 0 {
            self.buf.drain(..consumed);
            self.pos -= consumed as f64;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live, against OpenRouter with the free Fish model. Costs nothing;
    /// ignored so CI never needs a key:
    /// `OPENROUTER_API_KEY=... cargo test -p cinderpaw-core openrouter_live -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn openrouter_live_speaks_fish_at_the_contract_rate() {
        let key = std::env::var("OPENROUTER_API_KEY").expect("OPENROUTER_API_KEY");
        let e = OpenAiCompatTts::openrouter(&EngineConfig { api_key: &key, base_url: None, model: None });
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let req = SpeechRequest { text: "Salut, sunt Cinderpaw.".into(), voice: None };
        // Drained concurrently: the channel holds eight chunks, and a speak()
        // awaited before anyone reads deadlocks on the ninth.
        let synth = tokio::spawn(async move { e.speak(&req, tx).await });
        let mut got = 0;
        while let Some(c) = rx.recv().await {
            got += c.len();
        }
        let n = synth.await.unwrap().unwrap();
        assert_eq!(n, got);
        // ~1.5 s of speech at 24 kHz is ~72 kB; the raw 44.1 kHz reply was
        // ~140 kB, so anything near that means the resampler did not run.
        let secs = super::super::duration_secs(n);
        assert!((0.8..3.0).contains(&secs), "{n} bytes = {secs:.2}s at 24 kHz");
    }

    #[test]
    fn the_rate_is_read_from_the_vendor_or_assumed_to_be_the_contract() {
        assert_eq!(rate_from_content_type(Some("audio/pcm;rate=44100;channels=1")), Some(44100));
        assert_eq!(rate_from_content_type(Some("audio/pcm")), None);
        assert_eq!(rate_from_content_type(None), None);
    }

    #[test]
    fn resampling_keeps_duration_and_survives_a_split_sample() {
        // One second of a ramp at 44.1 kHz, fed in odd-sized chunks so a
        // sample is cut in half at every boundary.
        let src: Vec<u8> = (0..44_100u32).flat_map(|i| ((i % 2000) as i16 * 10).to_le_bytes()).collect();
        let mut rs = Resampler::new(44_100, 24_000);
        let mut out = Vec::new();
        for chunk in src.chunks(1001) {
            out.extend(rs.push(chunk));
        }
        let samples = out.len() / 2;
        // 24 000 expected, minus the one trailing sample interpolation cannot reach.
        assert!((23_990..=24_000).contains(&samples), "got {samples} samples");
        assert_eq!(out.len() % 2, 0, "whole samples only");
    }

    #[test]
    fn openrouter_is_the_same_wire_at_a_fixed_base_with_fish_by_default() {
        let e = OpenAiCompatTts::openrouter(&EngineConfig { api_key: "k", base_url: None, model: None });
        assert_eq!(e.base_url, OPENROUTER_BASE_URL);
        assert_eq!(e.model, OPENROUTER_MODEL);
        assert_eq!(e.id(), OPENROUTER_ID);
        // No named default: a Fish reference id is the vendor's, not ours.
        assert_eq!(e.default_voice, None);
        let body = SpeechBody { model: &e.model, input: "hi", voice: None, response_format: "pcm" };
        assert!(!serde_json::to_string(&body).unwrap().contains("voice"));
    }

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
