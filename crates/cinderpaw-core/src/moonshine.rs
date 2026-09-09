//! On-device speech-to-text via Moonshine.
//!
//! ## Why this exists next to `transcription.rs` rather than replacing it
//!
//! Local transcription has never shipped. `transcription.rs` works, and the
//! `whisper` feature is on no release job, because `whisper-rs-sys` and
//! `llama-cpp-sys-2` each **statically** link their own copy of ggml: enabling
//! both puts two definitions of every ggml symbol in one binary and the link
//! fails (`LNK2005: ggml_abort already defined`). That is not a flag to flip.
//! Settings has offered an on-device transcription picker the whole time, and
//! `transcribe_audio` has answered `voice-unavailable` to every build we ship.
//!
//! Moonshine is not ggml. It rides ONNX Runtime, which Kokoro already uses, and
//! the two coexist — measured on 2026-09-09, running rather than merely
//! linking, with an `ort` session and a Moonshine model live in one process:
//!
//! ```text
//! [1] ort initialised (onnxruntime.dll loaded)
//! [3] moonshine loaded, version 30000
//! GOT: "Hello.\nI am Cinderpah.\nThis is a test of local transcription…"
//! ```
//!
//! They do not collide the way whisper and llama.cpp do. That failure is a
//! LINK-time one: two static copies of ggml put two definitions of the same
//! symbol in one binary and the linker refuses. Neither of these is static in
//! that sense — `ort` fetches `onnxruntime.dll` and copies it beside the binary
//! (`download-binaries` + `copy-dylibs`), and `moonshine-sys` declares
//! `rustc-link-lib=static=onnxruntime` but the prebuilt it unpacks contains an
//! `onnxruntime.dll` too. So there is nothing for the linker to reject, and the
//! question moves to load time instead — see the open question below.
//!
//! `transcribe_pcm` deliberately takes the same shape as the whisper one —
//! 16 kHz mono `f32` and a path — so the caller does not learn which engine it
//! got.
//!
//! ## Licence
//!
//! `moonshine-rs` and `moonshine-sys` are MIT OR Apache-2.0, and the native
//! `libmoonshine` they fetch is MIT. **The weights are not uniformly MIT**, and
//! this is the trap: upstream keeps the *legacy non-streaming* models for
//! languages other than English under the non-commercial Moonshine Community
//! License. `Arch` below therefore exposes streaming variants only, and
//! `LANGUAGE` is pinned to English — so a build of Cinderpaw cannot reach a
//! non-commercial model by picking a different string in Settings.
//!
//! One thing accepted with eyes open: `moonshine-sys`'s build script downloads a
//! prebuilt `libmoonshine` tarball from GitHub releases and extracts it with no
//! checksum verification. That is the same risk `ort` already carries for ONNX
//! Runtime itself, so this is the second time rather than the first.
//!
//! ## Open question, and why nothing enables this yet
//!
//! Moonshine ships its own `onnxruntime.dll` (1.17.1) and `ort` copies a newer
//! one beside the binary. **A Windows process loads one file of a given name**,
//! so one of them serves both. Three observations, and an inference that is not
//! yet a measurement:
//!
//! * A scratch binary with an `ort` session and a Moonshine transcription in
//!   one process worked, and printed no complaint.
//! * This crate's tests with `moonshine` alone print `The requested API version
//!   [23] is not available, only API versions [1, 17] are supported in this
//!   build. Current ORT Version is: 1.17.1`.
//! * The same tests with `kokoro,moonshine` print nothing.
//!
//! That reads as "ort's newer runtime wins and satisfies both", which is the
//! outcome we want — but these tests never load a model, so what has been shown
//! is that the two link together, not that both run under load inside the
//! product. Until a build loads a Kokoro voice and a Moonshine model in one
//! process, `moonshine` stays off everywhere and `stt_local_available` keeps
//! answering `false`. Turning it on first would put a control in Settings whose
//! only outcome might be a failure the user cannot act on, which is the exact
//! shape `transcribe_audio` has been apologising for since it was written.
#![cfg(feature = "moonshine")]

use anyhow::{anyhow, bail, Context, Result};
use std::path::Path;

use moonshine_rs::{
    get_stt_dependencies_with_options, ModelArch, SttDependenciesOptions, Transcriber,
};

/// Moonshine's weights are MIT in every language **except** the legacy
/// non-streaming ones outside English. English is the only language this
/// module asks for, which keeps that exception out of reach.
const LANGUAGE: &str = "en";

/// What the model expects. Also what the recorder produces, and what
/// `transcription.rs` takes, so nothing upstream has to change.
const SAMPLE_RATE: u32 = 16_000;

/// The model sizes offered, smallest first.
///
/// Streaming variants only, and that is a licence bound rather than a taste:
/// see the module docs. `Tiny` and `Base` (the non-streaming pair) exist
/// upstream and are MIT for English, but naming them here would put a
/// non-commercial model one string away for any other language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    /// ~45 MB on disk across eight files.
    TinyStreaming,
    SmallStreaming,
    MediumStreaming,
}

impl Arch {
    /// The id used on disk and over IPC. Kept stable: it names a directory.
    pub fn id(self) -> &'static str {
        match self {
            Arch::TinyStreaming => "tiny-streaming",
            Arch::SmallStreaming => "small-streaming",
            Arch::MediumStreaming => "medium-streaming",
        }
    }

    /// Parse an id from settings or IPC. Unknown ids are refused rather than
    /// defaulted: silently transcribing with a different model than the one
    /// configured is the kind of substitution the TTS catalog already refuses.
    pub fn from_id(id: &str) -> Result<Self> {
        match id {
            "tiny-streaming" => Ok(Arch::TinyStreaming),
            "small-streaming" => Ok(Arch::SmallStreaming),
            "medium-streaming" => Ok(Arch::MediumStreaming),
            other => bail!(
                "unknown Moonshine model {other:?}. Known: tiny-streaming, \
                 small-streaming, medium-streaming"
            ),
        }
    }

    fn native(self) -> ModelArch {
        match self {
            Arch::TinyStreaming => ModelArch::TinyStreaming,
            Arch::SmallStreaming => ModelArch::SmallStreaming,
            Arch::MediumStreaming => ModelArch::MediumStreaming,
        }
    }
}

/// One file of a model, from upstream's manifest.
#[derive(Debug, Clone)]
pub struct ModelFile {
    pub name: String,
    pub url: String,
    /// Bytes upstream says it is; `0` when the manifest omits it.
    pub size: u64,
}

/// The files a model needs, asked of upstream rather than hard-coded.
///
/// A model is a DIRECTORY of eight files here (encoder, decoder, tokenizer, a
/// streaming config…), not the single `.bin` a whisper model is. Hard-coding
/// the list would rot the first time upstream repacked it.
pub fn model_files(arch: Arch) -> Result<Vec<ModelFile>> {
    let json = get_stt_dependencies_with_options(
        LANGUAGE,
        &SttDependenciesOptions::new().with_arch(arch.native()),
    )
    .map_err(|e| anyhow!("could not read Moonshine's model manifest: {e}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&json).context("Moonshine's model manifest is not valid JSON")?;

    let mut out = Vec::new();
    for group in manifest["groups"]
        .as_array()
        .ok_or_else(|| anyhow!("Moonshine's manifest has no `groups` array"))?
    {
        for file in group["files"]
            .as_array()
            .ok_or_else(|| anyhow!("a Moonshine manifest group has no `files` array"))?
        {
            out.push(ModelFile {
                name: file["name"]
                    .as_str()
                    .ok_or_else(|| anyhow!("a Moonshine manifest file has no `name`"))?
                    .to_string(),
                url: file["url"]
                    .as_str()
                    .ok_or_else(|| anyhow!("a Moonshine manifest file has no `url`"))?
                    .to_string(),
                size: file["size"].as_u64().unwrap_or(0),
            });
        }
    }
    if out.is_empty() {
        bail!("Moonshine's manifest listed no files for {}", arch.id());
    }
    Ok(out)
}

/// Whether every file of `arch` is already on disk under `dir`.
///
/// Presence AND size, because a download interrupted halfway leaves a short
/// file that exists. A model that is present-but-truncated fails inside the
/// native library with a message nobody can act on.
pub fn model_present(dir: &Path, arch: Arch) -> bool {
    let Ok(files) = model_files(arch) else {
        return false;
    };
    files.iter().all(|f| {
        let p = dir.join(&f.name);
        match std::fs::metadata(&p) {
            Ok(m) => f.size == 0 || m.len() == f.size,
            Err(_) => false,
        }
    })
}

/// Fetch every missing file of `arch` into `dir`, reporting 0.0..=1.0 overall.
///
/// Each file is written to `<name>.part` and renamed only once complete, so an
/// interrupted download cannot leave something that looks finished. `cancel`
/// is checked between files and between chunks.
pub async fn download_model(
    dir: &Path,
    arch: Arch,
    mut progress: impl FnMut(f32),
    cancel: impl Fn() -> bool,
) -> Result<()> {
    use futures::StreamExt;

    let files = model_files(arch)?;
    std::fs::create_dir_all(dir)
        .with_context(|| format!("create the Moonshine model directory {}", dir.display()))?;

    let total: u64 = files.iter().map(|f| f.size.max(1)).sum();
    let mut done: u64 = 0;
    let client = reqwest::Client::builder()
        .user_agent("cinderpaw/0.1")
        .build()
        .context("build the HTTP client for the Moonshine download")?;

    for file in &files {
        let dest = dir.join(&file.name);
        if let Ok(m) = std::fs::metadata(&dest) {
            if file.size == 0 || m.len() == file.size {
                done += file.size.max(1);
                progress(done as f32 / total as f32);
                continue;
            }
        }
        if cancel() {
            bail!("the Moonshine download was cancelled");
        }

        let part = dest.with_extension("part");
        let mut sink = std::fs::File::create(&part)
            .with_context(|| format!("create {}", part.display()))?;
        let res = client
            .get(&file.url)
            .send()
            .await
            .with_context(|| format!("fetch {}", file.name))?
            .error_for_status()
            .with_context(|| format!("fetch {}", file.name))?;

        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel() {
                let _ = std::fs::remove_file(&part);
                bail!("the Moonshine download was cancelled");
            }
            let chunk = chunk.with_context(|| format!("{}: stream interrupted", file.name))?;
            std::io::Write::write_all(&mut sink, &chunk)
                .with_context(|| format!("write {}", part.display()))?;
            done += chunk.len() as u64;
            progress((done as f32 / total as f32).min(1.0));
        }
        drop(sink);
        std::fs::rename(&part, &dest)
            .with_context(|| format!("finish {}", dest.display()))?;
    }
    progress(1.0);
    Ok(())
}

/// Transcribe 16 kHz mono f32 PCM using the model in `model_dir`.
///
/// Blocking and CPU-bound: call it from `spawn_blocking`, exactly as the caller
/// already does for `transcription::transcribe_pcm`.
pub fn transcribe_pcm(samples: &[f32], model_dir: &Path, arch: Arch) -> Result<String> {
    if !model_dir.exists() {
        bail!(
            "the Moonshine model {} is not downloaded yet ({})",
            arch.id(),
            model_dir.display()
        );
    }
    // Silence in, silence out — without this the native library is loaded (tens
    // of MB) to answer a question the length of the input already answered.
    if samples.is_empty() {
        return Ok(String::new());
    }

    let t = Transcriber::from_files(model_dir, arch.native(), None)
        .map_err(|e| anyhow!("could not load the Moonshine model {}: {e}", arch.id()))?;
    let transcript = t
        .transcribe(samples, SAMPLE_RATE)
        .map_err(|e| anyhow!("Moonshine transcription failed: {e}"))?;
    // `text()` joins lines with newlines; a transcript is handed on as one
    // utterance, so they become spaces.
    Ok(transcript.text().split('\n').collect::<Vec<_>>().join(" ").trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_model_id_is_refused_and_the_error_lists_what_is_known() {
        let err = Arch::from_id("base").unwrap_err().to_string();
        assert!(err.contains("unknown Moonshine model"), "{err}");
        assert!(err.contains("tiny-streaming"), "the error should list the real ids: {err}");
    }

    /// Ids name directories on disk, so they are a compatibility surface.
    #[test]
    fn every_arch_round_trips_through_its_id() {
        for arch in [Arch::TinyStreaming, Arch::SmallStreaming, Arch::MediumStreaming] {
            assert_eq!(Arch::from_id(arch.id()).unwrap(), arch);
        }
    }

    /// The licence bound, asserted rather than trusted to a comment.
    ///
    /// Upstream's non-streaming archs are non-commercial outside English. If
    /// someone adds one to `Arch`, its id will not end in `-streaming` and this
    /// fails before it can ship.
    #[test]
    fn only_streaming_models_are_reachable() {
        for arch in [Arch::TinyStreaming, Arch::SmallStreaming, Arch::MediumStreaming] {
            assert!(
                arch.id().ends_with("-streaming"),
                "{} is not a streaming model; the non-streaming weights are \
                 non-commercial outside English",
                arch.id()
            );
        }
        assert_eq!(LANGUAGE, "en", "the non-commercial exception is for non-English weights");
    }

    #[test]
    fn a_missing_model_directory_is_named_in_the_error() {
        let err = transcribe_pcm(&[0.0; 16], Path::new("nope-not-here"), Arch::TinyStreaming)
            .unwrap_err()
            .to_string();
        assert!(err.contains("tiny-streaming"), "{err}");
        assert!(err.contains("nope-not-here"), "the path the user must fix: {err}");
    }

    /// Empty input must not load the model to return an empty string.
    #[test]
    fn silence_returns_early_without_touching_the_model() {
        // The directory does not exist; reaching the loader would error.
        let out = transcribe_pcm(&[], Path::new("."), Arch::TinyStreaming).unwrap();
        assert_eq!(out, "");
    }
}
