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

use std::sync::atomic::{AtomicU64, Ordering};
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
///
/// `-latest` rather than the `-preview-12-2025` snapshot, changed while chasing
/// a call that dies seconds in with "the audio content type is not supported".
/// A pinned preview id is a snapshot the vendor can change or retire under you,
/// which fits a call that worked one day and not the next; `-latest` at least
/// fails the same way for everyone. Both are live-capable on this key —
/// `probe_what_the_live_api_accepts` lists them and both accept the full setup.
///
/// This is a suspect being eliminated, not a diagnosis. If the call still dies,
/// the model id was innocent.
const DEFAULT_MODEL: &str = "gemini-2.5-flash-native-audio-latest";

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
    let cfg = live::SessionConfig {
        api_key,
        model: model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        system_instruction: Some(live::system_instruction(&brief)),
        tools: bridge::declarations(),
        resume: None,
    };
    let handle = live::connect(clone_cfg(&cfg)).await.map_err(|e| e.to_string())?;

    // Replacing a live slot ends the previous call: dropping its sender closes
    // that socket. Leaving both open would put two models on one microphone.
    let previous = state.live_call.lock().replace(handle.commands.clone());
    drop(previous);

    tokio::spawn(supervise(app, session_id, cfg, handle));
    Ok(())
}

/// `SessionConfig` is not `Clone` — it holds the key — so the one place that
/// needs a second copy says so out loud rather than deriving Clone and making
/// key duplication invisible everywhere else.
fn clone_cfg(cfg: &live::SessionConfig) -> live::SessionConfig {
    live::SessionConfig {
        api_key: cfg.api_key.clone(),
        model: cfg.model.clone(),
        system_instruction: cfg.system_instruction.clone(),
        tools: cfg.tools.clone(),
        resume: cfg.resume.clone(),
    }
}

/// Keep the call alive across the server's own session limit.
///
/// Measured: a call opened at 13:38 was closed at 13:50 by the server, which
/// said in as many words that the duration limit was reached and that the
/// conversation could be resumed with a handle. Nothing we send makes one
/// session last longer — the fix is to open the next one already knowing what
/// was said, which is what the handle is for.
///
/// The webview is never told. It holds no socket: the microphone calls
/// `send_live_audio`, which reads whatever sender is in the slot, so swapping
/// the slot swaps the call underneath a page that has no idea. From the user's
/// side the conversation simply does not end.
///
/// Only a close that HAS a handle is retried, and only a few times. A refused
/// key, a depleted quota or a model that does not exist all close the socket
/// too, and reconnecting into those is a loop that spends money on the same
/// error — those arrive without a handle and end the call as before.
async fn supervise(
    app: AppHandle,
    session_id: String,
    cfg: live::SessionConfig,
    first: live::LiveHandle,
) {
    const MAX_RESUMES: u32 = 8;
    let mut handle = first;
    let mut resumes = 0u32;

    loop {
        let ended = pump(app.clone(), session_id.clone(), handle.commands.clone(), handle.events).await;
        let Some(token) = ended else { return };
        if resumes >= MAX_RESUMES {
            tracing::warn!("live: {MAX_RESUMES} resumptions reached, letting the call end");
            emit_status(&app, &session_id, CoreEvent::Closed {
                reason: "session ended".into(),
                resume: None,
            });
            return;
        }
        resumes += 1;
        tracing::info!("live: resuming session ({resumes}/{MAX_RESUMES})");

        let mut next_cfg = clone_cfg(&cfg);
        next_cfg.resume = Some(token);
        match live::connect(next_cfg).await {
            Ok(next) => {
                // The slot is what the microphone writes into. Swapping it here
                // is the whole trick — the old sender drops, its socket closes,
                // and the next frame of audio goes to the new one.
                let state = app.state::<AppState>();
                let previous = state.live_call.lock().replace(next.commands.clone());
                drop(previous);
                handle = next;
            }
            Err(e) => {
                tracing::warn!(error = %e, "live: resume failed");
                emit_status(&app, &session_id, CoreEvent::Closed {
                    reason: e.to_string(),
                    resume: None,
                });
                return;
            }
        }
    }
}

/// Forward everything the model says to the webview, and answer its tool calls
/// here rather than there.
/// Returns the resumption handle when the socket ended in a way that can be
/// continued, and `None` when the call is genuinely over. The caller decides
/// what to do with that — pump itself never reconnects, so the decision lives
/// in one place instead of being tangled with the event loop.
async fn pump(
    app: AppHandle,
    session_id: String,
    commands: mpsc::Sender<LiveCommand>,
    mut events_rx: mpsc::Receiver<CoreEvent>,
) -> Option<String> {
    // The turn being spoken, from both sides, until the model says it is done.
    let mut heard = String::new();
    let mut said = String::new();
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
                        // Tell the screen too, not only the terminal.
                        //
                        // This call is resolved entirely in Rust and used to
                        // leave no trace upstream at all — so a turn where the
                        // agent answered from what it already knew, calling no
                        // tool of its own, showed the user a blank panel for the
                        // whole wait. That is the COMMON case, and it was the one
                        // with no feedback: the widgets only ever saw the
                        // sidecar's own tools.
                        let _ = app.emit(
                            "feral://live-status",
                            events::LiveStatusEvent {
                                session_id: session_id.clone(),
                                kind: "toolCall".to_string(),
                                text: call
                                    .args
                                    .get("request")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&call.name)
                                    .to_string(),
                            },
                        );
                        // The runtime is what makes `ask_feral` answerable: it
                        // holds the sidecar's stdin and the event bus its reply
                        // comes back on. Fetched per call rather than captured,
                        // because the sidecar can restart mid-conversation and a
                        // captured sender would then be pointing at a dead pipe.
                        let state = app.state::<AppState>();
                        let mic_before = MIC_FRAMES.load(Ordering::Relaxed);
                        let blocked_before = MIC_BLOCKED_MS.load(Ordering::Relaxed);
                        let started = std::time::Instant::now();
                        let answer = bridge::answer(call, Some(&state.runtime), &session_id).await;
                        // The measurement this exists for. ~8 frames a second is
                        // a microphone that never stopped; near zero means the
                        // audio never reached us and the stall is on our side of
                        // the wire.
                        let secs = started.elapsed().as_secs_f32().max(0.001);
                        let frames = MIC_FRAMES.load(Ordering::Relaxed) - mic_before;
                        tracing::info!(
                            "live: tool ran {:.1}s — {} mic frames in ({:.1}/s), {} ms blocked on a full channel",
                            secs,
                            frames,
                            frames as f32 / secs,
                            MIC_BLOCKED_MS.load(Ordering::Relaxed) - blocked_before,
                        );
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
                        let ok = answer
                            .response
                            .get("ok")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let _ = app.emit(
                            "feral://live-status",
                            events::LiveStatusEvent {
                                session_id: session_id.clone(),
                                kind: "toolResult".to_string(),
                                // The verdict, and the reason when there is one.
                                // An empty string here means success, which the
                                // panel reads as "no error to show".
                                text: if ok { String::new() } else { preview.chars().take(160).collect() },
                            },
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
            // Both transcripts accumulate until the model finishes, then the
            // pair is filed as one turn.
            //
            // This is the whole of a Live call's memory. Gemini conducts the
            // conversation, so nothing here ever passes through the agent loop —
            // and without this the call left no trace at all: ten minutes of
            // talk, hung up, and the session had never heard of it. The next
            // call opened blind and `recall` could not find a word of it.
            //
            // Filed per TURN rather than at hang-up, because a call that crashes
            // or drops has still happened, and a record written only at the end
            // is the one that is never written.
            CoreEvent::InputTranscript(ref t) => {
                heard.push_str(t);
                emit_status(&app, &session_id, event);
            }
            CoreEvent::OutputTranscript(ref t) => {
                said.push_str(t);
                emit_status(&app, &session_id, event);
            }
            CoreEvent::TurnComplete => {
                let turn = (std::mem::take(&mut heard), std::mem::take(&mut said));
                if !turn.0.trim().is_empty() || !turn.1.trim().is_empty() {
                    let state = app.state::<AppState>();
                    record_turn(&state.runtime, &session_id, &turn.0, &turn.1);
                }
                emit_status(&app, &session_id, CoreEvent::TurnComplete);
            }
            // A close that carries a handle is NOT reported to the webview: the
            // conversation is about to continue on a new socket, and telling the
            // screen the call ended would put the pre-call panel up for a second
            // in the middle of a sentence.
            CoreEvent::Closed { reason, resume: Some(token) } => {
                tracing::info!(reason = %reason, "live: socket ended, resuming");
                return Some(token);
            }
            other => emit_status(&app, &session_id, other),
        }
    }
    None
}

/// Hand one spoken exchange to the agent's memory, without asking for a reply.
///
/// Fire and forget: the sidecar either takes it or it does not, and a memory
/// write must never be able to interrupt a call in progress. A failure here
/// costs the record of one turn; blocking the pump on it would cost the audio.
fn record_turn(
    runtime: &std::sync::Arc<feral_core::runtime::RuntimeState>,
    session_id: &str,
    user: &str,
    assistant: &str,
) {
    let Some(tx) = runtime.feral_agent_tx.lock().as_ref().cloned() else { return };
    let line = serde_json::json!({
        "type": "record_turn",
        "sessionId": session_id,
        "content": user,
        "assistantContent": assistant,
    })
    .to_string();
    tokio::spawn(async move {
        if tx.send(line).await.is_err() {
            tracing::warn!("live: could not file the turn — the sidecar stopped listening");
        }
    });
}

fn emit_status(app: &AppHandle, session_id: &str, event: CoreEvent) {
    // The one status worth a line in the terminal. A call that dies mid-session
    // reports its reason to the webview and nowhere else, so the only record of
    // WHY was whatever the user managed to copy off the screen.
    if let CoreEvent::Closed { reason, .. } = &event {
        tracing::warn!(reason = %reason, "live: session closed");
    }
    // The CADENCE of the input transcript, which is the only way to tell a
    // server that sends rare fat chunks from a UI that drops thin ones. The
    // screen shows the same words either way; the timestamps do not.
    // Answered, and so demoted: measured 13 Aug, the server sends 1–6 characters
    // every 130–200 ms, which is exactly the cadence live typing needs. Whatever
    // makes it look choppy is downstream of here, so this is `debug` — at `info`
    // it is one line per two characters for the whole call.
    if let CoreEvent::InputTranscript(t) = &event {
        tracing::debug!(chars = t.len(), text = %t, "live: input transcript piece");
    }
    let (kind, text) = match event {
        CoreEvent::Interrupted => ("interrupted", String::new()),
        CoreEvent::TurnComplete => ("turnComplete", String::new()),
        CoreEvent::InputTranscript(t) => ("inputTranscript", t),
        CoreEvent::OutputTranscript(t) => ("outputTranscript", t),
        CoreEvent::Closed { reason, .. } => ("closed", reason),
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
    MIC_FRAMES.fetch_add(1, Ordering::Relaxed);
    // Timed, because "my voice waits in a queue while a tool runs" has two
    // opposite causes and they look identical from the outside: either the
    // frames stop reaching us (the webview or the bridge is stalled), or they
    // arrive fine and the SERVER is holding the conversation while it waits for
    // the tool answer. One is ours to fix and the other is not, and guessing
    // wrong costs an afternoon — this counts frames and how long the handoff
    // took, so the tool-call log line below can report both.
    let at = std::time::Instant::now();
    let r = sender.send(LiveCommand::Audio(bytes)).await.map_err(|_| "live-closed".to_string());
    let waited = at.elapsed().as_millis() as u64;
    if waited > 50 {
        MIC_BLOCKED_MS.fetch_add(waited, Ordering::Relaxed);
    }
    r
}

/// Microphone frames handed to the session since the process started, and how
/// long `send` spent blocked on a full channel. Both are read as deltas around
/// a tool call; absolute values mean nothing.
static MIC_FRAMES: AtomicU64 = AtomicU64::new(0);
static MIC_BLOCKED_MS: AtomicU64 = AtomicU64::new(0);

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
