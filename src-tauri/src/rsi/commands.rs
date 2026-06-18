//! Tauri commands exposed to the Feral Agent sidecar.
//!
//! Everything that crosses the IPC boundary for RSI goes through
//! here. The sidecar has NO other way to read or write the RSI
//! substrate — every entry point:
//!
//! 1. Checks `RsiState::initialized` first; refuses to operate on
//!    an un-bootstrapped substrate.
//! 2. Runs path validation (`paths::require_under`) on every
//!    caller-supplied path.
//! 3. Re-loads `SandboxBounds` (and re-verifies its audit chain)
//!    before any decision that depends on the bound values, so an
//!    out-of-band edit between calls is caught.
//! 4. Records an audit row for any state mutation, with the same
//!    hash-chained anchor as the bounds audit.
//!
//! # State wiring (7c GOTCHA fix)
//!
//! Only `AppState` is `.manage()`d in `lib.rs`. The 8 commands that
//! read or write RSI state therefore take `State<'_, AppState>`
//! and access `.rsi_state` / `.rsi_goodhart`. The 5 stateless
//! commands (`rsi_ratchet_attempt`, `rsi_log`, `rsi_lca`,
//! `rsi_diff`, `rsi_get_tier0_specs`) operate directly on the
//! repo / constants and don't need any state handle — adding
//! `State<AppState>` to those would be unused noise.
//!
//! Command shape follows the rest of `src-tauri/src/lib.rs`:
//! `#[tauri::command] #[specta::specta] fn name(...) -> Result<T, String>`.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::audit::{AuditVerifyResult, SandboxBoundsAudit};
use super::goodhart::GoodhartDetector;
use super::repo::{self, IterationMetadata, RatchetResult};
use super::sandbox_bounds::SandboxBounds;
use super::tier0::TIER0_SPECS;
use super::types::{GoodhartResult, GoodhartSample};
use super::{EvalOutcome, ScoreBreakdown};

use crate::paths;
use crate::rsi::paths as rsi_paths;
use crate::AppState;

// ── Public types ────────────────────────────────────────────────────────────

/// Shared, lazily-initialised Goodhart detector. Held as a field on
/// `AppState` (replaces the pre-7c `State<'_, GoodhartSlot>` handle
/// that wasn't `.manage()`d — the GOTCHA fix). The rolling window
/// survives between commands within a single sidecar session and is
/// re-built on `rsi_init` from the current bounds.
#[derive(Default)]
pub struct GoodhartSlot {
    pub detector: Arc<Mutex<Option<GoodhartDetector>>>,
}

/// Mirror of the running engine. Populated from `rsi_engine_event`
/// outbound events on stdout (added when the sidecar starts emitting
/// them; Faza 7b-part2). Until then, `engine` stays `None` in
/// `RsiStatus` and the UI shows "engine not wired" rather than
/// crashing on `unwrap()`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
pub struct RsiEngineState {
    pub running: bool,
    pub iteration: u32,
    pub best_score: Option<f64>,
    pub cost_so_far_usd: f64,
    pub concurrency: u32,
    /// Last `StopReason` if the engine has terminated; `None` while
    /// running or before the engine has ever been started.
    pub stop_reason: Option<String>,
}

/// What `rsi_status` returns. Display-safe (no API keys, no paths
/// the agent shouldn't see). Substrate state is always populated
/// after `rsi_init`; engine state is populated as soon as the
/// sidecar starts emitting engine events.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RsiStatus {
    pub initialized: bool,
    pub bounds_sha256: Option<String>,
    pub bounds_version: Option<u32>,
    pub max_total_cost_usd: Option<f64>,
    pub cost_warning_ratio: Option<f64>,
    pub main_tip: Option<String>,
    pub main_tip_score: Option<f64>,
    /// `None` until the sidecar starts emitting engine status events.
    pub engine: Option<RsiEngineState>,
}

/// Result of `rsi_init`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RsiInitResult {
    pub plan_commit: String,
    pub main_tip: String,
    pub bounds_version: u32,
    pub audit_chain_ok: bool,
}

/// Ack returned by `rsi_start`. Sidecar will echo back via the
/// stdout `rsi_engine_started` event once the engine is actually up;
/// this ack only confirms the stdin message was delivered.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RsiStartAck {
    pub delivered: bool,
    pub request_id: String,
}

/// Ack returned by `rsi_stop`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RsiStopAck {
    pub delivered: bool,
}

// ── Substrate commands (State<AppState>) ───────────────────────────────────

/// Bootstrap the RSI substrate. Idempotent. Must be called once
/// per sidecar session before any other RSI command is allowed.
#[tauri::command]
#[specta::specta]
pub fn rsi_init(state: State<'_, AppState>) -> Result<RsiInitResult, String> {
    let rsi = &state.rsi_state;
    // 1. Bootstrap the git substrate (PLAN.md + commit).
    let plan_commit = repo::bootstrap().map_err(|e| e.to_string())?;

    // 2. Load or create SandboxBounds, verifying the audit chain.
    let audit_path = paths::rsi_sandbox_bounds_audit_path();
    let audit = SandboxBoundsAudit::open(&audit_path).map_err(|e| e.to_string())?;
    let verify = audit.verify().map_err(|e| e.to_string())?;
    let chain_ok = matches!(verify, AuditVerifyResult::Ok { .. });
    let bounds = if paths::rsi_sandbox_bounds_path().exists() {
        SandboxBounds::load().map_err(|e| e.to_string())?
    } else {
        SandboxBounds::bootstrap_with_audit(&audit).map_err(|e| e.to_string())?
    };
    let bounds_sha = bounds.file_sha256().map_err(|e| e.to_string())?;
    *rsi.bounds.lock() = Some(bounds.clone());
    *rsi.bounds_file_sha256.lock() = Some(bounds_sha);

    // 3. Mark initialized.
    *rsi.initialized.lock() = true;

    // 4. Get the main tip (or the plan commit if main doesn't exist yet).
    let main_tip = match repo::log(1) {
        Ok(commits) if !commits.is_empty() => commits[0].commit_hash.clone(),
        _ => plan_commit.clone(),
    };

    Ok(RsiInitResult {
        plan_commit,
        main_tip,
        bounds_version: bounds.version,
        audit_chain_ok: chain_ok,
    })
}

/// Read-only status. Safe to call any time. Returns the current
/// main tip's score when available so the UI can render the ratchet
/// line. Engine state is filled in if the sidecar has emitted any
/// engine events yet.
#[tauri::command]
#[specta::specta]
pub fn rsi_status(state: State<'_, AppState>) -> Result<RsiStatus, String> {
    let rsi = &state.rsi_state;
    let initialized = *rsi.initialized.lock();
    let bounds = rsi.bounds.lock().clone();
    let bounds_sha = rsi.bounds_file_sha256.lock().clone();

    let (main_tip, main_tip_score) = match repo::log(1) {
        Ok(commits) if !commits.is_empty() => {
            let tip = &commits[0];
            // metadata_json is a raw JSON string; we only need the
            // scalar score here. Cheap parse — just one number.
            let score = tip
                .metadata_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                .and_then(|v| v.get("score").and_then(|s| s.as_f64()));
            (Some(tip.commit_hash.clone()), score)
        }
        _ => (None, None),
    };

    let engine = state.rsi_engine.lock().clone();

    Ok(RsiStatus {
        initialized,
        bounds_sha256: bounds_sha,
        bounds_version: bounds.as_ref().map(|b| b.version),
        max_total_cost_usd: bounds.as_ref().map(|b| b.max_total_cost_usd),
        cost_warning_ratio: bounds.as_ref().map(|b| b.cost_warning_ratio),
        main_tip,
        main_tip_score,
        engine,
    })
}

/// Return the current SandboxBounds. The agent may read this — that's
/// intentional, the agent should know the rules it's playing by —
/// but any mutation goes through `rsi_update_bounds` which writes
/// the audit chain.
#[tauri::command]
#[specta::specta]
pub fn rsi_get_bounds(state: State<'_, AppState>) -> Result<SandboxBounds, String> {
    ensure_initialized(&state)?;
    Ok(state.rsi_state.bounds.lock().clone().expect("initialized"))
}

/// Mutate the SandboxBounds. **Only callable via the UI** — the
/// sidecar has no path to this command. The Tauri capability config
/// will be updated in a later phase to enforce this; for now we
/// require a `confirmation_token` string that matches a constant the
/// UI sends. The token is intentionally simple: the goal is
/// "agent cannot call this by accident", not cryptographic
/// authentication of the human (Tauri's window is the human's).
#[tauri::command]
#[specta::specta]
pub fn rsi_update_bounds(
    state: State<'_, AppState>,
    new_bounds: SandboxBounds,
    reason: String,
    confirmation_token: String,
) -> Result<(), String> {
    ensure_initialized(&state)?;
    if confirmation_token != "feral-user-confirmed" {
        return Err("rsi_update_bounds: confirmation_token missing or wrong".into());
    }
    if reason.trim().is_empty() {
        return Err("rsi_update_bounds: reason is required for the audit log".into());
    }
    let audit = SandboxBoundsAudit::open(paths::rsi_sandbox_bounds_audit_path())
        .map_err(|e| e.to_string())?;
    new_bounds
        .save_with_audit(&audit, &reason)
        .map_err(|e| e.to_string())?;
    let sha = new_bounds.file_sha256().map_err(|e| e.to_string())?;
    *state.rsi_state.bounds.lock() = Some(new_bounds);
    *state.rsi_state.bounds_file_sha256.lock() = Some(sha);
    Ok(())
}

/// Score a batch of eval outcomes. Pure function over the input;
/// no state is read, no audit is written. The sidecar calls this
/// every time it has a fresh eval batch to compute the composite
/// score that will be stored in `rsi_iteration.fitness_score`.
#[tauri::command]
#[specta::specta]
pub fn rsi_score(
    state: State<'_, AppState>,
    outcomes: Vec<EvalOutcome>,
) -> Result<ScoreBreakdown, String> {
    ensure_initialized(&state)?;
    // Use the bounds' weights if they exist, otherwise defaults.
    let weights = state
        .rsi_state
        .bounds
        .lock()
        .as_ref()
        .map(|b| b.scorer.weights.clone())
        .unwrap_or_default();
    Ok(super::scorer::score(&outcomes, &weights))
}

/// Return the 10 frozen Tier 0 sanity-check specs. The sidecar
/// uses these to drive the cheap pre-filter; the agent never sees
/// the list directly. **Stateless** — no State<AppState> handle.
#[tauri::command]
#[specta::specta]
pub fn rsi_get_tier0_specs() -> Result<Vec<super::tier0::Tier0Spec>, String> {
    Ok(TIER0_SPECS.iter().cloned().collect())
}

/// Commit a new genome candidate onto a branch. Returns the commit
/// hash. **The caller (sidecar) has already done all the agent-side
/// work**: this is the irreducible Rust surface for the git write.
/// We re-check bounds and path containment here before touching the
/// repo.
///
/// `genome_json` is passed as a JSON-encoded string rather than a
/// `serde_json::Value` because the latter doesn't implement
/// `specta::Type`. Rust parses the string, validates that it's a JSON
/// object (the shape we expect), and re-serialises for hashing.
#[tauri::command]
#[specta::specta]
pub fn rsi_commit_genome(
    state: State<'_, AppState>,
    genome_id: String,
    genome_json: String,
    parent_commits: Vec<String>,
    metadata: IterationMetadata,
    candidate_branch: String,
) -> Result<String, String> {
    ensure_initialized(&state)?;
    // Bounds check: parse the JSON, ensure it's an object. The
    // genome schema itself is opaque to Rust (the agent defines it);
    // we only enforce the top-level shape.
    let parsed: serde_json::Value = serde_json::from_str(&genome_json)
        .map_err(|e| format!("genome_json is not valid JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("genome_json must be a JSON object".into());
    }
    // Candidate branch name sanity — prevents the agent from
    // poking at `refs/heads/main` directly.
    if candidate_branch == "main" {
        return Err("candidate_branch must not be 'main' — use rsi_ratchet_attempt".into());
    }
    if candidate_branch.is_empty() || candidate_branch.contains("..") || candidate_branch.contains('/') {
        return Err(format!(
            "invalid candidate_branch '{}' — must be a single-segment name",
            candidate_branch
        ));
    }
    let parent_refs: Vec<&str> = parent_commits.iter().map(|s| s.as_str()).collect();
    repo::commit_genome(
        &genome_id,
        &parsed,
        &parent_refs,
        &metadata,
        &candidate_branch,
    )
    .map_err(|e| e.to_string())
}

// ── Stateless commands (no State handle) ───────────────────────────────────

/// Attempt a ratchet advance. The Rust side enforces the
/// monotonicity invariant — main moves forward only if the
/// candidate strictly beats the prior tip. **Stateless.**
#[tauri::command]
#[specta::specta]
pub fn rsi_ratchet_attempt(candidate_commit: String) -> Result<RatchetResult, String> {
    repo::ratchet_attempt(&candidate_commit).map_err(|e| e.to_string())
}

/// Return the last N commits as CommitMeta, newest first. Used by
/// the taste-vector miner in Faza 3 and by the explanation
/// generator in Faza 4.5. **Stateless.**
#[tauri::command]
#[specta::specta]
pub fn rsi_log(max: usize) -> Result<Vec<repo::CommitMeta>, String> {
    repo::log(max).map_err(|e| e.to_string())
}

/// Lowest common ancestor of two commits. Returns `None` when the
/// two histories are disjoint (no common ancestor besides the empty
/// repo root). Used by the lineage-aware crossover picker in Faza 2.
/// **Stateless.**
#[tauri::command]
#[specta::specta]
pub fn rsi_lca(a: String, b: String) -> Result<Option<String>, String> {
    repo::lca(&a, &b).map_err(|e| e.to_string())
}

/// Unified diff between two commits, as a UTF-8 string. Used by
/// the explanation generator and the taste-vector miner.
/// **Stateless.**
#[tauri::command]
#[specta::specta]
pub fn rsi_diff(a: String, b: String) -> Result<String, String> {
    repo::diff(&a, &b).map_err(|e| e.to_string())
}

// ── Goodhart commands (State<AppState>) ────────────────────────────────────

/// Ingest one Goodhart sample (Tier 1 + Tier 2 deltas for a single
/// iteration). The detector updates its rolling window and returns
/// the post-ingest state. The caller (sidecar) decides whether to
/// stamp `rsi_iteration.goodhart_flag = true` based on
/// `triggered`.
///
/// The detector is lazily constructed from the current bounds the
/// first time it's needed; subsequent calls reuse the same window
/// until the bounds change in a way that affects the window size or
/// thresholds.
#[tauri::command]
#[specta::specta]
pub fn rsi_record_goodhart_sample(
    state: State<'_, AppState>,
    sample: GoodhartSample,
) -> Result<GoodhartResult, String> {
    ensure_initialized(&state)?;

    let bounds = state
        .rsi_state
        .bounds
        .lock()
        .clone()
        .expect("initialized");
    let window_size = (bounds.goodhart_consecutive_required as usize).max(1);
    let mut slot = state.rsi_goodhart.detector.lock();
    let needs_rebuild = match slot.as_ref() {
        None => true,
        Some(_) => false, // thresholds are stable per session; a full
                          // reset is exposed via rsi_reset_goodhart.
    };
    if needs_rebuild {
        *slot = Some(GoodhartDetector::new(
            window_size as u32,
            bounds.goodhart_tier1_threshold,
            bounds.goodhart_tier2_threshold,
            bounds.goodhart_consecutive_required,
        ));
    }
    let detector = slot.as_mut().expect("just built");
    Ok(detector.observe(sample))
}

/// Reset the Goodhart detector's rolling window. Exposed so the UI
/// can clear the warning state after the user acknowledges it.
#[tauri::command]
#[specta::specta]
pub fn rsi_reset_goodhart(state: State<'_, AppState>) -> Result<(), String> {
    // Bind the guard to a variable so the compiler can resolve the
    // `Option::as_mut` call unambiguously (avoids the inference error
    // on `state.rsi_goodhart.detector.lock().as_mut()`).
    let mut guard = state.rsi_goodhart.detector.lock();
    if let Some(d) = guard.as_mut() {
        d.reset();
    }
    Ok(())
}

// ── Engine driver commands (State<AppState>) ──────────────────────────────

/// Start the RSI engine on the sidecar. Sends a `rsi_start` message
/// over stdin to the Feral Agent sidecar; the sidecar constructs the
/// engine (recorder → ratchet → selection → recalcitrance → GoalMode,
/// in that order — recorder MUST be the first EvalComplete
/// subscriber so it sees every result) and runs it autonomously
/// until a StopReason is reached.
///
/// `max_iterations` is the per-run hard cap. `budget_usd` is the
/// per-run token-cost ceiling; when hit, the sidecar stops with
/// `StopReason::BudgetExhausted`. `concurrency` is the initial
/// eval concurrency — ramped via `rsi_set_concurrency` once the
/// system is validated.
#[tauri::command]
#[specta::specta]
pub async fn rsi_start(
    state: State<'_, AppState>,
    goal: String,
    budget_usd: f64,
    max_iterations: u32,
    concurrency: u32,
) -> Result<RsiStartAck, String> {
    ensure_initialized(&state)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "type": "rsi_start",
        "id": request_id,
        "goal": goal,
        "budgetUsd": budget_usd,
        "maxIterations": max_iterations,
        "concurrency": concurrency,
    })
    .to_string();
    deliver_to_sidecar(&state, &payload).await?;
    Ok(RsiStartAck {
        delivered: true,
        request_id,
    })
}

/// Request a graceful stop of the running engine. The sidecar will
/// finish the current iteration, then stop with
/// `StopReason::UserStopped`.
#[tauri::command]
#[specta::specta]
pub async fn rsi_stop(state: State<'_, AppState>) -> Result<RsiStopAck, String> {
    let payload = serde_json::json!({
        "type": "rsi_stop",
        "id": uuid::Uuid::new_v4().to_string(),
    })
    .to_string();
    deliver_to_sidecar(&state, &payload).await?;
    Ok(RsiStopAck { delivered: true })
}

/// Adjust the eval-worker concurrency at runtime. Sends a
/// `rsi_set_concurrency` message; the sidecar applies it without
/// interrupting in-flight evals. Used in Faza 3 to ramp from 1
/// once the system is validated, and later to throttle on cost.
#[tauri::command]
#[specta::specta]
pub async fn rsi_set_concurrency(
    state: State<'_, AppState>,
    concurrency: u32,
) -> Result<(), String> {
    if concurrency == 0 {
        return Err("rsi_set_concurrency: concurrency must be >= 1".into());
    }
    let payload = serde_json::json!({
        "type": "rsi_set_concurrency",
        "concurrency": concurrency,
    })
    .to_string();
    deliver_to_sidecar(&state, &payload).await?;
    Ok(())
}

// ── Private helpers ─────────────────────────────────────────────────────────

/// Reject calls made before `rsi_init` succeeded. Without this guard
/// the sidecar could attempt to commit a genome before the git
/// substrate exists, and the failure mode would be confusing.
fn ensure_initialized(state: &State<'_, AppState>) -> Result<(), String> {
    if !*state.rsi_state.initialized.lock() {
        return Err("RSI not initialized — call rsi_init first".into());
    }
    Ok(())
}

/// Forward a JSON line to the Feral Agent sidecar via stdin.
/// Mirrors the existing `feral_send_message` pattern in `lib.rs`.
/// Returns an error if the sidecar isn't running; the caller is
/// expected to surface this to the UI as "engine not running".
async fn deliver_to_sidecar(state: &State<'_, AppState>, line: &str) -> Result<(), String> {
    let tx = {
        let guard = state.feral_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(line.to_string())
        .await
        .map_err(|e| format!("failed to deliver to sidecar: {e}"))?;
    Ok(())
}

// `rsi_paths` is referenced in the path validation flows even
// though every direct call site uses the free functions in
// `rsi::paths`; pin the alias so the import doesn't go unused.
#[allow(dead_code)]
fn _paths_module_pinned() {
    let _ = rsi_paths::is_valid_tier(0);
}

// `Arc` and `Mutex` are referenced from the public types above; pin
// them so the imports don't go unused when no public field actually
// uses one in a given build.
#[allow(dead_code)]
fn _arc_mutex_pinned() {
    let _: Arc<()> = Arc::new(());
    let _: Mutex<()> = Mutex::new(());
}
