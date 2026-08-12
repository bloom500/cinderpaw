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

pub mod fish;

use anyhow::Result;
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

    async fn speak(&self, req: &SpeechRequest, audio: Sender<Vec<u8>>) -> Result<usize>;
}

/// Providers the build knows about, for the settings UI.
pub fn available() -> Vec<(&'static str, &'static str, bool)> {
    vec![(fish::ID, "Fish Audio S2.1 Pro", false)]
}

/// Resolve a provider id from settings. Unknown ids are an error rather than a
/// silent fallback: quietly speaking through a different engine than the one
/// configured is worse than refusing, especially when the difference is whether
/// the audio left the machine.
pub fn from_id(id: &str, api_key: &str) -> Result<Box<dyn TtsProvider>> {
    match id {
        fish::ID => Ok(Box::new(fish::FishTts::new(api_key.to_string()))),
        other => anyhow::bail!(
            "unknown TTS provider {other:?} — known: {}",
            available().iter().map(|(i, _, _)| *i).collect::<Vec<_>>().join(", ")
        ),
    }
}

/// Seconds of audio a byte count represents. Used for pacing and for tests.
pub fn duration_secs(bytes: usize) -> f64 {
    bytes as f64 / BYTES_PER_SECOND as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_provider_is_refused_not_silently_swapped() {
        // `unwrap_err` would demand Debug on Box<dyn TtsProvider>; match instead.
        let err = match from_id("piper", "k") {
            Ok(_) => panic!("an unknown id must not resolve to a provider"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("unknown TTS provider"), "{err}");
        assert!(err.contains(fish::ID), "the error should list what IS known: {err}");
    }

    #[test]
    fn duration_matches_the_pcm_contract() {
        // One second of 24 kHz mono 16-bit is 48000 bytes.
        assert_eq!(BYTES_PER_SECOND, 48_000);
        assert!((duration_secs(48_000) - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn every_provider_declares_whether_audio_leaves_the_machine() {
        for (id, label, _) in available() {
            assert!(!id.is_empty() && !label.is_empty(), "provider metadata must be usable in UI");
        }
        let p = match from_id(fish::ID, "k") { Ok(p) => p, Err(e) => panic!("{e}") };
        assert!(!p.is_local(), "Fish is a hosted API and must not claim to be local");
    }
}
