//! Guided-setup commands (2026-07-10 OpenClaw onboarding-parity spec).
//! Thin wrappers over `cinderpaw_core::setup` — the same detect → verify →
//! persist seam the headless gateway serves on `/runtime/setup/*`, so the
//! desktop onboarding consumes the identical ladder and invariant
//! (persist only after a real completion round-trips).

use crate::*;
use tauri::State;

/// Run the detection ladder: existing config → local GGUFs → hardware-tier
/// download candidate → env API keys → Ollama → OpenClaw config import.
#[tauri::command]
#[specta::specta]
pub(crate) async fn setup_detect() -> Vec<cinderpaw_core::setup::Candidate> {
    cinderpaw_core::setup::detect().await
}

/// Verify a candidate with a real completion ("Reply with the single word
/// OK. Do not use tools.", 32 tokens, 90s). `persist` is honored only on
/// success.
#[tauri::command]
#[specta::specta]
pub(crate) async fn setup_verify(
    state: State<'_, AppState>,
    candidate: cinderpaw_core::setup::Candidate,
    api_key: Option<String>,
    persist: bool,
) -> Result<cinderpaw_core::setup::VerifyOutcome, String> {
    let runtime = state.runtime.clone();
    cinderpaw_core::setup::verify_candidate(&runtime, &candidate, api_key.as_deref(), None, persist)
        .await
        .map_err(|e| e.to_string())
}
