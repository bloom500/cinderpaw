//! Which on-device transcriber this build has, and how to reach it.
//!
//! There are two doors into local speech-to-text and they were separate
//! implementations of the same decision: the Tauri command `transcribe_audio`,
//! used by voice messages, and the HTTP route `/runtime/voice/transcribe`,
//! which is how a LiveKit call hears you. Both hard-coded whisper and both
//! hard-coded the model id `"small"`. Teaching one of them about a second
//! engine would have left the other deaf on the same machine, and the symptom
//! would have been "voice messages work, calls do not", which reads as a call
//! bug.
//!
//! So the decision lives here once, and both doors ask.
//!
//! Nothing in this module is feature-gated as a whole. A build with no STT
//! feature compiles it to an empty catalog, which is the honest answer and the
//! one `stt_local_available` is derived from — rather than a `cfg!` in the
//! frontend, which ships as one bundle for every build and cannot know.

use anyhow::{bail, Result};

/// One model this build can actually load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    /// Stable id. Names a file or a directory on disk and travels over IPC.
    pub id: &'static str,
    /// What a person reads in the picker. Names the engine, because on-device
    /// transcription is not the same product on two different engines.
    pub label: &'static str,
    /// Roughly what the download costs, in MB.
    pub size_mb: u32,
}

/// The models this build offers, best-first. Empty means this binary cannot
/// transcribe on the machine at all.
pub fn models() -> Vec<Model> {
    #[allow(unused_mut)]
    let mut out = Vec::new();

    #[cfg(feature = "moonshine")]
    {
        use crate::moonshine::Arch;
        for (arch, label, size_mb) in [
            (Arch::TinyStreaming, "Moonshine Tiny (fastest)", 45u32),
            (Arch::SmallStreaming, "Moonshine Small (more accurate)", 190),
            (Arch::MediumStreaming, "Moonshine Medium (most accurate)", 570),
        ] {
            out.push(Model { id: arch.id(), label, size_mb });
        }
    }

    #[cfg(feature = "whisper")]
    {
        out.push(Model { id: "base", label: "Whisper Base (lighter)", size_mb: 142 });
        out.push(Model { id: "small", label: "Whisper Small (more accurate)", size_mb: 466 });
    }

    out
}

/// Whether `id` is one this build knows at all. Says nothing about the disk.
pub fn is_known(id: &str) -> bool {
    models().iter().any(|m| m.id == id)
}

/// Every file of `id` present and the right size.
///
/// Size, not just presence: a download interrupted halfway leaves a short file
/// that exists, and a present-but-truncated model fails inside the native
/// library with a message nobody can act on.
pub fn model_present(id: &str) -> bool {
    #[cfg(feature = "moonshine")]
    {
        use crate::moonshine::{self, Arch};
        if let Ok(arch) = Arch::from_id(id) {
            return moonshine::model_present(&model_dir(arch), arch);
        }
    }

    #[cfg(feature = "whisper")]
    {
        if matches!(id, "base" | "small") {
            return crate::paths::whisper_model_path(id).exists();
        }
    }

    let _ = id;
    false
}

/// Where a Moonshine model lives: one directory of eight files, named by id.
#[cfg(feature = "moonshine")]
pub fn model_dir(arch: crate::moonshine::Arch) -> std::path::PathBuf {
    crate::paths::moonshine_dir().join(arch.id())
}

/// The id a caller should use when it has a stored preference (possibly from a
/// build with a different engine) and needs one that works here.
///
/// A stored id from another build is the ordinary case, not an edge one: an
/// install that used whisper has `"small"` saved, and a Moonshine build has no
/// such model. Reaching for it produces "model-missing" forever, with a
/// settings row that looks correct.
pub fn resolve(preferred: Option<&str>) -> Option<&'static str> {
    let known = models();
    if let Some(p) = preferred {
        if let Some(m) = known.iter().find(|m| m.id == p) {
            return Some(m.id);
        }
    }
    known.first().map(|m| m.id)
}

/// Transcribe 16 kHz mono f32 PCM with the on-device model `id`.
///
/// Blocking and CPU-bound: call it from `spawn_blocking`. Both callers do.
pub fn transcribe(samples: &[f32], id: &str) -> Result<String> {
    #[cfg(feature = "moonshine")]
    {
        use crate::moonshine::{self, Arch};
        if let Ok(arch) = Arch::from_id(id) {
            return moonshine::transcribe_pcm(samples, &model_dir(arch), arch);
        }
    }

    #[cfg(feature = "whisper")]
    {
        if matches!(id, "base" | "small") {
            return crate::transcription::transcribe_pcm(
                samples,
                &crate::paths::whisper_model_path(id),
            );
        }
    }

    let _ = samples;
    // Named rather than silently empty. An empty transcript is what a person
    // who said nothing produces, and this is a build that cannot listen.
    bail!(
        "this build has no on-device transcriber for {id:?} (it offers: {})",
        if models().is_empty() {
            "none".to_string()
        } else {
            models().iter().map(|m| m.id).collect::<Vec<_>>().join(", ")
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of the module: one answer, and it matches itself.
    #[test]
    fn every_offered_model_is_known_and_resolvable() {
        for m in models() {
            assert!(is_known(m.id), "{} is offered but not known", m.id);
            assert_eq!(resolve(Some(m.id)), Some(m.id));
        }
    }

    /// A stored id from a build with a different engine must not be handed back.
    #[test]
    fn an_id_this_build_does_not_have_falls_back_to_one_it_does() {
        let first = models().first().map(|m| m.id);
        assert_eq!(resolve(Some("a-model-from-another-build")), first);
        assert_eq!(resolve(None), first);
    }

    /// A build with no STT feature must say so instead of naming a model that
    /// would fail on first use.
    #[test]
    fn a_build_with_no_engine_offers_nothing() {
        let has_engine = cfg!(feature = "whisper") || cfg!(feature = "moonshine");
        assert_eq!(models().is_empty(), !has_engine);
        if !has_engine {
            assert_eq!(resolve(Some("small")), None);
            assert!(transcribe(&[0.0; 16], "small").is_err());
        }
    }

    #[test]
    fn an_unknown_id_names_what_is_on_offer() {
        let err = transcribe(&[0.0; 16], "not-a-model").unwrap_err().to_string();
        assert!(err.contains("not-a-model"), "{err}");
        assert!(err.contains("it offers"), "the way out belongs in the message: {err}");
    }
}
