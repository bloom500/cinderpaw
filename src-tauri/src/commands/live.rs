//! The Gemini Live call engine, from the webview's side.
//!
//! Picking this engine replaces the whole `STT → LLM → TTS` chain with one
//! session, so the webview's job shrinks to two things: push microphone bytes
//! in, play what comes back. Turn detection, interruption and synthesis all
//! happen on the far end.
//!
//! Tool calls never reach the webview. The model asks, Rust runs the tool and
//! answers, and the only trace upstream is that the reply mentions what it
//! found — which is the point: a round trip through the UI would add latency to
//! the one path that is supposed to be fast.

use std::sync::Arc;

use base64::Engine as _;
use feral_core::live::{self, bridge, LiveCommand, LiveEvent as CoreEvent};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::{events, AppState};

/// The provider id whose key this engine borrows.
///
/// The same AI Studio key already powers the OpenAI-compatible chat surface, so
/// there is no second key to enter, no second place to store one, and no way for
/// the two to disagree about which key is current.
const KEY_PROVIDER: &str = "google";

/// Function calling is **sequential only** on the 3.x live models; asynchronous
/// `NON_BLOCKING` calls are a 2.5-native-audio feature. For a call that runs
/// tools the newer model is the weaker one, so this is the default until
/// measured otherwise.
///
/// **Copy this string, never compose it.** The first version here was
/// `gemini-2.5-flash-live-preview`, assembled from the way the 3.x id is spelled,
/// and no such model exists. A live setup naming an unknown model is not
/// answered with an error — the server drops the socket, which surfaces as
/// rustls reporting a TLS stream that ended without `close_notify`. So the whole
/// failure reads as a network fault and points nowhere near the typo. The two
/// real ids are `gemini-3.1-flash-live-preview` and this one.
const DEFAULT_MODEL: &str = "gemini-2.5-flash-native-audio-preview-12-2025";

/// One call at a time — you cannot be in two conversations at once, and a map
/// keyed by session would imply otherwise.
pub type LiveCallSlot = Arc<Mutex<Option<mpsc::Sender<LiveCommand>>>>;

/// Start a call. Returns once the model has accepted the session, so a caller
/// that gets `Ok` can open the microphone immediately.
///
/// Errors: "live-no-key" | anything else is a message worth showing.
#[tauri::command]
#[specta::specta]
pub(crate) async fn start_live_call(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    model: Option<String>,
    current_task: Option<String>,
    workspace: Option<String>,
    context: Option<String>,
) -> Result<(), String> {
    let Some(api_key) = feral_core::byok::byok_get(KEY_PROVIDER) else {
        return Err("live-no-key".into());
    };

    // Everything the model gets to know, said once. The session is stateful, so
    // it is not re-sent per turn.
    let brief = live::Briefing { current_task, workspace, context };
    let handle = live::connect(live::SessionConfig {
        api_key,
        model: model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        system_instruction: Some(live::system_instruction(&brief)),
        tools: bridge::declarations(),
    })
    .await
    .map_err(|e| e.to_string())?;

    // Replacing a live slot ends the previous call: dropping its sender closes
    // that socket. Leaving both open would put two models on one microphone.
    let previous = state.live_call.lock().replace(handle.commands.clone());
    drop(previous);

    tokio::spawn(pump(app, session_id, handle.commands, handle.events));
    Ok(())
}

/// Forward everything the model says to the webview, and answer its tool calls
/// here rather than there.
async fn pump(
    app: AppHandle,
    session_id: String,
    commands: mpsc::Sender<LiveCommand>,
    mut events_rx: mpsc::Receiver<CoreEvent>,
) {
    while let Some(event) = events_rx.recv().await {
        match event {
            CoreEvent::Audio(pcm) => {
                // Rides the same event as every other engine's audio, at the
                // rate that travels with it — so the existing player needs to
                // know nothing about this one.
                let _ = app.emit(
                    "feral://tts-chunk",
                    events::TtsChunkEvent {
                        session_id: session_id.clone(),
                        pcm: base64::engine::general_purpose::STANDARD.encode(&pcm),
                        sample_rate: live::AUDIO_OUT_HZ,
                    },
                );
            }
            CoreEvent::ToolCall(calls) => {
                // Answered off the event loop: a slow tool must not stall the
                // audio still arriving behind it.
                let commands = commands.clone();
                let app = app.clone();
                let session_id = session_id.clone();
                tokio::spawn(async move {
                    let mut answers = Vec::with_capacity(calls.len());
                    for call in &calls {
                        // Logged on both sides of the await, and that is not
                        // noise. Nothing on this path said anything, so a call
                        // where the model asked for a tool and got a failure was
                        // indistinguishable from one where it never asked — the
                        // user reports "it could not search" and there is no way
                        // to tell which half is broken. These two lines answer it.
                        tracing::info!(tool = %call.name, args = %call.args, "live: tool call");
                        // The runtime is what makes `ask_feral` answerable: it
                        // holds the sidecar's stdin and the event bus its reply
                        // comes back on. Fetched per call rather than captured,
                        // because the sidecar can restart mid-conversation and a
                        // captured sender would then be pointing at a dead pipe.
                        let state = app.state::<AppState>();
                        let answer = bridge::answer(call, Some(&state.runtime), &session_id).await;
                        // The ANSWER, not just its verdict. `ok=true` says the
                        // round trip completed; it does not say whether the agent
                        // found anything, and those need opposite fixes — one is
                        // a retrieval problem, the other is the model summarising
                        // a good answer badly. Truncated, because a tool result
                        // can be a whole web page and the terminal is for
                        // deciding which of the two this is.
                        let preview = answer
                            .response
                            .get("output")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        tracing::info!(
                            tool = %call.name,
                            ok = %answer.response.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                            chars = preview.len(),
                            answer = %preview.chars().take(400).collect::<String>(),
                            "live: tool answered",
                        );
                        answers.push(answer);
                    }
                    let _ = commands.send(LiveCommand::ToolResponse(answers)).await;
                });
            }
            CoreEvent::ToolCallCancelled(_) => {
                // Nothing to undo yet: the tools Rust runs here are reads and
                // fetches. This arm exists so a tool with side effects cannot be
                // added later without someone reading this comment.
            }
            other => emit_status(&app, &session_id, other),
        }
    }
}

fn emit_status(app: &AppHandle, session_id: &str, event: CoreEvent) {
    // The one status worth a line in the terminal. A call that dies mid-session
    // reports its reason to the webview and nowhere else, so the only record of
    // WHY was whatever the user managed to copy off the screen.
    if let CoreEvent::Closed(reason) = &event {
        tracing::warn!(reason = %reason, "live: session closed");
    }
    // The CADENCE of the input transcript, which is the only way to tell a
    // server that sends rare fat chunks from a UI that drops thin ones. The
    // screen shows the same words either way; the timestamps do not.
    // `info` rather than `debug` because the default filter is `info` and a
    // diagnostic nobody can see without restarting the app with an env var is a
    // diagnostic that does not exist. A handful of lines per utterance, only
    // while a call is open. Drop it to `debug` once the cadence question is
    // settled.
    if let CoreEvent::InputTranscript(t) = &event {
        tracing::info!(chars = t.len(), text = %t, "live: input transcript piece");
    }
    let (kind, text) = match event {
        CoreEvent::Interrupted => ("interrupted", String::new()),
        CoreEvent::TurnComplete => ("turnComplete", String::new()),
        CoreEvent::InputTranscript(t) => ("inputTranscript", t),
        CoreEvent::OutputTranscript(t) => ("outputTranscript", t),
        CoreEvent::Closed(reason) => ("closed", reason),
        // Audio and tool calls are handled before this is reached.
        CoreEvent::Audio(_) | CoreEvent::ToolCall(_) | CoreEvent::ToolCallCancelled(_) => return,
    };
    let _ = app.emit(
        "feral://live-status",
        events::LiveStatusEvent {
            session_id: session_id.to_string(),
            kind: kind.to_string(),
            text,
        },
    );
}

/// Push microphone audio: base64 of 16 kHz mono 16-bit LE PCM.
///
/// Base64 for the same reason the audio coming back uses it — a `Vec<u8>` over
/// Tauri's IPC is serialised as a JSON array of numbers, several times the size.
#[tauri::command]
#[specta::specta]
pub(crate) async fn send_live_audio(state: State<'_, AppState>, pcm: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pcm.as_bytes())
        .map_err(|_| "live-bad-audio".to_string())?;
    let sender = state.live_call.lock().clone();
    let Some(sender) = sender else { return Err("live-not-started".into()) };
    sender.send(LiveCommand::Audio(bytes)).await.map_err(|_| "live-closed".to_string())
}

/// Hang up. Idempotent — hanging up twice is not an error, and a UI that has to
/// track whether it already did would get it wrong on the path that matters
/// (an error mid-call, where both the error handler and the user press stop).
#[tauri::command]
#[specta::specta]
pub(crate) async fn end_live_call(state: State<'_, AppState>) -> Result<(), String> {
    // Dropping the sender closes the socket, which ends both pump tasks.
    let sender = state.live_call.lock().take();
    drop(sender);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_model_is_the_one_that_can_run_tools_asynchronously() {
        // Guards a plausible "upgrade" to a newer live model, which would
        // silently downgrade function calling to sequential-only.
        assert!(DEFAULT_MODEL.contains("2.5"), "see the comment above DEFAULT_MODEL");
        // `native-audio`, not `live`. The earlier version of this assertion
        // demanded the substring "live" — which the real 2.5 id does not carry —
        // and so it PASSED for an id that does not exist while it would have
        // failed for the correct one. A guard that only accepts a typo is worse
        // than no guard.
        assert!(DEFAULT_MODEL.contains("native-audio"), "see the comment above DEFAULT_MODEL");
    }

    #[test]
    fn the_engine_borrows_the_existing_google_key() {
        // If this ever changes, the settings UI has to grow a second key field
        // and the two can then disagree. It is deliberately the same slot.
        assert_eq!(KEY_PROVIDER, "google");
    }
}
