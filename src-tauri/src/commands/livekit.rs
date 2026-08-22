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

use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// What the webview needs to join the room, and nothing else.
#[derive(serde::Serialize, specta::Type)]
pub struct LiveKitCall {
    /// Always loopback. Named rather than assumed, so the day it stops being
    /// loopback the webview is not the last to find out.
    pub url: String,
    pub token: String,
    pub room: String,
}

/// Start the local call and return once the far end is really in the room.
///
/// Errors are messages meant for a person, with one exception worth knowing:
/// `livekit-no-node` is a code, because "install Node" needs a link and a
/// sentence the UI can translate, not a string from Rust.
#[tauri::command]
#[specta::specta]
pub(crate) async fn start_livekit_selftest(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LiveKitCall, String> {
    // Starting a second call while one runs would leave the first server and
    // agent orphaned — two voice servers, one of them invisible. Replacing the
    // slot drops the old session, and dropping it is what hangs it up.
    let extra: Vec<std::path::PathBuf> =
        app.path().resource_dir().ok().into_iter().collect();

    let session = cinderpaw_core::livekit::start(&extra, "you").await?;
    let call =
        LiveKitCall { url: session.url.clone(), token: session.token.clone(), room: session.room.clone() };

    // Lock only after the await: a `parking_lot` guard held across one is both
    // a compile error and, if it ever compiled, a deadlock.
    let previous = state.livekit_call.lock().replace(session);
    drop(previous);

    Ok(call)
}

/// Hang up. Idempotent — the error path and the person pressing stop both end
/// up here, and a UI that had to track which one got there first would get it
/// wrong exactly when it matters.
#[tauri::command]
#[specta::specta]
pub(crate) async fn end_livekit_selftest(state: State<'_, AppState>) -> Result<(), String> {
    let previous = state.livekit_call.lock().take();
    drop(previous);
    Ok(())
}
