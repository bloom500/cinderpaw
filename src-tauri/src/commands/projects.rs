//! Project (conversation grouping) persistence.

use crate::*;

#[tauri::command]
#[specta::specta]
pub(crate) fn load_projects() -> Result<Vec<projects::ProjectSummary>, String> {
    projects::load_all().map_err(|e| e.to_string())
}

/// `instructions` and `files` are optional so a caller that only renames or
/// moves chats (every caller before spec 9) cannot wipe them: left out, the
/// stored ones are kept.
#[tauri::command]
#[specta::specta]
pub(crate) fn save_project(
    id: String,
    name: String,
    conversation_ids: Vec<String>,
    instructions: Option<String>,
    files: Option<Vec<projects::ProjectFile>>,
) -> Result<(), String> {
    let stored = if instructions.is_none() || files.is_none() {
        projects::find(&id).map_err(|e| e.to_string())?
    } else {
        None
    };
    let instructions = instructions
        .or_else(|| stored.as_ref().map(|p| p.instructions.clone()))
        .unwrap_or_default();
    let files = files
        .or_else(|| stored.map(|p| p.files))
        .unwrap_or_default();
    projects::save(&projects::ProjectSummary { id, name, conversation_ids, instructions, files })
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_project(id: String) -> Result<(), String> {
    projects::delete(&id).map_err(|e| e.to_string())
}

/// Copy a file into the project's folder; the caller adds it to the list.
#[tauri::command]
#[specta::specta]
pub(crate) fn project_add_file(project_id: String, src_path: String) -> Result<projects::ProjectFile, String> {
    projects::add_file(&project_id, std::path::Path::new(&src_path)).map_err(|e| e.to_string())
}

/// Delete one copied file; the caller drops it from the list.
#[tauri::command]
#[specta::specta]
pub(crate) fn project_remove_file(project_id: String, name: String) -> Result<(), String> {
    projects::remove_file(&project_id, &name).map_err(|e| e.to_string())
}
