//! The markdown half of a migration: persona and instruction files.
//!
//! Lowest risk and highest sentimental value — these are the files someone
//! wrote by hand over weeks, and they are plain text in both source tools, so
//! they carry across without interpretation. Everything with a schema waits for
//! a later increment.
//!
//! They land in `cinderpaw_dir()` because that is where the sidecar's
//! `soul-loader` looks for user overrides (`SOUL.md`, `IDENTITY.md`,
//! `AGENTS.md`, per-file, bundled default when absent). An import into any
//! other directory would copy files nothing reads.
//!
//! `AGENTS.md` is NOT imported (6 Oct 2026). The loader treats it as a full
//! replacement for Cinderpaw's own working manual, and the source tool's copy is
//! that tool's manual: OpenClaw's tells the agent to follow BOOTSTRAP.md, keep
//! `memory/YYYY-MM-DD.md` files and watch HEARTBEAT.md, none of which Cinderpaw
//! has. Imported, it made Cinderpaw follow another program's instructions.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;

use super::{Found, Source};

#[derive(Debug, Clone, Serialize)]
pub struct PlanItem {
    pub what: String,
    pub target: String,
    pub note: Option<String>,
    /// The file or folder copied to `target`. Apply copies exactly these
    /// pairs, so it cannot drift from the plan that was shown.
    #[serde(skip)]
    pub source: PathBuf,
    /// What apply does for this item. Never serialised: a key's secret must
    /// not reach the plan the UI shows.
    #[serde(skip)]
    pub action: Action,
}

/// How an item lands.
#[derive(Clone)]
pub enum Action {
    /// Copy `source` (file or folder) to `target`.
    Copy,
    /// Write this text to `target` (memory notes, see `memory.rs`).
    Write(String),
    /// Save an AI provider key in Cinderpaw's key store (see `keys.rs`).
    Key { provider: String, secret: String, base_url: Option<String> },
    /// Add a chat connection, switched off (see `connections.rs`).
    Connector { id: String, secrets: std::collections::BTreeMap<String, String>, allowlist: Vec<String> },
    /// Write the source's old conversations into `dir` (see `conversations.rs`).
    Conversations { root: PathBuf, source: Source, dir: PathBuf },
}

impl std::fmt::Debug for Action {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Action::Copy => f.write_str("Copy"),
            Action::Write(t) => write!(f, "Write({} bytes)", t.len()),
            Action::Key { provider, .. } => write!(f, "Key({provider}, secret hidden)"),
            Action::Connector { id, allowlist, .. } => write!(f, "Connector({id}, {} allowed, secrets hidden)", allowlist.len()),
            Action::Conversations { dir, .. } => write!(f, "Conversations(into {})", dir.display()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub will_import: Vec<PlanItem>,
    pub not_imported: Vec<String>,
    pub conflicts: Vec<String>,
    /// Where replaced files are copied before the first write.
    pub backup_dir: PathBuf,
}

/// `(source-relative path, target file name)` for one source tool.
fn persona_files(source: Source) -> &'static [(&'static str, &'static str)] {
    match source {
        Source::OpenClaw => &[("workspace/SOUL.md", "SOUL.md"), ("workspace/IDENTITY.md", "IDENTITY.md")],
        Source::Hermes => &[("SOUL.md", "SOUL.md")],
    }
}

/// Markdown this increment deliberately leaves behind. Files, not config keys,
/// so `KeyLedger` cannot see them — without this list they would vanish from
/// the report entirely, which is the one failure mode this module exists to
/// prevent.
fn deferred_files(source: Source) -> &'static [(&'static str, &'static str)] {
    match source {
        Source::OpenClaw => &[
            ("workspace/AGENTS.md", "OpenClaw's working manual; Cinderpaw keeps its own"),
            ("workspace/TOOLS.md", "notes about OpenClaw's tools"),
            ("workspace/HEARTBEAT.md", "OpenClaw's check-in schedule; use Cinderpaw's schedules instead"),
            ("workspace/BOOTSTRAP.md", "OpenClaw's first-run script"),
        ],
        Source::Hermes => &[
            ("AGENTS.md", "Hermes Agent's working manual; Cinderpaw keeps its own"),
        ],
    }
}

pub fn plan_persona(found: &Found, overwrite: bool) -> Plan {
    plan_persona_into(found, &crate::paths::cinderpaw_dir(), overwrite)
}

/// Target directory is a parameter so tests never touch the real `~/.cinderpaw`.
pub fn plan_persona_into(found: &Found, cinderpaw_dir: &Path, overwrite: bool) -> Plan {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let backup_dir = cinderpaw_dir
        .join("migration")
        .join(match found.source {
            Source::OpenClaw => "openclaw",
            Source::Hermes => "hermes",
        })
        .join(stamp);

    let mut will_import = Vec::new();
    let mut conflicts = Vec::new();

    for (rel, name) in persona_files(found.source) {
        let src = found.root.join(rel);
        if !src.is_file() {
            continue;
        }
        let dst = cinderpaw_dir.join(name);
        if dst.exists() && !overwrite {
            conflicts.push(format!(
                "{} exists — use --overwrite to replace it, otherwise skipped",
                dst.display()
            ));
            continue;
        }
        will_import.push(PlanItem {
            what: (*name).to_string(),
            target: dst.display().to_string(),
            note: dst.exists().then(|| "overwrites existing".to_string()),
            source: src,
            action: Action::Copy,
        });
    }

    let not_imported = deferred_files(found.source)
        .iter()
        .filter(|(rel, _)| found.root.join(rel).is_file())
        .map(|(rel, why)| format!("{rel} — {why}"))
        .collect();

    Plan { will_import, not_imported, conflicts, backup_dir }
}

pub fn apply(plan: &Plan) -> Result<Vec<String>> {
    let mut done = Vec::new();
    for item in &plan.will_import {
        if let Action::Key { provider, secret, base_url } = &item.action {
            let config = crate::byok::ProviderConfig {
                enabled: true,
                api_key: secret.clone(),
                base_url: base_url.clone(),
                default_model: None,
            };
            crate::byok::save_provider(provider, config).with_context(|| format!("saving the {provider} key"))?;
            done.push(item.what.clone());
            continue;
        }
        if let Action::Conversations { root, source, dir } = &item.action {
            let chats = super::conversations::find_chats(*source, root);
            super::conversations::write_chats(&chats, dir, false).context("writing the old conversations")?;
            done.push(item.what.clone());
            continue;
        }
        if let Action::Connector { id, secrets, allowlist } = &item.action {
            super::connections::save(id, secrets, allowlist).with_context(|| format!("adding the {id} connection"))?;
            done.push(item.what.clone());
            continue;
        }
        let dst = Path::new(&item.target);
        if dst.exists() {
            std::fs::create_dir_all(&plan.backup_dir)
                .with_context(|| format!("creating {}", plan.backup_dir.display()))?;
            let name = dst.file_name().unwrap_or_default();
            copy_all(dst, &plan.backup_dir.join(name)).with_context(|| format!("backing up {}", dst.display()))?;
            if dst.is_dir() {
                std::fs::remove_dir_all(dst)?;
            }
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match &item.action {
            Action::Write(text) => std::fs::write(dst, text).with_context(|| format!("writing {}", dst.display()))?,
            _ => copy_all(&item.source, dst)
                .with_context(|| format!("copying {} to {}", item.source.display(), dst.display()))?,
        }
        done.push(item.what.clone());
    }
    Ok(done)
}

/// A file, or a folder and everything in it. Symlinks are skipped: a link in
/// someone's skills folder can point anywhere on their disk.
fn copy_all(src: &Path, dst: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_file() {
        std::fs::copy(src, dst)?;
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        copy_all(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn openclaw_with_soul(text: &str) -> (tempfile::TempDir, Found) {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join(".openclaw");
        fs::create_dir_all(root.join("workspace")).unwrap();
        fs::write(root.join("openclaw.json"), "{}").unwrap();
        fs::write(root.join("workspace").join("SOUL.md"), text).unwrap();
        let found = Found {
            source: Source::OpenClaw,
            root: root.clone(),
            config: root.join("openclaw.json"),
            version: None,
        };
        (tmp, found)
    }

    #[test]
    fn a_present_soul_is_planned_for_import() {
        let (_tmp, found) = openclaw_with_soul("# my persona\n");
        let home = tempdir().unwrap();
        let plan = plan_persona_into(&found, home.path(), false);
        assert!(plan.will_import.iter().any(|i| i.what == "SOUL.md"));
    }

    #[test]
    fn a_missing_file_is_neither_imported_nor_an_error() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join(".openclaw");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("openclaw.json"), "{}").unwrap();
        let found = Found {
            source: Source::OpenClaw,
            root: root.clone(),
            config: root.join("openclaw.json"),
            version: None,
        };
        let home = tempdir().unwrap();
        let plan = plan_persona_into(&found, home.path(), false);
        assert!(plan.will_import.is_empty());
        assert!(plan.conflicts.is_empty());
    }

    #[test]
    fn an_existing_target_is_a_conflict_unless_overwrite() {
        let (_tmp, found) = openclaw_with_soul("# theirs\n");
        let home = tempdir().unwrap();
        fs::write(home.path().join("SOUL.md"), "# mine\n").unwrap();

        let plan = plan_persona_into(&found, home.path(), false);
        assert!(plan.will_import.is_empty());
        assert_eq!(plan.conflicts.len(), 1);
        assert!(plan.conflicts[0].contains("--overwrite"));

        let plan = plan_persona_into(&found, home.path(), true);
        assert_eq!(plan.will_import.len(), 1);
        assert!(plan.conflicts.is_empty());
        assert_eq!(plan.will_import[0].note.as_deref(), Some("overwrites existing"));
    }

    #[test]
    fn apply_copies_the_file_and_backs_up_what_it_replaced() {
        let (_tmp, found) = openclaw_with_soul("# theirs\n");
        let home = tempdir().unwrap();
        fs::write(home.path().join("SOUL.md"), "# mine\n").unwrap();

        let plan = plan_persona_into(&found, home.path(), true);
        let done = apply(&plan).unwrap();

        assert_eq!(done.len(), 1);
        assert_eq!(fs::read_to_string(home.path().join("SOUL.md")).unwrap(), "# theirs\n");
        // The replaced file is recoverable with one cp, which is the documented undo.
        let backup = plan.backup_dir.join("SOUL.md");
        assert_eq!(fs::read_to_string(backup).unwrap(), "# mine\n");
    }

    /// A conflict the user did not resolve must survive apply untouched — the
    /// plan is the whole decision, so a skipped file stays skipped.
    #[test]
    fn apply_does_not_touch_a_file_the_plan_listed_as_a_conflict() {
        let (_tmp, found) = openclaw_with_soul("# theirs\n");
        let home = tempdir().unwrap();
        fs::write(home.path().join("SOUL.md"), "# mine\n").unwrap();

        let plan = plan_persona_into(&found, home.path(), false);
        let done = apply(&plan).unwrap();

        assert!(done.is_empty());
        assert_eq!(fs::read_to_string(home.path().join("SOUL.md")).unwrap(), "# mine\n");
        assert!(!plan.backup_dir.exists());
    }

    #[test]
    fn the_source_install_is_never_written_to() {
        let (_tmp, found) = openclaw_with_soul("# theirs\n");
        let home = tempdir().unwrap();
        let before = fs::read_to_string(found.root.join("workspace").join("SOUL.md")).unwrap();

        let plan = plan_persona_into(&found, home.path(), true);
        apply(&plan).unwrap();

        let after = fs::read_to_string(found.root.join("workspace").join("SOUL.md")).unwrap();
        assert_eq!(before, after);
    }

    /// The source tool's working manual would replace Cinderpaw's own (the
    /// loader treats a user AGENTS.md as a full override), so it is reported,
    /// never copied.
    #[test]
    fn the_other_tools_working_manual_is_reported_not_imported() {
        let (_tmp, found) = openclaw_with_soul("# theirs\n");
        fs::write(found.root.join("workspace").join("AGENTS.md"), "follow BOOTSTRAP.md\n").unwrap();
        let home = tempdir().unwrap();
        let plan = plan_persona_into(&found, home.path(), true);
        assert!(plan.will_import.iter().all(|i| i.what != "AGENTS.md"));
        assert!(plan.not_imported.iter().any(|l| l.starts_with("workspace/AGENTS.md — ")));
        apply(&plan).unwrap();
        assert!(!home.path().join("AGENTS.md").exists());
    }

    /// Hermes' own working manual stays behind and says so; its memory is
    /// memory.rs's job now and no longer listed here.
    #[test]
    fn hermes_agents_md_is_reported_not_dropped() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hermes");
        fs::create_dir_all(root.join("memories")).unwrap();
        fs::write(root.join("config.yaml"), "{}
").unwrap();
        fs::write(root.join("SOUL.md"), "# theirs
").unwrap();
        fs::write(root.join("AGENTS.md"), "# their manual
").unwrap();
        fs::write(root.join("memories").join("MEMORY.md"), "notes
").unwrap();
        let found = Found {
            source: Source::Hermes,
            root: root.clone(),
            config: root.join("config.yaml"),
            version: None,
        };
        let home = tempdir().unwrap();

        let plan = plan_persona_into(&found, home.path(), false);

        assert_eq!(plan.will_import.len(), 1, "SOUL.md only");
        assert_eq!(plan.not_imported.len(), 1, "AGENTS.md; MEMORY.md is imported by memory.rs");
        assert!(plan.not_imported[0].starts_with("AGENTS.md — "));
    }
}
