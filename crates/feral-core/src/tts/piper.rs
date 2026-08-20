//! On-device text-to-speech with Piper voices.
//!
//! The engine this product should default to: MIT voices, 35+ languages,
//! ~60 MB on disk, and nothing spoken ever leaves the machine. `is_local()` returns true here and that is the whole point — every
//! hosted engine in this module is a compromise measured against this one.
//!
//! Three things about Piper shape this file:
//!
//! * **It is not streaming.** `Piper::create` returns the finished utterance as
//!   one `Vec<f32>`. The provider contract wants chunks, so the buffer is sliced
//!   on the way out — not to fake streaming (the wait already happened) but so
//!   the send loop has cancellation points and the frontend's scheduler sees the
//!   same shape it sees from every other engine.
//! * **It is CPU-bound and synchronous**, so synthesis runs on a blocking thread.
//!   Leaving it on the async runtime would stall every other task in the process
//!   for the length of a sentence.
//! * **It is 22.05 kHz f32**, not the 24 kHz i16 the rest of the pipeline uses.
//!   The conversion to i16 happens here; the rate does not, because every chunk
//!   event already carries its own `sample_rate` — which is exactly why that
//!   field was put there instead of hardcoding the constant in TypeScript.
//!
//! espeak-ng, which does the phonemization, is not reentrant, and the loaded
//! voice is worth keeping between turns. One global mutex solves both: it
//! serializes synthesis (correct for espeak) and caches the last voice (a call
//! asks for the same one every turn, so the model loads once instead of per
//! reply).

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tokio::sync::mpsc::Sender;

use super::{EngineConfig, SpeechRequest, TtsProvider, Voice, BYTES_PER_SAMPLE};
use crate::paths;

/// Stable id for settings and `from_id`.
pub const ID: &str = "piper";

/// The voice a machine with no choice stored downloads and speaks with.
///
/// English, because this is the answer for someone who has not chosen — and
/// until now that answer was Romanian, picked because the person this was built
/// for speaks it. Every install anywhere in the world fetched 60 MB to be
/// answered in a language it had no reason to think the user spoke, and nothing
/// on screen said why. The 35+ other languages are all one voice id away, and
/// the picker offers a shortlist for the interface language.
pub const DEFAULT_VOICE: &str = "en_US-amy-medium";

/// How many slices one second of audio is handed over in — so a quarter second
/// each. Small enough that a barge-in stops promptly, large enough that a long
/// reply crosses the IPC bridge as tens of messages rather than thousands.
///
/// Named for what it is: `CHUNK_SECONDS` was the previous name and it read as a
/// duration while being used as a divisor, which is how someone later "fixes" it
/// to 1 and gets four-second chunks.
const CHUNKS_PER_SECOND: usize = 4;

/// The one loaded voice, kept between utterances.
///
/// A single entry, not a map: a call uses one voice for its whole duration, so
/// this removes the per-reply model load (~hundreds of ms for a 60 MB ONNX) for
/// the case that matters.
/// ponytail: single-entry cache. If someone ever switches voices mid-sentence,
/// this thrashes — make it a small LRU then, not before.
static LOADED: OnceLock<Mutex<Option<(String, piper_rs::Piper)>>> = OnceLock::new();

fn loaded() -> &'static Mutex<Option<(String, piper_rs::Piper)>> {
    LOADED.get_or_init(|| Mutex::new(None))
}

pub struct PiperTts {
    voice: String,
    /// Advertised to the bridge before the first chunk goes out, so it must be
    /// known without synthesising: it comes from the voice's own config file.
    sample_rate: u32,
}

impl PiperTts {
    pub fn new(cfg: &EngineConfig) -> Self {
        // The voice travels in the BYOK record's `model` field like every other
        // engine's model name, so the picker needs no special case.
        let voice = cfg
            .model
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(DEFAULT_VOICE)
            .to_string();
        let sample_rate = config_sample_rate(&voice).unwrap_or(super::SAMPLE_RATE);
        Self { voice, sample_rate }
    }
}

/// Read `audio.sample_rate` out of a voice's `.onnx.json`.
///
/// Read rather than assumed. Piper voices are conventionally 22.05 kHz but the
/// config is what the model was actually trained at, and the alternative to
/// reading it is hardcoding a number that will be wrong for some voice nobody
/// tested. `None` when the voice is not downloaded — synthesis is going to fail
/// with a clear message in that case anyway.
fn config_sample_rate(voice: &str) -> Option<u32> {
    let bytes = std::fs::read(paths::piper_config_path(voice)?).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json.get("audio")?.get("sample_rate")?.as_u64()?.try_into().ok()
}

/// Every file under `root`, depth-first. A hand-rolled walk rather than a new
/// dependency: the tree is four levels deep and holds a handful of files.
fn walkdir(root: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}

/// Is this voice already downloaded? Both files are required — a `.onnx` with no
/// `.onnx.json` cannot be loaded, and reporting "present" for a half-download
/// turns a clear "not downloaded" into an ONNX parse error.
pub fn voice_present(voice: &str) -> bool {
    match (paths::piper_voice_path(voice), paths::piper_config_path(voice)) {
        (Some(model), Some(config)) => model.exists() && config.exists(),
        // An unplaceable voice id is not present and never will be.
        _ => false,
    }
}

/// f32 samples in -1..1 to signed 16-bit little-endian bytes.
///
/// Clamping is not optional: Piper can overshoot slightly, and in two's
/// complement an overshoot wraps from full-positive to full-negative, which is
/// heard as a loud click rather than as mild clipping.
fn to_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Load (or reuse) the voice and synthesize. Blocking: call from a blocking task.
fn synthesize_blocking(voice: &str, text: &str) -> Result<(Vec<u8>, u32)> {
    if !voice_present(voice) {
        bail!("the Piper voice {voice:?} is not downloaded yet");
    }
    // Both are Some once `voice_present` agreed — it checked the same two paths.
    let (Some(model), Some(config)) =
        (paths::piper_voice_path(voice), paths::piper_config_path(voice))
    else {
        bail!("{voice:?} is not a usable Piper voice id");
    };

    let mut guard = loaded()
        .lock()
        .map_err(|_| anyhow::anyhow!("the Piper voice lock was poisoned by an earlier panic"))?;

    let needs_load = match guard.as_ref() {
        Some((id, _)) => id != voice,
        None => true,
    };
    if needs_load {
        let engine = piper_rs::Piper::new(&model, &config)
            .map_err(|e| anyhow::anyhow!("{e}"))
            .with_context(|| format!("load Piper voice {voice:?}"))?;
        *guard = Some((voice.to_string(), engine));
    }

    let (id, engine) = guard.as_mut().expect("just loaded");
    debug_assert_eq!(id, voice);
    let (samples, rate) = engine
        .create(text, false, None, None, None, None)
        .map_err(|e| anyhow::anyhow!("{e}"))
        .context("Piper synthesis failed")?;

    Ok((to_pcm16(&samples), rate))
}

#[async_trait::async_trait]
impl TtsProvider for PiperTts {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Piper"
    }

    /// The reason this engine exists. Nothing is sent anywhere.
    fn is_local(&self) -> bool {
        true
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// The voices actually on disk — the only ones that can speak without a
    /// download. Found by walking the voice directory rather than kept in a list,
    /// so a voice deleted by hand disappears from the picker too.
    async fn voices(&self) -> Result<Vec<Voice>> {
        let mut found = Vec::new();
        // The layout mirrors the HF repo: <lang>/<locale>/<name>/<quality>/x.onnx
        for entry in walkdir(&paths::piper_dir()) {
            let Some(file) = entry.file_name().and_then(|n| n.to_str()) else { continue };
            let Some(voice) = file.strip_suffix(".onnx") else { continue };
            if !voice_present(voice) {
                continue; // model without its config
            }
            // `ro_RO-mihai-medium` → "mihai · ro_RO (medium)"
            let mut parts = voice.split('-');
            let locale = parts.next().unwrap_or_default().to_string();
            let name = parts.next().unwrap_or(voice);
            let quality = parts.next().unwrap_or("");
            found.push(Voice {
                label: format!("{name} · {locale}{}", if quality.is_empty() { String::new() } else { format!(" ({quality})") }),
                locale: locale.replace('_', "-"),
                id: voice.to_string(),
            });
        }
        found.sort_by(|a, b| a.label.cmp(&b.label));
        Ok(found)
    }

    async fn speak(&self, req: &SpeechRequest, audio: Sender<Vec<u8>>) -> Result<usize> {
        if req.text.trim().is_empty() {
            return Ok(0);
        }
        let voice = req.voice.clone().unwrap_or_else(|| self.voice.clone());
        let text = req.text.clone();

        // Synthesis is CPU-bound and synchronous. On the async runtime it would
        // block every other task — including the one forwarding audio to the UI.
        let job = (voice.clone(), text);
        let (pcm, rate) = tokio::task::spawn_blocking(move || synthesize_blocking(&job.0, &job.1))
            .await
            .context("Piper synthesis task panicked")??;

        // The bridge already labelled these chunks with `self.sample_rate`, read
        // from the config. If the model actually produced something else, the
        // audio would play at the wrong speed and still look like it worked —
        // so this disagreement is worth failing on rather than shipping.
        if rate != self.sample_rate {
            bail!(
                "Piper voice {voice:?} synthesised at {rate} Hz but its config says {} Hz",
                self.sample_rate
            );
        }

        // Derived from THIS voice's rate, not the module's 24 kHz constant: at
        // 22.05 kHz that constant would have made the slices 0.27 s, not the
        // quarter second the name promises. Rounded to an even number of bytes so
        // a slice never splits a sample down the middle.
        let chunk = (self.sample_rate as usize / CHUNKS_PER_SECOND) * BYTES_PER_SAMPLE;
        let mut total = 0usize;
        for slice in pcm.chunks(chunk) {
            total += slice.len();
            // A closed receiver is a barge-in, not an error: stop sending.
            if audio.send(slice.to_vec()).await.is_err() {
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
    fn full_scale_samples_do_not_wrap_into_a_click() {
        // 1.0 must land on full positive, and anything above it must clamp there
        // rather than wrapping to full negative.
        let bytes = to_pcm16(&[0.0, 1.0, -1.0, 2.0, -2.0]);
        let read = |i: usize| i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]);
        assert_eq!(read(0), 0);
        assert_eq!(read(1), i16::MAX);
        assert_eq!(read(2), -i16::MAX);
        assert_eq!(read(3), i16::MAX, "an overshoot must clamp, not wrap");
        assert_eq!(read(4), -i16::MAX, "an undershoot must clamp, not wrap");
    }

    /// The default is a download URL, not a label: a typo in it is a 404 on a
    /// fresh install and nothing else in the build would catch it.
    #[test]
    fn the_default_voice_can_be_placed_in_the_repo_layout() {
        let rel = crate::paths::piper_repo_path(DEFAULT_VOICE, "")
            .expect("DEFAULT_VOICE must parse as <locale>-<name>-<quality>");
        assert_eq!(rel, "en/en_US/amy/medium/en_US-amy-medium.onnx");
        // Not a language chosen for one user. The shortlist in the picker
        // follows the interface language; this is the answer for someone who
        // has not chosen at all.
        assert!(DEFAULT_VOICE.starts_with("en_"), "the no-choice default must be English");
    }

    #[test]
    fn a_missing_voice_is_named_in_the_error() {
        let err = synthesize_blocking("zz_ZZ-nobody-medium", "hello").unwrap_err().to_string();
        assert!(err.contains("not downloaded"), "{err}");
        assert!(err.contains("zz_ZZ-nobody-medium"), "the error must say which voice: {err}");
    }

    #[tokio::test]
    async fn empty_text_is_a_no_op_not_a_model_load() {
        let engine = PiperTts::new(&EngineConfig::default());
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        let req = SpeechRequest { text: "  \n ".into(), voice: None };
        assert_eq!(engine.speak(&req, tx).await.unwrap(), 0);
        assert!(rx.try_recv().is_err());
    }
}
