//! Memory: what the other agent wrote down about its person and its work.
//!
//! OpenClaw keeps it as Markdown in its workspace: `MEMORY.md` (long-term),
//! `memory/YYYY-MM-DD[-slug].md` (daily notes) and `USER.md` (about the person).
//! Hermes Agent keeps `memories/MEMORY.md` and `memories/USER.md`, entries split
//! by a bare `§` line (`tools/memory_tool.py`, ENTRY_DELIMITER).
//!
//! It lands as `~/.cinderpaw/import/<source>/<name>.jsonl`, one note per line,
//! because the sidecar is the only writer of Cinderpaw's memory (the writer
//! contract, docs/agents-memory/project_memory_roadmap.md): it files each line
//! as an observation, or USER.md as the card about the person, at the start of
//! the next conversation (CinderpawAgent/src/memory/import-inbox.ts). Parsing
//! happens here, once, so the plan can say how many notes it found and an
//! untouched template brings nothing.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{Found, Plan, PlanItem, Source};

/// One line of an import file. `kind` is "note" or "card".
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Note {
    pub kind: &'static str,
    pub text: String,
    /// The day the note is about (`YYYY-MM-DD`), when the source says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub priority: &'static str,
}

/// A note longer than this is split at a sentence end: one memory, one idea.
const MAX_NOTE: usize = 600;

/// Sentences OpenClaw's own USER.md template ships with (both the older
/// fields template and the newer directives one). An untouched template is
/// help text for the agent, not something anybody said about the person.
const TEMPLATE_LINES: &[&str] = &[
    "the more you know, the better you can help",
    "store stable user preferences and profile facts as directives",
    "use one directive per entry",
    "begin each directive with an imperative",
    "record the observation date and either",
    "when a preference changes, mark the old entry",
    "keep stable communication style, relationships, and active-project context here",
];

/// Notes in a Markdown memory file. Headings become the context of the items
/// under them; template help, empty fields, link-only lines, code examples and
/// entries OpenClaw marked `status: superseded` are left out.
pub fn notes_from_markdown(text: &str) -> Vec<(String, Option<String>)> {
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    let mut heading: Option<String> = None;
    let mut skip_section = false;
    let mut in_code = false;
    let mut current: Option<String> = None;
    let mut date: Option<String> = None;
    let mut superseded = false;

    // A metadata comment (date, superseded) belongs to the one entry after it.
    let mut flush = |current: &mut Option<String>, heading: &Option<String>, date: &mut Option<String>, superseded: &mut bool| {
        if let Some(t) = current.take() {
            let t = clean(&t);
            let day = date.take();
            if !std::mem::take(superseded) && is_content(&t) {
                let t = match heading {
                    Some(h) => format!("{h}: {t}"),
                    None => t,
                };
                for part in split_long(&t) {
                    out.push((part, day.clone()));
                }
            }
        }
    };

    for raw in text.lines() {
        let line = raw.trim_end();
        let t = line.trim();
        if t.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        if let Some(meta) = t.strip_prefix("<!--").and_then(|r| r.strip_suffix("-->")) {
            flush(&mut current, &heading, &mut date, &mut superseded);
            superseded = meta.contains("status: superseded");
            date = meta
                .split('|')
                .find_map(|p| p.trim().strip_prefix("observed:").map(|d| d.trim().to_string()))
                .filter(|d| is_date(d));
            continue;
        }
        if t.starts_with('#') {
            flush(&mut current, &heading, &mut date, &mut superseded);
            let level = t.chars().take_while(|c| *c == '#').count();
            let name = clean(t.trim_start_matches('#'));
            skip_section = name.eq_ignore_ascii_case("related");
            // The file's own title is not context for its notes.
            heading = (level > 1 && !name.is_empty()).then_some(name);
            continue;
        }
        if skip_section {
            continue;
        }
        if t.is_empty() || t == "§" || t.chars().all(|c| c == '-' || c == '*' || c == '_') {
            flush(&mut current, &heading, &mut date, &mut superseded);
            continue;
        }
        let item = ["- ", "* ", "+ "].iter().find_map(|m| t.strip_prefix(m)).or_else(|| numbered(t));
        match item {
            Some(rest) => {
                flush(&mut current, &heading, &mut date, &mut superseded);
                current = Some(rest.to_string());
            }
            None => match current.as_mut() {
                Some(c) => {
                    c.push(' ');
                    c.push_str(t);
                }
                None => current = Some(t.to_string()),
            },
        }
    }
    flush(&mut current, &heading, &mut date, &mut superseded);
    out
}

/// Hermes entries: prose split on a bare `§` line, each entry one note.
pub fn notes_from_entries(text: &str) -> Vec<String> {
    text.split('\n')
        .collect::<Vec<_>>()
        .split(|l| l.trim() == "§")
        .map(|lines| clean(&lines.join(" ")))
        .filter(|t| is_content(t))
        .flat_map(|t| split_long(&t))
        .collect()
}

fn numbered(t: &str) -> Option<&str> {
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    (digits > 0).then(|| t[digits..].strip_prefix(". ")).flatten()
}

/// Markup off, italic hints like `_(optional)_` gone, spaces collapsed.
fn clean(s: &str) -> String {
    let mut s = s.replace("**", "").replace("__", "");
    // `_(...)_` and a whole-line `_..._` are template hints, never content.
    while let (Some(a), Some(b)) = (s.find("_("), s.find(")_")) {
        if b < a {
            break;
        }
        s.replace_range(a..b + 2, "");
    }
    let t = s.trim();
    let t = if t.len() > 1 && t.starts_with('_') && t.ends_with('_') { "" } else { t };
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_content(t: &str) -> bool {
    if t.is_empty() || t.ends_with(':') {
        return false; // an empty field such as "Name:"
    }
    if t.ends_with("...") || t.ends_with('…') {
        return t.trim_end_matches(['.', '…']).split_whitespace().count() > 3; // "Prefer ..." is a placeholder
    }
    let lower = t.to_lowercase();
    if TEMPLATE_LINES.iter().any(|l| lower.starts_with(l)) {
        return false;
    }
    // Only a link: navigation, not memory.
    !(t.starts_with('[') && t.ends_with(')') && t.contains("]("))
}

fn split_long(t: &str) -> Vec<String> {
    if t.len() <= MAX_NOTE {
        return vec![t.to_string()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    for sentence in t.split_inclusive(". ") {
        if !cur.is_empty() && cur.len() + sentence.len() > MAX_NOTE {
            out.push(cur.trim().to_string());
            cur.clear();
        }
        cur.push_str(sentence);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && s.chars().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `2026-07-01.md` and `2026-07-01-standup.md` are about 2026-07-01.
fn date_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let d = name.get(..10)?;
    is_date(d).then(|| d.to_string())
}

/// Daily notes: every `.md` under `memory/`, a few levels deep (OpenClaw's own
/// imports from other agents live in `memory/imports/<agent>/`).
fn daily_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        if p.is_dir() && depth > 0 {
            daily_files(&p, depth - 1, out);
        } else if p.extension().is_some_and(|e| e == "md") {
            out.push(p);
        }
    }
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn jsonl(notes: &[Note]) -> String {
    notes.iter().map(|n| serde_json::to_string(n).unwrap_or_default() + "\n").collect()
}

fn note(text: String, date: Option<String>, priority: &'static str) -> Note {
    Note { kind: "note", text, date, priority }
}

/// Add the source's memory to `plan`: one import file per kind of memory, so
/// the Brings list says what each one is and how much of it there is.
pub fn plan_memory_into(found: &Found, cinderpaw_dir: &Path, overwrite: bool, plan: &mut Plan) {
    let src = match found.source {
        Source::OpenClaw => "openclaw",
        Source::Hermes => "hermes",
    };
    let inbox = cinderpaw_dir.join("import").join(src);
    let read = |rel: &str| std::fs::read_to_string(found.root.join(rel)).ok();
    let push = |name: &str, what: String, source: PathBuf, notes: Vec<Note>, plan: &mut Plan| {
        if notes.is_empty() {
            return;
        }
        let target = inbox.join(format!("{name}.jsonl"));
        if target.exists() && !overwrite {
            plan.conflicts.push(format!("{what}: an earlier import is still waiting to be read, kept it"));
            return;
        }
        plan.will_import.push(PlanItem {
            what,
            target: target.display().to_string(),
            note: None,
            source,
            content: Some(jsonl(&notes)),
        });
    };

    let (memory_rel, user_rel) = match found.source {
        Source::OpenClaw => ("workspace/MEMORY.md", "workspace/USER.md"),
        Source::Hermes => ("memories/MEMORY.md", "memories/USER.md"),
    };
    let entries = |text: &str| -> Vec<(String, Option<String>)> {
        match found.source {
            Source::OpenClaw => notes_from_markdown(text),
            Source::Hermes => notes_from_entries(text).into_iter().map(|t| (t, None)).collect(),
        }
    };

    if let Some(text) = read(memory_rel) {
        let notes: Vec<Note> = entries(&text).into_iter().map(|(t, d)| note(t, d, "high")).collect();
        let what = format!("memory: MEMORY.md ({})", plural(notes.len(), "note"));
        push("MEMORY", what, found.root.join(memory_rel), notes, plan);
    }

    if found.source == Source::OpenClaw {
        let mut files = Vec::new();
        daily_files(&found.root.join("workspace/memory"), 3, &mut files);
        let notes: Vec<Note> = files
            .iter()
            .flat_map(|f| {
                let day = date_of(f);
                let text = std::fs::read_to_string(f).unwrap_or_default();
                notes_from_markdown(&text).into_iter().map(move |(t, d)| note(t, d.or_else(|| day.clone()), "med"))
            })
            .collect();
        let what = format!("memory: {} ({})", plural(files.len(), "daily note"), plural(notes.len(), "note"));
        push("daily", what, found.root.join("workspace/memory"), notes, plan);
    }

    if let Some(text) = read(user_rel) {
        let lines: Vec<String> = entries(&text).into_iter().map(|(t, _)| format!("- {t}")).collect();
        if lines.is_empty() {
            plan.not_imported.push(format!("{user_rel} — still the empty template, nothing about you in it yet"));
        } else {
            let card = Note { kind: "card", text: lines.join("\n"), date: None, priority: "high" };
            push("USER", "about you: USER.md".to_string(), found.root.join(user_rel), vec![card], plan);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn found(source: Source, root: &Path) -> Found {
        Found { source, root: root.to_path_buf(), config: root.join("c"), version: None }
    }
    fn empty_plan() -> Plan {
        Plan { will_import: vec![], not_imported: vec![], conflicts: vec![], backup_dir: PathBuf::from("b") }
    }
    fn texts(v: Vec<(String, Option<String>)>) -> Vec<String> {
        v.into_iter().map(|(t, _)| t).collect()
    }

    // Darius's real OpenClaw USER.md, 18 Oct 2026: the untouched older template.
    const OLD_TEMPLATE: &str = "# USER.md - About Your Human\n\n_Learn about the person you're helping. Update this as you go._\n\n- **Name:**\n- **What to call them:**\n- **Pronouns:** _(optional)_\n- **Timezone:**\n- **Notes:**\n\n## Context\n\n_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_\n\n---\n\nThe more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.\n\n## Related\n\n- [Agent workspace](/concepts/agent-workspace)\n";
    // OpenClaw's current template (docs/reference/templates/USER.md, e051a7bb).
    const NEW_TEMPLATE: &str = "# USER.md - User Model\n\nStore stable user preferences and profile facts as directives that can guide future sessions.\n\nUse one directive per entry:\n\n```md\n<!-- observed: YYYY-MM-DD | status: active -->\n\n- Prefer concise progress updates during implementation work.\n```\n\n- Begin each directive with an imperative such as `Always`, `Never`, or `Prefer`.\n- Record the observation date and either `active` or `superseded` on the metadata line.\n- When a preference changes, mark the old entry `superseded` and rewrite the active directive in place. Never append a contradictory active directive.\n- Keep stable communication style, relationships, and active-project context here. Put durable non-profile facts and decisions in `MEMORY.md`.\n\n## Directives\n\n<!-- observed: YYYY-MM-DD | status: active -->\n\n- Prefer ...\n\n## Related\n\n- [Agent workspace](/concepts/agent-workspace)\n";

    #[test]
    fn an_untouched_template_brings_nothing() {
        assert!(notes_from_markdown(OLD_TEMPLATE).is_empty(), "{:?}", notes_from_markdown(OLD_TEMPLATE));
        assert!(notes_from_markdown(NEW_TEMPLATE).is_empty(), "{:?}", notes_from_markdown(NEW_TEMPLATE));
    }

    #[test]
    fn filled_fields_and_directives_come_through_and_superseded_ones_do_not() {
        let filled = OLD_TEMPLATE.replace("- **Name:**", "- **Name:** Darius").replace("- **Timezone:**", "- **Timezone:** Europe/Bucharest");
        assert_eq!(texts(notes_from_markdown(&filled)), ["Name: Darius", "Timezone: Europe/Bucharest"]);

        let directives = "## Directives\n\n<!-- observed: 2026-07-01 | status: superseded -->\n\n- Prefer long answers.\n\n<!-- observed: 2026-08-02 | status: active -->\n\n- Prefer short answers in Romanian.\n";
        assert_eq!(
            notes_from_markdown(directives),
            [("Directives: Prefer short answers in Romanian.".to_string(), Some("2026-08-02".to_string()))]
        );
    }

    #[test]
    fn items_keep_their_heading_and_continuation_lines() {
        let md = "# MEMORY\n\n## Projects\n- Cinderpaw launched on\n  16 Oct.\n1. Site is cinderpaw.dev\n\nLikes cozy apps.\n";
        assert_eq!(
            texts(notes_from_markdown(md)),
            ["Projects: Cinderpaw launched on 16 Oct.", "Projects: Site is cinderpaw.dev", "Projects: Likes cozy apps."]
        );
    }

    #[test]
    fn hermes_entries_split_on_the_section_sign() {
        let text = "User runs Windows 11.\n§\nPrefers Romanian,\nshort replies.\n§\n\n";
        assert_eq!(notes_from_entries(text), ["User runs Windows 11.", "Prefers Romanian, short replies."]);
    }

    #[test]
    fn a_very_long_note_is_split_at_sentence_ends() {
        let long = "One sentence here. ".repeat(60);
        let parts = split_long(long.trim());
        assert!(parts.len() > 1 && parts.iter().all(|p| p.len() <= MAX_NOTE));
    }

    #[test]
    fn openclaw_memory_daily_notes_and_user_land_in_the_inbox() {
        let src = tempdir().unwrap();
        let ws = src.path().join("workspace");
        fs::create_dir_all(ws.join("memory/imports/hermes")).unwrap();
        fs::write(ws.join("MEMORY.md"), "- Decided to ship on Windows first.\n").unwrap();
        fs::write(ws.join("memory/2026-07-01.md"), "- Fixed the installer.\n- Wrote the README.\n").unwrap();
        fs::write(ws.join("memory/2026-07-02-standup.md"), "Talked about voice.\n").unwrap();
        fs::write(ws.join("memory/imports/hermes/MEMORY.md"), "Old Hermes note.\n").unwrap();
        fs::write(ws.join("USER.md"), OLD_TEMPLATE.replace("- **Name:**", "- **Name:** Darius")).unwrap();
        let home = tempdir().unwrap();
        let mut plan = empty_plan();
        plan_memory_into(&found(Source::OpenClaw, src.path()), home.path(), false, &mut plan);

        let what: Vec<_> = plan.will_import.iter().map(|i| i.what.as_str()).collect();
        assert_eq!(what, ["memory: MEMORY.md (1 note)", "memory: 3 daily notes (4 notes)", "about you: USER.md"]);
        super::super::apply(&plan).unwrap();

        let daily = fs::read_to_string(home.path().join("import/openclaw/daily.jsonl")).unwrap();
        assert!(daily.contains(r#""text":"Fixed the installer.","date":"2026-07-01","priority":"med""#), "{daily}");
        assert!(daily.contains(r#""date":"2026-07-02""#));
        let user = fs::read_to_string(home.path().join("import/openclaw/USER.jsonl")).unwrap();
        assert_eq!(user, "{\"kind\":\"card\",\"text\":\"- Name: Darius\",\"priority\":\"high\"}\n");
        // The source is only read.
        assert!(ws.join("MEMORY.md").is_file());
    }

    #[test]
    fn an_empty_template_user_md_is_reported_not_imported() {
        let src = tempdir().unwrap();
        fs::create_dir_all(src.path().join("workspace")).unwrap();
        fs::write(src.path().join("workspace/USER.md"), OLD_TEMPLATE).unwrap();
        let home = tempdir().unwrap();
        let mut plan = empty_plan();
        plan_memory_into(&found(Source::OpenClaw, src.path()), home.path(), false, &mut plan);
        assert!(plan.will_import.is_empty());
        assert_eq!(plan.not_imported.len(), 1);
        assert!(plan.not_imported[0].contains("still the empty template"));
    }

    #[test]
    fn hermes_memory_and_user_and_a_waiting_import_is_kept() {
        let src = tempdir().unwrap();
        fs::create_dir_all(src.path().join("memories")).unwrap();
        fs::write(src.path().join("memories/MEMORY.md"), "Project uses Bun.\n§\nDeploys on Fridays.").unwrap();
        fs::write(src.path().join("memories/USER.md"), "Name is Ana.").unwrap();
        let home = tempdir().unwrap();
        fs::create_dir_all(home.path().join("import/hermes")).unwrap();
        fs::write(home.path().join("import/hermes/USER.jsonl"), "waiting\n").unwrap();
        let mut plan = empty_plan();
        plan_memory_into(&found(Source::Hermes, src.path()), home.path(), false, &mut plan);
        let what: Vec<_> = plan.will_import.iter().map(|i| i.what.as_str()).collect();
        assert_eq!(what, ["memory: MEMORY.md (2 notes)"]);
        assert_eq!(plan.conflicts.len(), 1, "the waiting USER import is not overwritten");
    }
}
