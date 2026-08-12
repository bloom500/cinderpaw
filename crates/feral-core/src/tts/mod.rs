//! Text-to-speech, provider-agnostic.
//!
//! Voice mode must not be welded to one vendor. Fish Audio's free tier is a
//! single source, time-limited (announced through 31 Aug 2026 and extended
//! three times already), carries no SLA, and its terms say requests may be used
//! to improve their models — which sits badly with a product whose pitch is
//! "raised on your machine". None of that makes it a bad default *today*; all
//! of it makes hard-coding it a bad idea.
//!
//! So synthesis goes through a trait with one method. Swapping vendors, or
//! adding a local engine that never leaves the machine, becomes a new file and
//! one line in `from_id` rather than a refactor of the voice loop.
//!
//! Every provider streams. That is not a stylistic choice: measured against the
//! live Fish API, synthesis runs ~3x faster than playback (61 chunks, 0.91s of
//! wall clock for 2.64s of audio), so a streaming consumer starts speaking
//! almost immediately and never starves. A provider that can only return a
//! whole buffer should send it as one chunk rather than change this shape.

pub mod azure;
pub mod elevenlabs;
pub mod fish;
pub mod openai_compat;
#[cfg(feature = "piper")]
pub mod piper;

/// Piper's id, known to the catalog whether or not the engine is compiled in —
/// the row is shown either way, and `from_id` is what refuses it.
pub const PIPER_ID: &str = "piper";
/// Same for Kokoro, which has no implementation yet at all.
pub const KOKORO_ID: &str = "kokoro";

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::Sender;

/// PCM the whole pipeline agrees on: 24 kHz, mono, signed 16-bit little-endian.
///
/// Chosen once, here, because three places depend on it — the provider asks the
/// vendor for it, the Tauri bridge forwards it untouched, and the frontend
/// builds an `AudioBuffer` from it. Speech carries nothing above ~8 kHz that
/// matters, so 24 kHz is transparent for voice while 44.1 would be double the
/// bytes for no audible gain. Raw PCM also skips decoding entirely, which is
/// what `useAudioPlayer.ts` already has to do by hand because the HTML `<audio>`
/// element fails on blob URLs under WebView2.
pub const SAMPLE_RATE: u32 = 24_000;
pub const CHANNELS: u16 = 1;
pub const BYTES_PER_SAMPLE: usize = 2;

/// Bytes of PCM per second, for turning a byte count into a duration.
pub const BYTES_PER_SECOND: usize = SAMPLE_RATE as usize * CHANNELS as usize * BYTES_PER_SAMPLE;

/// One selectable voice.
///
/// Listed from the vendor rather than hardcoded, because a voice catalogue is
/// account state: Fish voices are user-cloned, Azure adds locales, ElevenLabs
/// voices are per-workspace. A baked-in list is wrong the day after it is written.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    /// What goes into `SpeechRequest::voice`.
    pub id: String,
    pub label: String,
    /// BCP-47 when the vendor states one ("ro-RO"); empty for a multilingual or
    /// unspecified voice. Empty is not "English" — it is "the voice follows the
    /// text", which is what a bilingual conversation needs.
    pub locale: String,
}

/// What a caller wants said, and how.
#[derive(Debug, Clone, Default)]
pub struct SpeechRequest {
    pub text: String,
    /// Vendor-specific voice id. `None` means the provider's default voice.
    pub voice: Option<String>,
}

/// One synthesis backend.
///
/// `speak` streams PCM to `audio` and returns the total byte count. Dropping
/// the receiver is the cancellation signal — that is what a barge-in looks like
/// from down here — so an implementation must stop pulling from its source
/// rather than treating a closed channel as an error.
#[async_trait::async_trait]
pub trait TtsProvider: Send + Sync {
    /// Stable id used in settings and by `from_id`.
    fn id(&self) -> &'static str;

    /// Shown in the UI when the user picks a voice engine.
    fn label(&self) -> &'static str;

    /// Whether audio leaves the machine. Voice mode must be able to tell the
    /// user this before it starts recording them — a local-first product that
    /// silently ships every spoken reply to a third party has lied by omission.
    fn is_local(&self) -> bool;

    /// Sample rate of the PCM this provider emits, so the bridge can label the
    /// chunks it forwards.
    ///
    /// Every hosted engine here is *asked* for `SAMPLE_RATE` and returns it. A
    /// local model returns whatever it was trained at — Piper voices are 22.05
    /// kHz — and playing those bytes at 24 kHz makes the voice audibly wrong
    /// (fast and high) while looking like a working feature. Hence a method, not
    /// the constant, at the one place the number is put on the wire.
    fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }

    /// Voices this engine offers, asked of the vendor.
    ///
    /// Empty means "this engine publishes no list", not "this engine has one
    /// voice" — the caller shows a free-text field in that case instead of
    /// pretending the choice does not exist.
    ///
    /// Pinning a voice matters more than it looks: a reply split into two
    /// synthesis requests with no explicit voice came back in two DIFFERENT
    /// voices, because "the default" is resolved per request at the vendor.
    async fn voices(&self) -> Result<Vec<Voice>> {
        Ok(vec![])
    }

    async fn speak(&self, req: &SpeechRequest, audio: Sender<Vec<u8>>) -> Result<usize>;
}

/// One row of the voice-engine picker.
///
/// This is a catalog rather than a list of ids because the picker has to be
/// honest about three separate things per engine — whether audio leaves the
/// machine, whether the user must supply a key, and whether it is even built
/// yet — and a UI that has to infer any of those from the id will eventually
/// infer wrong.
/// `camelCase` on the wire, and it is not cosmetic: the React picker reads
/// `needsKey`, `isLocal`, `needsDownload`. Serialised as snake_case, every one of
/// those is `undefined` — which is falsy, so the UI silently concluded that no
/// engine needs a key, none is local, and none needs a download. The result was a
/// picker with no key field, no download button, and a disabled Call button with
/// nothing on screen explaining why.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TtsEngine {
    pub id: String,
    pub label: String,
    /// Audio never leaves the machine. The picker says so before recording.
    pub is_local: bool,
    /// Needs an API key from the BYOK keychain.
    pub needs_key: bool,
    /// Needs a base URL — Azure's region, or a compatible gateway's endpoint.
    /// False for engines with a fixed endpoint: showing the field anyway invites
    /// someone to fill in something that will only break the request.
    pub needs_base_url: bool,
    /// Takes a model or voice name (Piper's voice, ElevenLabs' voice id, OpenAI's
    /// model). Separate from `needs_base_url` because most engines want one and
    /// only some want the other.
    pub needs_model: bool,
    /// Runs from a file the user must fetch first. A property, not an id: the UI
    /// must not have to know which engines those are, or the next local engine
    /// added will silently skip the download step and start a mute call.
    pub needs_download: bool,
    /// Where to get a key, when there is a stable console page for it.
    pub console_url: Option<String>,
    /// One line of honest description for the picker.
    pub note: String,
    /// False = the engine is in the catalog but its implementation is not here
    /// yet. `from_id` refuses it, so a row can never look usable before it is.
    pub available: bool,
}

fn engine(id: &str, label: &str, note: &str) -> TtsEngine {
    TtsEngine {
        id: id.to_string(),
        label: label.to_string(),
        is_local: false,
        needs_key: false,
        needs_base_url: false,
        needs_model: false,
        needs_download: false,
        console_url: None,
        note: note.to_string(),
        available: true,
    }
}

/// Every voice engine the picker offers, built or not.
///
/// Local engines come first deliberately: for a product whose pitch is "raised
/// on your machine", the option where nothing leaves it is the default the user
/// should have to actively move away from.
pub fn catalog() -> Vec<TtsEngine> {
    vec![
        TtsEngine {
            is_local: true,
            needs_model: true,
            needs_download: true,
            // Compiled in only when the `piper` feature is on, because it pulls a
            // native runtime. A build without it must not offer the row as
            // usable — the picker would be promising an engine that is not here.
            available: cfg!(feature = "piper"),
            ..engine(
                PIPER_ID,
                "Piper",
                "On device. ~60 MB voice, 35+ languages including Romanian. MIT.",
            )
        },
        TtsEngine {
            is_local: true,
            needs_model: true,
            needs_download: true,
            available: false, // ponytail: lands with tts/kokoro.rs
            ..engine(
                KOKORO_ID,
                "Kokoro",
                "On device. Best free quality, English-first. Larger download.",
            )
        },
        TtsEngine {
            needs_key: true,
            needs_model: true,
            console_url: Some("https://fish.audio/go-api/api-keys/".into()),
            ..engine(
                fish::ID,
                "Fish Audio S2.1 Pro",
                "Hosted. Free tier announced through 31 Aug 2026, no SLA.",
            )
        },
        TtsEngine {
            needs_key: true,
            needs_base_url: true,
            needs_model: true,
            console_url: Some("https://portal.azure.com/".into()),
            ..engine(
                azure::ID,
                "Azure Speech",
                "Hosted. 500k characters/month on the standing free tier; has Romanian.",
            )
        },
        TtsEngine {
            needs_key: true,
            // Fixed endpoint. It was marked as needing a base URL, which put an
            // empty field in front of the user for a value there is no reason to
            // change — the id it actually needs is the voice.
            needs_model: true,
            console_url: Some("https://elevenlabs.io/app/settings/api-keys".into()),
            ..engine(
                elevenlabs::ID,
                "ElevenLabs",
                "Hosted. Set the voice id (or voice:model) in the model field.",
            )
        },
        TtsEngine {
            needs_key: true,
            needs_base_url: true,
            needs_model: true,
            console_url: Some("https://platform.openai.com/api-keys".into()),
            ..engine(
                openai_compat::ID,
                "OpenAI-compatible",
                "Hosted. OpenAI, Groq, or any /v1/audio/speech endpoint — set your own base URL and model.",
            )
        },
    ]
}

/// What an engine needs to start speaking, beyond the text itself.
///
/// A struct rather than positional arguments because engines disagree about
/// what they need — Fish wants only a key, Azure wants a region, a compatible
/// gateway wants an endpoint and a model name — and adding the next engine's
/// requirement should not edit every call site.
#[derive(Debug, Default, Clone)]
pub struct EngineConfig<'a> {
    pub api_key: &'a str,
    /// Azure: `https://<region>.tts.speech.microsoft.com`. Compatible gateways:
    /// the API root. `None` uses the engine's own default where it has one.
    pub base_url: Option<&'a str>,
    /// Vendor model name, for engines that take one.
    pub model: Option<&'a str>,
}

/// Resolve an engine id from settings.
///
/// Unknown *and unbuilt* ids are both errors rather than silent fallbacks:
/// quietly speaking through a different engine than the one configured is worse
/// than refusing, especially when the difference is whether the audio left the
/// machine.
pub fn from_id(id: &str, cfg: EngineConfig) -> Result<Box<dyn TtsProvider>> {
    let known = catalog();
    match known.iter().find(|e| e.id == id) {
        None => anyhow::bail!(
            "unknown TTS provider {id:?} — known: {}",
            known.iter().map(|e| e.id.as_str()).collect::<Vec<_>>().join(", ")
        ),
        Some(e) if !e.available => anyhow::bail!(
            "{} is in the catalog but not built into this version yet",
            e.label
        ),
        Some(_) => match id {
            #[cfg(feature = "piper")]
            PIPER_ID => Ok(Box::new(piper::PiperTts::new(&cfg))),
            fish::ID => Ok(Box::new(fish::FishTts::new(cfg.api_key.to_string()))),
            azure::ID => Ok(Box::new(azure::AzureTts::new(&cfg)?)),
            elevenlabs::ID => Ok(Box::new(elevenlabs::ElevenLabsTts::new(&cfg))),
            openai_compat::ID => Ok(Box::new(openai_compat::OpenAiCompatTts::new(&cfg))),
            // Unreachable while the catalog and this match agree; the test below
            // is what keeps them agreeing.
            other => anyhow::bail!("TTS provider {other:?} is catalogued but not wired"),
        },
    }
}

/// Seconds of audio a byte count represents. Used for pacing and for tests.
pub fn duration_secs(bytes: usize) -> f64 {
    bytes as f64 / BYTES_PER_SECOND as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(key: &str) -> EngineConfig<'_> {
        EngineConfig { api_key: key, ..Default::default() }
    }

    #[test]
    fn unknown_provider_is_refused_not_silently_swapped() {
        // `unwrap_err` would demand Debug on Box<dyn TtsProvider>; match instead.
        let err = match from_id("nope", cfg("k")) {
            Ok(_) => panic!("an unknown id must not resolve to a provider"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("unknown TTS provider"), "{err}");
        assert!(err.contains(fish::ID), "the error should list what IS known: {err}");
    }

    #[test]
    fn a_catalogued_but_unbuilt_engine_refuses_instead_of_pretending() {
        // Kokoro is in the picker before its implementation lands. Resolving it
        // must fail loudly rather than fall back to whatever else is around —
        // silently answering in a hosted voice when the user chose the local one
        // is the exact failure `is_local` exists to prevent.
        //
        // Piper used to stand in for this case and stopped being a valid example
        // the moment it was built, which is the useful property: this test tracks
        // whatever is still unfinished rather than a name frozen in the past.
        let err = match from_id(KOKORO_ID, cfg("k")) {
            Ok(_) => panic!("an unbuilt engine must not resolve"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("not built"), "{err}");
    }

    #[test]
    fn every_available_engine_in_the_catalog_is_actually_wired() {
        // Guards the one thing the `from_id` match cannot: a row added to the
        // catalog and marked available, with no arm to construct it.
        for e in catalog().iter().filter(|e| e.available) {
            let c = EngineConfig {
                api_key: "k",
                base_url: Some("https://example.invalid"),
                model: Some("m"),
            };
            match from_id(&e.id, c) {
                Ok(p) => assert_eq!(p.id(), e.id, "{} resolved to a different engine", e.id),
                Err(err) => panic!("catalogued engine {} does not resolve: {err}", e.id),
            }
        }
    }

    #[test]
    fn local_engines_are_offered_before_hosted_ones() {
        // Order is product, not decoration: the option where nothing leaves the
        // machine is the one a local-first product should show first.
        let first_hosted = catalog().iter().position(|e| !e.is_local).unwrap();
        let last_local = catalog().iter().rposition(|e| e.is_local).unwrap();
        assert!(last_local < first_hosted, "hosted engines must not be listed above local ones");
    }

    #[test]
    fn hosted_engines_declare_they_need_a_key() {
        for e in catalog() {
            assert_eq!(
                e.needs_key, !e.is_local,
                "{}: a hosted engine needs a key and a local one must not ask for one",
                e.id
            );
        }
    }

    #[test]
    fn the_catalog_goes_over_the_wire_in_camel_case() {
        // The bug this exists for: without `rename_all`, the fields arrive as
        // `needs_key` / `is_local` / `needs_download` while the picker reads
        // `needsKey` / `isLocal` / `needsDownload`. Every one is `undefined`,
        // which is falsy, so the UI concluded that nothing needs a key, nothing is
        // local and nothing needs downloading — and showed no key field, no
        // download button, and a disabled Call button with no explanation. Types
        // cannot catch it; only the serialised shape can.
        let json = serde_json::to_string(&catalog()[0]).expect("catalog row serialises");
        for camel in ["isLocal", "needsKey", "needsBaseUrl", "needsModel", "needsDownload", "consoleUrl"] {
            assert!(json.contains(camel), "missing {camel} in {json}");
        }
        for snake in ["is_local", "needs_key", "needs_base_url", "needs_model", "needs_download"] {
            assert!(!json.contains(snake), "{snake} leaked into {json}");
        }
    }

    #[test]
    fn only_local_engines_ask_for_a_download() {
        // The flag exists so the UI never has to name engines. If a hosted one
        // ever set it, the picker would demand a file that no download provides.
        for e in catalog() {
            if e.needs_download {
                assert!(e.is_local, "{}: a hosted engine has nothing to download", e.id);
            }
        }
        assert!(
            catalog().iter().any(|e| e.needs_download),
            "the flag is only meaningful while some engine uses it",
        );
    }

    #[test]
    fn an_engine_with_a_fixed_endpoint_does_not_ask_for_a_base_url() {
        // Every field the picker shows is a field someone can fill in wrongly.
        for id in [elevenlabs::ID, fish::ID, PIPER_ID] {
            let e = catalog().into_iter().find(|e| e.id == id).expect("catalogued");
            assert!(!e.needs_base_url, "{id} has a fixed endpoint and must not prompt for one");
        }
    }

    #[test]
    fn duration_matches_the_pcm_contract() {
        // One second of 24 kHz mono 16-bit is 48000 bytes.
        assert_eq!(BYTES_PER_SECOND, 48_000);
        assert!((duration_secs(48_000) - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn every_provider_declares_whether_audio_leaves_the_machine() {
        for e in catalog() {
            assert!(!e.id.is_empty() && !e.label.is_empty(), "engine metadata must be usable in UI");
            assert!(!e.note.is_empty(), "{}: the picker needs something honest to show", e.id);
        }
        let p = match from_id(fish::ID, cfg("k")) { Ok(p) => p, Err(e) => panic!("{e}") };
        assert!(!p.is_local(), "Fish is a hosted API and must not claim to be local");
    }
}
