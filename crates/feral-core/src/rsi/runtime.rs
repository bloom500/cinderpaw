//! Host-agnostic RSI dispatcher + shared runtime pieces (Faza 4.5 Slice 2).
//!
//! Split out of `src-tauri/src/rsi/commands.rs`: everything here is reachable
//! without a Tauri `State` extractor, so it can be shared by the Tauri
//! desktop app and any future headless host. The Tauri `#[tauri::command]`
//! wrappers (the only write path exposed to the UI/sidecar boundary) stay in
//! `src-tauri/src/rsi/commands.rs` and call into these helpers by name via
//! `use feral_core::rsi::runtime::*;`.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::code_patch;
use super::goodhart::GoodhartDetector;
use super::repo::{self, IterationMetadata};
use super::tier0::TIER0_SPECS;
use super::{EvalOutcome, ScoreBreakdown, ScorerWeights};

use crate::runtime::RuntimeState;

// ── Public types ────────────────────────────────────────────────────────────

/// Shared, lazily-initialised Goodhart detector. Held as a field on
/// `RuntimeState` (replaces the pre-7c `State<'_, GoodhartSlot>` handle
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
    /// has no reason to inspect the size. Not `#[cfg(test)]`-gated:
    /// the downstream `feral` crate's own test module (`src-tauri/src/rsi/commands.rs`)
    /// exercises this type too, and `cfg(test)` doesn't cross crate
    /// boundaries — it would only apply to feral-core's own tests.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    /// Present for the same tests, and because a public `len` without an
    /// `is_empty` is a trap for the next caller.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.inner.lock().is_empty()
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

// ── Private helpers ─────────────────────────────────────────────────────────

/// Reject calls made before `rsi_init` succeeded. Without this guard
/// the sidecar could attempt to commit a genome before the git
/// substrate exists, and the failure mode would be confusing.
pub fn ensure_initialized(state: &RuntimeState) -> Result<(), String> {
    if !*state.rsi_state.initialized.lock() {
        return Err("RSI not initialized — call rsi_init first".into());
    }
    Ok(())
}

/// Helper used by the dispatcher to pull a required string param out
/// of a serde_json::Value with a clear error. Returns
/// `Err(field_name)`-shaped errors so the sidecar's bridge sees a
/// useful message instead of a generic "missing field".
pub fn require_string(v: Option<&serde_json::Value>, field: &str) -> Result<String, String> {
    v.and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| format!("rsi_request: missing or non-string '{field}'"))
}

/// Body of `rsi_score` extracted so the sidecar request dispatcher
/// (`dispatch_rsi_request`) can call it without going through a
/// Tauri `State<'_, AppState>` extractor.
///
/// **Visibility note (Faza 4.5 Slice 2 audit):** promoted from
/// `pub(crate)` (when this lived in `src-tauri/src/rsi/commands.rs`) to
/// `pub` so future headless hosts built on `feral-core` can dispatch
/// `rsi_score` directly. Re-evaluate when the headless API stabilises —
/// if only `dispatch_rsi_request` ever calls this, it can go back to
/// `pub(crate)`. Same applies to `commit_genome_inner` below and the
/// other dispatcher-adjacent helpers.
pub fn do_rsi_score(state: &RuntimeState, outcomes: Vec<EvalOutcome>) -> Result<ScoreBreakdown, String> {
    ensure_initialized(state)?;
    // Use the bounds' weights if they exist, otherwise defaults.
    // Falling back to the default weights is fine — a fresh install genuinely
    // has no tuned bounds yet. Doing it SILENTLY was not: the same outcomes
    // scored differently depending on whether bounds happened to be loaded, and
    // both numbers were presented as authoritative with nothing saying which
    // formula produced them. Refusing outright would be worse still, since it
    // would break scoring on a machine where nothing is wrong; so it says so.
    let weights = match state.rsi_state.bounds.lock().as_ref() {
        Some(b) => b.scorer.weights.clone(),
        None => {
            tracing::warn!(
                "rsi_score: sandbox bounds are not loaded — scoring with the DEFAULT weights.                  Scores from this call are not comparable with ones taken after bounds load."
            );
            ScorerWeights::default()
        }
    };
    let breakdown = super::scorer::score(&outcomes, &weights);
    remember_scored(breakdown.score);
    Ok(breakdown)
}

/// Scores this process actually computed, newest last.
///
/// The scorer lives in Rust so the agent cannot rewrite the formula — but the
/// resulting NUMBER travelled back through the agent and returned as
/// `IterationMetadata.score`, which the ratchet then compared and trusted. A
/// candidate could therefore evaluate at 0.32, declare 0.99, and the ratchet
/// would advance `main` onto it while reporting that it only ever advances on a
/// strictly better score. The guarantee was on the honour system.
///
/// Keeping the scores we computed closes the loop for the ordinary path: a
/// declared score must be one this process produced. It is not cryptographic —
/// anything running inside this process could still call `do_rsi_score` with
/// invented outcomes — but it does mean the number cannot simply be typed in.
///
/// ponytail: a small ring of recent values, not a genome→score map. The commit
/// carries no reference to the scoring call that produced it, so the strongest
/// check available here is "we computed this". Threading a scoring receipt id
/// through the sidecar is the real fix, and needs a protocol change.
static SCORED: std::sync::Mutex<Vec<f64>> = std::sync::Mutex::new(Vec::new());
const SCORED_MEMORY: usize = 256;

fn remember_scored(score: f64) {
    let mut seen = SCORED.lock().unwrap_or_else(|e| e.into_inner());
    seen.push(score);
    let len = seen.len();
    if len > SCORED_MEMORY {
        seen.drain(..len - SCORED_MEMORY);
    }
}

/// True when `score` matches something [`do_rsi_score`] computed recently.
fn was_scored_here(score: f64) -> bool {
    // Zero is the sentinel an errored evaluation emits without going through
    // the scorer at all (`eval-worker.ts` scores a crashed genome 0 so the
    // population can move on). It is also the floor, so it can never win a
    // ratchet comparison — allowing it costs nothing.
    if score == 0.0 {
        return true;
    }
    let seen = SCORED.lock().unwrap_or_else(|e| e.into_inner());
    // Exact f64 equality is right here: the value made the round trip through
    // JSON, which is lossless for f64, and we want to catch a value that was
    // edited rather than one that drifted.
    seen.iter().any(|s| *s == score)
}

/// Body of `rsi_commit_genome` extracted so the sidecar request
/// dispatcher (`dispatch_rsi_request`) can call it without going
/// through a Tauri `State<'_, AppState>` extractor.
pub fn do_rsi_commit_genome(
    state: &RuntimeState,
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
///
/// **Visibility note (Faza 4.5 Slice 2 audit):** promoted from
/// `pub(crate)` (when this lived in `src-tauri/src/rsi/commands.rs`) to
/// `pub` so future headless hosts built on `feral-core` can commit
/// genomes directly. See `do_rsi_score` above — same review trigger.
pub fn commit_genome_inner(
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
    // Case-INSENSITIVE, and trimmed. macOS APFS and Windows NTFS are both
    // case-insensitive by default, so `refs/heads/Main` and `refs/heads/main`
    // are the same file — and a candidate branch named "Main" therefore wrote
    // straight onto the promoted line without ever going through the ratchet's
    // "strictly better score" check. Trailing whitespace did the same job.
    let branch = candidate_branch.trim();
    if branch.eq_ignore_ascii_case("main") || branch.eq_ignore_ascii_case("master") {
        return Err(format!(
            "candidate_branch '{}' resolves to the promoted branch — use rsi_ratchet_attempt",
            candidate_branch
        ));
    }
    if branch != candidate_branch {
        return Err(format!(
            "invalid candidate_branch '{}' — no leading or trailing whitespace",
            candidate_branch
        ));
    }
    if branch.is_empty()
        || branch.contains("..")
        || branch.contains('/')
        || branch.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!(
            "invalid candidate_branch '{}' — must be a single-segment name",
            candidate_branch
        ));
    }
    // The declared score must be one this process actually computed. See
    // `SCORED` above for why, and for what this does and does not prove.
    if !was_scored_here(metadata.score) {
        return Err(format!(
            "refusing to commit genome '{}': its declared score {} was never produced by              the scorer in this process. Score the outcomes through `rsi_score` and commit              the value it returns.",
            genome_id, metadata.score
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
/// `tier0`; they don't read RuntimeState. Stateful methods
/// (`rsi_commit_genome`, `rsi_score`) route through the `do_*`
/// helpers so the same body code serves both Tauri callers and the
/// bridge.
pub async fn dispatch_rsi_request(
    state: &RuntimeState,
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
        // Stateless methods: no RuntimeState needed. The sidecar's bridge
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
        // Is there a model the Dream Cycle may evaluate against? The scheduler
        // asks before every episode and skips the wake when the answer is no.
        //
        // Without this gate an idle episode reaches the local API with nothing
        // loaded, `wait_for_model` lazily loads the first GGUF on disk, and a
        // user who only ever talks to a cloud provider silently pays ~5 GB of
        // RSS for a model that never serves one of their tokens (2026-07-13).
        //
        // A cloud route needs no resident GGUF — the provider IS the model — so
        // it counts as ready and the Dream Cycle keeps running for cloud users.
        "rsi_model_ready" => {
            let local_loaded = state.manager.current().is_some();
            let cloud_route = crate::settings::load()
                .active_route
                .and_then(|r| r.split_once(':').map(|(pid, _)| pid != "local"))
                .unwrap_or(false);
            Ok(json!({ "ready": local_loaded || cloud_route }))
        }
        // ── Faza 4 (L2 LoRA): swap the personal adapter under the loaded model ──
        // The sidecar's eval runner calls this to A/B a candidate adapter
        // against the champion: stage the adapter (or clear with path:null),
        // then reload the CURRENT model so every pooled context — and the
        // KV caches decoded under the previous adapter — is rebuilt with it.
        // No model loaded → stage only (applies at the next load).
        "rsi_set_lora" => {
            let path: Option<std::path::PathBuf> = params
                .get("path")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(std::path::PathBuf::from);
            let scale = params
                .get("scale")
                .and_then(|v| v.as_f64())
                .map(|v| v as f32)
                .unwrap_or(1.0);
            if let Some(p) = &path {
                if !p.is_file() {
                    return Err(format!("rsi_set_lora: adapter file not found: {}", p.display()));
                }
                // The path comes over the sidecar bridge, and "the file exists"
                // was the only check — so any file anywhere on the machine could
                // be pushed into the running model: something in ~/Downloads, on
                // a network share, whatever a prompt-injected instruction named.
                //
                // Adapters that Feral trained or fetched live under ~/.feral.
                // Confining it there is broad enough for every real path
                // (models dir, RSI dir) and closes the rest.
                let root = crate::paths::feral_dir();
                match crate::rsi::paths::is_under(&root, p) {
                    Ok(true) => {}
                    _ => {
                        return Err(format!(
                            "rsi_set_lora: refusing to load an adapter from outside {} (got {})",
                            root.display(),
                            p.display()
                        ))
                    }
                }
            }
            let had_adapter = path.is_some();
            crate::inference::set_lora_adapter(path, scale);
            let current = state.manager.current();
            if let Some(cur) = current {
                // Skip the (expensive) reload when nothing changes — e.g. the
                // eval runner's restore-to-bare after a candidate that failed
                // to load and already got the model re-loaded bare below.
                if crate::inference::active_lora_adapter()
                    == params.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from)
                {
                    return Ok(json!({ "active": crate::inference::active_lora_adapter() }));
                }
                let manager = state.manager.clone();
                let n_gpu_layers = state.settings.default_gpu_layers;
                let ctx = Some(cur.ctx_len);
                // `Some(ctx)` forces a real reload (the manager's idempotence
                // shortcut only fires on `None`) while preserving the user's
                // active context size.
                let reload = tokio::task::spawn_blocking({
                    let manager = manager.clone();
                    let path = cur.path.clone();
                    move || manager.load(path, n_gpu_layers, ctx)
                })
                .await
                .map_err(|e| format!("rsi_set_lora: task panicked: {e}"))?;
                if let Err(e) = reload {
                    // A bad adapter must not leave the model UNLOADED with the
                    // broken staging still armed (a concurrent lazy-load would
                    // trip on it — seen live in the Faza 4 smoke). Clear the
                    // staging and put the bare model back BEFORE reporting the
                    // error; best-effort, the error we return is the original.
                    if had_adapter {
                        crate::inference::set_lora_adapter(None, 1.0);
                        let recover = tokio::task::spawn_blocking(move || {
                            manager.load(cur.path, n_gpu_layers, ctx)
                        })
                        .await;
                        if let Err(e2) = recover.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())) {
                            tracing::error!(error = %e2, "rsi_set_lora: bare-model recovery reload failed");
                        }
                    }
                    return Err(format!("rsi_set_lora: reload failed: {e}"));
                }
            }
            Ok(json!({ "active": crate::inference::active_lora_adapter() }))
        }
        // ── Faza 2 code-RSI (spec §2: the Rust half of the trust boundary) ──
        // The sidecar's TS wall is advisory once code-RSI can rewrite TS;
        // these three re-assert policy/scoring/commit in the compiled binary.
        "rsi_validate_code_patch" => {
            let patch: String = require_string(params.get("patch"), "patch")?;
            // Policy violation is a soft verdict (candidate rejection),
            // not a bridge error — mirrors the TS wall's PatchVerdict.
            Ok(match code_patch::validate_code_patch(&patch) {
                Ok(stats) => json!({ "ok": true, "changed_lines": stats.changed_lines, "files": stats.files }),
                Err(reason) => json!({ "ok": false, "reason": reason }),
            })
        }
        "rsi_score_code_patch" => {
            let measurements: code_patch::CodePatchMeasurements = serde_json::from_value(
                params
                    .get("measurements")
                    .cloned()
                    .ok_or_else(|| "rsi_score_code_patch: missing 'measurements'".to_string())?,
            )
            .map_err(|e| format!("rsi_score_code_patch: bad measurements: {e}"))?;
            let scored = code_patch::score_code_patch(&measurements);
            Ok(serde_json::to_value(scored)
                .map_err(|e| format!("rsi_score_code_patch: serialise: {e}"))?)
        }
        "rsi_commit_code_patch" => {
            let genome_id: String = require_string(params.get("genome_id"), "genome_id")?;
            let patch: String = require_string(params.get("patch"), "patch")?;
            let genome_json: String = require_string(params.get("genome_json"), "genome_json")?;
            let candidate_branch: String =
                require_string(params.get("candidate_branch"), "candidate_branch")?;
            let metadata: IterationMetadata = serde_json::from_value(
                params
                    .get("metadata")
                    .cloned()
                    .ok_or_else(|| "rsi_commit_code_patch: missing 'metadata'".to_string())?,
            )
            .map_err(|e| format!("rsi_commit_code_patch: bad metadata: {e}"))?;
            // HARD gate: an invalid patch never reaches the substrate. This
            // is the enforcement the sidecar cannot patch its way around.
            let stats = code_patch::validate_code_patch(&patch)
                .map_err(|reason| format!("rsi_commit_code_patch: policy violation: {reason}"))?;
            ensure_initialized(state)?;
            let commit_hash = tokio::task::spawn_blocking(move || {
                commit_genome_inner(genome_id, genome_json, Vec::new(), metadata, candidate_branch)
            })
            .await
            .map_err(|e| format!("rsi_commit_code_patch: task panicked: {e}"))??;
            Ok(json!({ "commitHash": commit_hash, "changed_lines": stats.changed_lines }))
        }
        // Embeddings for Fractal Memory Search. Not RSI per se, but it rides
        // the same sidecar↔Rust bridge: the TS `embed.ts` module calls this to
        // turn query/leaf text into vectors via the dedicated embedding model.
        // CPU-bound, so it runs on a blocking thread off the async runtime.
        "embed_text" => {
            // Bounded. Nothing limited how many texts, or how large each one
            // was, so a single request could ask this process to hold hundreds
            // of megabytes of input and then produce a vector for every piece
            // of it — the sidecar is a separate process, and a loop with a bad
            // batch size on that side takes the host down with it.
            const MAX_EMBED_TEXTS: usize = 512;
            const MAX_EMBED_BYTES_PER_TEXT: usize = 32 * 1024;
            const MAX_EMBED_TOTAL_BYTES: usize = 1024 * 1024;

            let arr = params
                .get("texts")
                .and_then(|v| v.as_array())
                .ok_or_else(|| "embed_text: missing or non-array 'texts'".to_string())?;
            if arr.len() > MAX_EMBED_TEXTS {
                return Err(format!(
                    "embed_text: {} texts in one request (max {})",
                    arr.len(),
                    MAX_EMBED_TEXTS
                ));
            }
            let mut texts: Vec<String> = Vec::with_capacity(arr.len());
            let mut total = 0usize;
            for value in arr {
                let Some(text) = value.as_str() else {
                    return Err("embed_text: every entry in 'texts' must be a string".to_string());
                };
                if text.len() > MAX_EMBED_BYTES_PER_TEXT {
                    return Err(format!(
                        "embed_text: one text is {} bytes (max {})",
                        text.len(),
                        MAX_EMBED_BYTES_PER_TEXT
                    ));
                }
                total += text.len();
                if total > MAX_EMBED_TOTAL_BYTES {
                    return Err(format!(
                        "embed_text: request exceeds {} bytes of text in total",
                        MAX_EMBED_TOTAL_BYTES
                    ));
                }
                texts.push(text.to_string());
            }
            let vectors = tokio::task::spawn_blocking(move || crate::inference::embed_text(texts))
                .await
                .map_err(|e| format!("embed_text: task panicked: {e}"))?
                .map_err(|e| format!("embed_text: {e}"))?;
            Ok(json!(vectors))
        }
        other => Err(format!("rsi_request: unknown method '{other}'")),
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal RuntimeState sufficient to exercise the
    /// dispatcher. We only touch the rsi_state field — the
    /// dispatcher doesn't read any other RuntimeState field, and
    /// the rest of the struct (manager, settings, …) isn't
    /// relevant to protocol-(a) routing. Default-initialised
    /// wherever possible.
    fn fake_state() -> RuntimeState {
        use std::sync::Arc as StdArc;
        use parking_lot::Mutex as PlMutex;
        RuntimeState {
            rsi_state: crate::rsi::RsiState {
                initialized: StdArc::new(PlMutex::new(true)),
                bounds: StdArc::new(PlMutex::new(None)),
                bounds_file_sha256: StdArc::new(PlMutex::new(None)),
            },
            rsi_goodhart: GoodhartSlot::default(),
            rsi_engine: StdArc::new(PlMutex::new(None)),
            rsi_request_registry: RsiRequestRegistry::default(),
            manager: StdArc::new(crate::inference::ModelManager::new()),
            settings: crate::settings::Settings::default(),
            feral_agent_process: StdArc::new(PlMutex::new(None)),
            feral_agent_tx: StdArc::new(PlMutex::new(None)),
            local_api_token: StdArc::from("test-token-not-used"),
            feral_agent_planned_exit: StdArc::new(PlMutex::new(None)),
            events_tx: tokio::sync::broadcast::channel(16).0,
            active_agent_model: StdArc::new(PlMutex::new(None)),
            shutdown: StdArc::new(tokio::sync::Notify::new()),
            // Sprint 2 / audit C-5 — in-flight model-download map. Tests
            // start empty; `runtime_models_install` populates it on the
            // real path and the GET handler reads it. Field added to
            // `RuntimeState` along with `install_model`; this fixture
            // closure grew one line at a time and was lagging the struct.
            model_downloads: StdArc::new(PlMutex::new(std::collections::HashMap::new())),
        }
    }

    fn run_dispatch(method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        // The dispatcher is async (so it can be wired to async ops
        // later); for now it doesn't actually await anything, so we
        // can use futures::executor::block_on without dragging in a
        // full tokio runtime here.
        let state = fake_state();
        futures::executor::block_on(dispatch_rsi_request(&state, method, params))
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
    fn dispatch_rsi_validate_code_patch_soft_verdicts() {
        // Policy-clean patch → ok:true with stats.
        let good = "--- a/src/rsi/mutation.ts\n+++ b/src/rsi/mutation.ts\n@@ -1 +1 @@\n-a\n+b\n";
        let v = run_dispatch("rsi_validate_code_patch", serde_json::json!({ "patch": good }))
            .expect("dispatch must succeed");
        assert_eq!(v.get("ok").and_then(|x| x.as_bool()), Some(true));
        assert_eq!(v.get("changed_lines").and_then(|x| x.as_u64()), Some(2));
        // Violation → ok:false soft verdict, NOT a bridge error.
        let bad = good.replace("src/rsi/mutation.ts", "src/agent-loop.ts");
        let v = run_dispatch("rsi_validate_code_patch", serde_json::json!({ "patch": bad }))
            .expect("soft verdict, not an error");
        assert_eq!(v.get("ok").and_then(|x| x.as_bool()), Some(false));
        assert!(v.get("reason").and_then(|x| x.as_str()).unwrap().contains("outside"));
    }

    #[test]
    fn dispatch_rsi_score_code_patch_returns_composite() {
        let v = run_dispatch(
            "rsi_score_code_patch",
            serde_json::json!({ "measurements": {
                "tests_passed": 10, "tests_failed": 0, "tests_exit_code": 0,
                "tsc_exit_code": 0, "build_exit_code": 0, "changed_lines": 200
            }}),
        )
        .expect("score must succeed");
        // 60 + 15 + 15 + 0 (diff economy exhausted at the cap) = 90
        let score = v.get("score").and_then(|x| x.as_f64()).unwrap();
        assert!((score - 90.0).abs() < 1e-9, "got {score}");
    }

    #[test]
    fn dispatch_rsi_commit_code_patch_hard_rejects_policy_violations() {
        // A denylisted target must never reach the substrate — hard error,
        // before any repo/init requirement can even apply.
        let bad = "--- a/src/rsi/code-genome.ts\n+++ b/src/rsi/code-genome.ts\n@@ -1 +1 @@\n-a\n+b\n";
        let err = run_dispatch(
            "rsi_commit_code_patch",
            serde_json::json!({
                "genome_id": "g1", "patch": bad, "genome_json": "{}",
                "candidate_branch": "genome-g1",
                "metadata": { "score": 1.0, "strategy": "code", "parent_lineage": [],
                              "mutation_type": "code_patch", "cost_tokens": 0, "duration_ms": 0 }
            }),
        )
        .unwrap_err();
        assert!(err.contains("policy violation"), "got: {err}");
        assert!(err.contains("enforcement"), "got: {err}");
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
}
