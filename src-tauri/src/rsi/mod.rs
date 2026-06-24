//! RSI (Recursive Self-Improvement) — Bounded-RSI Boundary Module.
//!
//! **NON-NEGOTIABLE INVARIANT**: every write to the RSI substrate
//! (`~/.feral/rsi/`, the git repo, the eval suite, the SandboxBounds file,
//! the scorer code) MUST go through a Tauri command exposed here. The
//! TypeScript sidecar and the LLM agent have NO direct filesystem path to
//! any of these locations. The scorer, the eval paths, and the
//! SandboxBounds live in Rust, are constants or read-only-from-Rust's-side
//! code, and the audit log of every bound mutation is itself
//! hash-chained. This is the only thing that keeps the agent from
//! "improving" itself by editing its own evaluation.
//!
//! Submodule split (kept narrow so each file is auditable on its own):
//! - `paths`    : canonical paths + containment checks (no traversal)
//! - `types`    : DB table shapes that match the sidecar SQLite schema
#![allow(dead_code)]
// `rsi_root` is a scaffolded helper that the Faza 3.5 (PBT) and
// Faza 4 (Mandelbrot) commands will consume. The allow keeps the
// build output clean until those phases wire it up.
//! - `scorer`   : pure scoring function — the formula the agent cannot edit
//! - `tier0`    : the 10 frozen Tier 0 sanity checks
//! - `goodhart` : Tier 1 vs Tier 2 divergence detector
//! - `sandbox_bounds` : the read-only-for-agent contract
//! - `audit`    : hash-chained audit log for bound mutations
//! - `plan`     : embedded PLAN.md (the versioned architectural plan)
//! - `repo`     : git2 wrapper for the RSI git substrate
//! - `commands` : the Tauri commands the sidecar calls

pub mod audit;
pub mod commands;
pub mod goodhart;
pub mod paths;
pub mod persistence;
pub mod plan;
pub mod repo;
pub mod sandbox_bounds;
pub mod scorer;
pub mod tier0;
pub mod types;

#[cfg(test)]
pub(crate) mod test_support;

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Runtime state held in Tauri's `AppState`. Currently just the cached
/// SandboxBounds + the head of its audit chain — kept here so any Tauri
/// command can answer "are these bounds still the ones the user signed off
/// on?" without re-reading + re-hashing the file on every call.
pub struct RsiState {
    /// Current SandboxBounds, loaded at startup + after every successful
    /// `update_bounds` call. `None` until the first `rsi_init` succeeds.
    pub bounds: Arc<Mutex<Option<sandbox_bounds::SandboxBounds>>>,
    /// SHA-256 of the on-disk SandboxBounds JSON right after the last load.
    /// Used to detect external tampering on the bounds file between
    /// command invocations (the audit log is the authoritative record of
    /// Rust-side mutations; this hash catches out-of-band edits).
    pub bounds_file_sha256: Arc<Mutex<Option<String>>>,
    /// Whether `rsi_init` has completed in this sidecar session. The
    /// Goodhart detector and the genome commit path both refuse to run
    /// until init succeeds — without the substrate there is nothing to
    /// protect.
    pub initialized: Arc<Mutex<bool>>,
    /// Last successfully-loaded engine state, if any. Populated by
    /// `do_load_engine_state` (called from `rsi_init` and from
    /// `rsi_load_engine_state` on demand) so other commands can answer
    /// "what iteration are we on?" without re-reading the file. The
    /// on-disk canonical lives at `<dataDir>/rsi/engine-state.json`;
    /// this field is a cache, not a separate source of truth.
    pub engine_persisted: Arc<Mutex<Option<persistence::PersistedEngineState>>>,
}

impl Default for RsiState {
    fn default() -> Self {
        Self {
            bounds: Arc::new(Mutex::new(None)),
            bounds_file_sha256: Arc::new(Mutex::new(None)),
            initialized: Arc::new(Mutex::new(false)),
            engine_persisted: Arc::new(Mutex::new(None)),
        }
    }
}

/// Outcome reported by the sidecar after running one eval task. This is
/// the input to the scorer; the scorer is a pure function over this
/// struct, so the agent cannot influence the formula by shaping the input
/// — only by improving the actual outcomes.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EvalOutcome {
    /// Stable identifier of the task that was evaluated (e.g. "tier0/format_json").
    pub task_id: String,
    /// Which tier this task belongs to.
    pub tier: u8,
    /// Whether the agent's response satisfied the task's expected output.
    /// True means success on the binary pass/fail check; latency and cost
    /// are tracked separately below.
    pub success: bool,
    /// Wall-clock duration of the task, including any tool calls. Used by
    /// the scorer to penalize slow wins.
    pub latency_ms: u32,
    /// Tokens consumed by this task (prompt + completion). The agent can
    /// drive this down via shorter prompts; it cannot fake it because
    /// the InferenceRouter is the only thing that knows the real number.
    pub tokens: u32,
    /// Whether the task errored out (timeout, OOM, tool failure, parse
    /// failure). Counted separately from `success` because a successful
    /// retry still costs resources.
    pub errored: bool,
    /// Free-form error message for logging; not used in scoring.
    pub error_message: Option<String>,
}

/// Returned by the scorer. The breakdown is exposed so the UI can
/// visualise WHY a genome scored what it scored (and the Goodhart
/// detector can compare Tier 1 vs Tier 2 deltas).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ScoreBreakdown {
    /// Composite score 0..100, the canonical eval-gate score.
    pub score: f64,
    /// success_rate component contribution (0..w1). 0..=w1 by construction.
    pub success_component: f64,
    /// token_cost component contribution (-w2..0). Higher cost = lower.
    pub cost_component: f64,
    /// error_rate component contribution (-w3..0). Higher error rate = lower.
    pub error_component: f64,
    /// latency component contribution (-w4..0). Higher latency = lower.
    pub latency_component: f64,
    /// Raw normalized values fed into the formula, exposed for debug
    /// rendering in the UI (hover breakdown, not used by the ratchet).
    pub raw: ScorerRaw,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ScorerRaw {
    /// Fraction of tasks that succeeded (0..1).
    pub success_rate: f64,
    /// Tokens consumed, normalized to a 0..1 cost score by the budget.
    pub cost_normalized: f64,
    /// Fraction of tasks that errored (0..1).
    pub error_rate: f64,
    /// Latency p95 normalized to a 0..1 score (lower is better).
    pub latency_normalized: f64,
}

/// Weights for the composite score. Centralised here so the spec's
/// `w1·success_rate − w2·token_cost − w3·error_rate − w4·latency` is
/// reproducible from one place. Defaults match the spec but a `Bounds`
/// update may retune them — every retune is logged in the audit chain.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ScorerWeights {
    pub w_success: f64,
    pub w_cost: f64,
    pub w_error: f64,
    pub w_latency: f64,
}

impl Default for ScorerWeights {
    fn default() -> Self {
        // Locked defaults from the plan. The four components sum to 100
        // so the composite lives in 0..100 with the weights as their
        // direct percentage contributions.
        Self {
            w_success: 55.0,
            w_cost: 15.0,
            w_error: 20.0,
            w_latency: 10.0,
        }
    }
}

/// Helper used by the bootstrap path: returns the canonical RSI dir for
/// the current user. Exposed at module level so the commands don't need
/// to depend on the private `paths` module directly.
pub fn rsi_root() -> PathBuf {
    crate::paths::rsi_dir()
}
