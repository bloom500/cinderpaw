use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VoiceMeta {
    pub audio_path: String,
    pub duration_ms: u32,
    pub transcript: String,
    /// Normalized 0..1 peak buckets for the waveform.
    pub peaks: Vec<f32>,
}

/// What the agent wrote in its own scratchpad (`~/.feral/workspace`) during one
/// turn.
///
/// Persisted rather than kept in memory because the whole point of the line is
/// to be read AFTER the fact — by someone who walked away, and quite possibly
/// after restarting the app. A trace that survives only until the next launch is
/// the ephemeral tool strip again, one layer up.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ScratchStats {
    pub edits: u32,
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PersistedMessage {
    pub role: String,
    pub content: String,
    /// Chain-of-thought content shown as a collapsible "Thought for Xs" block.
    /// Optional so existing on-disk conversations without this field load cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// Present when this user turn was recorded as a voice message. Optional and
    /// `#[serde(default)]` so conversations saved before this field load cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceMeta>,
    /// Scratchpad churn for this turn. Absent on most messages and on every
    /// conversation saved before this field existed — same `#[serde(default)]`
    /// contract as the two above, so no migration and no unreadable history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch: Option<ScratchStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<PersistedMessage>,
    /// Agent that owns this conversation, if it was created in the Agents tab.
    /// `None` for ordinary chat conversations. `#[serde(default)]` keeps existing
    /// on-disk conversations (saved before this field existed) loadable.
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    /// Mirrors `Conversation::agent_id` so the sidebar can route a click to the
    /// right tab (Agents vs Chat) without loading the full conversation.
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ConversationIndex {
    conversations: Vec<ConversationSummary>,
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

fn read_index(dir: &Path) -> Result<Vec<ConversationSummary>> {
    let path = index_path(dir);
    if !path.exists() {
        return Ok(vec![]);
    }
    let bytes = std::fs::read(&path)?;
    let index: ConversationIndex = serde_json::from_slice(&bytes)?;
    Ok(index.conversations)
}

fn write_index(dir: &Path, summaries: &[ConversationSummary]) -> Result<()> {
    let index = ConversationIndex { conversations: summaries.to_vec() };
    std::fs::write(index_path(dir), serde_json::to_vec(&index)?)?;
    Ok(())
}

// ── Dir-parameterised core (used by both Tauri commands and tests) ─────────────

pub fn save_to_dir(
    dir: &Path,
    id: &str,
    title: &str,
    messages: &[PersistedMessage],
    agent_id: Option<&str>,
) -> Result<()> {
    std::fs::create_dir_all(dir)?;

    let conv_path = dir.join(format!("{}.json", id));
    // Preserve created_at and a previously-stored agent_id across re-saves. A
    // caller that doesn't supply agent_id (e.g. the chat path) must not wipe an
    // existing agent tag.
    let existing: Option<Conversation> = if conv_path.exists() {
        std::fs::read(&conv_path).ok()
            .and_then(|b| serde_json::from_slice::<Conversation>(&b).ok())
    } else {
        None
    };
    let created_at = existing
        .as_ref()
        .map(|c| c.created_at.clone())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let agent_id = agent_id
        .map(str::to_string)
        .or_else(|| existing.and_then(|c| c.agent_id));

    let updated_at = Utc::now().to_rfc3339();

    let conv = Conversation {
        id: id.to_string(),
        title: title.to_string(),
        created_at,
        updated_at: updated_at.clone(),
        messages: messages.to_vec(),
        agent_id: agent_id.clone(),
    };

    std::fs::write(&conv_path, serde_json::to_vec(&conv)?)?;

    let mut summaries = read_index(dir)?;
    let summary = ConversationSummary {
        id: id.to_string(),
        title: title.to_string(),
        updated_at,
        agent_id,
    };
    match summaries.iter_mut().find(|s| s.id == id) {
        Some(existing) => *existing = summary,
        None => summaries.push(summary),
    }
    write_index(dir, &summaries)?;

    Ok(())
}

pub fn load_from_dir(dir: &Path, id: &str) -> Result<Conversation> {
    let bytes = std::fs::read(dir.join(format!("{}.json", id)))?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn load_index_from_dir(dir: &Path) -> Result<Vec<ConversationSummary>> {
    read_index(dir)
}

pub fn delete_from_dir(dir: &Path, id: &str) -> Result<()> {
    let path = dir.join(format!("{}.json", id));
    // Best-effort cleanup of on-disk voice blobs referenced by this conversation
    // before the JSON is removed (errors ignored — orphaned files are harmless).
    if let Ok(conv) = load_from_dir(dir, id) {
        for m in &conv.messages {
            if let Some(v) = &m.voice {
                let _ = std::fs::remove_file(&v.audio_path);
            }
        }
    }
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let mut summaries = read_index(dir)?;
    summaries.retain(|s| s.id != id);
    write_index(dir, &summaries)?;
    Ok(())
}

// ── Tauri-facing wrappers ──────────────────────────────────────────────────────

pub fn save(id: &str, title: &str, messages: &[PersistedMessage], agent_id: Option<&str>) -> Result<()> {
    paths::ensure_dirs()?;
    save_to_dir(&paths::conversations_dir(), id, title, messages, agent_id)
}

pub fn load_all() -> Result<Vec<ConversationSummary>> {
    paths::ensure_dirs()?;
    load_index_from_dir(&paths::conversations_dir())
}

pub fn load(id: &str) -> Result<Conversation> {
    load_from_dir(&paths::conversations_dir(), id)
}

pub fn delete(id: &str) -> Result<()> {
    paths::ensure_dirs()?;
    delete_from_dir(&paths::conversations_dir(), id)
}

pub fn clear_all() -> Result<()> {
    paths::ensure_dirs()?;
    let dir = paths::conversations_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    write_index(&dir, &[])
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("feral_conv_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn msgs(n: usize) -> Vec<PersistedMessage> {
        (0..n)
            .map(|i| PersistedMessage {
                role: if i % 2 == 0 { "user".into() } else { "assistant".into() },
                content: format!("Message {}", i),
                thinking: None,
                voice: None,
                scratch: None,
            })
            .collect()
    }

    // ── RED tests written first ────────────────────────────────────────────────

    #[test]
    fn loads_message_without_voice_field() {
        let json = r#"{"role":"user","content":"hi"}"#;
        let m: PersistedMessage = serde_json::from_str(json).unwrap();
        assert!(m.voice.is_none());
        assert_eq!(m.content, "hi");
    }

    #[test]
    fn loads_message_written_before_the_scratch_field_existed() {
        // Every conversation already on a user's disk looks like this. Failing to
        // deserialize it would lose their whole history to a telemetry field.
        let json = r#"{"role":"assistant","content":"done","thinking":"hmm"}"#;
        let m: PersistedMessage = serde_json::from_str(json).unwrap();
        assert!(m.scratch.is_none());
        assert_eq!(m.thinking.as_deref(), Some("hmm"));
    }

    #[test]
    fn scratch_stats_survive_a_restart() {
        // The point of the whole change: the desktop used to hold this only in
        // memory, so "1 scratchpad edit +71" vanished the next time the app
        // launched — which is precisely when someone who walked away reads it.
        let dir = tmp();
        let msgs = vec![PersistedMessage {
            role: "assistant".into(),
            content: "wrote my notes".into(),
            thinking: None,
            voice: None,
            scratch: Some(ScratchStats { edits: 1, added: 71, removed: 0 }),
        }];
        save_to_dir(&dir, "c1", "Title", &msgs, None).unwrap();

        // Nothing in memory — read back off disk exactly as a fresh launch does.
        let conv = load_from_dir(&dir, "c1").unwrap();
        let s = conv.messages[0].scratch.as_ref().expect("scratch stats should survive");
        assert_eq!((s.edits, s.added, s.removed), (1, 71, 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_turn_that_touched_no_scratchpad_stores_no_field_at_all() {
        // `skip_serializing_if` — otherwise every message on disk grows a
        // `"scratch":null` for a line that will never be rendered.
        let m = PersistedMessage {
            role: "user".into(),
            content: "hi".into(),
            thinking: None,
            voice: None,
            scratch: None,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("scratch"), "absent stats must not be written: {json}");
    }

    #[test]
    fn save_creates_json_file_for_conversation() {
        let dir = tmp();
        save_to_dir(&dir, "c1", "Title", &msgs(3), None).unwrap();
        assert!(dir.join("c1.json").exists(), "conversation file should exist on disk");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_returns_all_messages_after_save() {
        let dir = tmp();
        save_to_dir(&dir, "c1", "Title", &msgs(3), None).unwrap();

        let conv = load_from_dir(&dir, "c1").unwrap();
        assert_eq!(conv.messages.len(), 3);
        assert_eq!(conv.messages[0].content, "Message 0");
        assert_eq!(conv.messages[2].content, "Message 2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_conversations_persist_and_reload_independently() {
        let dir = tmp();

        save_to_dir(&dir, "conv-a", "Alpha", &msgs(3), None).unwrap();
        save_to_dir(&dir, "conv-b", "Beta", &msgs(4), None).unwrap();

        // Simulate "app closed" — read fresh from disk, no in-memory state.
        let index = load_index_from_dir(&dir).unwrap();
        assert_eq!(index.len(), 2, "index must contain both conversations");

        let ids: Vec<&str> = index.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"conv-a"), "conv-a missing from index");
        assert!(ids.contains(&"conv-b"), "conv-b missing from index");

        let a = load_from_dir(&dir, "conv-a").unwrap();
        let b = load_from_dir(&dir, "conv-b").unwrap();
        assert_eq!(a.messages.len(), 3);
        assert_eq!(b.messages.len(), 4);

        // Verify content integrity
        for (i, msg) in a.messages.iter().enumerate() {
            assert_eq!(msg.content, format!("Message {}", i), "conv-a message {} corrupted", i);
        }
        for (i, msg) in b.messages.iter().enumerate() {
            assert_eq!(msg.content, format!("Message {}", i), "conv-b message {} corrupted", i);
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_overwrites_messages_without_duplicating_index_entry() {
        let dir = tmp();

        save_to_dir(&dir, "c1", "Title", &msgs(1), None).unwrap();
        save_to_dir(&dir, "c1", "Title", &msgs(3), None).unwrap(); // update same conversation

        let index = load_index_from_dir(&dir).unwrap();
        assert_eq!(index.len(), 1, "index must have exactly one entry after two saves to same id");

        let conv = load_from_dir(&dir, "c1").unwrap();
        assert_eq!(conv.messages.len(), 3, "should have 3 messages after update");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_removes_file_and_index_entry() {
        let dir = tmp();

        save_to_dir(&dir, "c1", "One", &msgs(2), None).unwrap();
        save_to_dir(&dir, "c2", "Two", &msgs(2), None).unwrap();

        delete_from_dir(&dir, "c1").unwrap();

        assert!(!dir.join("c1.json").exists(), "c1.json should be gone after delete");

        let index = load_index_from_dir(&dir).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].id, "c2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn full_roundtrip_simulating_app_restart() {
        // Closest to the integration requirement:
        // 1. Write 2 conversations (3+ messages each)
        // 2. Read everything from disk as if the app was restarted
        // 3. Verify all conversations and all messages are intact
        let dir = tmp();

        let conv1_msgs = vec![
            PersistedMessage { role: "user".into(),      content: "Hello world".into(),               thinking: None, voice: None, scratch: None },
            PersistedMessage { role: "assistant".into(), content: "Hi there!".into(),                 thinking: None, voice: None, scratch: None },
            PersistedMessage { role: "user".into(),      content: "What is Rust?".into(),             thinking: None, voice: None, scratch: None },
        ];
        let conv2_msgs = vec![
            PersistedMessage { role: "user".into(),      content: "Tell me a joke".into(),            thinking: None, voice: None, scratch: None },
            PersistedMessage { role: "assistant".into(), content: "Why did the crab...".into(),       thinking: None, voice: None, scratch: None },
            PersistedMessage { role: "user".into(),      content: "Ha! Another one".into(),           thinking: None, voice: None, scratch: None },
            PersistedMessage { role: "assistant".into(), content: "Sure! What do you call...".into(), thinking: None, voice: None, scratch: None },
        ];

        save_to_dir(&dir, "session-1", "Hello world", &conv1_msgs, None).unwrap();
        save_to_dir(&dir, "session-2", "Tell me a joke", &conv2_msgs, None).unwrap();

        // ── Simulate app restart: no in-memory state, read only from disk ──
        let index = load_index_from_dir(&dir).unwrap();
        assert_eq!(index.len(), 2, "should have 2 conversations after restart");

        let s1 = load_from_dir(&dir, "session-1").unwrap();
        let s2 = load_from_dir(&dir, "session-2").unwrap();

        assert_eq!(s1.messages.len(), 3);
        assert_eq!(s1.messages[0].role, "user");
        assert_eq!(s1.messages[0].content, "Hello world");
        assert_eq!(s1.messages[1].content, "Hi there!");
        assert_eq!(s1.messages[2].content, "What is Rust?");

        assert_eq!(s2.messages.len(), 4);
        assert_eq!(s2.messages[0].content, "Tell me a joke");
        assert_eq!(s2.messages[3].content, "Sure! What do you call...");

        std::fs::remove_dir_all(&dir).ok();
    }
}
