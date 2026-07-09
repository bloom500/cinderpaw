//! Agent preset CRUD + running a one-shot agent config against local inference.

use crate::*;
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub(crate) fn save_agent(cfg: AgentConfig) -> Result<AgentConfig, String> {
    agents::save(&cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_agents() -> Result<Vec<AgentConfig>, String> {
    tracing::info!("get_agents: invoked");
    agents::list().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_agent(id: String) -> Result<(), String> {
    agents::delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_agent_presets() -> Vec<AgentConfig> {
    agents::presets()
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn run_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    prompt: String,
    session_id: String,
) -> Result<(), String> {
    let list = agents::list().map_err(|e| e.to_string())?;
    let cfg = list.into_iter().find(|a| a.id == agent_id)
        .ok_or_else(|| format!("agent {} not found", agent_id))?;

    // Local llama.cpp agent loop — requires a model to be loaded.
    // For AI without a local model, use feral_send_message which routes through
    // the Feral Agent sidecar (Ollama-backed, with sandbox + memory).
    let manager = state.manager.clone();
    if manager.current().is_none() {
        return Err(
            "No local model loaded. Use Feral Agent (feral_send_message) for AI without \
             a local model, or load a GGUF model first."
                .to_string(),
        );
    }
    let mut rx = agents::run(cfg, prompt, manager);

    // Stream each AgentEvent (already JSON-serialized) over the feral:// event
    // bus, tagged with session_id so concurrent run panels don't cross streams.
    while let Some(ev) = rx.recv().await {
        let _ = app.emit("feral://agent-event", events::AgentStreamEvent {
            session_id: session_id.clone(),
            data: ev,
        });
    }
    Ok(())
}
