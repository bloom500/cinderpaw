//! The Google Docs button. See `crate::google` for the flow.

#[tauri::command]
#[specta::specta]
pub(crate) async fn google_status() -> bool {
    crate::google::is_connected()
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn google_connect(app: tauri::AppHandle) -> Result<(), String> {
    crate::google::connect(app).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn google_disconnect() -> Result<(), String> {
    crate::google::disconnect()
}

/// `data` is base64 when `encoding` is "base64", plain text otherwise.
#[tauri::command]
#[specta::specta]
pub(crate) async fn google_upload(
    name: String,
    mime: String,
    data: String,
    encoding: Option<String>,
    convert: bool,
) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = if encoding.as_deref() == Some("base64") {
        base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?
    } else {
        data.into_bytes()
    };
    crate::google::upload(&name, &mime, bytes, convert).await
}
