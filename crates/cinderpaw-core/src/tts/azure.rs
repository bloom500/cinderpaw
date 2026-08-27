//! Text-to-speech via Azure Speech.
//!
//! Here for one reason that outweighs its being hosted: the free tier is a
//! **standing monthly allowance** — 500,000 neural characters that reset — not a
//! promotional window with a date on it. Fish's free tier is announced through
//! 31 Aug 2026 and has been extended three times, which is a loan, not a
//! foundation. It also has Romanian (`ro-RO-AlinaNeural`), which the free local
//! engines mostly do not.
//!
//! `raw-24khz-16bit-mono-pcm` is on Azure's documented *streaming* format list
//! and is byte-for-byte the contract in `super`: 24 kHz, mono, signed 16-bit
//! little-endian, no header. Nothing is converted anywhere in this file.
//!
//! The region is not optional and not guessable — each Speech resource lives in
//! one, and a key from one region is rejected by another — so it comes from the
//! provider's stored base URL and its absence is an error with instructions.

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc::Sender;

use super::{
    http, pump, EngineConfig, SpeechRequest, TtsProvider, Voice, LIST_TIMEOUT_SECS,
    SPEAK_TIMEOUT_SECS,
};

/// Stable id for settings and `from_id`.
pub const ID: &str = "azure";

/// Azure asks for the format by name; this is the one that needs no decoding.
const OUTPUT_FORMAT: &str = "raw-24khz-16bit-mono-pcm";

/// A voice that exists in every region, so a fresh setup speaks without the
/// user first having to learn Azure's voice catalog. Romanian is one field away
/// (`ro-RO-AlinaNeural`) and `xml:lang` follows the voice automatically.
pub const DEFAULT_VOICE: &str = "en-US-AvaNeural";

pub struct AzureTts {
    api_key: String,
    /// e.g. `https://westeurope.tts.speech.microsoft.com`
    base_url: String,
    voice: Option<String>,
}

impl AzureTts {
    pub fn new(cfg: &EngineConfig) -> Result<Self> {
        let Some(base_url) = cfg.base_url.map(str::trim).filter(|u| !u.is_empty()) else {
            bail!(
                "Azure Speech needs its region. Set the base URL to \
                 https://<region>.tts.speech.microsoft.com (the region of your Speech resource)"
            );
        };
        Ok(Self {
            api_key: cfg.api_key.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            // Azure calls the voice a model in some of its tooling; accept either
            // rather than making the user guess which field this UI means.
            voice: cfg.model.map(str::to_string),
        })
    }
}

/// The locale Azure should read the text in, taken from the voice name.
///
/// `ro-RO-AlinaNeural` → `ro-RO`. Sending `en-US` while asking for a Romanian
/// voice makes it read Romanian with English letter rules, which is worse than
/// an accent — it is the wrong word.
fn locale_of(voice: &str) -> &str {
    let mut parts = voice.char_indices().filter(|(_, c)| *c == '-').map(|(i, _)| i);
    match (parts.next(), parts.next()) {
        (Some(_), Some(second)) => &voice[..second],
        // A single-segment or unusual voice name: let Azure apply its own default
        // rather than inventing a locale for it.
        _ => "en-US",
    }
}

/// Escape text for an XML text node.
///
/// Not politeness — correctness. SSML is XML, so a reply containing `a < b`
/// makes the request a 400, and one containing a `</voice>` would end the
/// element early. The model writes this text and the user cannot see it before
/// it is sent, which is exactly the shape of input that must never be
/// interpolated raw.
fn escape_ssml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

#[async_trait::async_trait]
impl TtsProvider for AzureTts {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Azure Speech"
    }

    /// Hosted. The free tier is generous and standing, but the audio still
    /// leaves the machine, and the picker has to say so before recording.
    fn is_local(&self) -> bool {
        false
    }

    /// `GET /cognitiveservices/voices/list` — the documented catalogue for the
    /// region the key belongs to. Region matters: the list differs between them,
    /// and asking the wrong one returns voices that then 400 on synthesis.
    async fn voices(&self) -> Result<Vec<Voice>> {
        if self.api_key.trim().is_empty() {
            bail!("no Azure Speech key configured. Add one on the call screen");
        }
        let res = http(LIST_TIMEOUT_SECS)?
            .get(format!("{}/cognitiveservices/voices/list", self.base_url))
            .header("Ocp-Apim-Subscription-Key", &self.api_key)
            .send()
            .await
            .context("azure speech: voice list request failed")?;
        if !res.status().is_success() {
            bail!("azure speech: voice list returned HTTP {}", res.status());
        }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "PascalCase")]
        struct Row {
            short_name: String,
            local_name: Option<String>,
            display_name: Option<String>,
            locale: String,
            locale_name: Option<String>,
        }
        let rows: Vec<Row> = res.json().await.context("azure speech: unexpected voice list shape")?;
        Ok(rows
            .into_iter()
            .map(|r| {
                // Local name first: a Romanian voice reads better as "Alina" with
                // its own locale name than as the ShortName nobody says out loud.
                let name = r.local_name.or(r.display_name).unwrap_or_else(|| r.short_name.clone());
                let where_from = r.locale_name.unwrap_or_else(|| r.locale.clone());
                Voice { id: r.short_name, label: format!("{name} · {where_from}"), locale: r.locale }
            })
            .collect())
    }

    async fn speak(&self, req: &SpeechRequest, audio: Sender<Vec<u8>>) -> Result<usize> {
        if self.api_key.trim().is_empty() {
            bail!("no Azure Speech key configured. Add one on the call screen");
        }
        if req.text.trim().is_empty() {
            return Ok(0);
        }

        let voice = req
            .voice
            .as_deref()
            .or(self.voice.as_deref())
            .unwrap_or(DEFAULT_VOICE);
        let ssml = format!(
            "<speak version='1.0' xml:lang='{lang}'><voice name='{voice}'>{text}</voice></speak>",
            lang = locale_of(voice),
            voice = escape_ssml(voice),
            text = escape_ssml(&req.text),
        );

        let res = http(SPEAK_TIMEOUT_SECS)?
            .post(format!("{}/cognitiveservices/v1", self.base_url))
            .header("Ocp-Apim-Subscription-Key", &self.api_key)
            .header("Content-Type", "application/ssml+xml")
            .header("X-Microsoft-OutputFormat", OUTPUT_FORMAT)
            // Azure documents User-Agent as required and answers 400 without it.
            .header("User-Agent", "cinderpaw/0.1")
            .body(ssml)
            .send()
            .await
            .context("azure speech: request failed")?;

        let status = res.status();
        if !status.is_success() {
            let detail = res.text().await.unwrap_or_default();
            let hint = match status.as_u16() {
                401 => "the Azure Speech key was rejected. Check the key AND that the region matches the resource",
                429 => "the Azure Speech free allowance for this month is used up, or you are over the rate limit",
                400 => "Azure rejected the request, usually an unknown voice name for this region",
                503 => "Azure Speech is unavailable; retry shortly",
                _ => "unexpected response from Azure Speech",
            };
            bail!("{hint} (HTTP {status}) {}", detail.chars().take(200).collect::<String>());
        }

        pump(res, "azure speech", audio).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_that_would_break_the_xml_is_escaped() {
        // A model that writes "if a < b && c" must not produce a 400, and a model
        // that writes a closing tag must not be able to end the element.
        let out = escape_ssml("if a < b && c > d </voice>");
        assert!(!out.contains('<'), "{out}");
        assert!(!out.contains('>'), "{out}");
        assert_eq!(out, "if a &lt; b &amp;&amp; c &gt; d &lt;/voice&gt;");
    }

    #[test]
    fn the_locale_follows_the_voice() {
        assert_eq!(locale_of("ro-RO-AlinaNeural"), "ro-RO");
        assert_eq!(locale_of("en-US-AvaNeural"), "en-US");
        assert_eq!(locale_of("weird"), "en-US");
    }

    #[test]
    fn a_missing_region_is_an_error_with_instructions_not_a_guess() {
        // `unwrap_err` would demand `Debug` on `AzureTts`, and deriving it would
        // put the API key in every debug print. Match instead.
        let err = match AzureTts::new(&EngineConfig { api_key: "k", ..Default::default() }) {
            Ok(_) => panic!("a missing region must not resolve to a working engine"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("region"), "{err}");
        assert!(err.contains("tts.speech.microsoft.com"), "the error must show the shape: {err}");
    }

    #[tokio::test]
    async fn missing_key_fails_before_any_network_call() {
        let engine = match AzureTts::new(&EngineConfig {
            api_key: "",
            // Unroutable on purpose: reaching the network would hang instead of
            // failing, and the hang is the signal that the guard was skipped.
            base_url: Some("http://127.0.0.1:1"),
            model: None,
        }) {
            Ok(e) => e,
            Err(e) => panic!("{e}"),
        };
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        let req = SpeechRequest { text: "hello".into(), voice: None };
        let err = engine.speak(&req, tx).await.unwrap_err().to_string();
        assert!(err.contains("no Azure Speech key"), "unexpected: {err}");
    }
}
