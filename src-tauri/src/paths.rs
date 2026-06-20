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
    if let Some(over) = std::env::var_os("FERAL_HOME") {
        if !over.is_empty() {
            return PathBuf::from(over);
        }
    }
    let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".feral")
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

pub fn feral_agent_dir() -> PathBuf {
    feral_dir().join("agent")
}

pub fn feral_agent_db_path() -> PathBuf {
    feral_agent_dir().join("feral.db")
}

pub fn feral_agent_workspace_path() -> PathBuf {
    feral_dir().join("workspace")
}

pub fn whisper_dir() -> PathBuf {
    feral_dir().join("whisper")
}

pub fn voice_dir() -> PathBuf {
    feral_dir().join("voice")
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

/// HuggingFace repo + filename for the bundled embedding model (bge-small,
/// Q8_0 GGUF — ~130 MB, used by Fractal Memory Search). Lives in the shared
/// models dir like chat models.
///
/// NOTE: pinned from documentation, NOT verified against the live HF repo
/// (no network at authoring time). Confirm these coordinates before shipping;
/// a mismatch is a one-line fix.
pub const EMBED_REPO: &str = "CompendiumLabs/bge-small-en-v1.5-gguf";
pub const EMBED_FILENAME: &str = "bge-small-en-v1.5-q8_0.gguf";

/// Absolute path where the embedding model GGUF is stored.
pub fn embedding_model_path() -> PathBuf {
    models_dir().join(EMBED_FILENAME)
}

pub fn ensure_dirs() -> anyhow::Result<()> {
    std::fs::create_dir_all(models_dir())?;
    std::fs::create_dir_all(agents_dir())?;
    std::fs::create_dir_all(conversations_dir())?;
    std::fs::create_dir_all(skills_dir())?;
    std::fs::create_dir_all(feral_agent_dir())?;
    std::fs::create_dir_all(feral_agent_workspace_path())?;
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
    fn whisper_model_path_is_under_whisper_dir() {
        let p = whisper_model_path("small");
        assert!(p.ends_with("ggml-small.bin"));
        assert_eq!(p.parent().unwrap(), whisper_dir());
    }
}
