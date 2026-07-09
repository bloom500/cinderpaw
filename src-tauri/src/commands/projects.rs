//! Project (conversation grouping) persistence.

use crate::*;

#[tauri::command]
#[specta::specta]
pub(crate) fn load_projects() -> Result<Vec<projects::ProjectSummary>, String> {
    projects::load_all().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn save_project(id: String, name: String, conversation_ids: Vec<String>) -> Result<(), String> {
    projects::save(&projects::ProjectSummary { id, name, conversation_ids })
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_project(id: String) -> Result<(), String> {
    projects::delete(&id).map_err(|e| e.to_string())
}
