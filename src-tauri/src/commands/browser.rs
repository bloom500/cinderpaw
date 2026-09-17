//! The browser panel's door to the built-in browser. The agent reaches the same
//! code through `browser.<action>` on the desktop-control channel; both go
//! through `crate::browser::handle` so they cannot drift.

#[tauri::command]
#[specta::specta]
pub(crate) async fn browser_ui(
    app: tauri::AppHandle,
    op: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::browser::handle(app, &op, &params).await
}
