use leptos::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::pages::types::{LoadedModel, Message};

// ── Model Load Context ────────────────────────────────────────────────────────

/// Global model loading state. Shared between ChatPage pill and ModelsPage so
/// both UIs stay in sync with a single source of truth.
#[derive(Clone, Copy)]
pub struct ModelLoadContext {
    pub loaded: RwSignal<Option<LoadedModel>>,
    pub loading: RwSignal<bool>,
    pub progress: RwSignal<f64>,
    pub status: RwSignal<String>,
}

impl ModelLoadContext {
    pub fn new() -> Self {
        Self {
            loaded: create_rw_signal(None),
            loading: create_rw_signal(false),
            progress: create_rw_signal(0.0),
            status: create_rw_signal(String::new()),
        }
    }
}

// ── Download Context ──────────────────────────────────────────────────────────

/// Global download state — provided at App root, persists across tab navigation.
#[derive(Clone, Copy)]
pub struct DownloadContext {
    pub downloading: RwSignal<bool>,
    pub progress:    RwSignal<f32>,
    pub model_name:  RwSignal<String>,
    pub dl_id:       RwSignal<Option<String>>,
    pub dl_done:     RwSignal<bool>,
    pub dl_error:    RwSignal<Option<String>>,
}

// ── Layout Context ─────────────────────────────────────────────────────────────

/// Persistent shell layout state — sidebar collapse + first-paint guard.
/// Provided at App root so it survives every route navigation.
#[derive(Clone, Copy)]
pub struct LayoutContext {
    pub sidebar_collapsed: RwSignal<bool>,
    /// True until the first paint completes. Used to suppress slide-in animation
    /// on initial load when restoring collapsed state from localStorage.
    pub no_transition: RwSignal<bool>,
    pub skill_hub_open: RwSignal<bool>,
}

impl LayoutContext {
    pub fn new() -> Self {
        Self {
            sidebar_collapsed: create_rw_signal(read_sidebar_collapsed()),
            no_transition: create_rw_signal(true),
            skill_hub_open: create_rw_signal(false),
        }
    }

    pub fn toggle(&self) {
        let new_val = !self.sidebar_collapsed.get_untracked();
        self.sidebar_collapsed.set(new_val);
        write_sidebar_collapsed(new_val);
    }

    pub fn collapse(&self, val: bool) {
        self.sidebar_collapsed.set(val);
        write_sidebar_collapsed(val);
    }
}

pub fn read_sidebar_collapsed() -> bool {
    web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
        .and_then(|ls| ls.get_item("feral_sidebar_collapsed").ok().flatten())
        .map(|v| v == "true")
        .unwrap_or(false)
}

pub fn write_sidebar_collapsed(val: bool) {
    if let Some(ls) = web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
    {
        let _ = ls.set_item(
            "feral_sidebar_collapsed",
            if val { "true" } else { "false" },
        );
    }
}

// ── Chat Context ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSessionSummary {
    pub id: String,
    pub title: String,
}

/// Matches the backend ConversationSummary returned by load_conversations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// Matches the backend Conversation returned by load_conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedConversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<Message>,
}

#[derive(Clone, Copy)]
pub struct ChatContext {
    /// ID of the active conversation
    pub active_session_id: RwSignal<Option<String>>,
    /// Current messages in the active conversation
    pub messages: RwSignal<Vec<Message>>,
    /// All conversation summaries (sidebar history)
    pub history: RwSignal<Vec<ChatSessionSummary>>,
    /// Full message history keyed by session ID
    pub sessions: RwSignal<HashMap<String, Vec<Message>>>,
    /// Whether the model is currently generating (lives here so App-level listeners can write it)
    pub busy: RwSignal<bool>,
    /// Accumulated text from the live token stream. Reset to "" on stream completion.
    /// The streaming display component reads this directly — not chat.messages — to
    /// avoid re-rendering the completed message list on every token.
    pub streaming_content: RwSignal<String>,
    /// Per-completed-AI-message metadata: (datetime, token_count, tokens_per_sec).
    /// Lives in context so it survives navigation; reset on session swap.
    pub ai_meta: RwSignal<Vec<(String, u32, f32)>>,
    /// Per-session token accumulator for streams whose session is NOT currently
    /// active. Avoids invalidating the `sessions` signal on every background
    /// token. Flushed into `sessions` either on stream-done or when the user
    /// navigates back to the session via `load_session`.
    pub bg_buffers: StoredValue<HashMap<String, String>>,
}

impl ChatContext {
    pub fn new() -> Self {
        Self {
            active_session_id: create_rw_signal(None),
            messages: create_rw_signal(Vec::new()),
            history: create_rw_signal(Vec::new()),
            sessions: create_rw_signal(HashMap::new()),
            busy: create_rw_signal(false),
            streaming_content: create_rw_signal(String::new()),
            ai_meta: create_rw_signal(Vec::new()),
            bg_buffers: store_value(HashMap::new()),
        }
    }

    /// Drain any buffered background tokens for `id` into the `sessions` map.
    /// Call before reading `sessions[id]` to ensure the snapshot is complete.
    pub fn flush_bg_buffer(&self, id: &str) {
        let pending = self.bg_buffers.with_value(|b| b.get(id).cloned());
        let Some(pending) = pending else { return };
        if pending.is_empty() { return; }
        self.bg_buffers.update_value(|b| { b.remove(id); });
        self.sessions.update(|s| {
            if let Some(msgs) = s.get_mut(id) {
                if let Some(last) = msgs.last_mut() {
                    if last.role == "assistant" {
                        last.content.push_str(&pending);
                    }
                }
            }
        });
    }

    fn session_title(msgs: &[Message]) -> String {
        msgs.iter()
            .find(|m| m.role == "user")
            .map(|m| {
                let t = m.content.trim();
                let end = t.char_indices().nth(38).map(|(i, _)| i).unwrap_or(t.len());
                if t.len() > end { format!("{}…", &t[..end]) } else { t.to_string() }
            })
            .unwrap_or_else(|| "Conversation".into())
    }

    /// Persist the active conversation into `sessions` + `history` before swapping,
    /// and schedule an immediate disk write.
    pub fn save_current(&self) {
        let current = self.messages.get();
        if current.is_empty() { return; }
        let current_id = self.active_session_id.get()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let title = Self::session_title(&current);

        // In-memory update
        self.sessions.update(|s| { s.insert(current_id.clone(), current.clone()); });
        self.history.update(|h| {
            if let Some(entry) = h.iter_mut().find(|s| s.id == current_id) {
                entry.title = title.clone();
            } else {
                h.push(ChatSessionSummary { id: current_id.clone(), title: title.clone() });
            }
        });

        // Disk write — fire-and-forget, instant (no buffering in backend)
        let id = current_id;
        let msgs = current;
        wasm_bindgen_futures::spawn_local(async move {
            let _ = crate::tauri_bridge::invoke_unit("save_conversation", &serde_json::json!({
                "id": id,
                "title": title,
                "messages": msgs,
            })).await;
        });
    }

    /// Save the active conversation, then load the one with `id`.
    /// If the session is not yet in memory, loads its messages from disk.
    pub fn load_session(&self, id: String) {
        self.save_current();
        self.ai_meta.set(vec![]);
        // Drain any pending background tokens for this id BEFORE snapshotting
        // sessions[id] — otherwise the user would see a stale view missing
        // tokens that arrived while the session was off-screen.
        self.flush_bg_buffer(&id);

        // If already in memory, switch immediately
        if let Some(msgs) = self.sessions.get_untracked().get(&id).cloned() {
            self.active_session_id.set(Some(id));
            self.messages.set(msgs);
            self.busy.set(false);
            return;
        }

        // Set active session immediately so the sidebar highlights correctly,
        // then load full messages from disk asynchronously.
        self.active_session_id.set(Some(id.clone()));
        self.messages.set(vec![]);
        self.busy.set(false);

        let chat = *self;
        let target_id = id.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let result = crate::tauri_bridge::invoke::<PersistedConversation>(
                "load_conversation",
                &serde_json::json!({ "id": target_id }),
            ).await;

            if let Ok(conv) = result {
                // Only apply if the user hasn't switched away since we started loading
                if chat.active_session_id.get_untracked().as_deref() == Some(target_id.as_str()) {
                    chat.sessions.update(|s| { s.insert(target_id.clone(), conv.messages.clone()); });
                    chat.messages.set(conv.messages);
                }
            }
        });
    }

    /// Delete all conversations from memory and disk, then reset to a fresh session.
    pub fn clear_all(&self) {
        self.history.set(vec![]);
        self.sessions.set(HashMap::new());
        self.messages.set(vec![]);
        self.ai_meta.set(vec![]);
        self.active_session_id.set(None);
        self.busy.set(false);
        self.streaming_content.set(String::new());
        self.bg_buffers.update_value(|b| b.clear());
        wasm_bindgen_futures::spawn_local(async move {
            let _ = crate::tauri_bridge::invoke_unit("clear_all_conversations", &serde_json::json!({})).await;
        });
    }

    /// Save the active conversation, create a fresh one and make it active.
    pub fn start_new(&self) {
        self.save_current();
        self.ai_meta.set(vec![]);
        let new_id = uuid::Uuid::new_v4().to_string();
        self.history.update(|h| {
            h.push(ChatSessionSummary { id: new_id.clone(), title: "New Conversation".into() });
        });
        self.active_session_id.set(Some(new_id));
        self.messages.set(vec![]);
        self.busy.set(false);
    }
}
