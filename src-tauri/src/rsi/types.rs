//! Type shapes that mirror the sidecar SQLite schema for the 5 RSI
//! tables. Defined in Rust so the IPC payload from a Tauri command is
//! type-checked on both sides, and so the schema is greppable from one
//! place. The sidecar stores these as rows; Rust reads/writes them via
//! the sidecar's exposed helpers — but the Rust side still gets to
#![allow(dead_code)]
// These structs (RsiGenome, RsiIteration, RsiLineageEdge,
// RsiHallOfFameEntry, RsiStrategyGenome) are the IPC return shapes
// for Tauri commands that the Faza 3.5 (PBT) and Faza 4 (Mandelbrot)
// phases will expose. They're greppable here today so the schema
// stays in one place; the allow keeps the build clean until those
// phases wire the queries.
//! validate the shape before any scoring or ratchet logic runs.
//!
//! The DB lives in the sidecar (bun:sqlite). Rust never opens the DB
//! directly — these structs are the wire format for Tauri commands, not
//! row constructors. This is intentional: the Rust crate has no SQLite
//! dependency, and that isolation is part of the safety argument (a
//! bug here cannot silently rewrite the DB without going through the
//! typed command surface).
//!
//! Behavioral fingerprints are serialised as a packed `Vec<f32>` blob
//! by the sidecar; here we keep them as `Vec<f32>` and rely on the
//! boundary at the sidecar to do the packing. The shape is what matters
//! for type checking, not the on-disk layout.

use serde::{Deserialize, Serialize};

/// `rsi_genome` row. The DNA of an agent configuration — the unit of
/// evolution. The `strategy_dna` is the JSON payload that gets hashed
/// and diffed across generations; the other fields are bookkeeping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RsiGenome {
    pub id: String,
    pub commit_hash: String,
    /// May be empty for the first (genesis) genome; otherwise a JSON
    /// array of parent genome ids.
    pub parent_ids: Vec<String>,
    /// JSON blob describing the configuration: prompt template, temperature,
    /// retrieval strategy, tool weights, decomposition depth, etc. The
    /// shape of this blob is the same across all genomes; only the values
    /// change. The Rust side treats it as opaque — it never inspects
    /// fields, only re-serialises for hashing. Stored as a JSON-encoded
    /// string because `serde_json::Value` does not implement
    /// `specta::Type` and we don't need it over IPC.
    pub strategy_dna: String,
    pub fitness_score: Option<f64>,
    /// Per-task scores from the eval suite. Length matches the number of
    /// tasks in the suite at eval time; the sidecar stores it as a packed
    /// float blob and rehydrates into this Vec on read.
    pub behavioral_fp: Vec<f32>,
    /// Fitness after sharing penalty for niche overlap. `None` until
    /// shared_fitness has been computed for this genome's generation.
    pub shared_fitness: Option<f64>,
    pub generation: u32,
    pub alive: bool,
    pub explanation: Option<String>,
    /// Unix epoch milliseconds — the sidecar's `INTEGER` column.
    pub created_at: i64,
}

/// `rsi_iteration` row. One row per (genome, evaluation pass). The
/// `eval_results` JSON is opaque to Rust — only the Tier 1 and Tier 2
/// aggregate scores are extracted here, and even that extraction happens
/// on the sidecar before the row is sent to Rust for Goodhart analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RsiIteration {
    pub id: String,
    pub genome_id: String,
    /// JSON blob — sidecar's view of the per-task outcomes. Stored as a
    /// JSON-encoded string for the same reason as `RsiGenome.strategy_dna`.
    pub eval_results: String,
    pub token_cost: u32,
    pub duration_ms: u32,
    /// `true` iff this iteration produced a ratchet advance on main.
    pub ratchet_event: bool,
    /// `true` iff this iteration triggered a PBT sync (Faza 3.5).
    pub pbt_sync: bool,
    /// Set by the Goodhart detector (Rust-side, Faza 0).
    pub goodhart_flag: bool,
    /// Number of eval runs aggregated into this iteration's score. ≥ 2
    /// so we have a noise estimate before a genome is allowed onto main.
    pub noise_k: u32,
    /// Faza 1 addition: `tokens / max(score_improvement, ε)`. `None` if
    /// the iteration did not improve over the prior best on main. Surfaced
    /// in the UI as the secondary "cost per improvement" graph; consumed
    /// by the Recalcitrance handler to decide when to zoom Fractal Search
    /// out and reintroduce 20% wild explorers.
    pub improvement_difficulty: Option<f64>,
    pub created_at: i64,
}

/// `rsi_lineage` row. Directed parent → child edge. Composite primary
/// key so the same child can have multiple parents (crossover event).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RsiLineageEdge {
    pub child_id: String,
    pub parent_id: String,
    /// `mutation` | `crossover` | `parametric` | `wild`. Used by the
    /// explanation generator and the taste-vector miner.
    pub crossover_type: String,
    /// The git LCA commit between the two parents (only set when
    /// `crossover_type == "crossover"`; for mutations it's the parent
    /// commit itself).
    pub lca_commit: Option<String>,
}

/// `rsi_hall_of_fame` row. Genomes that are immune to extinction by
/// design. Two automatic induction paths (best-all-time and Tier 2
/// breakthrough) plus one manual entrypoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RsiHallOfFameEntry {
    pub genome_id: String,
    pub inducted_at: i64,
    /// `all_time_best` | `tier2_breakthrough` | `manual`.
    pub reason: String,
}

/// `rsi_strategy_genome` row. A hyperparameter vector that controls
/// HOW the Level-1 search operates. The Meta-RSI layer (Faza 3.5, Opus)
/// mutates these; until then the four seeds from Faza 0 are the only
/// rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RsiStrategyGenome {
    pub id: String,
    /// JSON blob with at minimum: `mutation_rate`, `population_size`,
    /// `zoom_policy`, `selection_pressure`. Shape is intentionally
    /// open — the strategy layer may add fields without a schema
    /// migration, as long as the core four keep their semantics.
    /// Stored as a JSON-encoded string (same reason as
    /// `RsiGenome.strategy_dna`).
    pub hyperparams: String,
    /// How many ratchet events this strategy-genome has been in
    /// charge for. Used by PBT to identify bottom-20% candidates.
    pub ratchet_count: u32,
    pub active: bool,
    pub last_sync_at: Option<i64>,
}

/// Inputs to the Goodhart detector. Sidecar sends these after every
/// `EvalComplete`; Rust maintains a rolling window and emits a flag
/// when the divergence pattern matches.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct GoodhartSample {
    pub iteration_id: String,
    /// Tier 1 score change vs the previous Tier 1 average. Expressed as
    /// a fraction (0.02 = +2%). Signed: positive means Tier 1 improved.
    pub tier1_delta: f64,
    /// Same shape, for Tier 2. May be `None` if the user has not yet
    /// populated Tier 2 — the detector skips samples with `None` rather
    /// than triggering on partial data.
    pub tier2_delta: Option<f64>,
}

/// What the detector returns after consuming one sample. `triggered`
/// flips to true once the divergence pattern is sustained over 3
/// consecutive samples — that's the Goodhart flag the iteration row
/// gets stamped with.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct GoodhartResult {
    pub triggered: bool,
    /// Rolling count of consecutive divergent samples seen so far. The
    /// threshold is 3; we surface the running count so the UI can show
    /// a progress bar.
    pub consecutive_divergent: u32,
    /// Mean Tier 1 / Tier 2 deltas over the current window, surfaced
    /// for debug.
    pub mean_tier1_delta: f64,
    pub mean_tier2_delta: Option<f64>,
}
