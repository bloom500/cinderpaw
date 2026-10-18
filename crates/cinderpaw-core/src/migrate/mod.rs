//! Importing another agent's setup into Cinderpaw.
//!
//! Read-only on the source, always. The design point is in `ledger`: their
//! formats move and we do not control them, so this module is built to be
//! honest about what it did not understand rather than to claim coverage it
//! cannot keep.
//!
//! One plan for every surface: `cinderpaw migrate`, the desktop onboarding and
//! the browser app all call `plan` and `apply`, so they cannot disagree about
//! what an import does.

pub mod detect;
pub mod ledger;
pub mod memory;
pub mod persona;
pub mod skills;
pub mod source;

use std::path::Path;

pub use detect::{detect, Found, Source};
pub use ledger::KeyLedger;
pub use persona::{apply, plan_persona, Plan, PlanItem};
pub use source::{read_source, SourceData};

/// Everything an import of `found` would do, without writing anything.
pub fn plan(found: &Found, overwrite: bool) -> Plan {
    plan_into(found, &crate::paths::cinderpaw_dir(), overwrite)
}

/// Target directory is a parameter so tests never touch the real `~/.cinderpaw`.
pub fn plan_into(found: &Found, cinderpaw_dir: &Path, overwrite: bool) -> Plan {
    let mut plan = persona::plan_persona_into(found, cinderpaw_dir, overwrite);
    skills::plan_skills_into(found, cinderpaw_dir, overwrite, &mut plan);
    memory::plan_memory_into(found, cinderpaw_dir, overwrite, &mut plan);
    plan.not_imported.extend(leftovers(found));
    plan
}

/// Every install found, each with what an import would bring: the shape the
/// desktop onboarding and the browser app render. An empty list for almost
/// everyone, and then their import step never shows.
pub fn preview() -> serde_json::Value {
    serde_json::Value::Array(
        detect(None)
            .iter()
            .map(|f| {
                let plan = plan(f, false);
                serde_json::json!({
                    "source": f.source.label(),
                    "root": f.root,
                    "version": f.version,
                    "summary": summary(&plan),
                    "plan": plan,
                })
            })
            .collect(),
    )
}

/// "its personality, its memory and 12 skills": what `plan` would bring, in the
/// words every surface shows (desktop card, browser app, `cinderpaw setup`), so
/// they cannot disagree. Empty when it brings nothing.
pub fn summary(plan: &Plan) -> String {
    let count = |prefix: &str| plan.will_import.iter().filter(|i| i.what.starts_with(prefix)).count();
    let skills = count("skill: ");
    let memory = count("memory: ") + count("about you: ");
    let persona = plan.will_import.iter().filter(|i| !i.what.contains(": ")).count();
    let mut parts: Vec<String> = Vec::new();
    if persona > 0 {
        parts.push("its personality".into());
    }
    if memory > 0 {
        parts.push("its memory".into());
    }
    if skills > 0 {
        parts.push(format!("{skills} skill{}", if skills == 1 { "" } else { "s" }));
    }
    match parts.len() {
        0 => String::new(),
        1 => parts.remove(0),
        n => format!("{} and {}", parts[..n - 1].join(", "), parts[n - 1]),
    }
}

/// Import from the install at `root` what `preview` showed for it. Only a root
/// `detect` finds is accepted, so a caller cannot point this at any folder, and
/// nothing already in ~/.cinderpaw is replaced.
pub fn apply_at(root: &str) -> Result<Vec<String>, String> {
    let found = detect(None)
        .into_iter()
        .find(|f| f.root.to_string_lossy() == root)
        .ok_or_else(|| format!("No OpenClaw or Hermes Agent setup at {root} any more."))?;
    apply(&plan(&found, false)).map_err(|e| format!("{e:#}"))
}

/// Everything in the source config that no importer claimed.
///
/// A config we cannot parse yields one honest line instead of an empty list:
/// "unreadable" and "nothing left over" must never look the same.
pub fn leftovers(found: &Found) -> Vec<String> {
    let data = match read_source(found) {
        Ok(data) => data,
        Err(e) => {
            return vec![format!(
                "{} — could not be read, so nothing in it could be examined: {e:#}",
                found.config.display()
            )]
        }
    };
    let mut ledger = KeyLedger::from_value(&data.config);
    // `detect` already read this one and the report prints it — a version stamp
    // is not user data waiting to be migrated. Exactly that key, not the whole
    // `meta` subtree: over-consuming is how a real setting goes missing.
    ledger.consume("meta.lastTouchedVersion");
    let mut out = ledger.leftovers();
    if let Some(err) = &data.env_error {
        out.push(format!(".env — could not be read, so its secrets are unknown: {err}"));
    }
    // Names only, never values (module contract).
    out.extend(data.env.keys().map(|k| format!(".env {k} — keys are not copied; Cinderpaw's setup asks for its own")));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn plan_of(whats: &[&str]) -> Plan {
        Plan {
            will_import: whats
                .iter()
                .map(|w| PlanItem { what: w.to_string(), target: String::new(), note: None, source: PathBuf::new(), content: None })
                .collect(),
            not_imported: vec![],
            conflicts: vec![],
            backup_dir: PathBuf::new(),
        }
    }

    #[test]
    fn the_summary_names_each_kind_once() {
        assert_eq!(summary(&plan_of(&[])), "");
        assert_eq!(summary(&plan_of(&["skill: a"])), "1 skill");
        assert_eq!(summary(&plan_of(&["SOUL.md", "IDENTITY.md", "skill: a", "skill: b"])), "its personality and 2 skills");
        assert_eq!(
            summary(&plan_of(&["SOUL.md", "memory: MEMORY.md (3 notes)", "about you: USER.md", "skill: a", "skill: b"])),
            "its personality, its memory and 2 skills"
        );
    }
}
