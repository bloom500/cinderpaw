use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::paths;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SourceProvider {
    Local,
    GitHub,
    ClawHub,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TrustLabel {
    Bundled,
    Local,
    Verified,
    Community,
    Experimental,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum InstallStatus {
    Installed,
    NotInstalled,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SkillMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub version: String,
    pub license: String,
    pub tags: Vec<String>,
    pub source_provider: SourceProvider,
    pub source_url: Option<String>,
    pub content_url: Option<String>,
    pub install_status: InstallStatus,
    pub trust_label: TrustLabel,
    pub last_updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SkillPreview {
    pub meta: SkillMeta,
    pub content: String,
}

// ── Validation ────────────────────────────────────────────────────────────────

/// Only allow safe slugs: lowercase letters, digits, hyphens, underscores.
pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() {
        bail!("skill id must not be empty");
    }
    if !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
        bail!("skill id '{}' contains invalid characters (only a-z, 0-9, -, _ allowed)", id);
    }
    Ok(())
}

/// Resolve the skills dir entry for `id` and assert it stays inside skills_dir().
pub fn skill_path(id: &str) -> Result<std::path::PathBuf> {
    validate_id(id)?;
    paths::ensure_dirs()?;
    let base = paths::skills_dir();
    let base_canon = base.canonicalize()?;
    let joined = base_canon.join(id);
    if !joined.starts_with(&base_canon) {
        bail!("path traversal detected for id '{}'", id);
    }
    Ok(base.join(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_id_accepted() {
        assert!(validate_id("systematic-debugging").is_ok());
        assert!(validate_id("my_skill_01").is_ok());
    }

    #[test]
    fn invalid_ids_rejected() {
        assert!(validate_id("").is_err());
        assert!(validate_id("../evil").is_err());
        assert!(validate_id("Has Spaces").is_err());
        assert!(validate_id("CamelCase").is_err());
        assert!(validate_id("../../etc/passwd").is_err());
    }
}
