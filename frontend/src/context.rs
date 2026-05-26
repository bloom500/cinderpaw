use leptos::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::pages::types::Message;

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

// ── Chat Context ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSessionSummary {
    pub id: String,
    pub title: String,
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
        }
    }
}