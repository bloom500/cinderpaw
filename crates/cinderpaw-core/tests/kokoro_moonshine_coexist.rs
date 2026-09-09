//! The coexistence measurement, and the one thing everything else waits on.
//!
//! Whisper has never shipped because `whisper-rs-sys` and `llama-cpp-sys-2`
//! each statically link ggml, so the two cannot be in one binary at all.
//! Moonshine avoids that, but it swaps a LINK-time question for a LOAD-time
//! one: Moonshine unpacks its own `onnxruntime.dll` (1.17.1) and `ort` copies a
//! newer one beside the binary, and a Windows process loads exactly one file of
//! a given name. Whichever wins has to satisfy both.
//!
//! Everything before this test only showed that they LINK. This one makes both
//! do real work in one process, in the order the product does it:
//!
//!   Kokoro speaks a sentence -> the samples are resampled to 16 kHz ->
//!   Moonshine transcribes them -> Kokoro speaks again, AFTER Moonshine has
//!   loaded its runtime.
//!
//! That last step is the actual risk. If Moonshine's older runtime wins the
//! load, the failure is not a crash at startup, it is a Kokoro session that
//! stops working halfway through a call.
//!
//! ## Running it
//!
//! Ignored by design: it needs ~130 MB of weights on disk and a minute of CPU,
//! and CI has neither. It is not a test that passes when it is skipped, it is
//! one that reports "not run".
//!
//! ```text
//! cargo test -p cinderpaw-core --features kokoro,moonshine \
//!     --test kokoro_moonshine_coexist -- --ignored --nocapture
//! ```
//!
//! Kokoro's model must already be downloaded (the app does that from Settings);
//! the Moonshine model this fetches itself, which measures `download_model` on
//! the way past.
#![cfg(all(feature = "kokoro", feature = "moonshine"))]

use cinderpaw_core::moonshine::{self, Arch};
use cinderpaw_core::paths;
use cinderpaw_core::tts::{self, kokoro, EngineConfig, SpeechRequest, TtsProvider};

/// Short, and every word ordinary. A name Moonshine has never seen would
/// measure its vocabulary rather than whether the two runtimes coexist.
const SENTENCE: &str = "The quick brown fox jumps over the lazy dog.";

const ARCH: Arch = Arch::TinyStreaming;

/// Speak `text` through the real provider and collect the PCM16 it streams.
async fn speak(text: &str) -> Vec<u8> {
    let engine = kokoro::KokoroTts::new(&EngineConfig {
        api_key: "",
        base_url: None,
        model: Some(kokoro::DEFAULT_VOICE),
    });
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let req = SpeechRequest { text: text.to_string(), voice: None };
    let pump = tokio::spawn(async move {
        let mut out = Vec::new();
        while let Some(chunk) = rx.recv().await {
            out.extend_from_slice(&chunk);
        }
        out
    });
    engine.speak(&req, tx).await.expect("Kokoro synthesis");
    pump.await.expect("collect the streamed audio")
}

/// PCM16 at Kokoro's 24 kHz -> f32 at Moonshine's 16 kHz.
///
/// Linear interpolation, which is enough at a 3:2 ratio for speech a model has
/// to recognise rather than a human has to enjoy.
/// ponytail: linear is fine here; a windowed-sinc resampler if the transcript
/// ever comes back worse than the same audio resampled by ffmpeg.
fn to_16k_mono(pcm16: &[u8]) -> Vec<f32> {
    let src: Vec<f32> = pcm16
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();
    let ratio = tts::SAMPLE_RATE as f32 / 16_000.0;
    let out_len = (src.len() as f32 / ratio) as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f32 * ratio;
            let a = pos as usize;
            let b = (a + 1).min(src.len().saturating_sub(1));
            let frac = pos - a as f32;
            src[a] * (1.0 - frac) + src[b] * frac
        })
        .collect()
}

/// Lowercase, letters and spaces only, so punctuation and casing cannot fail a
/// transcript that is otherwise correct.
fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

#[tokio::test]
#[ignore = "needs ~130 MB of downloaded weights and about a minute of CPU"]
async fn kokoro_and_moonshine_both_work_in_one_process() {
    // Kokoro's weights are not fetched here: the app downloads them from
    // Settings, and a test that silently pulls 86 MB from HuggingFace is a
    // surprise. Name the file the user has to get instead.
    assert!(
        kokoro::voice_present(kokoro::DEFAULT_VOICE) && kokoro::model_path().exists(),
        "download the Kokoro model first (Settings -> Voice). Expected {} and \
         the voice {}",
        kokoro::model_path().display(),
        kokoro::DEFAULT_VOICE
    );

    let model_dir = paths::moonshine_dir().join(ARCH.id());
    if !moonshine::model_present(&model_dir, ARCH) {
        eprintln!("[0] fetching the Moonshine {} model into {}", ARCH.id(), model_dir.display());
        moonshine::download_model(&model_dir, ARCH, |_| {}, || false)
            .await
            .expect("download the Moonshine model");
    }
    assert!(
        moonshine::model_present(&model_dir, ARCH),
        "the Moonshine model is still incomplete after downloading it"
    );

    // 1. ort's runtime loads here, for Kokoro.
    let first = speak(SENTENCE).await;
    assert!(!first.is_empty(), "Kokoro produced no audio at all");
    eprintln!("[1] kokoro spoke {} bytes of PCM16", first.len());

    // 2. Moonshine loads its model into whichever runtime won.
    let samples = to_16k_mono(&first);
    let dir = model_dir.clone();
    let transcript =
        tokio::task::spawn_blocking(move || moonshine::transcribe_pcm(&samples, &dir, ARCH))
            .await
            .expect("the transcription task panicked")
            .expect("Moonshine transcription");
    eprintln!("[2] moonshine heard: {transcript:?}");

    let heard = words(&transcript);
    let expected = words(SENTENCE);
    let hits = expected.iter().filter(|w| heard.contains(w)).count();
    assert!(
        hits * 4 >= expected.len() * 3,
        "Moonshine only recovered {hits} of {} words from Kokoro's audio: {transcript:?}. \
         Both engines ran, so this is an audio or accuracy problem rather than a \
         runtime collision.",
        expected.len()
    );

    // 3. The real question: Kokoro again, now that Moonshine has loaded its own
    // ONNX Runtime into this process. A version clash shows up here, not at
    // startup.
    let second = speak("Still here.").await;
    assert!(
        !second.is_empty(),
        "Kokoro produced audio before Moonshine loaded and nothing after it. \
         That is the runtime collision this whole test exists to catch."
    );
    eprintln!("[3] kokoro spoke again after moonshine: {} bytes", second.len());
}

