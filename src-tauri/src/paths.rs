use std::path::PathBuf;

pub fn feral_dir() -> PathBuf {
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

pub fn ensure_dirs() -> anyhow::Result<()> {
    std::fs::create_dir_all(models_dir())?;
    std::fs::create_dir_all(agents_dir())?;
    std::fs::create_dir_all(conversations_dir())?;
    std::fs::create_dir_all(skills_dir())?;
    std::fs::create_dir_all(feral_agent_dir())?;
    std::fs::create_dir_all(feral_agent_workspace_path())?;
    std::fs::create_dir_all(whisper_dir())?;
    std::fs::create_dir_all(voice_dir())?;
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
