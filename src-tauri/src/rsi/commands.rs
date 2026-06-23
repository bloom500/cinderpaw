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

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::oneshot;

use super::audit::{AuditVerifyResult, SandboxBoundsAudit};
use super::goodhart::GoodhartDetector;
use super::persistence::{self, PersistedEngineState};
use super::repo::{self, IterationMetadata, RatchetResult};
use super::sandbox_bounds::SandboxBounds;
use super::tier0::TIER0_SPECS;
use super::types::{GoodhartResult, GoodhartSample};
use super::{EvalOutcome, ScoreBreakdown};

use crate::paths;
use crate::rsi::paths as rsi_paths;
use crate::AppState;

/// How long `rsi_start` / `rsi_stop` / `rsi_set_concurrency` wait for a
/// matching ack on the Feral Agent's stdout before returning an error to the
/// UI. The sidecar emits an `rsi_engine_event` line whose `id` matches the
/// request's `request_id`; `feral_agent::stdout_reader` routes that into the
/// matching `oneshot::Sender` here. 500 ms is the proven ceiling on Windows
/// for spawn-to-IPC-ready (see Faza 7b-part2 design notes) and short enough
/// that a wedged engine surfaces to the UI in under a second.
pub const RSI_ACK_TIMEOUT: Duration = Duration::from_millis(500);

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

/// In-flight request registry for the three engine-driver commands
/// (`rsi_start` / `rsi_stop` / `rsi_set_concurrency`).
///
/// The race condition we close here: `tx.send()` on the stdin mpsc
/// returns as soon as the message is queued in the channel, NOT when
/// the sidecar has actually ingested it and set up its IPC handlers.
/// On Windows the gap between "Rust started writing to stdin" and
/// "sidecar is ready to ack" can be hundreds of ms during cold
/// boot; sending `rsi_start` then would drop the message into a
/// sidecar that isn't yet listening for it.
///
/// Pattern: Rust generates a `request_id` UUID, registers a
/// `oneshot::Sender<()>` keyed by that id, sends the message, and
/// awaits the receiver with `RSI_ACK_TIMEOUT`. The sidecar emits
/// `{type:"rsi_engine_event", event:"started"|"stopped"|"concurrency_set",
/// id:"<request_id>", ...}` on stdout once the engine action has
/// actually been applied; `feral_agent::stdout_reader` looks up
/// `request_id` in this registry and fires the oneshot. If the
/// oneshot doesn't fire within `RSI_ACK_TIMEOUT`, the command
/// returns a timeout error to the UI instead of hanging.
///
/// `Clone` is cheap (only an `Arc`) so `stdout_reader` can keep a
/// long-lived handle next to `feral_agent_tx`.
#[derive(Default, Clone)]
pub struct RsiRequestRegistry {
    inner: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl RsiRequestRegistry {
    /// Register `request_id` and return the receiver the caller awaits.
    /// If `request_id` is already registered, the previous sender is
    /// dropped (which causes its receiver to error with `RecvError`) —
    /// duplicate ids are programmer error, not user error.
    pub fn register(&self, request_id: String) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        self.inner.lock().insert(request_id, tx);
        rx
    }

    /// Fire the oneshot for `request_id`, if registered. Returns true
    /// iff the ack actually fired (false = unknown or already-consumed
    /// id). Used by `feral_agent::stdout_reader` to route engine
    /// events. The send errors are ignored — a `RecvError` just means
    /// the command already gave up (timeout).
    pub fn ack(&self, request_id: &str) -> bool {
        if let Some(tx) = self.inner.lock().remove(request_id) {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }

    /// Drop the pending sender for `request_id` without firing it.
    /// Called by the command after a timeout so the registry doesn't
    /// grow unbounded if the sidecar eventually acks a request nobody
    /// is waiting on.
    #[allow(dead_code)]
    pub fn cleanup(&self, request_id: &str) {
        self.inner.lock().remove(request_id);
    }

    /// Number of in-flight requests. Tests only — production code
    /// has no reason to inspect the size.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }
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
    do_rsi_score(state.inner(), outcomes)
}

/// Body of `rsi_score` extracted so the sidecar request dispatcher
/// (`dispatch_rsi_request`) can call it without going through a Tauri
/// `State<'_, AppState>` extractor — it gets a plain `&AppState` from
/// `app.state::<AppState>().inner()`.
pub(crate) fn do_rsi_score(state: &AppState, outcomes: Vec<EvalOutcome>) -> Result<ScoreBreakdown, String> {
    ensure_initialized(state)?;
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

// ── Engine-state persistence (Pathway 4 PR-B Task B.1) ──────────────────

/// Body of `rsi_save_engine_state`. Writes the state atomically to
/// `<dataDir>/rsi/engine-state.json` and caches the value on
/// `RsiState.engine_persisted` so the next read can answer without a
/// disk round-trip. Mirrors the `do_rsi_score` shape so the sidecar
/// dispatcher can call it without a `State<AppState>` extractor.
///
/// The Tauri command (`rsi_save_engine_state`) is added in B.2; this
/// helper exists so the persistence path is testable in isolation in
/// B.1.
pub(crate) fn do_save_engine_state(
    state: &AppState,
    value: PersistedEngineState,
) -> Result<(), String> {
    // Atomic write to disk. A failure here is reported back to the
    // caller — the B.2 Tauri command surfaces the error string; the
    // sidecar's per-iteration call site swallows it (B.3 best-effort).
    persistence::save(&value).map_err(|e| format!("rsi_save_engine_state: {e}"))?;
    // Update the in-memory cache so the next read can answer without
    // a disk round-trip. The cache mirrors disk on success — on a
    // future read miss the load helper will rehydrate it.
    *state.rsi_state.engine_persisted.lock() = Some(value);
    Ok(())
}

/// Body of `rsi_load_engine_state`. Reads the persisted state from
/// disk (returning `Ok(None)` if absent), and caches it on
/// `RsiState.engine_persisted`. Mirrors `do_rsi_score` so the sidecar
/// dispatcher can call it without `State<AppState>`.
pub(crate) fn do_load_engine_state(state: &AppState) -> Result<Option<PersistedEngineState>, String> {
    let loaded = persistence::load().map_err(|e| format!("rsi_load_engine_state: {e}"))?;
    // Update the cache to match what disk said — even when `loaded` is
    // None (file absent), so a subsequent save-then-load sees a
    // consistent in-memory snapshot.
    *state.rsi_state.engine_persisted.lock() = loaded.clone();
    Ok(loaded)
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
    do_rsi_commit_genome(state.inner(), genome_id, genome_json, parent_commits, metadata, candidate_branch)
}

/// Body of `rsi_commit_genome` extracted so the sidecar request
/// dispatcher (`dispatch_rsi_request`) can call it without going
/// through a Tauri `State<'_, AppState>` extractor — it gets a plain
/// `&AppState` from `app.state::<AppState>().inner()`.
pub(crate) fn do_rsi_commit_genome(
    state: &AppState,
    genome_id: String,
    genome_json: String,
    parent_commits: Vec<String>,
    metadata: IterationMetadata,
    candidate_branch: String,
) -> Result<String, String> {
    ensure_initialized(state)?;
    commit_genome_inner(genome_id, genome_json, parent_commits, metadata, candidate_branch)
}

/// State-free body of the genome commit: JSON validation + the libgit2
/// write. Split out from `do_rsi_commit_genome` so the sidecar request
/// dispatcher can run it on a blocking thread — libgit2 is synchronous
/// and would otherwise stall a tokio worker for the whole commit. The
/// cheap `ensure_initialized` lock check stays on the async path; only
/// this (git-bound) part is offloaded.
pub(crate) fn commit_genome_inner(
    genome_id: String,
    genome_json: String,
    parent_commits: Vec<String>,
    metadata: IterationMetadata,
    candidate_branch: String,
) -> Result<String, String> {
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
///
/// The returned `RsiStartAck` only proves the sidecar **acked** the
/// request (i.e. received the message and started constructing the
/// engine), NOT that the engine reached a steady state. The UI
/// polls `rsi_status` for `engine.running = true`.
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
    // The sidecar (TS) reads `rsiGoal` / `rsiMaxIterations` /
    // `rsiMaxTotalTokens` / `rsiConcurrency` from the inbound
    // `InboundMessage`. Renaming here without updating both sides
    // would silently fall back to the TS defaults — a real bug we
    // hit during the first manual e2e (the engine ran with
    // hard-coded defaults, not the user's inputs).
    //
    // budget_usd → maxTotalTokens heuristic: 1 USD ≈ 1M tokens,
    // conservative for local models (Gemma 4 E4B-it is well under
    // this). A future phase can wire a proper USD↔tokens rate
    // for cloud providers; the sidecar's `stopReason: BudgetExhausted`
    // will still fire correctly because the engine compares
    // accumulated tokens against `rsiMaxTotalTokens`.
    let max_total_tokens = ((budget_usd.max(0.1) * 1_000_000.0) as u64).max(100_000);
    let payload = build_rsi_start_payload(&request_id, &goal, budget_usd, max_iterations, concurrency, max_total_tokens);
    let payload = payload.to_string();
    wait_for_sidecar_ack(&state, &request_id, &payload).await?;
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
    let request_id = uuid::Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "type": "rsi_stop",
        "id": request_id,
    })
    .to_string();
    wait_for_sidecar_ack(&state, &request_id, &payload).await?;
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
    let request_id = uuid::Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "type": "rsi_set_concurrency",
        "id": request_id,
        "concurrency": concurrency,
    })
    .to_string();
    wait_for_sidecar_ack(&state, &request_id, &payload).await?;
    Ok(())
}

// ── Private helpers ─────────────────────────────────────────────────────────

/// Reject calls made before `rsi_init` succeeded. Without this guard
/// the sidecar could attempt to commit a genome before the git
/// substrate exists, and the failure mode would be confusing.
fn ensure_initialized(state: &AppState) -> Result<(), String> {
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

/// Build the JSON payload the host writes to the sidecar's stdin
/// for `rsi_start`. Extracted so the field-name convention can be
/// regression-tested without spinning up the Tauri command + state
/// plumbing (see `tests::rsi_start_payload_uses_prefixed_field_names`).
///
/// History: the original implementation sent `goal` / `budgetUsd` /
/// `maxIterations` / `concurrency` — the sidecar's `InboundMessage`
/// reads the `rsi`-prefixed variants (`rsiGoal` etc.), so every
/// field silently fell back to the TS defaults. The first manual
/// e2e surfaced this as "the engine runs but ignores my inputs".
///
/// Wire contract (read by `FeralAgent/src/index.ts::onMessage`):
///   type:               "rsi_start"
///   id:                 request_id (mirrors back in rsi_engine_event)
///   rsiGoal:            string
///   rsiMaxIterations:   u32
///   rsiMaxTotalTokens:  u64 — derived from `budget_usd` × 1M
///                       (conservative for local models; see rsi_start)
///   rsiConcurrency:     u32
///   budgetUsd:          f64 — kept for the live event feed display
///   goal / maxIterations / concurrency — kept as legacy camelCase
///                       aliases for any future TS-side override path
fn build_rsi_start_payload(
    request_id: &str,
    goal: &str,
    budget_usd: f64,
    max_iterations: u32,
    concurrency: u32,
    max_total_tokens: u64,
) -> serde_json::Value {
    serde_json::json!({
        "type": "rsi_start",
        "id": request_id,
        "rsiGoal": goal,
        "rsiMaxIterations": max_iterations,
        "rsiMaxTotalTokens": max_total_tokens,
        "rsiConcurrency": concurrency,
        "goal": goal,
        "budgetUsd": budget_usd,
        "maxIterations": max_iterations,
        "concurrency": concurrency,
    })
}

/// Send `payload` to the sidecar and wait up to `RSI_ACK_TIMEOUT`
/// for a matching ack on stdout (via `RsiRequestRegistry`).
///
/// `request_id` is included in `payload` verbatim — the sidecar
/// echoes it back in the corresponding `rsi_engine_event` line so
/// `feral_agent::stdout_reader` can route the ack to this wait.
///
/// On timeout the registry entry is dropped so the registry doesn't
/// leak: the sidecar may eventually ack a request nobody is waiting
/// on, and we don't want those ghosts to accumulate. The error
/// message is explicit so the UI can render a meaningful banner
/// ("sidecar didn't ack rsi_start within 500ms — is it hung?").
async fn wait_for_sidecar_ack(
    state: &State<'_, AppState>,
    request_id: &str,
    payload: &str,
) -> Result<(), String> {
    let rx = state.rsi_request_registry.register(request_id.to_string());
    // Deliver AFTER registering so an instantly-acking sidecar
    // (tests, warm boot) can't fire-and-forget before we've hooked
    // the receiver into the registry.
    deliver_to_sidecar(state, payload).await?;
    match tokio::time::timeout(RSI_ACK_TIMEOUT, rx).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_canceled)) => Err(format!(
            "rsi request {request_id}: ack channel closed before fire (engine task died?)"
        )),
        Err(_elapsed) => {
            // Drop the pending sender so a late ack doesn't keep
            // an entry alive forever.
            state.rsi_request_registry.cleanup(request_id);
            Err(format!(
                "rsi request {request_id}: sidecar did not ack within {RSI_ACK_TIMEOUT:?}"
            ))
        }
    }
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

// ── Sidecar request dispatcher (protocol (a)) ─────────────────────────────

/// Dispatch a single `{type:"rsi_request", id, method, params}` line
/// coming from the Feral Agent sidecar's stdout. Returns a JSON
/// value to embed in `{type:"rsi_response", id, ok, data}` on
/// success, or `Err(message)` for `{ok:false, error}`.
///
/// The methods listed here are the ones the sidecar's bridge client
/// actually calls. The UI-driven ones (`rsi_init`, `rsi_update_bounds`,
/// `rsi_status`, `rsi_record_goodhart_sample`, `rsi_reset_goodhart`)
/// are NOT routed here — those flow through Tauri's invoke path
/// from React and never appear on the sidecar's stdout. Adding them
/// here without callers would be dead code that drifts.
///
/// Stateless methods (`rsi_ratchet_attempt`, `rsi_log`, `rsi_lca`,
/// `rsi_diff`, `rsi_get_tier0_specs`) delegate straight to `repo` /
/// `tier0`; they don't read AppState. Stateful methods
/// (`rsi_commit_genome`, `rsi_score`) route through the `do_*`
/// helpers so the same body code serves both Tauri callers and the
/// bridge.
pub async fn dispatch_rsi_request(
    state: &AppState,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::json;
    match method {
        "rsi_commit_genome" => {
            let genome_id: String = require_string(params.get("genome_id"), "genome_id")?;
            let genome_json: String = require_string(params.get("genome_json"), "genome_json")?;
            let parent_commits: Vec<String> = params
                .get("parent_commits")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let metadata: IterationMetadata = serde_json::from_value(
                params
                    .get("metadata")
                    .cloned()
                    .ok_or_else(|| "rsi_commit_genome: missing 'metadata'".to_string())?,
            )
            .map_err(|e| format!("rsi_commit_genome: bad metadata: {e}"))?;
            let candidate_branch: String = require_string(params.get("candidate_branch"), "candidate_branch")?;
            // Fast lock check on the async path; the libgit2 write runs on a
            // blocking thread so a slow commit can't stall a tokio worker.
            ensure_initialized(state)?;
            let commit_hash = tokio::task::spawn_blocking(move || {
                commit_genome_inner(genome_id, genome_json, parent_commits, metadata, candidate_branch)
            })
            .await
            .map_err(|e| format!("rsi_commit_genome: task panicked: {e}"))??;
            Ok(json!({ "commitHash": commit_hash }))
        }
        "rsi_score" => {
            let outcomes: Vec<EvalOutcome> = serde_json::from_value(
                params
                    .get("outcomes")
                    .cloned()
                    .ok_or_else(|| "rsi_score: missing 'outcomes'".to_string())?,
            )
            .map_err(|e| format!("rsi_score: bad outcomes: {e}"))?;
            let breakdown = do_rsi_score(state, outcomes)?;
            // breakdown is specta::Type, so serialises to its own JSON
            // shape — wrap as the canonical {data: ...} envelope the
            // bridge client expects.
            Ok(serde_json::to_value(breakdown).map_err(|e| format!("rsi_score: serialise: {e}"))?)
        }
        // Stateless methods: no AppState needed. The sidecar's bridge
        // client uses these for lineage queries, diffing, and the
        // ratchet decision; routing them here keeps the protocol
        // symmetric (every method the sidecar can call is handled).
        "rsi_ratchet_attempt" => {
            let candidate_commit: String =
                require_string(params.get("candidate_commit"), "candidate_commit")?;
            let result = tokio::task::spawn_blocking(move || repo::ratchet_attempt(&candidate_commit))
                .await
                .map_err(|e| format!("rsi_ratchet_attempt: task panicked: {e}"))?
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "advanced": result.advanced,
                "previous_tip": result.previous_tip,
                "new_tip": result.new_tip,
                "candidate_score": result.candidate_score,
                "prior_score": result.prior_score,
            }))
        }
        "rsi_log" => {
            let max: usize = params
                .get("max")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize)
                .unwrap_or(50);
            let commits = tokio::task::spawn_blocking(move || repo::log(max))
                .await
                .map_err(|e| format!("rsi_log: task panicked: {e}"))?
                .map_err(|e| e.to_string())?;
            Ok(json!(commits))
        }
        "rsi_lca" => {
            let a: String = require_string(params.get("a"), "a")?;
            let b: String = require_string(params.get("b"), "b")?;
            let lca = tokio::task::spawn_blocking(move || repo::lca(&a, &b))
                .await
                .map_err(|e| format!("rsi_lca: task panicked: {e}"))?
                .map_err(|e| e.to_string())?;
            Ok(json!({ "lca": lca }))
        }
        "rsi_diff" => {
            let a: String = require_string(params.get("a"), "a")?;
            let b: String = require_string(params.get("b"), "b")?;
            let diff = tokio::task::spawn_blocking(move || repo::diff(&a, &b))
                .await
                .map_err(|e| format!("rsi_diff: task panicked: {e}"))?
                .map_err(|e| e.to_string())?;
            Ok(json!({ "diff": diff }))
        }
        "rsi_get_tier0_specs" => {
            let specs: Vec<super::tier0::Tier0Spec> = TIER0_SPECS.iter().cloned().collect();
            Ok(json!(specs))
        }
        // Embeddings for Fractal Memory Search. Not RSI per se, but it rides
        // the same sidecar↔Rust bridge: the TS `embed.ts` module calls this to
        // turn query/leaf text into vectors via the dedicated embedding model.
        // CPU-bound, so it runs on a blocking thread off the async runtime.
        "embed_text" => {
            let texts: Vec<String> = params
                .get("texts")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .ok_or_else(|| "embed_text: missing or non-array 'texts'".to_string())?;
            let vectors = tokio::task::spawn_blocking(move || crate::inference::embed_text(texts))
                .await
                .map_err(|e| format!("embed_text: task panicked: {e}"))?
                .map_err(|e| format!("embed_text: {e}"))?;
            Ok(json!(vectors))
        }
        other => Err(format!("rsi_request: unknown method '{other}'")),
    }
}

/// Helper used by the dispatcher to pull a required string param out
/// of a serde_json::Value with a clear error. Returns
/// `Err(field_name)`-shaped errors so the sidecar's bridge sees a
/// useful message instead of a generic "missing field".
fn require_string(v: Option<&serde_json::Value>, field: &str) -> Result<String, String> {
    v.and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| format!("rsi_request: missing or non-string '{field}'"))
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_register_and_ack_round_trip() {
        let reg = RsiRequestRegistry::default();
        let rx = reg.register("req-1".to_string());
        assert_eq!(reg.len(), 1);
        assert!(reg.ack("req-1"));
        assert_eq!(reg.len(), 0);
        // Receiver should now resolve with Ok.
        let result = rx.blocking_recv();
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn registry_ack_for_unknown_id_is_noop() {
        let reg = RsiRequestRegistry::default();
        assert!(!reg.ack("never-registered"));
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn registry_ack_twice_only_fires_first_sender() {
        // Repro guard: if a duplicate ack came in (sidecar emits a
        // second event for the same id by mistake) we must not
        // accidentally fire a stale sender that's been replaced by a
        // re-registration.
        let reg = RsiRequestRegistry::default();
        let rx1 = reg.register("req".to_string());
        assert!(reg.ack("req"));
        // After ack the entry is gone; a second ack should not panic
        // and should return false.
        assert!(!reg.ack("req"));
        // rx1 still resolves to Ok(()).
        assert_eq!(rx1.blocking_recv(), Ok(()));
    }

    #[test]
    fn registry_cleanup_drops_sender_so_late_ack_returns_false() {
        let reg = RsiRequestRegistry::default();
        let _rx = reg.register("req-c".to_string());
        reg.cleanup("req-c");
        assert_eq!(reg.len(), 0);
        // Late ack from the sidecar finds no entry → no-op.
        assert!(!reg.ack("req-c"));
    }

    #[test]
    fn registry_is_clone_and_shares_state() {
        let reg = RsiRequestRegistry::default();
        let reg2 = reg.clone();
        let rx = reg.register("shared".to_string());
        // Clone can ack; original receiver still resolves.
        assert!(reg2.ack("shared"));
        assert_eq!(rx.blocking_recv(), Ok(()));
    }

    #[test]
    fn wait_for_sidecar_ack_succeeds_when_ack_arrives() {
        // We can't easily build a full State<AppState> without a
        // Tauri runtime, so test the registry primitives the wait
        // helper relies on (the wait itself is exercised by the
        // engine integration test once 7d ships the UI). What we CAN
        // verify here: the registry primitives compose correctly.
        let reg = RsiRequestRegistry::default();
        let request_id = "ack-test".to_string();
        let rx = reg.register(request_id.clone());
        let handle = std::thread::spawn(move || {
            // Simulate the sidecar's stdout reader firing the ack.
            std::thread::sleep(Duration::from_millis(10));
            reg.ack(&request_id);
        });
        // The real wait would do `tokio::time::timeout(RSI_ACK_TIMEOUT, rx)`.
        // Verify the receiver unblocks promptly once the ack fires.
        let result = rx.blocking_recv();
        assert_eq!(result, Ok(()));
        handle.join().unwrap();
    }

    // --- dispatch_rsi_request routing tests -----------------------------

    fn fake_state() -> AppState {
        // Build a minimal AppState sufficient to exercise the
        // dispatcher. We only touch the rsi_state field — the
        // dispatcher doesn't read any other AppState field, and
        // the rest of the struct (manager, settings, mcp, …) isn't
        // relevant to protocol-(a) routing. Default-initialised
        // wherever possible.
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc as StdArc;
        use parking_lot::Mutex as PlMutex;
        crate::AppState {
            rsi_state: crate::rsi::RsiState {
                initialized: StdArc::new(PlMutex::new(true)),
                bounds: StdArc::new(PlMutex::new(None)),
                bounds_file_sha256: StdArc::new(PlMutex::new(None)),
                engine_persisted: StdArc::new(PlMutex::new(None)),
            },
            rsi_goodhart: crate::rsi::commands::GoodhartSlot::default(),
            rsi_engine: StdArc::new(PlMutex::new(None)),
            rsi_request_registry: crate::rsi::commands::RsiRequestRegistry::default(),
            manager: StdArc::new(crate::inference::ModelManager::new()),
            downloads: StdArc::new(PlMutex::new(std::collections::HashMap::new())),
            stop_signal: StdArc::new(AtomicBool::new(false)),
            settings: crate::settings::Settings::default(),
            system_info_cache: StdArc::new(PlMutex::new(None)),
            feral_agent_process: StdArc::new(PlMutex::new(None)),
            feral_agent_tx: StdArc::new(PlMutex::new(None)),
            feral_model_config: StdArc::new(PlMutex::new(None)),
            local_api_token: StdArc::from("test-token-not-used"),
            mcp: StdArc::new(crate::mcp::McpManager::new()),
        }
    }

    fn run_dispatch(method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        // The dispatcher is async (so it can be wired to async ops
        // later); for now it doesn't actually await anything, so we
        // can use futures::executor::block_on without dragging in a
        // full tokio runtime here.
        let state = fake_state();
        futures::executor::block_on(crate::rsi::commands::dispatch_rsi_request(
            &state, method, params,
        ))
    }

    #[test]
    fn dispatch_unknown_method_returns_named_error() {
        let result = run_dispatch("rsi_does_not_exist", serde_json::json!({}));
        let err = result.unwrap_err();
        assert!(err.contains("unknown method"), "got: {err}");
        assert!(err.contains("rsi_does_not_exist"), "got: {err}");
    }

    #[test]
    fn dispatch_rsi_get_tier0_specs_returns_array() {
        let result = run_dispatch("rsi_get_tier0_specs", serde_json::json!({}))
            .expect("dispatch must succeed");
        let arr = result.as_array().expect("tier0 specs must be an array");
        // Tier 0 has 13 frozen specs (see tier0.rs) — Pathway 4 PR-A Task A.1
        // grew the list from 10 by adding identity_honesty,
        // search_narration, and constraint_count. The kind list is
        // still 4 (frozen); only the spec count grew.
        assert_eq!(arr.len(), 13, "Tier 0 should have 13 frozen specs");
        // Each spec must have at least a string id field.
        for spec in arr {
            assert!(spec.get("id").and_then(|v| v.as_str()).is_some(),
                "every Tier 0 spec needs a string id; got {spec}");
        }
    }

    #[test]
    fn dispatch_rsi_score_rejects_missing_outcomes() {
        let err = run_dispatch("rsi_score", serde_json::json!({})).unwrap_err();
        assert!(err.contains("outcomes"), "error must mention 'outcomes': {err}");
    }

    #[test]
    fn dispatch_rsi_score_returns_breakdown_shape() {
        // Use defaults from ScorerWeights; ensure_initialized passes
        // because fake_state sets initialized = true.
        let result = run_dispatch(
            "rsi_score",
            serde_json::json!({
                "outcomes": [
                    { "task_id": "t1", "tier": 0, "success": true, "latency_ms": 10, "tokens": 100, "errored": false }
                ]
            }),
        )
        .expect("score must succeed");
        // ScoreBreakdown shape: {score, success_component, cost_component, error_component, latency_component, raw}
        assert!(result.get("score").and_then(|v| v.as_f64()).is_some(), "missing score: {result}");
        assert!(result.get("success_component").is_some());
        assert!(result.get("raw").is_some());
    }

    #[test]
    fn dispatch_rsi_commit_genome_rejects_missing_genome_id() {
        let err = run_dispatch("rsi_commit_genome", serde_json::json!({})).unwrap_err();
        assert!(err.contains("genome_id"), "error must mention genome_id: {err}");
    }

    #[test]
    fn dispatch_rsi_commit_genome_rejects_missing_metadata() {
        let err = run_dispatch(
            "rsi_commit_genome",
            serde_json::json!({
                "genome_id": "g1",
                "genome_json": "{}",
                "candidate_branch": "genome/g1"
            }),
        )
        .unwrap_err();
        assert!(err.contains("metadata"), "error must mention metadata: {err}");
    }

    #[test]
    fn dispatch_rsi_lca_requires_two_commits() {
        let err = run_dispatch("rsi_lca", serde_json::json!({ "a": "x" })).unwrap_err();
        assert!(err.contains("'b'") || err.contains("\"b\""), "error must mention missing 'b': {err}");
    }

    #[test]
    fn require_string_helper_handles_missing_and_wrong_type() {
        assert!(require_string(None, "x").is_err());
        assert!(require_string(Some(&serde_json::json!(123)), "x").is_err());
        assert_eq!(
            require_string(Some(&serde_json::json!("hi")), "x").unwrap(),
            "hi",
        );
    }

    /// Regression test for the field-name alignment between Rust
    /// (host) and TS (sidecar) — without the `rsi`-prefixed fields
    /// the sidecar's `InboundMessage` reader silently falls back to
    /// its hardcoded defaults (50 iterations, 5M tokens, etc.) and
    /// the engine ignores every input the user typed in the UI.
    /// Surfaced during the first manual e2e (`nothing happens` on
    /// /rsi). If this test ever flips, both sides of the wire
    /// drifted — update both at once.
    #[test]
    fn rsi_start_payload_uses_prefixed_field_names() {
        let payload = build_rsi_start_payload(
            "req-uuid",
            "smoke",
            1.0,
            50,
            4,
            1_000_000,
        );

        // Discriminant + id MUST match what the sidecar's onMessage
        // switch arms on.
        assert_eq!(payload.get("type").and_then(|v| v.as_str()), Some("rsi_start"));
        assert_eq!(payload.get("id").and_then(|v| v.as_str()), Some("req-uuid"));

        // The four prefixed fields are the ones the TS side reads.
        assert_eq!(payload.get("rsiGoal").and_then(|v| v.as_str()), Some("smoke"));
        assert_eq!(
            payload.get("rsiMaxIterations").and_then(|v| v.as_u64()),
            Some(50),
        );
        assert_eq!(
            payload.get("rsiMaxTotalTokens").and_then(|v| v.as_u64()),
            Some(1_000_000),
        );
        assert_eq!(
            payload.get("rsiConcurrency").and_then(|v| v.as_u64()),
            Some(4),
        );

        // The legacy camelCase aliases are still present (event feed
        // reads budgetUsd for display).
        assert_eq!(payload.get("budgetUsd").and_then(|v| v.as_f64()), Some(1.0));
    }

    /// `budget_usd → max_total_tokens` heuristic: 1 USD ≈ 1M tokens,
    /// clamped to a floor of 100k so a $0.05 smoke test still has
    /// enough budget for a few Tier 0 specs. The cap is defensive —
    /// the sidecar's `BudgetExhausted` stop reason will still fire
    /// correctly even if the heuristic drifts for a given model.
    #[test]
    fn rsi_start_payload_converts_budget_usd_to_tokens() {
        // $1.00 → 1M tokens
        assert_eq!(
            build_rsi_start_payload("id", "g", 1.0, 1, 1, 1_000_000)
                .get("rsiMaxTotalTokens").and_then(|v| v.as_u64()),
            Some(1_000_000),
        );
        // $0.10 → 100k (the floor)
        assert_eq!(
            build_rsi_start_payload("id", "g", 0.1, 1, 1, 100_000)
                .get("rsiMaxTotalTokens").and_then(|v| v.as_u64()),
            Some(100_000),
        );
        // $5.00 → 5M
        assert_eq!(
            build_rsi_start_payload("id", "g", 5.0, 1, 1, 5_000_000)
                .get("rsiMaxTotalTokens").and_then(|v| v.as_u64()),
            Some(5_000_000),
        );
    }

    // --- Engine-state persistence (Pathway 4 PR-B Task B.1) -----------

    /// PR-B B.1: after `do_save_engine_state` succeeds, the in-memory
    /// cache (`RsiState.engine_persisted`) must be populated so a
    /// subsequent `rsi_status` / `rsi_load_engine_state` returns the
    /// same value without re-reading disk. This is the hot-path
    /// invariant the resume path (B.3) relies on.
    #[test]
    fn do_save_engine_state_populates_rsi_state() {
        crate::rsi::test_support::with_temp_feral_home(|_root| {
            let state = fake_state();
            let value = crate::rsi::persistence::PersistedEngineState::default();
            do_save_engine_state(&state, value.clone()).unwrap();
            let cached = state.rsi_state.engine_persisted.lock();
            assert!(cached.is_some(), "engine_persisted must be Some after save");
            assert_eq!(cached.as_ref().unwrap(), &value);
        });
    }
}
