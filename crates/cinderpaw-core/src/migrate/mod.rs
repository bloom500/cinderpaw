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
                serde_json::json!({
                    "source": f.source.label(),
                    "root": f.root,
                    "version": f.version,
                    "plan": plan(f, false),
                })
            })
            .collect(),
    )
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
