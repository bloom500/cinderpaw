//! On-device text-to-speech with Kokoro-82M.
//!
//! The second local engine, and the one to reach for when Piper's voice is not
//! good enough: 82M parameters against Piper's ~20M, and it is the model that
//! keeps winning blind listening tests among things this size. Apache-2.0, so it
//! ships without a licence footnote.
//!
//! What it costs, said plainly: **no Romanian**. Kokoro v1.0 covers American and
//! British English, Spanish, French, Hindi, Italian, Japanese, Brazilian
//! Portuguese and Mandarin — and that is the whole list. Piper stays the default
//! for exactly that reason; this is the better voice in the languages it has.
//!
//! Four things about Kokoro shape this file, and every one of them is READ from
//! what the vendor ships rather than assumed:
//!
//! * **The vocabulary is not ours to invent.** Token ids come from the repo's
//!   own `tokenizer.json` (`model.vocab`, 115 symbols). A hand-copied table
//!   would be wrong in one entry and produce audio that is *almost* words.
//! * **The voice is a style tensor, not a name.** `voices/<id>.bin` is a raw f32
//!   block — 522,240 bytes = 510 frames x 256 — and the row is chosen by how
//!   many phoneme tokens the utterance has. The frame count is derived from the
//!   file's length, so a repack with a different cap keeps working.
//! * **It takes phonemes, not text.** espeak-ng does the G2P, the same
//!   phonemizer Piper already links, and the voice's first letter picks the
//!   language it phonemizes in.
//! * **It is 24 kHz**, which is the contract in `super` exactly. Nothing here
//!   resamples anything.
//!
//! Like Piper, inference is CPU-bound and synchronous, so it runs on a blocking
//! thread and the loaded session is kept between turns.

use anyhow::{anyhow, bail, Context, Result};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tokio::sync::mpsc::Sender;

use super::{EngineConfig, SpeechRequest, TtsProvider, Voice, BYTES_PER_SAMPLE};
use crate::paths;

/// Stable id for settings and `from_id`.
pub const ID: &str = "kokoro";

/// Kokoro's most-recommended voice, and the one a fresh setup downloads.
pub const DEFAULT_VOICE: &str = "af_heart";

/// Where the model, its tokenizer and the voice packs come from.
pub const REPO: &str = "onnx-community/Kokoro-82M-v1.0-ONNX";

/// Quantised weights: ~86 MB against ~310 MB for the float model, which is the
/// difference between a download someone waits through and one they abandon.
/// The repo ships several quantisations; this is the one that keeps fp16
/// activations, so the quality cost is small where it is audible.
pub const MODEL_FILE: &str = "onnx/model_q8f16.onnx";

/// The authority on token ids. Downloaded with the model and parsed at load.
pub const TOKENIZER_FILE: &str = "tokenizer.json";

/// Style vectors are 256 wide. The number of FRAMES is read from the file.
const STYLE_DIM: usize = 256;

/// Longest token run the model accepts, minus the two pad tokens it is wrapped
/// in. Longer text is split rather than truncated — a cut sentence is a bug the
/// listener hears, and this is the one number the model will not negotiate.
const MAX_TOKENS: usize = 508;

/// How many slices one second of audio is handed over in. Same reasoning as
/// Piper: small enough that a barge-in stops promptly, large enough that a long
/// reply crosses the IPC bridge as tens of messages rather than thousands.
const CHUNKS_PER_SECOND: usize = 4;

/// Repo-relative path of a voice pack. Voices are flat, unlike Piper's tree.
pub fn voice_rel_path(voice: &str) -> Option<String> {
    // A voice id is a file name in someone else's repo, so it is validated
    // rather than trusted: anything with a separator or a dot could reach out
    // of `voices/` entirely.
    if voice.is_empty()
        || !voice
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(format!("voices/{voice}.bin"))
}

pub fn model_path() -> PathBuf {
    paths::kokoro_dir().join(MODEL_FILE)
}

pub fn tokenizer_path() -> PathBuf {
    paths::kokoro_dir().join(TOKENIZER_FILE)
}

pub fn voice_path(voice: &str) -> Option<PathBuf> {
    voice_rel_path(voice).map(|rel| paths::kokoro_dir().join(rel))
}

/// Is this voice usable? All three files are required — a voice pack without
/// the model is a download that reports "present" and then cannot speak.
pub fn voice_present(voice: &str) -> bool {
    match voice_path(voice) {
        Some(v) => v.exists() && model_path().exists() && tokenizer_path().exists(),
        None => false,
    }
}

/// The espeak language a voice's phonemes must be produced in.
///
/// Kokoro's ids encode it in the first letter (`a` American, `b` British, …);
/// the second is the speaker's gender and carries nothing we need. An unknown
/// prefix falls back to American English rather than failing: a voice we have
/// not seen is more likely a new English one than a new language.
fn espeak_lang(voice: &str) -> &'static str {
    match voice.as_bytes().first() {
        Some(b'b') => "en-gb",
        Some(b'e') => "es",
        Some(b'f') => "fr-fr",
        Some(b'h') => "hi",
        Some(b'i') => "it",
        Some(b'j') => "ja",
        Some(b'p') => "pt-br",
        Some(b'z') => "cmn",
        _ => "en-us",
    }
}

/// Human-readable half of a voice id: `af_heart` → "heart · American English".
fn label_for(voice: &str) -> String {
    let name = voice.split_once('_').map(|(_, n)| n).unwrap_or(voice);
    let lang = match voice.as_bytes().first() {
        Some(b'b') => "British English",
        Some(b'e') => "Spanish",
        Some(b'f') => "French",
        Some(b'h') => "Hindi",
        Some(b'i') => "Italian",
        Some(b'j') => "Japanese",
        Some(b'p') => "Portuguese",
        Some(b'z') => "Mandarin",
        _ => "American English",
    };
    format!("{name} · {lang}")
}

/// BCP-47 for the picker, so a voice can be ranked by language like any other.
fn locale_for(voice: &str) -> String {
    match espeak_lang(voice) {
        "en-gb" => "en-GB",
        "es" => "es-ES",
        "fr-fr" => "fr-FR",
        "hi" => "hi-IN",
        "it" => "it-IT",
        "ja" => "ja-JP",
        "pt-br" => "pt-BR",
        "cmn" => "zh-CN",
        _ => "en-US",
    }
    .to_string()
}

/// Symbol → token id, straight out of the repo's `tokenizer.json`.
///
/// Parsed out of a `Value` rather than a typed struct: this is another project's
/// file, and the one thing that must not happen is a rename turning into a
/// silent empty vocabulary — which would tokenise every utterance to nothing and
/// synthesise silence that looks like a working engine.
fn load_vocab(path: &std::path::Path) -> Result<std::collections::HashMap<String, i64>> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("read the Kokoro tokenizer at {}", path.display()))?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).context("the Kokoro tokenizer is not JSON")?;
    let table = json
        .get("model")
        .and_then(|m| m.get("vocab"))
        .or_else(|| json.get("vocab"))
        .and_then(|v| v.as_object())
        .ok_or_else(|| anyhow!("no `model.vocab` in the Kokoro tokenizer"))?;
    let vocab: std::collections::HashMap<String, i64> = table
        .iter()
        .filter_map(|(sym, id)| id.as_i64().map(|i| (sym.clone(), i)))
        .collect();
    if vocab.is_empty() {
        bail!("the Kokoro tokenizer has an empty vocabulary");
    }
    Ok(vocab)
}

/// IPA from espeak → token ids.
///
/// Symbols the vocabulary does not contain are dropped. That is deliberate and
/// it is what the reference implementations do: espeak emits stress marks and
/// ties Kokoro was not trained on, and refusing the whole utterance over one of
/// them would mean a reply that says nothing at all.
fn tokenize(phonemes: &str, vocab: &std::collections::HashMap<String, i64>) -> Vec<i64> {
    let mut out = Vec::with_capacity(phonemes.len());
    for ch in phonemes.chars() {
        let mut buf = [0u8; 4];
        if let Some(&id) = vocab.get(ch.encode_utf8(&mut buf) as &str) {
            out.push(id);
        }
    }
    out
}

/// The style row for an utterance of `n_tokens`.
///
/// Kokoro ships one vector per LENGTH — the model was trained with the style
/// conditioned on how long the utterance is — so this indexes rather than
/// averages. The frame count comes from the file size instead of a constant:
/// today every pack is 510 frames, and deriving it means a repack does not
/// silently read past the end.
fn style_row(bytes: &[u8], n_tokens: usize) -> Result<Vec<f32>> {
    let floats = bytes.len() / 4;
    if floats < STYLE_DIM || floats % STYLE_DIM != 0 {
        bail!(
            "a Kokoro voice pack is a multiple of {STYLE_DIM} floats; this one is {} bytes",
            bytes.len()
        );
    }
    let frames = floats / STYLE_DIM;
    let row = n_tokens.min(frames - 1);
    let start = row * STYLE_DIM * 4;
    Ok(bytes[start..start + STYLE_DIM * 4]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

/// f32 samples in -1..1 to signed 16-bit little-endian bytes.
///
/// Clamped, for the reason Piper's copy is: an overshoot wraps from
/// full-positive to full-negative in two's complement, which is heard as a loud
/// click rather than as mild clipping.
fn to_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// The loaded model and its vocabulary, kept between utterances.
///
/// One entry, like Piper's: the session does not depend on the voice (only the
/// style tensor does), so a call reuses it for its whole duration instead of
/// paying the ONNX load per reply.
/// ponytail: the style pack is re-read from disk per utterance — 512 KB, far
/// cheaper than the session. Cache it too if a profile ever says otherwise.
type Loaded = (ort::session::Session, std::collections::HashMap<String, i64>);
static SESSION: OnceLock<Mutex<Option<Loaded>>> = OnceLock::new();

fn session_slot() -> &'static Mutex<Option<Loaded>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

pub struct KokoroTts {
    voice: String,
    speed: f32,
}

impl KokoroTts {
    pub fn new(cfg: &EngineConfig) -> Self {
        // The voice travels in the BYOK record's `model` field like every other
        // engine's, so the picker needs no special case for this one.
        let voice = cfg
            .model
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(DEFAULT_VOICE)
            .to_string();
        Self { voice, speed: 1.0 }
    }
}

/// Load (or reuse) the model and synthesise. Blocking: call from a blocking task.
fn synthesize_blocking(voice: &str, text: &str, speed: f32) -> Result<Vec<f32>> {
    if !voice_present(voice) {
        bail!("the Kokoro voice {voice:?} is not downloaded yet");
    }
    let Some(voice_file) = voice_path(voice) else {
        bail!("{voice:?} is not a usable Kokoro voice id");
    };

    // Phonemes first: it needs no lock, and a text that phonemises to nothing
    // should not have loaded 86 MB of weights to find that out.
    let sentences = espeak_rs::text_to_phonemes(text, espeak_lang(voice), None)
        .map_err(|e| anyhow!("espeak could not phonemise the reply: {e}"))?;
    let phonemes = sentences.join(" ");
    if phonemes.trim().is_empty() {
        return Ok(Vec::new());
    }

    let style_bytes = std::fs::read(&voice_file)
        .with_context(|| format!("read the Kokoro voice pack {}", voice_file.display()))?;

    let mut guard = session_slot()
        .lock()
        .map_err(|_| anyhow!("the Kokoro model lock was poisoned by an earlier panic"))?;
    if guard.is_none() {
        let session = ort::session::Session::builder()
            .context("create an ONNX session builder")?
            .commit_from_file(model_path())
            .with_context(|| format!("load the Kokoro model at {}", model_path().display()))?;
        let vocab = load_vocab(&tokenizer_path())?;
        *guard = Some((session, vocab));
    }
    let (session, vocab) = guard.as_mut().expect("just loaded");

    let ids = tokenize(&phonemes, vocab);
    if ids.is_empty() {
        // Every symbol was unknown. Silence would look like a working engine, so
        // this is an error the call screen can show.
        bail!("none of the phonemes for this reply are in Kokoro's vocabulary");
    }

    let mut audio = Vec::new();
    for chunk in ids.chunks(MAX_TOKENS) {
        let style = style_row(&style_bytes, chunk.len())?;

        // Wrapped in the pad token at both ends, which is what the model was
        // trained to see. The style row is chosen by the UNWRAPPED length —
        // that is the length the vector was fitted for.
        let mut input: Vec<i64> = Vec::with_capacity(chunk.len() + 2);
        input.push(0);
        input.extend_from_slice(chunk);
        input.push(0);

        let ids_t = ort::value::Tensor::<i64>::from_array((
            [1usize, input.len()],
            input.into_boxed_slice(),
        ))
        .context("build the Kokoro input tensor")?;
        let style_t =
            ort::value::Tensor::<f32>::from_array(([1usize, STYLE_DIM], style.into_boxed_slice()))
                .context("build the Kokoro style tensor")?;
        let speed_t =
            ort::value::Tensor::<f32>::from_array(([1usize], vec![speed].into_boxed_slice()))
                .context("build the Kokoro speed tensor")?;

        // Named inputs, not positional: the model has three and two of them are
        // the same rank, so an order that drifts would be accepted and produce
        // noise rather than an error.
        let outputs = session
            .run(ort::inputs![
                "input_ids" => ids_t,
                "style" => style_t,
                "speed" => speed_t,
            ])
            .context("Kokoro inference failed")?;
        let (_, samples) = outputs[0]
            .try_extract_tensor::<f32>()
            .context("Kokoro returned something that is not audio")?;
        audio.extend_from_slice(samples);
    }
    Ok(audio)
}

#[async_trait::async_trait]
impl TtsProvider for KokoroTts {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Kokoro"
    }

    /// The reason to pick it over the hosted engines. Nothing is sent anywhere.
    fn is_local(&self) -> bool {
        true
    }

    /// Kokoro is 24 kHz, which is `super::SAMPLE_RATE` — the one rate the whole
    /// pipeline already speaks. Unlike Piper, there is nothing to read from a
    /// config here, because the model has exactly one output rate.
    /// The voices actually on disk, which are the only ones that can speak
    /// without a download.
    async fn voices(&self) -> Result<Vec<Voice>> {
        let dir = paths::kokoro_dir().join("voices");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(vec![]);
        };
        let mut found: Vec<Voice> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name();
                let id = name.to_str()?.strip_suffix(".bin")?.to_string();
                Some(Voice { label: label_for(&id), locale: locale_for(&id), id })
            })
            .collect();
        found.sort_by(|a, b| a.label.cmp(&b.label));
        Ok(found)
    }

    async fn speak(&self, req: &SpeechRequest, audio: Sender<Vec<u8>>) -> Result<usize> {
        if req.text.trim().is_empty() {
            return Ok(0);
        }
        let voice = req.voice.clone().unwrap_or_else(|| self.voice.clone());
        let job = (voice, req.text.clone(), self.speed);

        // ONNX is CPU-bound and synchronous. On the async runtime it would block
        // every other task, including the one forwarding audio to the UI.
        let pcm = tokio::task::spawn_blocking(move || synthesize_blocking(&job.0, &job.1, job.2))
            .await
            .context("the Kokoro synthesis task panicked")??;

        // Quarter-second slices, derived from the module's rate because Kokoro
        // has exactly one. Rounded to whole samples so a slice never splits one.
        let chunk = (super::SAMPLE_RATE as usize / CHUNKS_PER_SECOND) * BYTES_PER_SAMPLE;
        let bytes = to_pcm16(&pcm);
        let mut total = 0usize;
        for slice in bytes.chunks(chunk) {
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
    fn a_voice_id_that_could_escape_the_voices_directory_is_refused() {
        // The id becomes a path inside someone else's repo AND a path on disk.
        assert!(voice_rel_path("af_heart").is_some());
        assert!(voice_rel_path("../../etc/passwd").is_none());
        assert!(voice_rel_path("af heart").is_none());
        assert!(voice_rel_path("af.heart").is_none());
        assert!(voice_rel_path("").is_none());
        assert_eq!(voice_rel_path("af_heart").unwrap(), "voices/af_heart.bin");
    }

    #[test]
    fn the_voice_prefix_picks_the_phonemizer_language() {
        // Getting this wrong is not an accent: espeak would phonemise Spanish
        // through English letter rules and the model would say other words.
        assert_eq!(espeak_lang("af_heart"), "en-us");
        assert_eq!(espeak_lang("bm_george"), "en-gb");
        assert_eq!(espeak_lang("ef_dora"), "es");
        assert_eq!(espeak_lang("jf_alpha"), "ja");
        assert_eq!(espeak_lang("zf_xiaobei"), "cmn");
        // A prefix nobody has mapped falls back to American English: a voice we
        // have not seen is likelier a new English one than a new language.
        assert_eq!(espeak_lang("qq_unknown_future_voice"), "en-us");
    }

    #[test]
    fn the_style_row_is_indexed_by_length_and_clamped_to_the_pack() {
        // 3 frames of 256, each filled with its own row number.
        let mut bytes = Vec::new();
        for row in 0..3u32 {
            for _ in 0..STYLE_DIM {
                bytes.extend_from_slice(&(row as f32).to_le_bytes());
            }
        }
        assert_eq!(style_row(&bytes, 0).unwrap()[0], 0.0);
        assert_eq!(style_row(&bytes, 2).unwrap()[0], 2.0);
        // Past the end clamps to the last frame rather than reading off it.
        assert_eq!(style_row(&bytes, 99).unwrap()[0], 2.0);
        assert_eq!(style_row(&bytes, 1).unwrap().len(), STYLE_DIM);
    }

    #[test]
    fn a_voice_pack_that_is_not_a_whole_number_of_frames_is_refused() {
        // Better than reading a truncated row and synthesising noise.
        assert!(style_row(&[0u8; 100], 0).is_err());
        assert!(style_row(&[], 0).is_err());
    }

    #[test]
    fn unknown_phonemes_are_dropped_rather_than_failing_the_reply() {
        let vocab: std::collections::HashMap<String, i64> =
            [("h".to_string(), 1i64), ("i".to_string(), 2i64)].into_iter().collect();
        assert_eq!(tokenize("hi", &vocab), vec![1, 2]);
        // espeak emits stress marks the model was not trained on.
        assert_eq!(tokenize("hˈi", &vocab), vec![1, 2]);
        assert!(tokenize("ˈˌː", &vocab).is_empty());
    }

    #[test]
    fn the_vocabulary_comes_from_the_file_and_an_empty_one_is_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let good = dir.path().join("tokenizer.json");
        std::fs::write(&good, br#"{"model":{"vocab":{"$":0,"h":1}}}"#).unwrap();
        assert_eq!(load_vocab(&good).unwrap().get("h"), Some(&1));

        // An empty vocabulary tokenises every reply to nothing and synthesises
        // silence, which is indistinguishable from a working engine.
        let empty = dir.path().join("empty.json");
        std::fs::write(&empty, br#"{"model":{"vocab":{}}}"#).unwrap();
        assert!(load_vocab(&empty).is_err());

        let wrong = dir.path().join("wrong.json");
        std::fs::write(&wrong, br#"{"something":"else"}"#).unwrap();
        assert!(load_vocab(&wrong).is_err());
    }

    #[test]
    fn full_scale_samples_do_not_wrap_into_a_click() {
        let bytes = to_pcm16(&[0.0, 1.0, -1.0, 2.0, -2.0]);
        let read = |i: usize| i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]);
        assert_eq!(read(1), i16::MAX);
        assert_eq!(read(3), i16::MAX, "an overshoot must clamp, not wrap");
        assert_eq!(read(4), -i16::MAX, "an undershoot must clamp, not wrap");
    }

    #[test]
    fn a_missing_voice_is_named_in_the_error() {
        let err = synthesize_blocking("zz_nobody", "hello", 1.0).unwrap_err().to_string();
        assert!(err.contains("not downloaded"), "{err}");
        assert!(err.contains("zz_nobody"), "the error must say which voice: {err}");
    }
}
