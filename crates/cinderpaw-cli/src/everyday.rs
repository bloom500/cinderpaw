//! Everyday commands that OpenClaw and Hermes Agent users already reach for:
//! `ask`, `sessions`, `skills`, `agents`, `backup`, `docs`, `memory`, `cron`,
//! `mcp`, `message`. Each one rides an engine route (`/runtime/...`) or a
//! folder that already exists. Their help lines are written for a 6th grader;
//! the detail lives here.

use std::path::{Path, PathBuf};

use clap::Subcommand;
use serde_json::{json, Value};

use crate::admin::{block_on, ensure_gateway, fetch_json, post_json_slow, post_json_with_body};
use crate::common::{json as json_mode, palette, read_token, Palette};

#[derive(Subcommand)]
pub enum SessionsAction {
    /// List your latest chats (default)
    List,
    /// Read one chat
    Show { id: String },
}

#[derive(Subcommand)]
pub enum SkillsAction {
    /// List the skills Cinderpaw knows (default)
    List,
    /// Read one skill
    Show { name: String },
    /// Remove one skill (asks first)
    Remove { name: String },
}

#[derive(Subcommand)]
pub enum BackupAction {
    /// Save a copy now (default)
    Create {
        /// Where to save it. Default: a "Cinderpaw Backups" folder in your home folder
        #[arg(long)]
        to: Option<PathBuf>,
    },
    /// List the copies you saved
    List,
    /// Bring a saved copy back (asks first, and saves a copy of now before it does)
    Restore {
        folder: PathBuf,
        /// Do not ask first
        #[arg(long)]
        yes: bool,
    },
}

fn token() -> Result<String, i32> {
    ensure_gateway()?;
    read_token().ok_or_else(|| {
        eprintln!("Cinderpaw is not ready yet. Run `cinderpaw doctor` to see why.");
        1
    })
}

// ── ask ──────────────────────────────────────────────────────────────────────

/// One question, one answer, no chat window: `openclaw agent --message` and
/// `hermes chat -q`. Its own session, `ask`, so it never lands in the middle of
/// a conversation the person has open elsewhere.
pub fn ask(question: &[String]) -> i32 {
    let q = question.join(" ");
    if q.trim().is_empty() {
        eprintln!("Write your question after `ask`, like this: cinderpaw ask \"What can you do?\"");
        return 2;
    }
    let token = match token() {
        Ok(t) => t,
        Err(code) => return code,
    };
    let Palette { meta: META, fail: FAIL, reset: RESET, .. } = palette();
    if !json_mode() {
        eprint!("{META}thinking...{RESET}\r");
    }
    let body = json!({ "content": q, "session_id": "ask", "stream": false });
    match block_on(post_json_slow(&token, "/runtime/chat", body)) {
        Ok(v) if json_mode() => {
            println!("{v}");
            0
        }
        Ok(v) => {
            eprint!("           \r");
            println!("{}", v["content"].as_str().unwrap_or("").trim());
            0
        }
        Err(e) => {
            eprintln!("{FAIL}No answer came back.{RESET} {e}");
            eprintln!("If that is about your key or your model, run `cinderpaw setup`. For anything else, `cinderpaw doctor` checks the rest.");
            1
        }
    }
}

// ── sessions ─────────────────────────────────────────────────────────────────

pub fn sessions(limit: usize, action: Option<SessionsAction>) -> i32 {
    let token = match token() {
        Ok(t) => t,
        Err(code) => return code,
    };
    let Palette { text: TEXT, meta: META, dim: DIM, bold: BOLD, accent: ACCENT, fail: FAIL, reset: RESET, .. } = palette();
    match action.unwrap_or(SessionsAction::List) {
        SessionsAction::List => {
            let v = match block_on(fetch_json(&token, &format!("/runtime/sessions?limit={limit}"))) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{FAIL}Could not read your chats.{RESET} {e}");
                    return 1;
                }
            };
            if json_mode() {
                println!("{v}");
                return 0;
            }
            let rows = v["sessions"].as_array().cloned().unwrap_or_default();
            if rows.is_empty() {
                println!("{META}No chats yet. Start one with `cinderpaw chat`.{RESET}");
                return 0;
            }
            for r in rows {
                let title = r["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("(no title)");
                let when = r["updated_at"].as_str().unwrap_or("").get(..10).unwrap_or("");
                println!("  {TEXT}{title}{RESET}  {DIM}{META}{when}  {}{RESET}", r["id"].as_str().unwrap_or(""));
            }
            println!("\n{META}Read one: cinderpaw sessions show <id>{RESET}");
            0
        }
        SessionsAction::Show { id } => {
            let v = match block_on(fetch_json(&token, &format!("/runtime/sessions/{id}/transcript"))) {
                Ok(v) => v,
                Err(_) => {
                    eprintln!("{FAIL}No chat with that id.{RESET} See the list with `cinderpaw sessions`.");
                    return 1;
                }
            };
            if json_mode() {
                println!("{v}");
                return 0;
            }
            println!("{BOLD}{}{RESET}\n", v["title"].as_str().unwrap_or("(no title)"));
            for m in v["messages"].as_array().cloned().unwrap_or_default() {
                let who = if m["role"] == "user" { format!("{ACCENT}You{RESET}") } else { format!("{BOLD}Cinderpaw{RESET}") };
                println!("{who}: {}\n", m["content"].as_str().unwrap_or("").trim());
            }
            0
        }
    }
}

// ── skills ───────────────────────────────────────────────────────────────────

fn skills_dir() -> PathBuf {
    cinderpaw_core::paths::cinderpaw_dir().join("skills")
}

/// `name:` and `description:` from the top of a SKILL.md, the two lines
/// `list_skills` reads too.
fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let grab = |key: &str| {
        text.lines()
            .take(30)
            .find_map(|l| l.strip_prefix(key).map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string()))
            .filter(|v| !v.is_empty())
    };
    (grab("name:"), grab("description:"))
}

/// A skill name as typed: one folder name, nothing that walks out of `skills/`.
fn skill_path(name: &str) -> Option<PathBuf> {
    let ok = !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', ':']);
    ok.then(|| skills_dir().join(name)).filter(|p| p.join("SKILL.md").is_file())
}

pub fn skills(action: Option<SkillsAction>) -> i32 {
    let Palette { text: TEXT, meta: META, dim: DIM, ok: OK, fail: FAIL, reset: RESET, .. } = palette();
    match action.unwrap_or(SkillsAction::List) {
        SkillsAction::List => {
            let mut rows: Vec<(String, String)> = std::fs::read_dir(skills_dir())
                .map(|it| {
                    it.flatten()
                        .filter_map(|e| {
                            let text = std::fs::read_to_string(e.path().join("SKILL.md")).ok()?;
                            let id = e.file_name().to_string_lossy().to_string();
                            Some((id, frontmatter(&text).1.unwrap_or_default()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            rows.sort();
            if json_mode() {
                let list: Vec<Value> = rows.iter().map(|(id, d)| json!({ "id": id, "description": d })).collect();
                println!("{}", json!({ "skills": list }));
                return 0;
            }
            if rows.is_empty() {
                println!("{META}No skills yet. Teach one in a chat (\"remember how to do this\"),");
                println!("or bring yours from OpenClaw or Hermes with `cinderpaw migrate`.{RESET}");
                return 0;
            }
            for (id, desc) in &rows {
                // One line each: the full description is one `skills show` away.
                let short: String = desc.chars().take(70).collect();
                let more = if desc.chars().count() > 70 { "..." } else { "" };
                println!("  {TEXT}{id}{RESET}  {DIM}{META}{short}{more}{RESET}");
            }
            println!("\n{META}Read one: cinderpaw skills show <name>{RESET}");
            0
        }
        SkillsAction::Show { name } => match skill_path(&name).and_then(|p| std::fs::read_to_string(p.join("SKILL.md")).ok()) {
            Some(text) => {
                println!("{text}");
                0
            }
            None => {
                eprintln!("{FAIL}No skill called \"{name}\".{RESET} See the list with `cinderpaw skills`.");
                1
            }
        },
        SkillsAction::Remove { name } => {
            let Some(path) = skill_path(&name) else {
                eprintln!("{FAIL}No skill called \"{name}\".{RESET} See the list with `cinderpaw skills`.");
                return 1;
            };
            if !crate::guided::confirm(&format!("Remove the skill \"{name}\"?"), false) {
                println!("Kept it.");
                return 0;
            }
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {
                    println!("{OK}✓{RESET} removed \"{name}\".");
                    0
                }
                Err(e) => {
                    eprintln!("{FAIL}Could not remove it:{RESET} {e}");
                    1
                }
            }
        }
    }
}

// ── agents ───────────────────────────────────────────────────────────────────

pub fn agents() -> i32 {
    let token = match token() {
        Ok(t) => t,
        Err(code) => return code,
    };
    let Palette { text: TEXT, meta: META, dim: DIM, warn: WARN, fail: FAIL, reset: RESET, .. } = palette();
    let v = match block_on(fetch_json(&token, "/runtime/cowork/team")) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{FAIL}Could not read your teammates.{RESET} {e}");
            return 1;
        }
    };
    if json_mode() {
        println!("{v}");
        return 0;
    }
    let roster = v["roster"].as_array().cloned().unwrap_or_default();
    if roster.is_empty() {
        println!("{META}No teammates yet. Ask Cinderpaw in a chat to make one, like \"make me a teammate who checks my email\".{RESET}");
    }
    for a in &roster {
        let model = a["model"].as_str().map(|m| format!("  · {m}")).unwrap_or_default();
        println!("  {TEXT}{}{RESET}  {DIM}{META}{}{model}{RESET}", a["name"].as_str().unwrap_or("?"), a["role"].as_str().unwrap_or(""));
    }
    let waiting = v["pendingApprovals"].as_array().map(Vec::len).unwrap_or(0);
    if waiting > 0 {
        println!("\n{WARN}{waiting} thing(s) waiting for your OK.{RESET} Open the app to answer: cinderpaw open");
    }
    0
}

// ── backup ───────────────────────────────────────────────────────────────────

/// Left out of a copy: models and voices (gigabytes, downloadable again), the
/// browser profile (cookies of every site the agent signed into), logs, the API
/// token, and the chat-app logins kept as files (WhatsApp and Zalo: whoever holds
/// them can act as the person's linked device). Keys are in the OS keychain,
/// never in the folder, so a copy holds no keys either.
const NOT_COPIED: &[&str] = &[
    "models", "kokoro", "piper", "moonshine", "livekit", "bin", "logs",
    "browser-profile", "browser-extensions", "browser-adblock", "browser-downloads",
    "api-token", "gateway.pid",
    "whatsapp-auth", "whatsapp-qr.json", "zalouser-session.json", "zalouser-qr.png",
];
const MARKER: &str = "cinderpaw-backup.json";

fn backups_root() -> PathBuf {
    let home = cinderpaw_core::paths::cinderpaw_dir();
    home.parent().map(Path::to_path_buf).unwrap_or(home).join("Cinderpaw Backups")
}

fn copy_tree(src: &Path, dst: &Path, top: bool) -> std::io::Result<u64> {
    let mut files = 0;
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if top && (NOT_COPIED.contains(&name_str.as_ref()) || name_str.ends_with(".log")) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files += copy_tree(&entry.path(), &dst.join(&name), false)?;
        } else {
            std::fs::copy(entry.path(), dst.join(&name))?;
            files += 1;
        }
    }
    Ok(files)
}

fn create_backup(to: Option<PathBuf>, label: &str) -> Result<(PathBuf, u64), String> {
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let dst = to.unwrap_or_else(backups_root).join(format!("{stamp}{label}"));
    let files = copy_tree(&cinderpaw_core::paths::cinderpaw_dir(), &dst, true).map_err(|e| e.to_string())?;
    let marker = json!({ "version": env!("CARGO_PKG_VERSION"), "created": stamp.to_string(), "files": files });
    std::fs::write(dst.join(MARKER), marker.to_string()).map_err(|e| e.to_string())?;
    Ok((dst, files))
}

pub fn backup(action: Option<BackupAction>) -> i32 {
    let Palette { text: TEXT, meta: META, dim: DIM, ok: OK, warn: WARN, fail: FAIL, reset: RESET, .. } = palette();
    match action.unwrap_or(BackupAction::Create { to: None }) {
        BackupAction::Create { to } => match create_backup(to, "") {
            Ok((dst, files)) => {
                if json_mode() {
                    println!("{}", json!({ "folder": dst, "files": files }));
                } else {
                    println!("{OK}✓{RESET} saved a copy ({files} files) in:\n  {}", dst.display());
                    println!("{DIM}{META}Your keys stay in your computer's keychain and chat-app logins stay out, so neither is in the copy.{RESET}");
                }
                0
            }
            Err(e) => {
                eprintln!("{FAIL}Could not save a copy:{RESET} {e}");
                1
            }
        },
        BackupAction::List => {
            let mut rows: Vec<PathBuf> = std::fs::read_dir(backups_root())
                .map(|it| it.flatten().map(|e| e.path()).filter(|p| p.join(MARKER).is_file()).collect())
                .unwrap_or_default();
            rows.sort();
            if json_mode() {
                println!("{}", json!({ "backups": rows }));
            } else if rows.is_empty() {
                println!("{META}No copies yet. Save one with `cinderpaw backup`.{RESET}");
            } else {
                for r in &rows {
                    println!("  {TEXT}{}{RESET}", r.display());
                }
            }
            0
        }
        BackupAction::Restore { folder, yes } => {
            if !folder.join(MARKER).is_file() {
                eprintln!("{FAIL}That folder is not a Cinderpaw copy.{RESET} See yours with `cinderpaw backup list`.");
                return 1;
            }
            println!("This puts back everything from:\n  {}", folder.display());
            println!("{META}Files that are not in the copy stay as they are. A copy of how things are now is saved first.{RESET}");
            if !yes && !crate::guided::confirm("Bring it back?", false) {
                println!("Nothing changed.");
                return 0;
            }
            // Stopped before anything is read or written: the safety copy and the
            // restore both touch the live SQLite file, which a running engine still
            // has open. One that will not stop means nothing changes.
            let port = crate::common::api_port();
            if crate::common::port_in_use(port) && (crate::admin::gateway_stop() != 0 || crate::common::port_in_use(port)) {
                eprintln!("{FAIL}Cinderpaw is still running, so nothing was changed.{RESET} Close the Cinderpaw app, then run this again.");
                return 1;
            }
            let safety = match create_backup(None, " before restore") {
                Ok((dst, _)) => dst,
                Err(e) => {
                    eprintln!("{FAIL}Could not save a copy of now first, so nothing was changed:{RESET} {e}");
                    return 1;
                }
            };
            match copy_tree(&folder, &cinderpaw_core::paths::cinderpaw_dir(), false) {
                Ok(_) => {
                    let _ = std::fs::remove_file(cinderpaw_core::paths::cinderpaw_dir().join(MARKER));
                    println!("{OK}✓{RESET} brought it back. Start Cinderpaw again with `cinderpaw open`.");
                    0
                }
                Err(e) => {
                    eprintln!("{WARN}It stopped partway:{RESET} {e}");
                    eprintln!("If the Cinderpaw app is open, close it and run this again.");
                    eprintln!("Nothing is lost: how things were before is in\n  {}", safety.display());
                    1
                }
            }
        }
    }
}

// ── memory ───────────────────────────────────────────────────────────────────

#[derive(Subcommand)]
pub enum MemoryAction {
    /// What Cinderpaw noted about you (default)
    List,
    /// Look something up in what Cinderpaw remembers
    Search {
        #[arg(required = true, num_args = 1..)]
        words: Vec<String>,
    },
    /// Forget one note (use its number from the list)
    Forget { id: i64 },
}

pub fn memory(action: Option<MemoryAction>) -> i32 {
    let token = match token() {
        Ok(t) => t,
        Err(code) => return code,
    };
    let Palette { text: TEXT, meta: META, dim: DIM, bold: BOLD, ok: OK, fail: FAIL, reset: RESET, .. } = palette();
    let print_notes = |v: &Value| {
        if let Some(card) = v["card"].as_str().filter(|c| !c.trim().is_empty()) {
            println!("{BOLD}About you{RESET}\n{card}\n");
        }
        let notes = v["notes"].as_array().cloned().unwrap_or_default();
        if notes.is_empty() {
            println!("{META}Nothing noted yet. Cinderpaw writes notes as you chat.{RESET}");
        }
        for n in &notes {
            println!("  {DIM}{META}#{:<5}{RESET} {TEXT}{}{RESET}", n["id"], n["text"].as_str().unwrap_or(""));
        }
    };
    match action.unwrap_or(MemoryAction::List) {
        MemoryAction::List => match block_on(fetch_json(&token, "/runtime/memory/notes")) {
            Ok(v) if json_mode() => {
                println!("{v}");
                0
            }
            Ok(v) => {
                print_notes(&v);
                println!("\n{META}Forget one: cinderpaw memory forget <number>{RESET}");
                0
            }
            Err(e) => {
                eprintln!("{FAIL}Could not read the memory.{RESET} {e}");
                1
            }
        },
        MemoryAction::Search { words } => {
            let mut url = reqwest::Url::parse("http://x/runtime/memory/search").expect("static url");
            url.query_pairs_mut().append_pair("q", &words.join(" "));
            match block_on(fetch_json(&token, &format!("{}?{}", url.path(), url.query().unwrap_or("")))) {
                Ok(v) if json_mode() => {
                    println!("{v}");
                    0
                }
                Ok(v) => {
                    let items = v["items"].as_array().cloned().unwrap_or_default();
                    if items.is_empty() {
                        println!("{META}Nothing about that yet.{RESET}");
                    }
                    for i in &items {
                        let kind = if i["kind"] == "fact" { "Fact" } else { "Past chat" };
                        println!("  {DIM}{META}{kind:<9}{RESET} {TEXT}{}{RESET}", i["text"].as_str().unwrap_or(""));
                    }
                    0
                }
                Err(e) => {
                    eprintln!("{FAIL}Could not search the memory.{RESET} {e}");
                    1
                }
            }
        }
        MemoryAction::Forget { id } => {
            if !crate::guided::confirm(&format!("Forget note #{id}?"), false) {
                println!("Kept it.");
                return 0;
            }
            match block_on(post_json_with_body(&token, "/runtime/memory/notes/delete", json!({ "noteId": id }))) {
                Ok(v) if v["ok"] == true => {
                    println!("{OK}✓{RESET} forgotten.");
                    0
                }
                Ok(v) => {
                    eprintln!("{FAIL}{}{RESET}", v["error"].as_str().unwrap_or("Could not forget it."));
                    1
                }
                Err(e) => {
                    eprintln!("{FAIL}Could not forget it.{RESET} {e}");
                    1
                }
            }
        }
    }
}

// ── cron ─────────────────────────────────────────────────────────────────────

#[derive(Subcommand)]
pub enum CronAction {
    /// Your scheduled tasks (default)
    List,
    /// Add a task, like: cinderpaw cron add "Summarize the news" --every 1d
    Add {
        /// What Cinderpaw should do, in plain words
        task: String,
        /// How often: 30m, 2h, 1d
        #[arg(long, conflicts_with_all = ["at", "cron"])]
        every: Option<String>,
        /// Once, at a time: "2026-10-07 09:00"
        #[arg(long, conflicts_with = "cron")]
        at: Option<String>,
        /// A cron line, for those who know them: "0 9 * * 1-5"
        #[arg(long)]
        cron: Option<String>,
        /// A short name (the task itself is used if you leave it out)
        #[arg(long)]
        name: Option<String>,
    },
    /// Delete a task
    Remove { id: String },
    /// Turn a task back on
    On { id: String },
    /// Pause a task
    Off { id: String },
}

/// "30m", "2h", "1d", "45s" in milliseconds.
fn interval_ms(text: &str) -> Option<u64> {
    let t = text.trim();
    let (num, unit) = t.split_at(t.find(|c: char| !c.is_ascii_digit())?);
    let n: u64 = num.parse().ok().filter(|n| *n > 0)?;
    let per = match unit.trim() {
        "s" | "sec" => 1_000,
        "m" | "min" => 60_000,
        "h" | "hour" | "hours" => 3_600_000,
        "d" | "day" | "days" => 86_400_000,
        _ => return None,
    };
    Some(n * per)
}

fn schedule_of(every: Option<String>, at: Option<String>, cron: Option<String>) -> Result<Value, String> {
    if let Some(e) = every {
        return interval_ms(&e)
            .map(|ms| json!({ "kind": "every", "intervalMs": ms }))
            .ok_or_else(|| format!("\"{e}\" is not a length of time. Try 30m, 2h or 1d."));
    }
    if let Some(a) = at {
        let local = chrono::NaiveDateTime::parse_from_str(a.trim(), "%Y-%m-%d %H:%M")
            .map_err(|_| format!("\"{a}\" is not a time. Write it like \"2026-10-07 09:00\"."))?;
        let when = local.and_local_timezone(chrono::Local).single().ok_or("That time happens twice or never (a clock change).")?;
        return Ok(json!({ "kind": "at", "isoTimestamp": when.to_rfc3339() }));
    }
    if let Some(c) = cron {
        if c.split_whitespace().count() != 5 {
            return Err(format!("\"{c}\" needs 5 parts, like \"0 9 * * 1-5\"."));
        }
        return Ok(json!({ "kind": "cron", "expression": c.trim() }));
    }
    Err("Say when: --every 1d, --at \"2026-10-07 09:00\", or --cron \"0 9 * * *\".".into())
}

fn describe_schedule(s: &Value) -> String {
    match s["kind"].as_str() {
        Some("every") => {
            let ms = s["intervalMs"].as_u64().unwrap_or(0);
            match ms {
                m if m % 86_400_000 == 0 => format!("every {}d", m / 86_400_000),
                m if m % 3_600_000 == 0 => format!("every {}h", m / 3_600_000),
                m => format!("every {}m", m / 60_000),
            }
        }
        Some("at") => format!("once, {}", s["isoTimestamp"].as_str().unwrap_or("").get(..16).unwrap_or("")),
        Some("cron") => format!("cron {}", s["expression"].as_str().unwrap_or("")),
        _ => "?".into(),
    }
}

pub fn cron(action: Option<CronAction>) -> i32 {
    let token = match token() {
        Ok(t) => t,
        Err(code) => return code,
    };
    let Palette { text: TEXT, meta: META, dim: DIM, ok: OK, warn: WARN, fail: FAIL, reset: RESET, .. } = palette();
    let reply = match action.unwrap_or(CronAction::List) {
        CronAction::List => block_on(fetch_json(&token, "/runtime/cron")),
        CronAction::Add { task, every, at, cron, name } => match schedule_of(every, at, cron) {
            Ok(schedule) => {
                let name = name.unwrap_or_else(|| task.chars().take(40).collect());
                block_on(post_json_with_body(&token, "/runtime/cron", json!({ "op": "add", "name": name, "task": task, "schedule": schedule })))
            }
            Err(e) => {
                eprintln!("{FAIL}{e}{RESET}");
                return 2;
            }
        },
        CronAction::Remove { id } => block_on(post_json_with_body(&token, "/runtime/cron", json!({ "op": "remove", "id": id }))),
        CronAction::On { id } => block_on(post_json_with_body(&token, "/runtime/cron", json!({ "op": "toggle", "id": id, "enabled": true }))),
        CronAction::Off { id } => block_on(post_json_with_body(&token, "/runtime/cron", json!({ "op": "toggle", "id": id, "enabled": false }))),
    };
    let v = match reply {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{FAIL}Could not reach the scheduled tasks.{RESET} {e}");
            return 1;
        }
    };
    if json_mode() {
        println!("{v}");
        return 0;
    }
    if let Some(e) = v["error"].as_str() {
        eprintln!("{WARN}{e}{RESET}");
    }
    let jobs = v["jobs"].as_array().cloned().unwrap_or_default();
    if jobs.is_empty() {
        println!("{META}No scheduled tasks. Add one: cinderpaw cron add \"Summarize the news\" --every 1d{RESET}");
    }
    for j in &jobs {
        let state = if j["enabled"] == true { format!("{OK}on {RESET}") } else { format!("{DIM}off{RESET}") };
        println!(
            "  {state} {TEXT}{}{RESET}  {DIM}{META}{}  ·  {}{RESET}",
            j["name"].as_str().unwrap_or("?"),
            describe_schedule(&j["schedule"]),
            j["id"].as_str().unwrap_or("")
        );
    }
    i32::from(v["ok"] == false)
}

// ── mcp ──────────────────────────────────────────────────────────────────────

pub fn mcp() -> i32 {
    let token = match token() {
        Ok(t) => t,
        Err(code) => return code,
    };
    let Palette { text: TEXT, meta: META, dim: DIM, ok: OK, warn: WARN, fail: FAIL, reset: RESET, .. } = palette();
    let v = match block_on(fetch_json(&token, "/runtime/mcp")) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{FAIL}Could not read the tool servers.{RESET} {e}");
            return 1;
        }
    };
    if json_mode() {
        println!("{v}");
        return 0;
    }
    let servers = v["servers"].as_array().cloned().unwrap_or_default();
    if servers.is_empty() {
        println!("{META}No extra tool servers yet. Add one in the app under Settings, or ask Cinderpaw in a chat.{RESET}");
    }
    for s in &servers {
        let state = match (s["running"] == true, s["error"].as_str()) {
            (true, _) => format!("{OK}running{RESET}  {DIM}{META}{} tools{RESET}", s["toolCount"]),
            (false, Some(e)) => format!("{WARN}not running{RESET}  {DIM}{META}{e}{RESET}"),
            (false, None) => format!("{DIM}not running{RESET}"),
        };
        println!("  {TEXT}{}{RESET}  {state}", s["id"].as_str().unwrap_or("?"));
    }
    0
}

// ── message ──────────────────────────────────────────────────────────────────

#[derive(Subcommand)]
pub enum MessageAction {
    /// Send one message, like: cinderpaw message send --to telegram:12345 "On my way"
    Send {
        /// Which chat: the app, a colon, and the chat's id (telegram:12345)
        #[arg(long)]
        to: String,
        /// What to say (use quotes)
        #[arg(required = true, num_args = 1..)]
        text: Vec<String>,
    },
}

pub fn message(action: MessageAction) -> i32 {
    let MessageAction::Send { to, text } = action;
    let token = match token() {
        Ok(t) => t,
        Err(code) => return code,
    };
    let Palette { ok: OK, fail: FAIL, reset: RESET, .. } = palette();
    match block_on(post_json_with_body(&token, "/runtime/message", json!({ "to": to, "text": text.join(" ") }))) {
        Ok(v) if v["ok"] == true => {
            println!("{OK}✓{RESET} sent.");
            0
        }
        Ok(v) => {
            eprintln!("{FAIL}Not sent:{RESET} {}", v["error"].as_str().unwrap_or("no reason given"));
            1
        }
        Err(e) => {
            eprintln!("{FAIL}Not sent.{RESET} {e}");
            1
        }
    }
}

// ── docs ─────────────────────────────────────────────────────────────────────

pub fn docs() -> i32 {
    const URL: &str = "https://cinderpaw.dev/docs";
    if !crate::install::launch_browser(URL) {
        println!("Open this in your browser: {URL}");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_skill_name_cannot_walk_out_of_the_skills_folder() {
        for bad in ["", ".", "..", "../secrets", "a/b", "a\\b", "C:x", ".hidden"] {
            assert!(skill_path(bad).is_none(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn a_schedule_is_read_the_way_people_write_it() {
        assert_eq!(interval_ms("30m"), Some(1_800_000));
        assert_eq!(interval_ms("2h"), Some(7_200_000));
        assert_eq!(interval_ms("1d"), Some(86_400_000));
        assert_eq!(interval_ms("0h"), None);
        assert_eq!(interval_ms("soon"), None);
        assert_eq!(schedule_of(Some("1d".into()), None, None).unwrap(), json!({ "kind": "every", "intervalMs": 86_400_000 }));
        assert_eq!(schedule_of(None, None, Some("0 9 * * 1-5".into())).unwrap()["kind"], "cron");
        assert!(schedule_of(None, None, Some("0 9 *".into())).is_err());
        assert!(schedule_of(None, Some("tomorrow".into()), None).is_err());
        assert!(schedule_of(None, None, None).is_err());
        assert_eq!(describe_schedule(&json!({ "kind": "every", "intervalMs": 7_200_000 })), "every 2h");
    }

    #[test]
    fn frontmatter_reads_name_and_description() {
        let (n, d) = frontmatter("---\nname: \"Summarize\"\ndescription: Short notes from long pages\n---\nbody");
        assert_eq!(n.as_deref(), Some("Summarize"));
        assert_eq!(d.as_deref(), Some("Short notes from long pages"));
    }

    #[test]
    fn a_copy_leaves_out_models_browser_cookies_logs_the_token_and_chat_logins() {
        let src = tempfile::tempdir().unwrap();
        for (p, body) in [("byok.json", "{}"), ("conversations/a.json", "{}"), ("models/big.gguf", "x"),
                          ("browser-profile/Cookies", "x"), ("gateway.log", "x"), ("api-token", "secret"),
                          ("whatsapp-auth/creds.json", "x"), ("zalouser-session.json", "x")] {
            let f = src.path().join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, body).unwrap();
        }
        let dst = tempfile::tempdir().unwrap();
        assert_eq!(copy_tree(src.path(), dst.path(), true).unwrap(), 2);
        assert!(dst.path().join("conversations/a.json").is_file());
        for gone in ["models", "browser-profile", "gateway.log", "api-token", "whatsapp-auth", "zalouser-session.json"] {
            assert!(!dst.path().join(gone).exists(), "{gone} was copied");
        }
    }
}
