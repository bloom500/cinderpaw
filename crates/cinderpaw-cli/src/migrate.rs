//! `feral migrate` — the command surface.
//!
//! Prints the plan before it writes, always. The report's three sections are
//! ordered so the honest one cannot be missed: what it will do, what it could
//! not do, and what it refused to overwrite.
//!
//! The middle section is the reason this command is trustworthy. Everything the
//! source config holds and no importer claimed is listed there, straight out of
//! `KeyLedger` — so a channel or provider Cinderpaw has never heard of shows up as a
//! line in the report instead of quietly not working.

// Destructured palette fields keep their SCREAMING names so `{ACCENT}`-style
// interpolation reads the same here as in every other command file.
#![allow(non_snake_case)]

use std::path::PathBuf;

use cinderpaw_core::migrate::{self, Found, KeyLedger, Plan};

use crate::common::{self, palette, Palette};

/// Leftover key paths shown inline before the list is cut short. Long enough to
/// see the shape of what was left, short enough that the sections after it stay
/// on screen; `--json` always carries the full list.
const MAX_LEFTOVER_LINES: usize = 12;

pub fn render_report(found: &Found, plan: &Plan) -> String {
    let Palette { accent: ACCENT, meta: META, warn: WARN, bold: BOLD, dim: DIM, reset: RESET, .. } =
        palette();
    let mut out = String::new();
    let version = found.version.as_deref().map(|v| format!(" (v{v})")).unwrap_or_default();
    out.push_str(&format!(
        "{ACCENT}Found {}{RESET} at {}{DIM}{META}{version}{RESET}\n\n",
        found.source.label(),
        found.root.display(),
    ));

    out.push_str(&format!("{BOLD}Will import ({}){RESET}\n", plan.will_import.len()));
    if plan.will_import.is_empty() {
        out.push_str(&format!("  {DIM}{META}nothing{RESET}\n"));
    }
    for item in &plan.will_import {
        let note = item.note.as_deref().map(|n| format!("  ({n})")).unwrap_or_default();
        out.push_str(&format!("  {:<24} -> {}{}\n", item.what, item.target, note));
    }
    out.push('\n');

    // Never omitted. A missing section reads as "nothing was dropped".
    if plan.not_imported.is_empty() {
        out.push_str(&format!("{BOLD}Not imported: none{RESET}\n"));
    } else {
        out.push_str(&format!("{BOLD}Not imported ({}){RESET}\n", plan.not_imported.len()));
        for line in plan.not_imported.iter().take(MAX_LEFTOVER_LINES) {
            out.push_str(&format!("  {line}\n"));
        }
        let hidden = plan.not_imported.len().saturating_sub(MAX_LEFTOVER_LINES);
        if hidden > 0 {
            out.push_str(&format!(
                "  {DIM}{META}… and {hidden} more — `feral migrate --json` for the full list{RESET}\n"
            ));
        }
    }

    if !plan.conflicts.is_empty() {
        out.push_str(&format!("\n{WARN}Conflicts ({}){RESET}\n", plan.conflicts.len()));
        for line in &plan.conflicts {
            out.push_str(&format!("  {line}\n"));
        }
    }
    out
}

/// Everything in the source config that no importer in this increment claimed.
///
/// Persona files are markdown, so they consume nothing from the config — every
/// key is a leftover today, and increment 2 starts subtracting from this list as
/// importers land. A config we cannot parse yields one honest line instead of an
/// empty list: "unreadable" and "nothing left over" must never look the same.
fn leftovers(found: &Found) -> Vec<String> {
    let data = match migrate::read_source(found) {
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
    // Names only, never values (module contract). Secrets are increment 2.
    out.extend(data.env.keys().map(|k| format!(".env {k} — secrets need --with-secrets (not in this release)")));
    out
}

pub fn run(
    from: Option<String>,
    source: Option<PathBuf>,
    dry_run: bool,
    yes: bool,
    overwrite: bool,
) -> i32 {
    let Palette { ok: OK, meta: META, dim: DIM, reset: RESET, .. } = palette();
    let mut found = migrate::detect(source.as_deref());
    if let Some(want) = from.as_deref() {
        let want = want.to_lowercase();
        found.retain(|f| f.source.label().to_lowercase().starts_with(&want));
    }

    if found.is_empty() {
        println!("No OpenClaw or Hermes install found.");
        println!("If you have one somewhere unusual, point at it: feral migrate --source <path>");
        println!("Setting Cinderpaw up from scratch instead: feral setup");
        return 0;
    }

    let chosen = if found.len() == 1 { &found[0] } else { select(&found) };
    let mut plan = migrate::plan_persona(chosen, overwrite);
    plan.not_imported.extend(leftovers(chosen));

    if common::json() {
        // Machine-readable plan. Same content, no prompts, never writes.
        println!(
            "{}",
            serde_json::json!({
                "source": chosen.source.label(),
                "root": chosen.root,
                "version": chosen.version,
                "willImport": plan.will_import.iter().map(|i| serde_json::json!({
                    "what": i.what, "target": i.target, "note": i.note
                })).collect::<Vec<_>>(),
                "notImported": plan.not_imported,
                "conflicts": plan.conflicts,
                "backupDir": plan.backup_dir,
            })
        );
        return 0;
    }

    print!("{}", render_report(chosen, &plan));

    if dry_run {
        println!("\n{DIM}{META}Dry run — nothing was written.{RESET}");
        return 0;
    }
    if plan.will_import.is_empty() {
        println!("\nNothing to import.");
        return 0;
    }
    if !yes && !crate::guided::confirm("\nImport these?", false) {
        println!("Cancelled — nothing was written.");
        return 0;
    }

    match migrate::apply_persona(chosen, &plan) {
        Ok(done) => {
            println!("\n{OK}✓{RESET} imported {} file(s).", done.len());
            if plan.backup_dir.exists() {
                println!("  {DIM}{META}replaced files backed up to {}{RESET}", plan.backup_dir.display());
            }
            0
        }
        Err(e) => {
            eprintln!("\nmigrate failed partway: {e:#}");
            eprintln!("Your OpenClaw/Hermes install was not touched — it is only ever read.");
            1
        }
    }
}

fn select(found: &[Found]) -> &Found {
    println!("Found more than one install:\n");
    for (i, f) in found.iter().enumerate() {
        println!("  {}) {} — {}", i + 1, f.source.label(), f.root.display());
    }
    loop {
        let line = crate::guided::ask("\nWhich one? [1]");
        if line.is_empty() {
            return &found[0];
        }
        if let Ok(n) = line.parse::<usize>() {
            if n >= 1 && n <= found.len() {
                return &found[n - 1];
            }
        }
        println!("Pick a number between 1 and {}.", found.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cinderpaw_core::migrate::{Found, Plan, PlanItem, Source};
    use std::path::PathBuf;

    fn found() -> Found {
        Found {
            source: Source::OpenClaw,
            root: PathBuf::from("/home/u/.openclaw"),
            config: PathBuf::from("/home/u/.openclaw/openclaw.json"),
            version: Some("2026.6.11".into()),
        }
    }

    fn plan_with(not_imported: Vec<String>) -> Plan {
        Plan {
            will_import: vec![],
            not_imported,
            conflicts: vec![],
            backup_dir: PathBuf::from("/tmp/x"),
        }
    }

    #[test]
    fn the_report_names_what_it_could_not_bring() {
        let plan = Plan {
            will_import: vec![PlanItem {
                what: "SOUL.md".into(),
                target: "/home/u/.feral/SOUL.md".into(),
                note: None,
            }],
            not_imported: vec!["channels.signal — no Cinderpaw connector for Signal yet".into()],
            conflicts: vec![],
            backup_dir: PathBuf::from("/home/u/.feral/migration/openclaw/x"),
        };
        let out = render_report(&found(), &plan);
        assert!(out.contains("Will import (1)"));
        assert!(out.contains("Not imported (1)"));
        assert!(out.contains("channels.signal"));
    }

    #[test]
    fn an_empty_leftover_list_still_prints_the_section() {
        // Never empty by omission: a missing section reads as "nothing was
        // dropped", which is the one thing this report must not imply by accident.
        let out = render_report(&found(), &plan_with(vec![]));
        assert!(out.contains("Not imported: none"), "got:\n{out}");
    }

    #[test]
    fn the_source_version_is_shown_so_a_stale_mapping_is_visible() {
        let out = render_report(&found(), &plan_with(vec![]));
        assert!(out.contains("2026.6.11"), "got:\n{out}");
    }

    /// A real `openclaw.json` has more keys than fit on a screen. The count in
    /// the heading stays truthful even though the list is cut short, and the
    /// full list is one flag away.
    #[test]
    fn a_long_leftover_list_is_cut_short_but_the_count_is_not() {
        let many: Vec<String> = (0..30).map(|i| format!("some.key.number{i}")).collect();
        let out = render_report(&found(), &plan_with(many));
        assert!(out.contains("Not imported (30)"), "got:\n{out}");
        assert!(out.contains("some.key.number0"));
        assert!(!out.contains("some.key.number29"), "should be cut short:\n{out}");
        assert!(out.contains("and 18 more"), "got:\n{out}");
    }

    /// An unparseable config must not read as "nothing was left over" — that is
    /// the same output as a fully-imported install, for the opposite situation.
    #[test]
    fn an_unreadable_config_is_a_leftover_line_not_silence() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::write(root.join("openclaw.json"), "{ this is not json5 ][").unwrap();
        let f = Found {
            source: Source::OpenClaw,
            root: root.clone(),
            config: root.join("openclaw.json"),
            version: None,
        };

        let lines = leftovers(&f);

        assert_eq!(lines.len(), 1, "got: {lines:?}");
        assert!(lines[0].contains("could not be read"), "got: {lines:?}");
        let out = render_report(&f, &plan_with(lines));
        assert!(!out.contains("Not imported: none"), "got:\n{out}");
    }

    /// Hermes secret names belong in the report; their values must never be in
    /// any output this command produces.
    #[test]
    fn env_secret_names_are_reported_and_values_are_not() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::write(root.join("config.yaml"), "model: gpt\n").unwrap();
        std::fs::write(root.join(".env"), "DISCORD_BOT_TOKEN=hunter2\n").unwrap();
        let f = Found {
            source: Source::Hermes,
            root: root.clone(),
            config: root.join("config.yaml"),
            version: None,
        };

        let lines = leftovers(&f);
        let joined = lines.join("\n");

        assert!(joined.contains("DISCORD_BOT_TOKEN"), "got: {lines:?}");
        assert!(!joined.contains("hunter2"), "secret value leaked: {lines:?}");
        let out = render_report(&f, &plan_with(lines));
        assert!(!out.contains("hunter2"), "secret value leaked into report:\n{out}");
    }
}
