//! The markdown half of a migration: persona and instruction files.
//!
//! Lowest risk and highest sentimental value — these are the files someone
//! wrote by hand over weeks, and they are plain text in both source tools, so
//! they carry across without interpretation. Everything with a schema waits for
//! a later increment.
//!
//! All three land in `feral_dir()` because that is where the sidecar's
//! `soul-loader` looks for user overrides (`SOUL.md`, `IDENTITY.md`,
//! `AGENTS.md`, per-file, bundled default when absent). An import into any
//! other directory would copy files nothing reads.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::{Found, Source};

#[derive(Debug, Clone)]
pub struct PlanItem {
    pub what: String,
    pub target: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone)]
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
        Source::OpenClaw => &[
            ("workspace/SOUL.md", "SOUL.md"),
            ("workspace/AGENTS.md", "AGENTS.md"),
            ("workspace/IDENTITY.md", "IDENTITY.md"),
        ],
        Source::Hermes => &[("SOUL.md", "SOUL.md"), ("AGENTS.md", "AGENTS.md")],
    }
}

/// Markdown this increment deliberately leaves behind. Files, not config keys,
/// so `KeyLedger` cannot see them — without this list they would vanish from
/// the report entirely, which is the one failure mode this module exists to
/// prevent.
fn deferred_files(source: Source) -> &'static [(&'static str, &'static str)] {
    match source {
        Source::OpenClaw => &[],
        Source::Hermes => &[
            ("memories/MEMORY.md", "memory arrives in a later increment"),
            ("memories/USER.md", "memory arrives in a later increment"),
        ],
    }
}

pub fn plan_persona(found: &Found, overwrite: bool) -> Plan {
    plan_persona_into(found, &crate::paths::feral_dir(), overwrite)
}

/// Target directory is a parameter so tests never touch the real `~/.feral`.
pub fn plan_persona_into(found: &Found, feral_dir: &Path, overwrite: bool) -> Plan {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let backup_dir = feral_dir
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
        let dst = feral_dir.join(name);
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
        });
    }

    let not_imported = deferred_files(found.source)
        .iter()
        .filter(|(rel, _)| found.root.join(rel).is_file())
        .map(|(rel, why)| format!("{rel} — {why}"))
        .collect();

    Plan { will_import, not_imported, conflicts, backup_dir }
}

pub fn apply_persona(found: &Found, plan: &Plan) -> Result<Vec<String>> {
    apply_persona_into(found, plan, &crate::paths::feral_dir())
}

/// Copies exactly what `plan.will_import` listed and nothing else — the plan the
/// user approved is the only input to the decision, so apply cannot drift from
/// what was printed.
pub fn apply_persona_into(found: &Found, plan: &Plan, feral_dir: &Path) -> Result<Vec<String>> {
    let mut done = Vec::new();
    for (rel, name) in persona_files(found.source) {
        if !plan.will_import.iter().any(|i| i.what == *name) {
            continue;
        }
        let src = found.root.join(rel);
        let dst = feral_dir.join(name);
        if dst.exists() {
            std::fs::create_dir_all(&plan.backup_dir)
                .with_context(|| format!("creating {}", plan.backup_dir.display()))?;
            std::fs::copy(&dst, plan.backup_dir.join(name))
                .with_context(|| format!("backing up {}", dst.display()))?;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&src, &dst)
            .with_context(|| format!("copying {} to {}", src.display(), dst.display()))?;
        done.push((*name).to_string());
    }
    Ok(done)
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
        let done = apply_persona_into(&found, &plan, home.path()).unwrap();

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
        let done = apply_persona_into(&found, &plan, home.path()).unwrap();

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
        apply_persona_into(&found, &plan, home.path()).unwrap();

        let after = fs::read_to_string(found.root.join("workspace").join("SOUL.md")).unwrap();
        assert_eq!(before, after);
    }

    /// Hermes memory markdown is out of scope for this increment, so it has to
    /// show up as deferred rather than disappear.
    #[test]
    fn hermes_memory_markdown_is_reported_not_dropped() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hermes");
        fs::create_dir_all(root.join("memories")).unwrap();
        fs::write(root.join("config.yaml"), "{}\n").unwrap();
        fs::write(root.join("SOUL.md"), "# theirs\n").unwrap();
        fs::write(root.join("memories").join("MEMORY.md"), "notes\n").unwrap();
        let found = Found {
            source: Source::Hermes,
            root: root.clone(),
            config: root.join("config.yaml"),
            version: None,
        };
        let home = tempdir().unwrap();

        let plan = plan_persona_into(&found, home.path(), false);

        assert_eq!(plan.will_import.len(), 1, "SOUL.md only");
        assert_eq!(plan.not_imported.len(), 1, "MEMORY.md present, USER.md is not");
        assert!(plan.not_imported[0].starts_with("memories/MEMORY.md — "));
    }
}
