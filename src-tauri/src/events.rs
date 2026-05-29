//! Formal event payload structs.
//!
//! Replaces ad-hoc `serde_json::json!({...})` payloads with typed structs so
//! tauri-specta can export TypeScript types for them. The wire format
//! (camelCase JSON over the existing `feral://...` event names) is preserved
//! so the legacy Leptos frontend keeps working unchanged.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TokenEvent {
    pub session_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct StreamDoneEvent {
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct StreamErrorEvent {
    pub session_id: String,
    pub error: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub repo_id: String,
    pub filename: String,
    pub progress: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCompleteEvent {
    pub repo_id: String,
    pub filename: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DownloadErrorEvent {
    pub repo_id: String,
    pub filename: String,
    pub error: String,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ModelLoadProgressEvent {
    pub percentage: f64,
    pub status_text: String,
}
