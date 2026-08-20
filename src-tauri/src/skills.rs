use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::paths;

const GITHUB_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/bloom500/feral/main/skills/manifest.json";

const COMMUNITY_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/bloom500/feral/main/skills/community-manifest.json";

const ALLOWED_CONTENT_HOSTS: &[&str] = &[
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
];

fn validate_content_url(url: &str) -> Result<()> {
    if !url.starts_with("https://") {
        bail!("only https:// URLs are allowed for skill content fetching");
    }
    let without_scheme = url.trim_start_matches("https://");
    let host = without_scheme.split('/').next().unwrap_or("");
    if !ALLOWED_CONTENT_HOSTS.contains(&host) {
        bail!(
            "host '{}' is not in the allowed list for skill content fetching",
            host
        );
    }
    Ok(())
}

/// The HTTP client every skill/manifest fetch uses.
///
/// `validate_content_url` checked only the URL we typed. With reqwest's default
/// policy the response could redirect anywhere — a 302 off an allowed host to
/// somewhere else entirely — and the allowlist was already satisfied by then,
/// so the check it exists to make never ran on the URL actually fetched. The
/// custom policy below re-runs it on every hop and stops the chain rather than
/// following a redirect out of the allowlist.
fn content_client() -> Result<reqwest::Client> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.stop();
        }
        if validate_content_url(attempt.url().as_str()).is_ok() {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    Ok(reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(15))
        .redirect(policy)
        .build()?)
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SourceProvider {
    Local,
    #[serde(rename = "github")]
    GitHub,
    #[serde(rename = "clawhub")]
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

/// Reject a fetched body that is not a SKILL.md.
///
/// Minimal on purpose: a frontmatter block with a description. Anything
/// stricter starts rejecting legitimate skills over formatting.
pub fn validate_skill_body(content: &str) -> Result<()> {
    if content.trim().is_empty() {
        bail!("capability body is empty");
    }
    if !content.trim_start().starts_with("---") {
        bail!("capability body has no frontmatter block — this is not a SKILL.md");
    }
    let meta = parse_frontmatter("probe", content);
    if meta.description.trim().is_empty() {
        bail!("capability body has no description in its frontmatter");
    }
    Ok(())
}

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

/// Download the GitHub skills manifest and return SkillMeta list.
/// Cross-references with local installed skills to set install_status.
pub async fn github_list() -> Result<Vec<SkillMeta>> {
    let client = content_client()?;

    validate_content_url(GITHUB_MANIFEST_URL)?;

    let resp = client
        .get(GITHUB_MANIFEST_URL)
        .send()
        .await?
        .error_for_status()?;

    let mut remote: Vec<SkillMeta> = resp.json().await?;

    // Cross-reference with installed skills to set install_status
    let installed_ids: std::collections::HashSet<String> = local_list()
        .unwrap_or_default()
        .into_iter()
        .map(|m| m.id)
        .collect();

    for skill in &mut remote {
        if installed_ids.contains(&skill.id) {
            skill.install_status = InstallStatus::Installed;
        } else {
            skill.install_status = InstallStatus::NotInstalled;
        }
        skill.source_provider = SourceProvider::GitHub;
        // The official Cinderpaw manifest. This used to be stamped `Community`
        // like the community list, which erased the whole distinction the two
        // separate URLs exist to make — and left the trust label unable to
        // inform the install confirmation the agent now has to show.
        skill.trust_label = TrustLabel::Verified;
    }

    Ok(remote)
}

/// Download the community manifest and return SkillMeta list.
/// Skills are stamped ClawHub / Community trust level; install_status cross-referenced.
pub async fn community_list() -> Result<Vec<SkillMeta>> {
    let client = content_client()?;

    validate_content_url(COMMUNITY_MANIFEST_URL)?;

    let resp = client
        .get(COMMUNITY_MANIFEST_URL)
        .send()
        .await?
        .error_for_status()?;

    let mut skills: Vec<SkillMeta> = resp.json().await?;

    let installed_ids: std::collections::HashSet<String> = local_list()
        .unwrap_or_default()
        .into_iter()
        .map(|m| m.id)
        .collect();

    for skill in &mut skills {
        skill.install_status = if installed_ids.contains(&skill.id) {
            InstallStatus::Installed
        } else {
            InstallStatus::NotInstalled
        };
        skill.source_provider = SourceProvider::ClawHub;
        skill.trust_label = TrustLabel::Community;
    }

    Ok(skills)
}

/// Find `id` in the catalogues the HOST knows about.
///
/// This is the Phase 2 trust boundary. The caller names a capability; what
/// that name means — where the content lives, who published it, how far it is
/// trusted — is resolved here, from manifests this process fetched itself.
/// Nothing the caller sends can influence the entry that comes back.
///
/// The official manifest is searched first so a community entry can never
/// shadow an official one by reusing its id.
pub async fn resolve_catalogue_entry(id: &str) -> Result<SkillMeta> {
    validate_id(id)?;

    if let Ok(official) = github_list().await {
        if let Some(hit) = official.into_iter().find(|m| m.id == id) {
            return Ok(hit);
        }
    }
    let community = community_list().await?;
    community
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| anyhow::anyhow!("no capability named '{}' is available", id))
}

/// Fetch a catalogue entry's body without installing it.
///
/// The "inspect before trusting" step: it lets the agent tell the user what it
/// is about to add to their machine, and it is the only way to read a
/// capability that is not installed yet.
pub async fn inspect_catalogue_entry(id: &str) -> Result<SkillPreview> {
    let meta = resolve_catalogue_entry(id).await?;
    let content = fetch_catalogue_content(&meta).await?;
    Ok(SkillPreview { meta, content })
}

/// Download a catalogue entry's body, host-allowlisted.
async fn fetch_catalogue_content(meta: &SkillMeta) -> Result<String> {
    let url = meta
        .content_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("catalogue entry '{}' has no content URL", meta.id))?;
    validate_content_url(url)?;

    let client = content_client()?;

    Ok(client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?)
}

/// Install a capability the host resolved itself.
///
/// The caller supplies a name and nothing else. Compare the old
/// `install_skill(meta, content, overwrite)`, which took the file body, the
/// metadata AND the trust label from whoever called it and checked only that
/// the id was a safe slug — safe purely because its one caller happened to be
/// a well-behaved UI. This entry point exists so the agent can ask for a
/// capability without also being the thing that vouches for it.
pub async fn install_from_catalogue(id: &str) -> Result<SkillMeta> {
    let meta = resolve_catalogue_entry(id).await?;
    let content = fetch_catalogue_content(&meta).await?;

    // What came back must actually be a skill.
    //
    // There is deliberately no "the body declares a different id" check here:
    // SKILL.md frontmatter carries no id at all — the id is the directory
    // name, supplied externally — so such a comparison could never fail and
    // would read as protection while providing none. What CAN arrive instead
    // is a 404 page, an empty file, or a redirect body, and writing one of
    // those to disk while telling the user their capability installed is the
    // real failure this guards.
    validate_skill_body(&content)?;

    do_install(&meta, &content, true)?;
    Ok(meta)
}

/// Fetch the raw SKILL.md from a remote URL, validate host, parse frontmatter.
pub async fn fetch_remote_preview(url: &str) -> Result<SkillPreview> {
    validate_content_url(url)?;

    let client = content_client()?;

    let content = client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    // Derive a provisional id from the URL filename (without .md extension).
    let provisional_id = url
        .rsplit('/')
        .next()
        .unwrap_or("unknown")
        .trim_end_matches(".md")
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();

    let mut meta = parse_frontmatter(&provisional_id, &content);
    meta.source_provider = SourceProvider::GitHub;
    meta.trust_label = TrustLabel::Community;
    meta.content_url = Some(url.to_string());

    Ok(SkillPreview { meta, content })
}

/// Read a user-specified local SKILL.md file, validate it is a regular file,
/// and parse its frontmatter. Does NOT allow symlinks to escape arbitrary paths.
pub fn preview_local_file(path: &str) -> Result<SkillPreview> {
    let p = std::path::Path::new(path);

    let metadata = std::fs::metadata(p)
        .map_err(|_| anyhow::anyhow!("path '{}' does not exist or cannot be read", path))?;

    if !metadata.is_file() {
        bail!("'{}' is not a regular file", path);
    }

    // Resolve symlinks; bail if the canonical path differs in a suspicious way.
    let canon = p.canonicalize()?;
    if !canon.is_file() {
        bail!("resolved path is not a regular file");
    }

    // Reachable from the webview (`preview_local_skill`), so it must not be an
    // arbitrary-file-read primitive: without these two guards, pointing it at
    // ~/.ssh/id_rsa returned the private key as "skill preview content", and
    // pointing it at a huge file — or /dev/urandom — read until the process
    // died. Same threat model, same guard, as the file readers in commands/files.rs.
    crate::commands::files::deny_feral_private(&canon).map_err(|e| anyhow::anyhow!(e))?;
    crate::commands::files::deny_sensitive_home_paths(&canon).map_err(|e| anyhow::anyhow!(e))?;

    const MAX_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;
    if metadata.len() > MAX_PREVIEW_BYTES {
        bail!(
            "'{}' is {} bytes — too large to preview as a skill (limit {} bytes)",
            path,
            metadata.len(),
            MAX_PREVIEW_BYTES
        );
    }

    let content = std::fs::read_to_string(&canon)?;

    // Derive provisional id from filename
    let provisional_id = canon
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported")
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();

    let mut meta = parse_frontmatter(&provisional_id, &content);
    meta.source_provider = SourceProvider::Local;
    meta.trust_label = TrustLabel::Unknown;

    Ok(SkillPreview { meta, content })
}

pub fn skill_exists(id: &str) -> Result<bool> {
    let dir = skill_path(id)?;
    Ok(dir.exists())
}

/// Write SKILL.md to ~/.feral/skills/<id>/SKILL.md.
/// Fails if the directory already exists and overwrite is false.
///
/// PRIVATE ON PURPOSE. This function trusts everything it is given — the body,
/// the metadata and the trust label — and checks only that the id is a safe
/// slug. It used to be a Tauri command, which meant provenance was whatever
/// the caller claimed it was. Reach it through `install_from_catalogue`,
/// `install_from_url` or `install_from_file`, each of which reads the content
/// itself before calling here.
fn do_install(meta: &SkillMeta, content: &str, overwrite: bool) -> Result<()> {
    validate_id(&meta.id)?;
    let skill_dir = skill_path(&meta.id)?;

    if skill_dir.exists() {
        if !overwrite {
            bail!(
                "skill '{}' already exists; pass overwrite=true to replace it",
                meta.id
            );
        }
        // Remove existing directory before writing fresh
        std::fs::remove_dir_all(&skill_dir)?;
    }

    std::fs::create_dir_all(&skill_dir)?;
    std::fs::write(skill_dir.join("SKILL.md"), content)?;
    Ok(())
}

pub fn do_remove(id: &str) -> Result<()> {
    let skill_dir = skill_path(id)?;
    if !skill_dir.exists() {
        bail!("skill '{}' is not installed", id);
    }
    // Final path guard before deletion
    let base_canon = paths::skills_dir().canonicalize().unwrap_or_else(|_| paths::skills_dir());
    let dir_canon = skill_dir.canonicalize()?;
    if !dir_canon.starts_with(&base_canon) {
        bail!("path traversal detected for id '{}'", id);
    }
    std::fs::remove_dir_all(&skill_dir)?;
    Ok(())
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

/// Serve one `capability_request` from the agent sidecar.
///
/// The three verbs the agent gets. Note what is NOT here: no way to pass
/// content, metadata or a trust label. `do_install` — which trusts all three —
/// is private to this module, and every route to it fetches first.
pub async fn handle_capability_request(
    action: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");

    match action {
        "list" => {
            // Both catalogues, official first, deduplicated by id so a
            // community entry cannot shadow an official one.
            let mut out: Vec<SkillMeta> = github_list().await.unwrap_or_default();
            let mut seen: std::collections::HashSet<String> =
                out.iter().map(|m| m.id.clone()).collect();
            for m in community_list().await.unwrap_or_default() {
                if seen.insert(m.id.clone()) {
                    out.push(m);
                }
            }
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "inspect" => {
            let preview = inspect_catalogue_entry(name).await.map_err(|e| e.to_string())?;
            serde_json::to_value(preview).map_err(|e| e.to_string())
        }
        "install" => {
            let meta = install_from_catalogue(name).await.map_err(|e| e.to_string())?;
            serde_json::to_value(meta).map_err(|e| e.to_string())
        }
        other => Err(format!("unknown capability action '{other}'")),
    }
}

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

#[tauri::command]
#[specta::specta]
pub async fn fetch_remote_skills() -> Result<Vec<SkillMeta>, String> {
    github_list().await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn fetch_community_skills() -> Result<Vec<SkillMeta>, String> {
    community_list().await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn preview_remote_skill(url: String) -> Result<SkillPreview, String> {
    fetch_remote_preview(&url).await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn preview_local_skill(path: String) -> Result<SkillPreview, String> {
    preview_local_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn skill_exists_cmd(id: String) -> Result<bool, String> {
    skill_exists(&id).map_err(|e| e.to_string())
}

/// Install a capability by name. The host resolves everything else.
/// This is the only install path reachable from the agent.
#[tauri::command]
#[specta::specta]
pub async fn install_capability(id: String) -> Result<SkillMeta, String> {
    install_from_catalogue(&id).await.map_err(|e| e.to_string())
}

/// Read a catalogue capability without installing it.
#[tauri::command]
#[specta::specta]
pub async fn inspect_capability(id: String) -> Result<SkillPreview, String> {
    inspect_catalogue_entry(&id).await.map_err(|e| e.to_string())
}

/// Install from a URL the user pasted. Host-side fetch, host allowlist
/// enforced — but the decision to trust this URL is the user's, which is why
/// this is not reachable from the agent.
#[tauri::command]
#[specta::specta]
pub async fn install_skill_from_url(url: String, overwrite: bool) -> Result<SkillMeta, String> {
    let preview = fetch_remote_preview(&url).await.map_err(|e| e.to_string())?;
    do_install(&preview.meta, &preview.content, overwrite).map_err(|e| e.to_string())?;
    Ok(preview.meta)
}

/// Install from a file the user picked. The user's own file picker is the
/// provenance, and that is a claim only a person can make.
#[tauri::command]
#[specta::specta]
pub fn install_skill_from_file(path: String, overwrite: bool) -> Result<SkillMeta, String> {
    let preview = preview_local_file(&path).map_err(|e| e.to_string())?;
    do_install(&preview.meta, &preview.content, overwrite).map_err(|e| e.to_string())?;
    Ok(preview.meta)
}

#[tauri::command]
#[specta::specta]
pub fn remove_skill(id: String) -> Result<(), String> {
    do_remove(&id).map_err(|e| e.to_string())
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
    fn catalogue_content_url_must_be_allowlisted() {
        // The install path used to never call this at all: content came in as
        // a &str from whoever called do_install, from anywhere or nowhere.
        assert!(validate_content_url("https://raw.githubusercontent.com/x/y.md").is_ok());
        assert!(validate_content_url("https://evil.example.com/x.md").is_err());
        assert!(validate_content_url("http://raw.githubusercontent.com/x.md").is_err());
        // A host that merely ends with an allowed name must not pass.
        assert!(validate_content_url("https://notraw.githubusercontent.com.evil.com/x.md").is_err());
    }

    #[test]
    fn a_fetched_body_that_is_not_a_skill_is_refused() {
        // The realistic failure: the content URL 200s with a GitHub 404 page,
        // a redirect stub, or nothing at all. Writing that to disk and
        // reporting success is worse than failing the install.
        assert!(validate_skill_body("").is_err());
        assert!(validate_skill_body("   
  ").is_err());
        assert!(validate_skill_body("<!DOCTYPE html><h1>404</h1>").is_err());
        assert!(validate_skill_body("# Just a heading
no frontmatter").is_err());
        // Frontmatter present but empty of meaning.
        assert!(validate_skill_body("---
name: x
---
body").is_err());
        // A real skill passes.
        assert!(
            validate_skill_body("---
name: Excel Reader
description: Reads xlsx
---
Body")
                .is_ok()
        );
    }

    #[test]
    fn install_ids_still_reject_traversal_through_the_new_entry_point() {
        // resolve_catalogue_entry validates before any network call, so a
        // traversal id can never reach a fetch.
        for bad in ["../evil", "../../etc/passwd", "", "Has Spaces"] {
            assert!(validate_id(bad).is_err(), "{bad} should be rejected");
        }
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

    #[test]
    fn rejects_non_https_url() {
        assert!(validate_content_url("http://raw.githubusercontent.com/x").is_err());
        assert!(validate_content_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn rejects_unlisted_host() {
        assert!(validate_content_url("https://evil.com/skill.md").is_err());
    }

    #[test]
    fn accepts_allowed_hosts() {
        assert!(validate_content_url(
            "https://raw.githubusercontent.com/bloom500/feral/main/skills/manifest.json"
        ).is_ok());
    }

    #[test]
    fn install_guard_rejects_bad_id() {
        let meta = SkillMeta {
            id: "Bad.Slug!".to_string(),
            name: "x".to_string(),
            description: "".to_string(),
            author: "".to_string(),
            version: "1.0.0".to_string(),
            license: "".to_string(),
            tags: vec![],
            source_provider: SourceProvider::Local,
            source_url: None,
            content_url: None,
            install_status: InstallStatus::NotInstalled,
            trust_label: TrustLabel::Unknown,
            last_updated: None,
        };
        assert!(do_install(&meta, "content", false).is_err());
    }
}
