//! Formal event payload structs.
//!
//! Replaces ad-hoc `serde_json::json!({...})` payloads with typed structs so
//! tauri-specta can export TypeScript types for them. The wire format
//! (camelCase JSON over the existing `cinderpaw://...` event names) is preserved
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

/// Emitted right after the prompt is tokenized, before any new tokens are generated.
/// Carries the exact prompt token count so the frontend can show real usage immediately.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct StreamStartEvent {
    pub session_id: String,
    /// Real token count of the full prompt (all history + system prompt), from llama.cpp.
    pub prompt_tokens: u32,
}

/// Emitted at the end of a cloud (OpenAI-compatible) stream when the provider
/// returns usage stats in the final SSE chunk. Carries the real prompt and
/// completion token counts so the frontend can show accurate usage.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct StreamUsageEvent {
    pub session_id: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

/// One chunk of synthesised speech, base64-encoded raw PCM.
///
/// Base64 rather than `Vec<u8>` because a byte vector crosses the Tauri IPC as
/// a JSON array of decimal numbers — roughly 4 bytes of wire per byte of audio.
/// Base64 costs 1.33x, and the webview decodes it with `atob` for free.
///
/// `sample_rate` travels with every chunk instead of being a constant the
/// TypeScript re-declares: the frontend has to build an `AudioBuffer` at the
/// right rate, and a provider that streams something other than
/// `cinderpaw_core::tts::SAMPLE_RATE` must not be able to desync playback silently.
///
/// Chunks carry no sequence number. Emission is a single sequential loop over
/// one IPC channel, so order is preserved by the transport; a `seq` field with
/// no reorder buffer behind it would only look like a guarantee.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TtsChunkEvent {
    pub session_id: String,
    /// Base64 of signed 16-bit little-endian mono PCM.
    pub pcm: String,
    pub sample_rate: u32,
}

/// Everything a live (speech-to-speech) call reports that is not audio.
///
/// One event with a `kind` rather than five typed ones, matching how the sidecar
/// bridge already does it: the set grows with a Preview API, and each new member
/// would otherwise be a new event, a new listener and a new registration before
/// the UI could even ignore it.
///
/// `kind` is one of `interrupted`, `turnComplete`, `inputTranscript`,
/// `outputTranscript`, `closed`. `text` carries the transcript or the reason for
/// closing, and is empty for the rest.
///
/// `interrupted` is the one the player must act on: the user spoke over the
/// answer, and whatever is queued should be dropped rather than played out.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatusEvent {
    pub session_id: String,
    pub kind: String,
    pub text: String,
}

/// One raw JSON line emitted by the feral-agent sidecar on stdout.
/// The React frontend parses `data` to get the typed event
/// (`chunk`, `done`, `tool_start`, `tool_done`, `proactive`, `pong`, `error`).
/// Using a single opaque event keeps the Rust side thin and forward-compatible.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CinderpawAgentOutputEvent {
    pub data: String,
}

/// One streamed agent event. `data` is a serialized `AgentEvent`
/// (token / tool_call / tool_result / final / error). Delivered over the
/// `cinderpaw://` event bus rather than a Tauri `Channel`: channel callback ids
/// are torn down by Vite HMR mid-run ("Couldn't find callback id"), whereas
/// named events re-bind cleanly on reload. `session_id` lets multiple agent
/// run panels share the one event name without crosstalk.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub session_id: String,
    pub data: String,
}

/// Heartbeat for in-flight inference — emitted on a ~750 ms cadence so the
/// UI can show live progress ("prefill", then "generating • 12.3 tok/s")
/// instead of a static "Thinking…" black box. The watchdog in `chat_stream`
/// emits this; the sidecar's `stream_progress` OutboundEvent is the
/// equivalent for the agent path and is forwarded through the existing
/// `cinderpaw://agent-output` channel (not a separate channel — the sidecar
/// emits structured JSON lines and React filters by `type`).
///
/// All timing fields are milliseconds since the inference call's start.
/// `prompt_tokens` is set once `on_start` fires; `tokens_generated` and
/// `tokens_per_sec` populate only after the first sampled token.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct StreamProgressEvent {
    pub session_id: String,
    pub phase: String, // "prefill" | "generating"
    pub elapsed_ms: u32,
    pub prompt_tokens: u32,
    pub tokens_generated: u32,
    /// Rolling tok/s, updated on each heartbeat after the first token.
    /// Zero during prefill and before the first token lands.
    pub tokens_per_sec: f32,
}
