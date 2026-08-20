use std::path::PathBuf;

/// Root of all Feral on-disk state. Defaults to `~/.feral`.
///
/// Honors the `FERAL_HOME` environment variable when set: its value is
/// used as the `.feral` root verbatim (no `.feral` suffix appended), so
/// `FERAL_HOME=/tmp/x` puts the RSI substrate at `/tmp/x/rsi`. Two uses:
///
/// 1. **Relocatable data dir** for portable installs / custom storage.
/// 2. **Hermetic tests** — the RSI test suite points this at a `TempDir`
///    so it never writes into the developer's real `~/.feral/rsi`.
///
/// This does NOT weaken the bounded-RSI boundary. The variable is read
/// in-process by the Rust host that owns the sandbox. The agent runs as
/// a separate sidecar subprocess; it inherits env at spawn and has no
/// API to mutate the host's environment afterward, so it cannot redirect
/// the sandbox root by setting `FERAL_HOME`.
pub fn feral_dir() -> PathBuf {
    // Both names are honoured — see `crate::env`. Someone who set FERAL_HOME in
    // a shell profile a year ago must not find the app quietly ignoring it.
    if let Some(over) = crate::env::env_var_os("FERAL_HOME") {
        if !over.is_empty() {
            return PathBuf::from(over);
        }
    }
    let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(crate::brand::APP_HOME_DIR_NAME)
}

pub fn models_dir() -> PathBuf {
    feral_dir().join("models")
}

pub fn agents_dir() -> PathBuf {
    feral_dir().join("agents")
}

pub fn skills_dir() -> PathBuf {
    feral_dir().join("skills")
}

pub fn conversations_dir() -> PathBuf {
    feral_dir().join("conversations")
}

pub fn settings_path() -> PathBuf {
    feral_dir().join("settings.json")
}

pub fn cinderpaw_agent_dir() -> PathBuf {
    feral_dir().join("agent")
}

pub fn cinderpaw_agent_db_path() -> PathBuf {
    cinderpaw_agent_dir().join("feral.db")
}

pub fn cinderpaw_agent_workspace_path() -> PathBuf {
    feral_dir().join("workspace")
}

pub fn whisper_dir() -> PathBuf {
    feral_dir().join("whisper")
}

pub fn voice_dir() -> PathBuf {
    feral_dir().join("voice")
}

/// Downloaded Piper voices — one `.onnx` and one `.onnx.json` per voice.
pub fn piper_dir() -> PathBuf {
    feral_dir().join("piper")
}

/// Kokoro's model, tokenizer and voice packs, mirroring the repo's own layout
/// (`onnx/…`, `voices/…`) so it is obvious on disk where a file came from.
pub fn kokoro_dir() -> PathBuf {
    feral_dir().join("kokoro")
}

/// HuggingFace repo hosting Piper voices (MIT).
pub const PIPER_VOICES_REPO: &str = "rhasspy/piper-voices";

/// Romanian voices the official repo does not have: `(voice id, repo, directory)`.
///
/// `rhasspy/piper-voices` ships exactly one Romanian voice, `ro_RO-mihai-medium`,
/// male and medium quality. For a product whose users speak Romanian that is not
/// a catalogue, it is a single option, so these community-trained ones are
/// offered beside it.
///
/// A table and not a rule, because their layout does not follow one: `lili-high`
/// sits under `voices/lili-high/` but `raluca-high` sits under `voices/raluca/`.
/// Any derivation that fits four of the five 404s on the fifth, and a 404 here
/// downloads an error page into a `.onnx` file that fails much later inside ONNX.
///
/// Licence: **CC BY-NC 4.0**, trained on research-only data — unlike the MIT
/// official repo. The credit the licence requires rides along in
/// [`PIPER_EXTRA_VOICES_CREDIT`] so it cannot drift from what it credits.
pub const PIPER_EXTRA_VOICES: &[(&str, &str, &str)] = &[
    ("ro_RO-raluca-high", "eduardem/piper-tts-romanian", "voices/raluca"),
    ("ro_RO-lili-high", "eduardem/piper-tts-romanian", "voices/lili-high"),
    ("ro_RO-lili-medium", "eduardem/piper-tts-romanian", "voices/lili"),
    ("ro_RO-sanda-high", "eduardem/piper-tts-romanian", "voices/sanda-high"),
    ("ro_RO-sanda-medium", "eduardem/piper-tts-romanian", "voices/sanda"),
];

/// Attribution for [`PIPER_EXTRA_VOICES`], required by their licence.
pub const PIPER_EXTRA_VOICES_CREDIT: &str =
    "Voices by eduardem (piper-tts-romanian), CC BY-NC 4.0";

/// Where a voice's bytes come from: the repo, and the path inside it.
///
/// Separate from [`piper_voice_path`] on purpose — that one answers where the
/// file goes, this one answers where it is fetched from, and for a community
/// voice those two differ.
pub fn piper_source(voice: &str, ext: &str) -> Option<(&'static str, String)> {
    if let Some((_, repo, dir)) = PIPER_EXTRA_VOICES.iter().find(|(id, _, _)| *id == voice) {
        return Some((*repo, format!("{dir}/{voice}.onnx{ext}")));
    }
    Some((PIPER_VOICES_REPO, piper_repo_path(voice, ext)?))
}

/// Repo-relative path of a voice file inside `rhasspy/piper-voices`.
///
/// The repo nests by language: `ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx`.
/// That layout is derivable from the voice id itself, so a voice is one string
/// everywhere — settings, download, and disk — instead of four fields that can
/// disagree.
///
/// `ro_RO-mihai-medium` → `ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx`
pub fn piper_repo_path(voice: &str, ext: &str) -> Option<String> {
    let mut parts = voice.split('-');
    let locale = parts.next()?; // ro_RO
    let name = parts.next()?; // mihai
    let quality = parts.next()?; // medium
    let lang = locale.split('_').next()?; // ro
    if parts.next().is_some() || lang.is_empty() {
        return None; // not a voice id we can place in the repo
    }
    Some(format!("{lang}/{locale}/{name}/{quality}/{voice}.onnx{ext}"))
}

/// Absolute path of a downloaded voice's model file, mirroring the repo layout
/// on disk so it is obvious where a file came from and a re-download lands in
/// the same place. `None` for a voice id that cannot be placed — refused rather
/// than turned into a plausible path that will never exist.
pub fn piper_voice_path(voice: &str) -> Option<PathBuf> {
    piper_repo_path(voice, "").map(|rel| piper_dir().join(rel))
}

/// The `.onnx.json` config that sits beside the model — Piper's own naming.
pub fn piper_config_path(voice: &str) -> Option<PathBuf> {
    piper_repo_path(voice, ".json").map(|rel| piper_dir().join(rel))
}

// ── RSI (Fractal Memory System) ────────────────────────────────────────────────
// All RSI state lives under ~/.feral/rsi/. The git substrate at .git/ holds
// every genome commit; the eval/ tree holds the frozen Tier 0/1/2 tasks; the
// meta/ dir holds PBT state and taste_vector. The agent has no write path to
// any of these directories — every write is mediated by Rust commands in
// src/rsi/commands.rs after SandboxBounds validation.

/// Root of the RSI substrate.
pub fn rsi_dir() -> PathBuf {
    feral_dir().join("rsi")
}

/// `~/.feral/rsi/eval/<tier>/` — frozen evaluation suite per tier.
/// Tier 0 frozen permanently. Tier 1 frozen per epoch. Tier 2 human-gated.
pub fn rsi_eval_dir(tier: u8) -> PathBuf {
    rsi_dir().join("eval").join(format!("tier{}", tier))
}

/// `~/.feral/rsi/genomes/` — per-commit snapshot of the winning genome JSON.
pub fn rsi_genomes_dir() -> PathBuf {
    rsi_dir().join("genomes")
}

/// `~/.feral/rsi/meta/pbt_state.json` — strategy-genomes + taste_vector.
/// Updated on every RatchetAdvanced by the meta-RSI handler (Faza 3.5).
pub fn rsi_meta_dir() -> PathBuf {
    rsi_dir().join("meta")
}

/// `~/.feral/rsi/sandbox_bounds.json` — the canonical, agent-immutable
/// SandboxBounds. Writes go through the hash-chained audit log.
pub fn rsi_sandbox_bounds_path() -> PathBuf {
    rsi_dir().join("sandbox_bounds.json")
}

/// `~/.feral/rsi/sandbox_bounds_audit.log` — append-only hash-chained log of
/// every mutation to sandbox_bounds.json. The chain starts at GENESIS; each
/// row carries `prev_hash` and `entry_hash = sha256(prev_hash || canonical(row))`.
pub fn rsi_sandbox_bounds_audit_path() -> PathBuf {
    rsi_dir().join("sandbox_bounds_audit.log")
}

/// `~/.feral/rsi/PLAN.md` — versioned architectural plan. Read-only for the
/// agent after bootstrap (writes require an out-of-band user confirmation).
pub fn rsi_plan_path() -> PathBuf {
    rsi_dir().join("PLAN.md")
}

/// `~/.feral/rsi/dream.jsonl` — one JSONL line per completed Dream Cycle
/// episode. Written by the sidecar (`dream-telemetry.ts`); read back by the
/// `rsi_dream_telemetry` command for the Cinderpaw's Dreams UI panel. NOTE: the
/// sidecar honors a `FERAL_RSI_TELEMETRY` override (dev/test only); the host
/// reads the default path here, which is correct for normal installs.
pub fn rsi_dream_telemetry_path() -> PathBuf {
    rsi_dir().join("dream.jsonl")
}

/// `~/.feral/rsi/journal/` — the BRSI Evolution Journal (§2.9): per-day
/// `journal-YYYY-MM-DD.jsonl` files, one semantic row per dream episode
/// (observed / decided / budget). Written by the sidecar (`journal.ts`,
/// mirroring `instance-paths.ts` journalDir); read back by
/// `rsi_journal_recent` for the receipts UI.
pub fn rsi_journal_dir() -> PathBuf {
    rsi_dir().join("journal")
}

/// HuggingFace repo hosting whisper.cpp ggml models.
pub const WHISPER_REPO: &str = "ggerganov/whisper.cpp";

/// ggml filename for a model size key ("small" | "base"). Unknown → small.
pub fn whisper_filename(size: &str) -> &'static str {
    match size {
        "base" => "ggml-base.bin",
        _ => "ggml-small.bin",
    }
}

/// Absolute path where the whisper ggml model for `size` is stored.
pub fn whisper_model_path(size: &str) -> PathBuf {
    whisper_dir().join(whisper_filename(size))
}

/// HuggingFace repo + filename for the embedding model used by Fractal Memory
/// Search. Default: BGE-M3 (Q8_0 GGUF, ~600 MB) — multilingual, 1024-dim, an
/// 8192-token window; markedly stronger recall than the old bge-small (384d).
/// Lives in the shared models dir like chat models. `n_embd` is read from the
/// model at load, so swapping the model needs no code change beyond these two
/// constants (and a one-time re-embed, handled by FractalMemory's dim guard).
///
/// NOTE: repo coordinates pinned from documentation; confirm against the live
/// HF repo before shipping — a mismatch is a one-line fix (the FILENAME must
/// match what the Models tab downloads into the models dir).
pub const EMBED_REPO: &str = "gpustack/bge-m3-GGUF";
pub const EMBED_FILENAME: &str = "bge-m3-Q8_0.gguf";

/// Absolute path where the embedding model GGUF is stored.
pub fn embedding_model_path() -> PathBuf {
    models_dir().join(EMBED_FILENAME)
}

pub fn ensure_dirs() -> anyhow::Result<()> {
    std::fs::create_dir_all(models_dir())?;
    std::fs::create_dir_all(agents_dir())?;
    std::fs::create_dir_all(conversations_dir())?;
    std::fs::create_dir_all(skills_dir())?;
    std::fs::create_dir_all(cinderpaw_agent_dir())?;
    std::fs::create_dir_all(cinderpaw_agent_workspace_path())?;
    std::fs::create_dir_all(whisper_dir())?;
    std::fs::create_dir_all(voice_dir())?;
    // RSI substrate — created here so the bootstrap path is a no-op on
    // subsequent launches. Contents (.git, eval/, PLAN.md, …) are populated
    // by rsi::bootstrap().
    std::fs::create_dir_all(rsi_dir())?;
    std::fs::create_dir_all(rsi_meta_dir())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whisper_filename_defaults_to_small() {
        assert_eq!(whisper_filename("small"), "ggml-small.bin");
        assert_eq!(whisper_filename("base"), "ggml-base.bin");
        assert_eq!(whisper_filename("garbage"), "ggml-small.bin");
    }

    #[test]
    fn piper_repo_path_derives_the_nested_layout_from_the_voice_id() {
        assert_eq!(
            piper_repo_path("ro_RO-mihai-medium", "").unwrap(),
            "ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx"
        );
        assert_eq!(
            piper_repo_path("en_US-amy-low", ".json").unwrap(),
            "en/en_US/amy/low/en_US-amy-low.onnx.json"
        );
    }

    #[test]
    fn a_community_voice_is_fetched_from_its_own_repo_but_stored_canonically() {
        let (repo, rel) = piper_source("ro_RO-raluca-high", "").unwrap();
        assert_eq!(repo, "eduardem/piper-tts-romanian");
        assert_eq!(rel, "voices/raluca/ro_RO-raluca-high.onnx");
        // Where it LANDS is the same layout as every other voice — the whole
        // point of keeping source and destination apart.
        assert!(piper_voice_path("ro_RO-raluca-high")
            .unwrap()
            .ends_with("ro/ro_RO/raluca/high/ro_RO-raluca-high.onnx"));
    }

    #[test]
    fn the_community_repo_layout_is_read_from_the_table_not_guessed() {
        // `lili-high` is under `voices/lili-high/` but `raluca-high` is under
        // `voices/raluca/`. A rule derived from the id gets one of these wrong.
        assert_eq!(
            piper_source("ro_RO-lili-high", ".json").unwrap().1,
            "voices/lili-high/ro_RO-lili-high.onnx.json"
        );
        assert_eq!(
            piper_source("ro_RO-sanda-medium", "").unwrap().1,
            "voices/sanda/ro_RO-sanda-medium.onnx"
        );
    }

    #[test]
    fn a_voice_not_in_the_table_still_comes_from_the_official_repo() {
        let (repo, rel) = piper_source("ro_RO-mihai-medium", "").unwrap();
        assert_eq!(repo, PIPER_VOICES_REPO);
        assert_eq!(rel, "ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx");
        assert!(piper_source("mihai", "").is_none());
    }

    #[test]
    fn a_voice_id_that_is_not_three_parts_is_refused_not_guessed() {
        // Building a wrong URL would download a 404 page into a .onnx file and
        // fail much later, inside ONNX, with an error about the model.
        assert!(piper_repo_path("mihai", "").is_none());
        assert!(piper_repo_path("ro_RO-mihai", "").is_none());
        assert!(piper_repo_path("ro_RO-mihai-medium-extra", "").is_none());
    }

    #[test]
    fn whisper_model_path_is_under_whisper_dir() {
        let p = whisper_model_path("small");
        assert!(p.ends_with("ggml-small.bin"));
        assert_eq!(p.parent().unwrap(), whisper_dir());
    }
}
