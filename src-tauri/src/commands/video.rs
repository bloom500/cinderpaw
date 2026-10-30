//! Video links in the composer and the chat (cinderpaw_core::video does the work).
//! Clips and whole videos land in ~/.cinderpaw/cache/videos, which the asset
//! scope in tauri.conf.json already lets the page play.

use cinderpaw_core::video;

/// Are yt-dlp and ffmpeg here? The card offers the download when they are not.
#[tauri::command]
#[specta::specta]
pub(crate) async fn video_tools_ready() -> bool {
    video::find().is_some()
}

/// Download them. Only ever called from a button the person pressed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn install_video_tools() -> Result<(), String> {
    video::fetch().await.map(|_| ())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn video_link_info(url: String) -> Result<video::VideoInfo, String> {
    video::info(&url).await
}

/// The first seconds, small, for hover. Returns a path the page can play.
#[tauri::command]
#[specta::specta]
pub(crate) async fn video_link_preview(url: String) -> Result<String, String> {
    video::preview(&url).await.map(|p| p.to_string_lossy().into_owned())
}

/// The whole video, at most 720p, to watch in the app.
#[tauri::command]
#[specta::specta]
pub(crate) async fn video_link_full(url: String) -> Result<String, String> {
    video::full(&url).await.map(|p| p.to_string_lossy().into_owned())
}
