//! Conversation persistence (save/load/list/delete).

use crate::*;

#[tauri::command]
#[specta::specta]
pub(crate) fn save_conversation(
    id: String,
    title: String,
    messages: Vec<conversations::PersistedMessage>,
    agent_id: Option<String>,
) -> Result<(), String> {
    conversations::save(&id, &title, &messages, agent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn load_conversations() -> Result<Vec<conversations::ConversationSummary>, String> {
    conversations::load_all().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn load_conversation(id: String) -> Result<conversations::Conversation, String> {
    conversations::load(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn rename_conversation(id: String, title: String) -> Result<(), String> {
    conversations::rename(&id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_conversation(id: String) -> Result<(), String> {
    conversations::delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn clear_all_conversations() -> Result<(), String> {
    conversations::clear_all().map_err(|e| e.to_string())
}
