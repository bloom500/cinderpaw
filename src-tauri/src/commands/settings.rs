//! App settings + desktop-control/token-budget/RSI-budget toggles that
//! restart the Feral Agent sidecar so it re-reads its env.

use crate::*;

#[tauri::command]
#[specta::specta]
pub(crate) fn get_settings() -> Settings { settings::load() }

#[tauri::command]
#[specta::specta]
pub(crate) fn save_settings(settings: Settings) -> Result<(), String> {
    settings::save(&settings).map_err(|e| e.to_string())
}

/// Toggle OS-level desktop control (the `control_app` tool) at runtime.
///
/// Persists the choice, updates the host-process env (so the Rust command
/// gate and the next sidecar spawn agree — both read
/// `FERAL_ENABLE_DESKTOP_CONTROL`), then restarts the sidecar so its tool
/// registry re-registers or drops `control_app`. The restart is what makes the
/// tool actually appear/disappear: tool registration happens once, at sidecar
/// startup, from `process.env`.
///
/// The restart is performed by killing the current child; the `#11` supervisor
/// detects the exit and respawns it, re-reading the env set above. The stdin
/// `tx` slot is invalidated so any in-flight send fails fast instead of writing
/// into a dead pipe.
#[tauri::command]
#[specta::specta]
pub(crate) fn set_desktop_control_enabled(
    enabled: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.desktop_control_enabled = enabled;
    settings::save(&s).map_err(|e| e.to_string())?;

    if enabled {
        std::env::set_var("FERAL_ENABLE_DESKTOP_CONTROL", "true");
    } else {
        std::env::remove_var("FERAL_ENABLE_DESKTOP_CONTROL");
    }
    restart_sidecar(&state);
    Ok(())
}

/// Set the per-conversation token budget for the Feral Agent sidecar.
///
/// `budget = None` → unlimited (exports `FERAL_BUDGET_CONVERSATION=Infinity`).
/// `budget = Some(n)` → caps at n tokens (exports the number as a string).
/// The sidecar reads this env at startup via `Number(env.FERAL_BUDGET_CONVERSATION)`.
/// Persists the choice and restarts the sidecar so the new budget takes effect.
#[tauri::command]
#[specta::specta]
pub(crate) fn set_token_budget_conversation(
    budget: Option<u64>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.token_budget_conversation = budget;
    settings::save(&s).map_err(|e| e.to_string())?;

    match budget {
        Some(n) => std::env::set_var("FERAL_BUDGET_CONVERSATION", n.to_string()),
        None => std::env::set_var("FERAL_BUDGET_CONVERSATION", "Infinity"),
    }
    restart_sidecar(&state);
    Ok(())
}

/// Set the USD spend cap for the passive RSI background engine.
///
/// `budget = Some(0.0)` (default) → local-only: free local runs continue, any
/// paid cloud spend halts. `Some(n)` → allow up to $n of cloud spend. `None` →
/// no cap. Exports `FERAL_RSI_MAX_COST_USD` and restarts the sidecar so the
/// passive supervisor re-reads it.
#[tauri::command]
#[specta::specta]
pub(crate) fn set_rsi_budget(
    budget: Option<f64>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.rsi_max_cost_usd = budget;
    settings::save(&s).map_err(|e| e.to_string())?;

    match budget {
        Some(n) => std::env::set_var("FERAL_RSI_MAX_COST_USD", n.to_string()),
        None => std::env::remove_var("FERAL_RSI_MAX_COST_USD"),
    }
    restart_sidecar(&state);
    Ok(())
}

/// Toggle desktop-control "YOLO mode" (no per-action confirmation) at runtime.
///
/// The confirmation gate lives in the SIDECAR (it reads
/// `FERAL_DESKTOP_CONTROL_CONFIRM`), so like the enable toggle this updates the
/// host env and restarts the sidecar to apply it. Safe mode (the default) asks
/// before each state-changing action; YOLO mode runs them immediately. `launch`
/// always confirms regardless, since it creates a process.
#[tauri::command]
#[specta::specta]
pub(crate) fn set_desktop_control_yolo(
    enabled: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.desktop_control_yolo = enabled;
    settings::save(&s).map_err(|e| e.to_string())?;

    if enabled {
        std::env::set_var("FERAL_DESKTOP_CONTROL_CONFIRM", "false");
    } else {
        std::env::remove_var("FERAL_DESKTOP_CONTROL_CONFIRM");
    }
    restart_sidecar(&state);
    Ok(())
}

/// Restart the Feral Agent sidecar so it re-reads the desktop-control env vars.
///
/// Kills the current child; the `#11` supervisor detects the exit and respawns
/// it with the updated environment. The slot is kept populated (the supervisor
/// stops only when it is cleared), and the stdin `tx` is invalidated so any
/// in-flight send fails fast instead of writing into a dead pipe.
fn restart_sidecar(state: &AppState) {
    // Mark the exit as planned so the supervisor skips crash accounting
    // AND the Faza 3 watchdog counter (an env-toggle restart during a
    // patch's observation window must not push it toward auto-revert).
    *state.feral_agent_planned_exit.lock() = Some(feral_core::runtime::PlannedExit::Restart);
    {
        let mut guard = state.feral_agent_process.lock();
        if let Some(ref mut child) = *guard {
            let _ = child.start_kill();
        }
    }
    *state.feral_agent_tx.lock() = None;
}
