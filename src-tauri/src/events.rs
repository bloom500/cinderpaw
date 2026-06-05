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

/// Emitted by `chat_cloud_stream` when the OpenAI-compatible provider reports
/// `finish_reason: "length"` — the model hit its server-side token cap before
/// producing a natural stop. The frontend keeps the partial response visible
/// but marks the message as truncated so the user can see *why* it cut off.
///
/// For the local llama.cpp backend we still emit `stream-done` and
/// `finish_reason` is unknown to the frontend; the truncation only applies
/// to the cloud streaming path.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct StreamTruncatedEvent {
    pub session_id: String,
    /// The raw `finish_reason` from the provider, typically "length".
    pub reason: String,
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

/// One raw JSON line emitted by the feral-agent sidecar on stdout.
/// The React frontend parses `data` to get the typed event
/// (`chunk`, `done`, `tool_start`, `tool_done`, `proactive`, `pong`, `error`).
/// Using a single opaque event keeps the Rust side thin and forward-compatible.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct FeralAgentOutputEvent {
    pub data: String,
}

/// One streamed agent event. `data` is a serialized `AgentEvent`
/// (token / tool_call / tool_result / final / error). Delivered over the
/// `feral://` event bus rather than a Tauri `Channel`: channel callback ids
/// are torn down by Vite HMR mid-run ("Couldn't find callback id"), whereas
/// named events re-bind cleanly on reload. `session_id` lets multiple agent
/// run panels share the one event name without crosstalk.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub session_id: String,
    pub data: String,
}
