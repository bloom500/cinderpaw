//! The LiveKit call, from the webview's side.
//!
//! Two commands, because a self-hosted call has exactly two states worth
//! naming: running, and not. Everything that makes it run — resolving a server
//! binary, booting it on loopback, minting credentials, starting the far end —
//! is `cinderpaw_core::livekit`'s problem, and none of it is the webview's
//! business beyond the URL and token it needs to join.
//!
//! Note what does NOT cross this boundary: audio. Unlike the Gemini Live engine
//! next door, where every microphone frame is base64'd through Tauri's IPC, here
//! the webview speaks WebRTC directly to a server on 127.0.0.1. That is the
//! whole reason for choosing a real media stack — the audio path stops being
//! ours to carry, and stops being ours to get wrong.
//!
//! What DOES cross it: what was said, and what went wrong. Both arrive as
//! `cinderpaw://livekit-event`.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

/// How long a finished call's machinery is kept alive before it is taken down.
///
/// The chain costs about fourteen seconds to start — server boot, Node, the
/// Agents SDK, a local end-of-turn model. Paying that on every call is what
/// turns a feature into one people avoid, and a conversation that drops and has
/// to be restarted is exactly when the wait hurts most. Keeping it warm for a
/// few minutes makes the second call instant; taking it down afterwards means a
/// person who tried voice once is not left with a voice server and a Node
/// process running for the rest of the session.
const IDLE_SHUTDOWN: std::time::Duration = std::time::Duration::from_secs(180);

/// Bumped every time a call starts or ends. The idle timer captures the value
/// it was armed at and does nothing if it changed — which is the whole
/// cancellation mechanism, and it is a number rather than a task handle because
/// the thing being cancelled is "the intent to shut down", not a task.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// One row in the voice-provider picker.
#[derive(serde::Serialize, specta::Type)]
pub struct S2sProviderInfo {
    pub id: String,
    pub label: String,
    /// Every voice this vendor offers. The picker lists these and nothing else
    /// — a voice id belongs to the vendor that issued it.
    pub voices: Vec<String>,
    /// The one used when the user has not picked.
    pub default_voice: String,
    /// Whether a key for it is actually stored. The picker needs this to show
    /// what a choice will DO — an option that silently produces an echo because
    /// its key was never pasted is the shape of bug this whole change is about.
    pub connected: bool,
}

/// The speech-to-speech vendors this build can run a call on.
///
/// Served from Rust rather than listed in the frontend because the same table
/// decides which npm plugin gets installed. A second list in TypeScript would
/// be free to offer a vendor the agent cannot load.
#[tauri::command]
#[specta::specta]
pub(crate) fn list_s2s_providers() -> Vec<S2sProviderInfo> {
    cinderpaw_core::livekit::S2S_PROVIDERS
        .iter()
        .map(|p| S2sProviderInfo {
            id: p.id.to_string(),
            label: p.label.to_string(),
            voices: p.voices.iter().map(|v| v.to_string()).collect(),
            default_voice: p.voice.to_string(),
            connected: cinderpaw_core::byok::byok_get(p.id).is_some(),
        })
        .collect()
}

/// What the webview needs to join the room, and nothing else.
#[derive(serde::Serialize, specta::Type)]
pub struct LiveKitCall {
    /// Always loopback. Named rather than assumed, so the day it stops being
    /// loopback the webview is not the last to find out.
    pub url: String,
    pub token: String,
    pub room: String,
    /// "assistant" when a key is stored for some speech-to-speech provider,
    /// "echo" when none is. The UI must say which: a diagnostic that presents
    /// itself as an assistant is worse than no assistant.
    pub mode: String,
    /// True when this call reused machinery that was already running. Reported
    /// so the difference between a fourteen-second start and an instant one is
    /// visible to whoever is wondering why it varies.
    pub warm: bool,
}

/// Start the local call, or join the one whose machinery is already up.
///
/// Errors are messages meant for a person, with one exception worth knowing:
/// `livekit-no-node` is a code, because "install Node" needs a link and a
/// sentence the UI can translate, not a string from Rust.
#[tauri::command]
#[specta::specta]
pub(crate) async fn start_livekit_call(
    app: AppHandle,
    state: State<'_, AppState>,
    // The speech-to-speech vendor the user picked, or `None` when they have
    // not. `None` is not "no assistant": Rust falls back to whichever provider
    // has a key stored, so pasting a key is enough to get a talking call
    // without also having to find a picker.
    provider: Option<String>,
    // The voice picked for that provider, if any. Rust rejects an id that
    // does not belong to the provider rather than forwarding it — a stale id
    // from a previous vendor is refused mid-session, i.e. a call that connects
    // and then dies.
    voice: Option<String>,
) -> Result<LiveKitCall, String> {
    GENERATION.fetch_add(1, Ordering::SeqCst);

    // Already warm: mint a fresh token and let the webview back in. The room is
    // recreated by the join, which is what makes LiveKit dispatch the agent
    // again — the worker never stopped being registered.
    {
        let mut slot = state.livekit_call.lock();
        if let Some(session) = slot.as_mut() {
            let token = session.rejoin("you");
            tracing::info!("livekit: rejoining the running call");
            return Ok(LiveKitCall {
                url: session.url.clone(),
                token,
                room: session.room.clone(),
                mode: session.mode.clone(),
                warm: true,
            });
        }
    }

    let extra: Vec<std::path::PathBuf> = app.path().resource_dir().ok().into_iter().collect();

    // The same briefing the engine being replaced sends, so the assistant on
    // the far end is the same character with the same rules about speaking.
    let brief =
        cinderpaw_core::live::Briefing { current_task: None, workspace: None, context: None };

    let emitter = app.clone();
    let session = cinderpaw_core::livekit::start(
        &extra,
        "you",
        Some(cinderpaw_core::live::system_instruction(&brief)),
        provider,
        voice,
        move |event| {
            // Failing to emit is not worth interrupting a call over: the audio
            // path is unaffected, and the person is mid-sentence.
            if let Err(e) = emitter.emit("cinderpaw://livekit-event", event) {
                tracing::warn!("livekit: could not forward an agent event ({e})");
            }
        },
        // The runtime is what makes `ask_cinder` work: it is a door to the
        // local agent, and only a host that owns a sidecar can open it.
        Some(state.runtime.clone()),
    )
    .await?;

    let call = LiveKitCall {
        url: session.url.clone(),
        token: session.token.clone(),
        room: session.room.clone(),
        mode: session.mode.clone(),
        warm: false,
    };

    // Lock only after the await: a `parking_lot` guard held across one is both
    // a compile error and, if it ever compiled, a deadlock.
    let previous = state.livekit_call.lock().replace(session);
    drop(previous);

    Ok(call)
}

/// Hang up, and let the machinery idle for a few minutes before taking it down.
///
/// Idempotent — the error path and the person pressing stop both end up here,
/// and a UI that had to track which one got there first would get it wrong
/// exactly when it matters.
#[tauri::command]
#[specta::specta]
pub(crate) async fn end_livekit_call(
    app: AppHandle,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    let armed_at = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // The webview has already left the room by the time this runs, so the call
    // is over from the person's side no matter what happens below. What is
    // being delayed is only the teardown of the processes.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDLE_SHUTDOWN).await;
        if GENERATION.load(Ordering::SeqCst) != armed_at {
            return; // another call came or went; that one owns the timer now
        }
        if let Some(state) = app.try_state::<AppState>() {
            let previous = state.livekit_call.lock().take();
            if previous.is_some() {
                tracing::info!("livekit: idle, taking the voice server down");
            }
            drop(previous);
        }
    });

    Ok(())
}
