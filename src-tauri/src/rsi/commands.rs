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
//!
//! # Faza 4.5 Slice 2 split
//!
//! The shared runtime pieces (the sidecar request dispatcher, the
//! `do_rsi_*` bodies, `GoodhartSlot` / `RsiRequestRegistry` /
//! `RsiEngineState`, `ensure_initialized`, `require_string`) moved to
//! `feral_core::rsi::runtime` so a future headless host can reuse them
//! without Tauri. Only the `#[tauri::command]` wrappers — the sole
//! write path exposed to the UI/sidecar boundary — remain here. This
//! file imports the moved helpers by name via the glob import below.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use feral_core::rsi::runtime::*;

use super::audit::{AuditVerifyResult, SandboxBoundsAudit};
use super::goodhart::GoodhartDetector;
use super::repo::{self, IterationMetadata, RatchetResult};
use super::sandbox_bounds::SandboxBounds;
use super::tier0::TIER0_SPECS;
use super::types::{GoodhartResult, GoodhartSample};
use super::{EvalOutcome, ScoreBreakdown};

use crate::paths;
use crate::AppState;

/// How long `rsi_start` / `rsi_stop` / `rsi_set_concurrency` wait for a
/// matching ack on the Feral Agent's stdout before returning an error to the
/// UI. The sidecar emits an `rsi_engine_event` line whose `id` matches the
/// request's `request_id`; `feral_agent::stdout_reader` routes that into the
/// matching `oneshot::Sender` here. 500 ms is the proven ceiling on Windows
/// for spawn-to-IPC-ready (see Faza 7b-part2 design notes) and short enough
/// that a wedged engine surfaces to the UI in under a second.
pub const RSI_ACK_TIMEOUT: Duration = Duration::from_millis(500);

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
    let needs_rebuild = slot.as_ref().is_none();
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
    // `rsiMaxTotalTokens` / `rsiMaxTotalCostUsd` / `rsiConcurrency` from the inbound
    // `InboundMessage`. Renaming here without updating both sides
    // would silently fall back to the TS defaults — a real bug we
    // hit during the first manual e2e (the engine ran with
    // hard-coded defaults, not the user's inputs).
    //
    // USD and token budgets are distinct contracts. The UI currently exposes
    // only USD, so retain the sidecar's existing defensive token ceiling while
    // sending the exact USD cap to the network-boundary spend authority.
    let max_total_tokens = 5_000_000;
    let payload = build_rsi_start_payload(&request_id, &goal, budget_usd.max(0.0), max_iterations, concurrency, max_total_tokens);
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
///   rsiMaxTotalTokens:  u64 — independent defensive token ceiling
///   rsiMaxTotalCostUsd: f64 — exact user-approved USD ceiling
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
        "rsiMaxTotalCostUsd": budget_usd,
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

// ── Dream Cycle telemetry (read path for the Feral's Dreams panel) ──────────

/// One completed Dream Cycle episode, mirroring the sidecar's
/// `DreamEpisodeRecord` (`dream-telemetry.ts`). Field names are camelCase on
/// the wire to match the JSONL the sidecar writes and the TS UI that reads it.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DreamEpisode {
    pub started_at: i64,
    pub ended_at: i64,
    pub trigger: String,
    pub iterations: u64,
    pub tokens: u64,
    pub ratchets: u64,
    pub stop_reason: String,
}

/// Aggregated Dream Cycle telemetry for the UI: lifetime totals plus the most
/// recent episodes (newest first, capped at the requested limit).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct DreamTelemetrySummary {
    /// Total completed episodes across all sessions.
    pub episodes: u64,
    /// Sum of ratchet advances — the count of real self-improvements.
    pub ratchets: u64,
    pub tokens: u64,
    pub iterations: u64,
    /// Most recent episodes, newest first (up to the requested limit).
    pub last: Vec<DreamEpisode>,
}

/// Parse the dream JSONL body into a summary. Tolerant by design: blank lines
/// and unparseable rows are skipped (telemetry is a soft audit trail, never a
/// correctness surface — one poisoned line must not blank the whole panel).
fn parse_dream_telemetry(body: &str, limit: usize) -> DreamTelemetrySummary {
    let mut summary = DreamTelemetrySummary::default();
    let mut recent: Vec<DreamEpisode> = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(ep) = serde_json::from_str::<DreamEpisode>(line) else {
            continue; // skip malformed rows
        };
        summary.episodes += 1;
        summary.ratchets += ep.ratchets;
        summary.tokens += ep.tokens;
        summary.iterations += ep.iterations;
        recent.push(ep);
    }
    // Newest first, capped at `limit`.
    recent.reverse();
    recent.truncate(limit);
    summary.last = recent;
    summary
}

/// Read `~/.feral/rsi/dream.jsonl` and return lifetime totals + the most recent
/// `limit` episodes. A missing file yields an empty summary (the Dream Cycle
/// simply hasn't run yet) rather than an error, so the panel renders a clean
/// "no dreams yet" state. **Stateless.**
#[tauri::command]
#[specta::specta]
pub fn rsi_dream_telemetry(limit: usize) -> Result<DreamTelemetrySummary, String> {
    let path = paths::rsi_dream_telemetry_path();
    match std::fs::read_to_string(&path) {
        Ok(body) => Ok(parse_dream_telemetry(&body, limit)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(DreamTelemetrySummary::default())
        }
        Err(e) => Err(format!("read dream telemetry: {e}")),
    }
}

// ── Evolution Journal (read path for the receipts UI) ───────────────────────

/// The terminal decision of a journal row (BRSI §2.9). The sidecar's
/// `decided` union (accept / reject / halt) always carries `action` + `reason`;
/// per-variant extras (`nextStep`, `stage`) are ignored here — the receipts
/// UI renders action + reason.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct JournalDecisionRow {
    pub action: String,
    pub reason: String,
}

/// The measured slice of a per-candidate row's fitness vector. Only the
/// components the receipts UI renders — serde skips the rest.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalFitnessRow {
    pub accuracy: f64,
    pub user_satisfaction: f64,
}

/// Evaluate-stage result of a journal row. Present on per-candidate Contract
/// FSM rows; episode summary rows carry `result: null`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalResultRow {
    pub aggregate: f64,
    pub tier0: String,
    pub fitness_vector: JournalFitnessRow,
}

/// One Evolution Journal row, flattened for the receipts UI. The `observed`
/// lines are already human-readable (trigger, N promoted, gate-blocked count,
/// budget left), so the UI renders them verbatim. Extra journal fields
/// (`hypothesized`, `experimented`, `budgetRemaining`) are ignored here —
/// they are episode-internal, not receipt copy. `result` is the per-candidate
/// fitness receipt (Contract FSM rows); null on episode summary rows.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalRow {
    pub cycle_id: String,
    pub timestamp: i64,
    pub duration_min: f64,
    pub observed: Vec<String>,
    pub decided: JournalDecisionRow,
    #[serde(default)]
    pub result: Option<JournalResultRow>,
}

/// Parse a journal JSONL body into rows, oldest-first. Tolerant: blank lines
/// and unparseable rows are skipped (the journal is a soft trail — one
/// poisoned line must not blank the whole receipts view).
fn parse_journal_rows(body: &str) -> Vec<JournalRow> {
    let mut rows = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<JournalRow>(line) {
            rows.push(row);
        }
    }
    rows
}

/// Read the per-day journal files under `~/.feral/rsi/journal/` and return the
/// most recent `limit` rows, newest first. A missing directory yields an empty
/// list (the Dream Cycle simply hasn't journaled yet). **Stateless.**
///
/// ponytail: reads every day-file fully. Journals are one row per episode
/// (occasional), so this is cheap; if it ever grows, read newest file first
/// and stop once `limit` rows are collected.
#[tauri::command]
#[specta::specta]
pub fn rsi_journal_recent(limit: usize) -> Result<Vec<JournalRow>, String> {
    let dir = paths::rsi_journal_dir();
    let mut files: Vec<std::path::PathBuf> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("journal-") && n.ends_with(".jsonl"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read journal dir: {e}")),
    };
    // `journal-YYYY-MM-DD.jsonl` → lexical sort is chronological.
    files.sort();

    let mut rows: Vec<JournalRow> = Vec::new();
    for f in &files {
        if let Ok(body) = std::fs::read_to_string(f) {
            rows.append(&mut parse_journal_rows(&body));
        }
    }
    // Rows are oldest-first across sorted files; flip to newest-first and cap.
    rows.reverse();
    rows.truncate(limit);
    Ok(rows)
}

/// One niche's reigning champion, flattened for the receipts UI (§7.4). The
/// full config lives in the on-disk record; the UI shows the behavioural niche
/// key + the score.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChampionTreeRow {
    pub niche: String,
    pub genome_id: String,
    pub score: f64,
}

/// Read the Tree of Champions archive (`~/.feral/rsi/champion-tree.json`) and
/// return its niche champions, highest score first, for the receipts UI. A
/// missing / corrupt file yields an empty list (the engine simply hasn't
/// ratcheted a niche yet). Tolerant `Value` parse so a schema drift on the TS
/// writer side degrades to fewer rows, never a crash. **Stateless.**
#[tauri::command]
#[specta::specta]
pub fn rsi_champion_tree() -> Result<Vec<ChampionTreeRow>, String> {
    let path = crate::paths::rsi_dir().join("champion-tree.json");
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read champion-tree: {e}")),
    };
    let state: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()), // corrupt → empty, don't crash the panel
    };
    let mut rows: Vec<ChampionTreeRow> = Vec::new();
    if let Some(niches) = state.get("niches").and_then(|n| n.as_array()) {
        for n in niches {
            let niche = n
                .get("niche")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let champ = n.get("champion");
            let genome_id = champ
                .and_then(|c| c.get("genomeId"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let score = champ
                .and_then(|c| c.get("score"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            if !niche.is_empty() {
                rows.push(ChampionTreeRow { niche, genome_id, score });
            }
        }
    }
    rows.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(rows)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn champion_tree_rows_parse_sorted_and_tolerant() {
        // The parse is inline in rsi_champion_tree; mirror it on a literal body
        // to pin the shape + sort + tolerance without touching the real home.
        let body = r#"{"version":1,"niches":[
            {"niche":"t1:c1:rsemantic:d1","champion":{"genomeId":"g1","score":50.0}},
            {"niche":"t2:c2:rgraph:d2","champion":{"genomeId":"g2","score":80.0}},
            {"niche":"","champion":{"genomeId":"g3","score":99.0}}
        ]}"#;
        let state: serde_json::Value = serde_json::from_str(body).unwrap();
        let mut rows: Vec<ChampionTreeRow> = Vec::new();
        if let Some(niches) = state.get("niches").and_then(|n| n.as_array()) {
            for n in niches {
                let niche = n.get("niche").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let champ = n.get("champion");
                let genome_id = champ.and_then(|c| c.get("genomeId")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let score = champ.and_then(|c| c.get("score")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                if !niche.is_empty() {
                    rows.push(ChampionTreeRow { niche, genome_id, score });
                }
            }
        }
        rows.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        assert_eq!(rows.len(), 2); // the empty-niche row is dropped
        assert_eq!(rows[0].genome_id, "g2"); // highest score first
        assert_eq!(rows[1].genome_id, "g1");
    }

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
    fn parse_dream_telemetry_aggregates_and_skips_bad_lines() {
        let body = "\
{\"startedAt\":1000,\"endedAt\":2000,\"trigger\":\"idle\",\"iterations\":3,\"tokens\":100,\"ratchets\":1,\"stopReason\":\"MaxIterations\"}
not json — must be skipped

{\"startedAt\":3000,\"endedAt\":4000,\"trigger\":\"error\",\"iterations\":2,\"tokens\":50,\"ratchets\":0,\"stopReason\":\"BudgetExhausted\"}
{\"missing\":\"fields\"}
{\"startedAt\":5000,\"endedAt\":6000,\"trigger\":\"idle\",\"iterations\":4,\"tokens\":200,\"ratchets\":2,\"stopReason\":\"Converged\"}";
        let s = parse_dream_telemetry(body, 2);
        // Three valid rows; two junk lines skipped.
        assert_eq!(s.episodes, 3);
        assert_eq!(s.ratchets, 3);
        assert_eq!(s.tokens, 350);
        assert_eq!(s.iterations, 9);
        // Newest-first, capped at the limit.
        assert_eq!(s.last.len(), 2);
        assert_eq!(s.last[0].started_at, 5000);
        assert_eq!(s.last[1].started_at, 3000);
    }

    #[test]
    fn parse_dream_telemetry_empty_is_zeroed() {
        let s = parse_dream_telemetry("", 10);
        assert_eq!(s.episodes, 0);
        assert!(s.last.is_empty());
    }

    #[test]
    fn parse_journal_rows_extracts_decision_and_observed_skipping_junk() {
        let body = "\
{\"cycleId\":\"c-1\",\"timestamp\":1000,\"durationMin\":1.5,\"observed\":[\"trigger: idle\",\"12 evaluation(s), 2 promoted to main\"],\"hypothesized\":[],\"experimented\":null,\"result\":null,\"decided\":{\"action\":\"accept\",\"reason\":\"2 candidate(s) cleared the gate\"},\"budgetRemaining\":{\"wallClockMin\":6,\"tokens\":18000,\"cpuPct\":50,\"ramMb\":2048,\"diskMb\":5120}}
not json — skipped
{\"missing\":\"fields\"}
{\"cycleId\":\"c-2\",\"timestamp\":2000,\"durationMin\":0.5,\"observed\":[\"stop reason: error\"],\"hypothesized\":[],\"experimented\":null,\"result\":null,\"decided\":{\"action\":\"halt\",\"reason\":\"bridge timeout\",\"stage\":\"evaluate\"},\"budgetRemaining\":{\"wallClockMin\":0,\"tokens\":0,\"cpuPct\":0,\"ramMb\":0,\"diskMb\":0}}";
        let rows = parse_journal_rows(body);
        // Two valid rows; two junk lines skipped.
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].cycle_id, "c-1");
        assert_eq!(rows[0].decided.action, "accept");
        assert_eq!(rows[0].observed.len(), 2);
        // The halt variant's extra `stage` field is ignored; action+reason kept.
        assert_eq!(rows[1].decided.action, "halt");
        assert_eq!(rows[1].decided.reason, "bridge timeout");
    }

    #[test]
    fn parse_journal_rows_empty_is_empty() {
        assert!(parse_journal_rows("").is_empty());
    }

    #[test]
    fn parse_journal_rows_carries_per_candidate_fitness_result() {
        // A per-candidate Contract FSM row: non-null `result` with the full
        // 6-component fitness vector — the receipts UI reads aggregate +
        // tier0 + accuracy/userSatisfaction; the rest is skipped by serde.
        let body = "{\"cycleId\":\"c-1\",\"timestamp\":1000,\"durationMin\":0.1,\"observed\":[],\"hypothesized\":[],\"experimented\":{\"candidateId\":\"g1\",\"change\":\"\",\"layer\":\"L1\"},\"result\":{\"fitnessVector\":{\"accuracy\":0.73,\"latency\":0.27,\"cost\":0.27,\"toolSuccess\":0.73,\"hallucination\":0.5,\"userSatisfaction\":0.62},\"aggregate\":0.73,\"confidence\":0.95,\"tier0\":\"passed\",\"tier1\":\"no_regression\"},\"decided\":{\"action\":\"accept\",\"reason\":\"all contract stages passed\"},\"budgetRemaining\":{\"wallClockMin\":6,\"tokens\":18000,\"cpuPct\":50,\"ramMb\":2048,\"diskMb\":5120}}";
        let rows = parse_journal_rows(body);
        assert_eq!(rows.len(), 1);
        let result = rows[0].result.as_ref().expect("per-candidate result");
        assert!((result.aggregate - 0.73).abs() < 1e-9);
        assert_eq!(result.tier0, "passed");
        assert!((result.fitness_vector.user_satisfaction - 0.62).abs() < 1e-9);
        assert!((result.fitness_vector.accuracy - 0.73).abs() < 1e-9);
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
        assert_eq!(
            payload.get("rsiMaxTotalCostUsd").and_then(|v| v.as_f64()),
            Some(1.0),
        );

        // The legacy camelCase aliases are still present (event feed
        // reads budgetUsd for display).
        assert_eq!(payload.get("budgetUsd").and_then(|v| v.as_f64()), Some(1.0));
    }

    /// USD authorization and token volume are separate limits. Changing the
    /// approved USD amount must not silently rewrite the token ceiling.
    #[test]
    fn rsi_start_payload_keeps_usd_and_token_budgets_independent() {
        let payload = build_rsi_start_payload("id", "g", 0.1, 1, 1, 5_000_000);
        assert_eq!(
            payload.get("rsiMaxTotalCostUsd").and_then(|v| v.as_f64()),
            Some(0.1),
        );
        assert_eq!(
            payload.get("rsiMaxTotalTokens").and_then(|v| v.as_u64()),
            Some(5_000_000),
        );
    }
}
