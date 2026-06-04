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

pub fn ensure_dirs() -> anyhow::Result<()> {
    std::fs::create_dir_all(models_dir())?;
    std::fs::create_dir_all(agents_dir())?;
    std::fs::create_dir_all(conversations_dir())?;
    std::fs::create_dir_all(skills_dir())?;
    std::fs::create_dir_all(feral_agent_dir())?;
    std::fs::create_dir_all(feral_agent_workspace_path())?;
    Ok(())
}
