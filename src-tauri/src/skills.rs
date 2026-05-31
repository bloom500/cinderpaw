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

/// Scan ~/.feral/skills/ and return one SkillMeta per subdirectory
/// that contains a SKILL.md file.
pub fn local_list() -> Result<Vec<SkillMeta>> {
    paths::ensure_dirs()?;
    let dir = paths::skills_dir();
    let mut out = Vec::new();

    if !dir.exists() {
        return Ok(out);
    }

    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if validate_id(&id).is_err() {
            continue; // skip dirs with invalid names
        }
        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
        let mut meta = parse_frontmatter(&id, &content);
        meta.source_provider = SourceProvider::Local;
        meta.install_status = InstallStatus::Installed;
        meta.trust_label = TrustLabel::Local;
        out.push(meta);
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Read the raw SKILL.md content for an installed skill.
pub fn get_installed_content(id: &str) -> Result<String> {
    let skill_dir = skill_path(id)?;
    let skill_md = skill_dir.join("SKILL.md");
    if !skill_md.exists() {
        bail!("skill '{}' is not installed", id);
    }
    // Extra safety: confirm skill_md is inside skills_dir
    let base = paths::skills_dir();
    let base_canon = base.canonicalize().unwrap_or(base);
    let md_canon = skill_md.canonicalize()?;
    if !md_canon.starts_with(&base_canon) {
        bail!("path traversal detected");
    }
    Ok(std::fs::read_to_string(skill_md)?)
}

/// Parse SKILL.md content and extract a partial SkillMeta.
/// Unknown fields default to empty/None. The caller fills in
/// source_provider, source_url, content_url, install_status, trust_label.
pub fn parse_frontmatter(id: &str, content: &str) -> SkillMeta {
    let mut name = id.to_string();
    let mut description = String::new();
    let mut author = String::new();
    let mut version = String::from("0.0.0");
    let mut license = String::new();
    let mut tags: Vec<String> = Vec::new();
    let mut last_updated: Option<String> = None;

    // Extract the block between the first two `---` delimiters.
    let mut parts = content.splitn(3, "---");
    let _ = parts.next(); // content before first ---
    if let Some(front) = parts.next() {
        for line in front.lines() {
            let line = line.trim();
            if let Some(val) = line.strip_prefix("name:") {
                name = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("description:") {
                description = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("author:") {
                author = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("version:") {
                version = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("license:") {
                license = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("last_updated:") {
                last_updated = Some(val.trim().to_string());
            } else if let Some(val) = line.strip_prefix("tags:") {
                // Inline: tags: [foo, bar] or tags: foo, bar
                let raw = val.trim().trim_matches(|c| c == '[' || c == ']');
                tags = raw.split(',')
                    .map(|t| t.trim().trim_matches('"').trim_matches('\'').to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
            }
        }
    }

    SkillMeta {
        id: id.to_string(),
        name,
        description,
        author,
        version,
        license,
        tags,
        source_provider: SourceProvider::Local,
        source_url: None,
        content_url: None,
        install_status: InstallStatus::NotInstalled,
        trust_label: TrustLabel::Local,
        last_updated,
    }
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn list_installed_skills() -> Result<Vec<SkillMeta>, String> {
    local_list().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_installed_skill_content(id: String) -> Result<String, String> {
    get_installed_content(&id).map_err(|e| e.to_string())
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

    #[test]
    fn parses_full_frontmatter() {
        let content = "---\nname: My Skill\ndescription: Does stuff\nauthor: Alice\nversion: 1.2.3\nlicense: MIT\ntags: [debug, workflow]\n---\n# Body";
        let meta = parse_frontmatter("my-skill", content);
        assert_eq!(meta.name, "My Skill");
        assert_eq!(meta.description, "Does stuff");
        assert_eq!(meta.author, "Alice");
        assert_eq!(meta.version, "1.2.3");
        assert_eq!(meta.license, "MIT");
        assert_eq!(meta.tags, vec!["debug", "workflow"]);
        assert!(matches!(meta.source_provider, SourceProvider::Local));
        assert!(matches!(meta.install_status, InstallStatus::NotInstalled));
        assert!(matches!(meta.trust_label, TrustLabel::Local));
    }

    #[test]
    fn parses_partial_frontmatter() {
        let content = "---\nname: Minimal\n---\nBody here";
        let meta = parse_frontmatter("minimal", content);
        assert_eq!(meta.name, "Minimal");
        assert_eq!(meta.description, "");
        assert_eq!(meta.version, "0.0.0");
        assert!(meta.tags.is_empty());
    }

    #[test]
    fn handles_missing_frontmatter() {
        let content = "# Just a heading\nSome content";
        let meta = parse_frontmatter("no-front", content);
        assert_eq!(meta.name, "no-front");
    }

    #[test]
    fn parses_tags_without_brackets() {
        let content = "---\nname: X\ntags: foo, bar, baz\n---\nbody";
        let meta = parse_frontmatter("x", content);
        assert_eq!(meta.tags, vec!["foo", "bar", "baz"]);
    }

    #[test]
    fn local_list_empty_when_no_dir() {
        // Verifies no panic when skills dir doesn't exist yet.
        let result = local_list();
        assert!(result.is_ok());
    }
}
