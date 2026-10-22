//! Skills: a folder with a `SKILL.md` in it, the same shape in OpenClaw, in
//! Hermes Agent and in Cinderpaw (`read_skill` loads `skills/<id>/SKILL.md`), so
//! a skill carries across as a folder copy with nothing to translate.
//!
//! Where they live: OpenClaw keeps them in `skills/` and `workspace/skills/`,
//! Hermes in `skills/<category>/<name>/`. All are searched a few levels deep
//! for `SKILL.md`; the folder holding it is the skill, its name is the id.

use std::path::{Path, PathBuf};

use super::{Found, Plan, PlanItem, Source};

/// Folders searched for skills, relative to the install root.
fn skill_roots(source: Source) -> &'static [&'static str] {
    match source {
        Source::OpenClaw => &["skills", "workspace/skills"],
        Source::Hermes => &["skills"],
    }
}

/// How deep below a root a `SKILL.md` may sit (Hermes adds a category level).
const MAX_DEPTH: usize = 3;
// ponytail: a skill folder past this is almost certainly carrying its own
// node_modules or a model; it is reported, not copied. Raise it if real skills hit it.
const MAX_SKILL_BYTES: u64 = 50 * 1024 * 1024;

fn find_skill_dirs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if dir.join("SKILL.md").is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for d in dirs {
        find_skill_dirs(&d, depth - 1, out);
    }
}

fn size_of(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    std::fs::read_dir(path)
        .map(|it| it.flatten().map(|e| size_of(&e.path())).sum())
        .unwrap_or(0)
}

/// Add the source's skills to `plan`: new ones to import, existing ones as
/// conflicts unless `overwrite`, oversized and duplicate names as not imported.
pub fn plan_skills_into(found: &Found, cinderpaw_dir: &Path, overwrite: bool, plan: &mut Plan) {
    let mut dirs = Vec::new();
    for rel in skill_roots(found.source) {
        // A root that is itself a skill is not one of many skills; start below it.
        let Ok(entries) = std::fs::read_dir(found.root.join(rel)) else { continue };
        let mut subdirs: Vec<PathBuf> =
            entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect();
        subdirs.sort();
        for d in subdirs {
            find_skill_dirs(&d, MAX_DEPTH - 1, &mut dirs);
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    for src in dirs {
        let Some(name) = src.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        if name.starts_with('.') {
            continue;
        }
        let rel = src.strip_prefix(&found.root).unwrap_or(&src).display().to_string();
        if !seen.insert(name.clone()) {
            plan.not_imported.push(format!("{rel} — another skill is also called \"{name}\""));
            continue;
        }
        let size = size_of(&src);
        if size > MAX_SKILL_BYTES {
            plan.not_imported.push(format!("{rel} — {} MB, too large to copy as a skill", size / (1024 * 1024)));
            continue;
        }
        let dst = cinderpaw_dir.join("skills").join(&name);
        if dst.exists() && !overwrite {
            plan.conflicts.push(format!("skill \"{name}\" exists in {} — kept yours", dst.display()));
            continue;
        }
        plan.will_import.push(PlanItem {
            what: format!("skill: {name}"),
            target: dst.display().to_string(),
            note: dst.exists().then(|| "overwrites existing".to_string()),
            source: src,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn skill(root: &Path, rel: &str) {
        fs::create_dir_all(root.join(rel)).unwrap();
        fs::write(root.join(rel).join("SKILL.md"), "---\nname: x\n---\nbody\n").unwrap();
    }

    fn found(source: Source, root: &Path) -> Found {
        Found { source, root: root.to_path_buf(), config: root.join("c"), version: None }
    }

    fn empty_plan() -> Plan {
        Plan { will_import: vec![], not_imported: vec![], conflicts: vec![], backup_dir: PathBuf::from("b") }
    }

    #[test]
    fn openclaw_and_hermes_skills_are_found_and_copied_whole() {
        let src = tempdir().unwrap();
        skill(src.path(), "skills/summarize");
        fs::write(src.path().join("skills/summarize/run.sh"), "echo hi").unwrap();
        skill(src.path(), "workspace/skills/trello");
        let home = tempdir().unwrap();
        let mut plan = empty_plan();
        plan_skills_into(&found(Source::OpenClaw, src.path()), home.path(), false, &mut plan);
        let names: Vec<_> = plan.will_import.iter().map(|i| i.what.as_str()).collect();
        assert_eq!(names, ["skill: summarize", "skill: trello"]);

        super::super::apply(&plan).unwrap();
        assert!(home.path().join("skills/summarize/SKILL.md").is_file());
        assert_eq!(fs::read_to_string(home.path().join("skills/summarize/run.sh")).unwrap(), "echo hi");

        // Hermes nests a category level.
        let hermes = tempdir().unwrap();
        skill(hermes.path(), "skills/productivity/notion");
        let mut plan = empty_plan();
        plan_skills_into(&found(Source::Hermes, hermes.path()), home.path(), false, &mut plan);
        assert_eq!(plan.will_import[0].what, "skill: notion");
    }

    #[test]
    fn a_skill_you_already_have_is_kept_unless_overwrite() {
        let src = tempdir().unwrap();
        skill(src.path(), "skills/summarize");
        let home = tempdir().unwrap();
        skill(home.path(), "skills/summarize");
        let mut plan = empty_plan();
        plan_skills_into(&found(Source::OpenClaw, src.path()), home.path(), false, &mut plan);
        assert!(plan.will_import.is_empty());
        assert_eq!(plan.conflicts.len(), 1);

        let mut plan = empty_plan();
        plan_skills_into(&found(Source::OpenClaw, src.path()), home.path(), true, &mut plan);
        assert_eq!(plan.will_import[0].note.as_deref(), Some("overwrites existing"));
    }

    #[test]
    fn a_second_skill_with_the_same_name_is_reported_not_dropped() {
        let src = tempdir().unwrap();
        skill(src.path(), "skills/notes");
        skill(src.path(), "workspace/skills/notes");
        let home = tempdir().unwrap();
        let mut plan = empty_plan();
        plan_skills_into(&found(Source::OpenClaw, src.path()), home.path(), false, &mut plan);
        assert_eq!(plan.will_import.len(), 1);
        assert!(plan.not_imported[0].contains("another skill is also called"));
    }
}
