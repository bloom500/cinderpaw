//! On-device speech-to-text via whisper.cpp (whisper-rs).
//! Feature-gated behind `whisper`, mirroring the `inference` gate on llama.cpp.
#![cfg(feature = "whisper")]

use anyhow::{Context, Result};
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Transcribe 16 kHz mono f32 PCM samples to text using the ggml model at `model_path`.
/// Language is auto-detected. Returns the concatenated, trimmed transcript.
pub fn transcribe_pcm(samples: &[f32], model_path: &Path) -> Result<String> {
    let ctx = WhisperContext::new_with_params(
        &model_path.to_string_lossy(),
        WhisperContextParameters::default(),
    )
    .context("failed to load whisper model")?;

    let mut state = ctx.create_state().context("failed to create whisper state")?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    state.full(params, samples).context("whisper inference failed")?;

    let n = state.full_n_segments().context("failed to count segments")?;
    let mut out = String::new();
    for i in 0..n {
        out.push_str(&state.full_get_segment_text(i).context("failed to read segment")?);
    }
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn read_wav_f32(path: &Path) -> Vec<f32> {
        // Minimal 16-bit PCM WAV reader: skip the 44-byte canonical header,
        // interpret the rest as little-endian i16, normalize to [-1, 1].
        let bytes = std::fs::read(path).unwrap();
        bytes[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect()
    }

    #[test]
    #[ignore = "requires WHISPER_TEST_MODEL env var pointing at a ggml model"]
    fn transcribes_known_sample() {
        let model = std::env::var("WHISPER_TEST_MODEL").expect("set WHISPER_TEST_MODEL");
        let wav = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/jfk_16k_mono.wav");
        let samples = read_wav_f32(&wav);
        let text = transcribe_pcm(&samples, Path::new(&model)).unwrap().to_lowercase();
        assert!(text.contains("country"), "got: {text}");
    }
}
