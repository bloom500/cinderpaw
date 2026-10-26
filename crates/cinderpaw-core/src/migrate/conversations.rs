//! Old conversations, as an archive to read in Cinderpaw's sidebar.
//!
//! They become ordinary saved conversations (`~/.cinderpaw/conversations/<id>.json`
//! plus `index.json`, the format src-tauri/src/conversations.rs writes and
//! api.rs reads), titled and dated as they were, with what the person wrote
//! and what the agent answered. Tool calls, tool output and reasoning stay
//! behind: they were the other agent's working steps, not the conversation.
//! Cinderpaw does not learn from them, and the Brings line says so: memory is
//! what carries over into new answers.
//!
//! Where they are:
//! - OpenClaw: `agents/<id>/sessions/<session>.jsonl` (one JSON per line;
//!   `type: "message"` lines carry `message.role` and `message.content`, a
//!   string or text blocks; `*.trajectory.jsonl` is a different log).
//! - Hermes: `state.db` (SQLite, read-only), tables `sessions` and `messages`
//!   (hermes_state_common.py).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{Action, Found, Plan, PlanItem, Source};

pub struct Chat {
    pub id: String,
    pub title: String,
    /// (role, text, epoch ms)
    pub messages: Vec<(String, String, i64)>,
}

fn safe_id(src: &str, raw: &str) -> String {
    let body: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    format!("import-{src}-{}", body.trim_matches('-'))
}

fn title_of(messages: &[(String, String, i64)]) -> String {
    let first = messages.iter().find(|m| m.0 == "user").map(|m| m.1.as_str()).unwrap_or("Old conversation");
    let line = first.lines().next().unwrap_or("").trim();
    let t: String = line.chars().take(60).collect();
    if t.is_empty() { "Old conversation".into() } else { t }
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.trim().to_string(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

fn ms_of(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s).ok().map(|t| t.timestamp_millis()),
        _ => None,
    }
}

fn openclaw_session(path: &Path) -> Option<Chat> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut id = path.file_stem()?.to_str()?.to_string();
    let mut messages = Vec::new();
    for line in text.lines() {
        let Ok(d) = serde_json::from_str::<Value>(line) else { continue };
        match d.get("type").and_then(|t| t.as_str()) {
            Some("session") => {
                if let Some(s) = d.get("id").and_then(|v| v.as_str()) {
                    id = s.to_string();
                }
            }
            Some("message") => {
                let Some(m) = d.get("message") else { continue };
                let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
                if role != "user" && role != "assistant" {
                    continue;
                }
                let body = text_of(m.get("content").unwrap_or(&Value::Null));
                if body.is_empty() {
                    continue;
                }
                let at = ms_of(m.get("timestamp")).or_else(|| ms_of(d.get("timestamp"))).unwrap_or(0);
                messages.push((role.to_string(), body, at));
            }
            _ => {}
        }
    }
    (!messages.is_empty()).then(|| Chat { id: safe_id("openclaw", &id), title: title_of(&messages), messages })
}

fn openclaw_chats(root: &Path) -> Vec<Chat> {
    let mut files = Vec::new();
    for agent in std::fs::read_dir(root.join("agents")).into_iter().flatten().flatten() {
        for f in std::fs::read_dir(agent.path().join("sessions")).into_iter().flatten().flatten() {
            let p = f.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.ends_with(".jsonl") && !name.ends_with(".trajectory.jsonl") {
                files.push(p);
            }
        }
    }
    files.sort();
    files.iter().filter_map(|p| openclaw_session(p)).collect()
}

fn hermes_chats(root: &Path) -> Vec<Chat> {
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = rusqlite::Connection::open_with_flags(root.join("state.db"), flags) else { return vec![] };
    let sessions: Vec<(String, Option<String>)> = match conn.prepare("SELECT id, title FROM sessions ORDER BY started_at") {
        Ok(mut stmt) => match stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))) {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => vec![],
        },
        Err(_) => return vec![],
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT role, content, timestamp FROM messages \
         WHERE session_id = ?1 AND role IN ('user', 'assistant') AND content IS NOT NULL AND content != '' \
         ORDER BY timestamp, id",
    ) else {
        return vec![];
    };
    let mut out = Vec::new();
    for (id, title) in sessions {
        let messages: Vec<(String, String, i64)> = match stmt.query_map([&id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?.trim().to_string(), (r.get::<_, f64>(2)? * 1000.0) as i64))
        }) {
            Ok(rows) => rows.flatten().filter(|m| !m.1.is_empty()).collect(),
            Err(_) => continue,
        };
        if messages.is_empty() {
            continue;
        }
        let title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| title_of(&messages));
        out.push(Chat { id: safe_id("hermes", &id), title, messages });
    }
    out
}

pub fn find_chats(source: Source, root: &Path) -> Vec<Chat> {
    match source {
        Source::OpenClaw => openclaw_chats(root),
        Source::Hermes => hermes_chats(root),
    }
}

/// One line for all of them: the list could be hundreds long.
pub fn plan_conversations_into(found: &Found, cinderpaw_dir: &Path, overwrite: bool, plan: &mut Plan) {
    let dir = cinderpaw_dir.join("conversations");
    let chats = find_chats(found.source, &found.root);
    let new = chats.iter().filter(|c| overwrite || !dir.join(format!("{}.json", c.id)).exists()).count();
    if chats.is_empty() {
        return;
    }
    if new == 0 {
        plan.conflicts.push(format!("{} old conversations: already brought over, kept them", chats.len()));
        return;
    }
    plan.will_import.push(PlanItem {
        what: format!("chats: {new} old conversation{}", if new == 1 { "" } else { "s" }),
        target: dir.display().to_string(),
        note: Some("to read in the sidebar; Cinderpaw does not learn from them, its memory does that".into()),
        source: found.root.clone(),
        action: Action::Conversations { root: found.root.clone(), source: found.source, dir },
    });
}

fn rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339()
}

/// Write every chat not already there, and add it to the sidebar's index.
pub fn write_chats(chats: &[Chat], dir: &Path, overwrite: bool) -> anyhow::Result<usize> {
    std::fs::create_dir_all(dir)?;
    let index_path = dir.join("index.json");
    let mut index: Value = std::fs::read(&index_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({ "conversations": [] }));
    if !index.get("conversations").is_some_and(|c| c.is_array()) {
        index = json!({ "conversations": [] });
    }
    let mut written = 0;
    for c in chats {
        let path: PathBuf = dir.join(format!("{}.json", c.id));
        if path.exists() && !overwrite {
            continue;
        }
        let first = c.messages.first().map(|m| m.2).unwrap_or(0);
        let last = c.messages.last().map(|m| m.2).unwrap_or(first);
        let messages: Vec<Value> = c
            .messages
            .iter()
            .map(|(role, text, at)| json!({ "role": role, "content": text, "created_at": at }))
            .collect();
        let conv = json!({
            "id": c.id, "title": c.title, "created_at": rfc3339(first), "updated_at": rfc3339(last),
            "messages": messages, "agent_id": null, "title_locked": true,
        });
        crate::atomic_file::write_atomic(&path, &serde_json::to_vec(&conv)?)?;
        let list = index["conversations"].as_array_mut().expect("checked above");
        list.retain(|s| s.get("id").and_then(|i| i.as_str()) != Some(c.id.as_str()));
        list.push(json!({ "id": c.id, "title": c.title, "updated_at": rfc3339(last), "agent_id": null }));
        written += 1;
    }
    // ponytail: the app's index lock lives in src-tauri; an import runs on the
    // onboarding screen (or the CLI), when no conversation is being saved.
    crate::atomic_file::write_atomic(&index_path, &serde_json::to_vec(&index)?)?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn empty_plan() -> Plan {
        Plan { will_import: vec![], not_imported: vec![], conflicts: vec![], backup_dir: PathBuf::from("b") }
    }

    #[test]
    fn openclaw_sessions_become_conversations_with_text_only() {
        let src = tempdir().unwrap();
        let sessions = src.path().join("agents/main/sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("abc.jsonl"),
            [
                r#"{"type":"session","id":"abc-123","timestamp":"2026-06-04T02:00:00Z"}"#,
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Plan my week\nplease"}],"timestamp":1780000000000}}"#,
                r#"{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"toolCall","name":"x"},{"type":"text","text":"Here is the plan."}],"timestamp":1780000001000}}"#,
                r#"{"type":"message","message":{"role":"toolResult","content":"secret tool output","timestamp":1780000002000}}"#,
                r#"{"type":"message","message":{"role":"assistant","content":[],"errorMessage":"429","timestamp":1780000003000}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(sessions.join("abc.trajectory.jsonl"), "{}").unwrap();
        let found = Found { source: Source::OpenClaw, root: src.path().to_path_buf(), config: src.path().join("openclaw.json"), version: None };
        let home = tempdir().unwrap();
        let mut plan = empty_plan();
        plan_conversations_into(&found, home.path(), false, &mut plan);
        assert_eq!(plan.will_import.len(), 1);
        assert_eq!(plan.will_import[0].what, "chats: 1 old conversation");
        super::super::apply(&plan).unwrap();

        let conv: Value = serde_json::from_slice(&fs::read(home.path().join("conversations/import-openclaw-abc-123.json")).unwrap()).unwrap();
        assert_eq!(conv["title"], "Plan my week");
        assert_eq!(conv["messages"].as_array().unwrap().len(), 2);
        assert_eq!(conv["messages"][1]["content"], "Here is the plan.");
        assert!(!conv.to_string().contains("secret tool output"));
        let index: Value = serde_json::from_slice(&fs::read(home.path().join("conversations/index.json")).unwrap()).unwrap();
        assert_eq!(index["conversations"][0]["id"], "import-openclaw-abc-123");

        // A second import finds them already there.
        let mut again = empty_plan();
        plan_conversations_into(&found, home.path(), false, &mut again);
        assert!(again.will_import.is_empty());
        assert_eq!(again.conflicts.len(), 1);
    }

    #[test]
    fn hermes_state_db_sessions_and_an_existing_index_is_kept() {
        let src = tempdir().unwrap();
        let conn = rusqlite::Connection::open(src.path().join("state.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL NOT NULL);
             CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL NOT NULL);
             INSERT INTO sessions VALUES ('20260101_120000_ab', 'Trip to Cluj', 1767268800.0);
             INSERT INTO messages (session_id, role, content, timestamp) VALUES
               ('20260101_120000_ab', 'user', 'Book a train', 1767268800.0),
               ('20260101_120000_ab', 'tool', '{...}', 1767268801.0),
               ('20260101_120000_ab', 'assistant', 'Done: 9:15 train.', 1767268802.5);",
        )
        .unwrap();
        drop(conn);
        let home = tempdir().unwrap();
        fs::create_dir_all(home.path().join("conversations")).unwrap();
        fs::write(home.path().join("conversations/index.json"), r#"{"conversations":[{"id":"mine","title":"Mine","updated_at":"x","agent_id":null}]}"#).unwrap();
        let found = Found { source: Source::Hermes, root: src.path().to_path_buf(), config: src.path().join("config.yaml"), version: None };
        let chats = find_chats(Source::Hermes, &found.root);
        assert_eq!(write_chats(&chats, &home.path().join("conversations"), false).unwrap(), 1);
        let conv: Value = serde_json::from_slice(&fs::read(home.path().join("conversations/import-hermes-20260101-120000-ab.json")).unwrap()).unwrap();
        assert_eq!(conv["title"], "Trip to Cluj");
        assert_eq!(conv["messages"][1]["created_at"], 1767268802500i64);
        let index: Value = serde_json::from_slice(&fs::read(home.path().join("conversations/index.json")).unwrap()).unwrap();
        let ids: Vec<_> = index["conversations"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["mine", "import-hermes-20260101-120000-ab"]);
    }
}
