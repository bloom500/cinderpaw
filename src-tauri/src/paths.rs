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

pub fn settings_path() -> PathBuf {
    feral_dir().join("settings.json")
}

pub fn ensure_dirs() -> anyhow::Result<()> {
    std::fs::create_dir_all(models_dir())?;
    std::fs::create_dir_all(agents_dir())?;
    Ok(())
}
