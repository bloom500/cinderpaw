//! The versioned architectural plan, embedded as a Rust string and
//! written into `~/.feral/rsi/PLAN.md` at bootstrap. The plan is also
//! committed to the RSI git repo as the initial commit, so every
//! future commit has a diff-able ancestor.
//!
//! **Why embed it instead of reading from disk**: the plan is the
//! source of truth for what the system is *supposed* to be. If the
//! plan lived in a file the agent could (eventually, with enough
//! capability creep) influence. Embedding it as a Rust `&'static str`
//! puts it on the same footing as the scorer code: the only way to
//! change it is a code edit, which the agent cannot do.

/// The locked architectural plan. Mirrors the spec delivered by
/// Opus. Kept here as a single `&'static str` so the `bootstrap`
/// path can write it to `~/.feral/rsi/PLAN.md` and commit it without
/// loading anything from disk.
///
/// **DO NOT EDIT without a corresponding spec amendment.** The plan
/// is the audit trail for "why does the system work the way it does";
/// every divergence between this file and a live Cinderpaw build should
/// be intentional and reviewed.
pub const PLAN_MD: &str = r#"# Cinderpaw RSI — Fractal Memory System with Recursive Self-Improvement

## Scope

Config-RSI, not code-RSI. The RSI optimises the *configuration* of
an agent (prompts, skills, retrieval, inference params). It does not
edit the Rust or TypeScript engines. The agent cannot reach its own
metric, eval suite, scorer, budgets, or sandbox — by construction.

## Genome (the unit of evolution)

A configuration candidate:

| field                      | type     | notes                                           |
|----------------------------|----------|-------------------------------------------------|
| prompt_template_id         | string   | which SOUL/preset template to load              |
| temperature                | float    | sampled in [0, 2]                                |
| system_prompt_hash         | string   | identifies the active system prompt             |
| retrieval_strategy         | string   | enum: episodic | semantic | graph | hybrid       |
| context_window_usage       | float    | fraction of available context used              |
| tool_preference_weights    | map      | per-tool preference, sum normalises to 1        |
| decomposition_depth        | uint     | 0..3, how many sub-tasks to spawn               |

## Metric — Eval-Gate Score

```
score = w1·success_rate − w2·token_cost − w3·error_rate − w4·latency
```

Normalised 0..100. Same shape as the existing `fitScore`. The
scorer, the eval suite, the weights, and the budget all live in
Rust (`src-tauri/src/rsi/`). The agent never has filesystem access
to the scorer code; the only way to change the formula is a
code review.

## Git substrate

```
~/.feral/rsi/   ← libgit2 via the git2 crate, vendored
├── PLAN.md              ← read-only for agent, this file
├── eval/
│   ├── tier0/           ← frozen permanent
│   ├── tier1/           ← frozen per epoch
│   └── tier2/           ← human-gated, empty initially
├── genomes/             ← per-commit JSON snapshot
├── meta/
│   └── pbt_state.json   ← strategy-genomes + taste_vector
└── .git/
```

- Every iteration = one commit; metadata in the commit message
  `{score, strategy, parent_lineage, mutation_type, cost_tokens, duration_ms}`
- `main` = the ratchet; advances ONLY when score > prior best
- Branches = live candidates
- Tags `score/v{n}-{score}` = reference points
- `git diff` between generations = source of learning
- All local. Zero external accounts. Zero internet for this component.

## Scored Memory Pool

A population with: id, fitness_score, behavioral_fingerprint
(Vec<f32> per-task score), shared_fitness (fitness sharing applied),
generation, lineage (parent ids), alive, commit_hash, explanation.

**Fitness sharing**: penalise genomes in the same behavioural niche.
`shared_fitness = fitness_score / niche_count`, where niche_count =
genomes with cosine_similarity > threshold on the
behavioral_fingerprint.

## Fractal Search

The search space is an N-dimensional bounded region over the genome
fields. The algorithm:

- **Level 0 Coarse**: large mutations, many dimensions, uniform
  exploration
- **Escape-time** = how many iterations a lineage survives before
  plateau
- Long escape-time regions get **zoom-in** (fine mutations, more
  samples)
- Short escape-time regions get **pruned**
- **5% wild explorers**: ignore zoom policy, fully random
- The output: concentrate compute on promising regions, not
  uniformly across the whole space

## Ratchet

`main` advances ONLY when the new score > the prior best on main.
Monotonicity is guaranteed. **Hall of Fame**: genomes immune to
extinction, auto-inducted at best-all-time and at Tier 2
breakthroughs.

## Extinction (anti-monoculture)

Adaptive trigger: monoculture detector (mean cosine similarity of
behavioral fingerprints in the population > 0.85) + persistent
plateau. Kills 80% of live candidates (NOT Hall of Fame, NOT main,
NOT elite). Periodic fallback every 20 generations if the adaptive
trigger hasn't fired.

## NEAT-Speciation Crossover

Candidates for crossover = genomes with recent common ancestor (git
LCA) + divergent behavioral fingerprint. Destructive crossover
(genomes from completely different regions of the space) is avoided.
Git LCA is free from the existing commit DAG.

## Eval Suite — 3 Tiers

- **Tier 0**: sanity checks frozen PERMANENTLY. 10 checks:
  JSON format, 6 fact lookups, JSON structure, token budget,
  latency. Cheap, run first as pre-filter.
- **Tier 1**: golden set frozen per epoch. Task-specific, changed
  by the user at milestones only.
- **Tier 2**: stretch goals human-gated. Added manually by the user;
  the agent cannot suggest what to add.

## Goodhart Detector (active from Faza 0)

After each `EvalComplete`, compares Tier 1 delta to Tier 2 delta.
If Tier 1 increases > 2% AND Tier 2 decreases > 1% for 3
consecutive EvalComplete → set `goodhart_flag = TRUE` in
`rsi_iteration`, log to the hash-chained audit, and emit a
`GoodhartDetected` event. In Faza 0 the handler only logs and
surfaces a UI warning; later phases may extend it to trigger
extinction.

The detector skips samples where Tier 2 data is missing (it has
< 3 data points). This prevents false-positives during the period
when Tier 2 is still empty.

## Async RSI Engine (Faza 1)

Event-driven, not loop-based. No master scheduler. Seven events:

| event              | when                                              |
|--------------------|---------------------------------------------------|
| GenomeBorn         | a new genome was created                          |
| EvalStarted        | an evaluation started                             |
| EvalComplete       | an evaluation finished, score available           |
| RatchetAdvanced    | a genome beat best-all-time, main advanced        |
| GenomeDied         | a genome was culled from the population           |
| ExtinctionTriggered| extinction event started                          |
| PBTSyncTriggered   | ratchet event triggered PBT sync (Faza 3.5)       |

Concurrency starts at 1 and is raised once validated. The ratchet
fires on every `EvalComplete`, not at generation boundaries.
Mutations are triggered by `EvalComplete` and `GenomeDied`.

## Recalcitrance (Faza 1)

Each score improvement costs more than the previous one. This is a
fundamental property of RSI, not an anomaly. Track
`improvement_difficulty = tokens / max(score_delta, ε)` per
iteration. When the 10-event moving average of
improvement_difficulty grows 3× vs the baseline of the first 5
ratchet events, emit `RecalcitranceHigh`. Handler: signal Fractal
Search to zoom out 2 levels and reintroduce 20% wild explorers
(temporary, vs 5% baseline).

## Fractal Search + Taste Layer (Faza 3)

Zoom-adaptive policy + a taste vector mined from the last 20
ratchet-commits. At each `RatchetAdvanced`, M3 reads the diffs
between winning and losing genomes in those 20 commits and writes
a `taste_vector` into `meta/pbt_state.json`. The taste weight
grows with population size and history depth — at small
populations the weight is small (no history yet), at large
populations the weight is large. The `GenomeBorn` handler reads
the taste vector and biases sampling accordingly.

## Passive Operation (amendment 2026-06-19)

The engine is a PASSIVE, always-on background system — the successor to
the old simple self-improvement loop. It is NOT user-triggered:

- The sidecar autostarts the engine on boot when a real model is
  present (placeholder/empty model → skip, to avoid learning from empty
  responses). Kill switch: `CINDERPAW_RSI_PASSIVE=false`.
- There is no user-typed goal. The standing objective is fixed:
  improve the agent's own general-purpose configuration against the
  frozen eval suite (quality + reliability up, cost + latency down).
- The run is continuous: effectively-unbounded iteration/token budget,
  bounded only by a low concurrency cap. When a run ends (plateau /
  convergence / iteration cap) the supervisor restarts it.
- The ONLY user-facing surface is the read-only Mandelbrot view
  (below). No control panel, no goal/budget form, no Start/Stop — a
  non-technical user gets an evolving agent without touching configs or
  code. The lifecycle brain is `passive-supervisor.ts` (sidecar).

## Mandelbrot Visualization (Faza 4)

The sole user-facing surface (see Passive Operation above): a read-only
window onto the background engine, not a control panel.

WebGL2 canvas with fragment shader for the Mandelbrot background.
Smooth zoom via uniform variables. PCA on the population's
behavioral fingerprints projects to 2D complex-plane coordinates.
Colour: brightness = fitness, hue/saturation = behavioral
fingerprint dimensions 0/1. Escape-time drives point size / glow.
Lineage trails connect parents → children with falling opacity.
Ratchet frontier = visible contour separating genomes under best-
all-time. Extinction pulse = radial animation on each extinction
event. Hover: tooltip with explanation + score + generation +
mutation type. Real-time updates over `rsi_population_update`
Tauri events.

## Meta-RSI via PBT (Faza 3.5 — Opus)

Second recursive layer; optimises HOW Level 1 searches.
Strategy-genomes control hyperparams (mutation_rate, pop_size,
zoom_policy, selection_pressure). Runs concurrently with the
Level-1 population. Sync on `RatchetAdvanced`, not on wall-clock.
Bottom 20% of strategy-genomes copy hyperparams from top
performers + perturbation. Meta-genomes are bounded — they cannot
touch the metric, eval suite, or sandbox.

## LLM Adapter — Tier System (Faza 5)

- **BYOK Tier 1** (default): M3 via OpenRouter / OpenAI-compatible,
  base URL in the existing `InferenceRouter`. ~$0.30 / $1.20 per
  1M tokens.
- **BYOK Tier 2** (power / debug): Opus or GPT-5.5. Called
  automatically only when M3 is not making progress or at
  anomalies.
- **Local Tier**: 12-14B+ via llama.cpp sidecar. Full M3
  capability, privacy-first.
- **Sub-12B fallback**: parametric + grammar-constrained mutations
  only, no LLM-driven mutations. Reduced breadth, slower, but
  functional.

Role-based routing in `InferenceRouter`:

| task                                   | preferred model |
|----------------------------------------|-----------------|
| eval runner + behavioral fingerprint   | M3              |
| LLM-driven mutations                   | M3              |
| git diff analysis + pattern learning   | M3              |
| post-hoc explanation generation        | M3              |
| plateau narration                      | M3              |
| architectural design + anomaly debug   | Opus (rare)     |

## DB Schema

```sql
rsi_genome (
  id TEXT PK,
  commit_hash TEXT NOT NULL,
  parent_ids JSON,
  strategy_dna JSON NOT NULL,
  fitness_score REAL,
  behavioral_fp BLOB,
  shared_fitness REAL,
  generation INTEGER NOT NULL,
  alive BOOL DEFAULT TRUE,
  explanation TEXT,
  created_at DATETIME
);

rsi_iteration (
  id TEXT PK,
  genome_id TEXT → rsi_genome,
  eval_results JSON,
  token_cost INTEGER,
  duration_ms INTEGER,
  ratchet_event BOOL DEFAULT FALSE,
  pbt_sync BOOL DEFAULT FALSE,
  goodhart_flag BOOL DEFAULT FALSE,
  noise_k INTEGER DEFAULT 2,
  improvement_difficulty REAL,  -- Faza 1, null when no improvement
  created_at DATETIME
);

rsi_lineage (
  child_id  TEXT → rsi_genome,
  parent_id TEXT → rsi_genome,
  crossover_type TEXT (mutation|crossover|parametric|wild),
  lca_commit TEXT,
  PRIMARY KEY (child_id, parent_id)
);

rsi_hall_of_fame (
  genome_id TEXT → rsi_genome,
  inducted_at DATETIME,
  reason TEXT (all_time_best|tier2_breakthrough|manual)
);

rsi_strategy_genome (
  id TEXT PK,
  hyperparams JSON (mutation_rate, pop_size, zoom_policy, selection_pressure),
  ratchet_count INTEGER DEFAULT 0,
  active BOOL DEFAULT TRUE,
  last_sync_at DATETIME
);
```

## Bounded-RSI Boundary (Rust)

The non-negotiable invariant. Lives in `src-tauri/src/rsi/`:

- `paths.rs`  : canonical paths + containment checks
- `types.rs`  : DB table shapes (wire format with sidecar)
- `scorer.rs` : pure scoring function, default weights 55/15/20/10
- `tier0.rs`  : 10 frozen sanity checks
- `goodhart.rs` : rolling-window Tier 1 / Tier 2 divergence detector
- `sandbox_bounds.rs` : the agent-immutable contract
- `audit.rs`  : hash-chained audit log for every bound mutation
- `repo.rs`   : git2 wrapper (libgit2, vendored)
- `plan.rs`   : this file, embedded
- `commands.rs`: Tauri commands exposed to the sidecar

`SandboxBounds` mutations go through `save_with_audit`, which
appends a row to `sandbox_bounds_audit.log` (sha256 chain,
starts at GENESIS). Every load re-verifies the chain first.

## Phase Map

| Phase | Title                              | Owner |
|-------|------------------------------------|-------|
| 0     | Keystone (Rust boundary + PLAN)    | M3    |
| 1     | Async RSI Engine                   | M3    |
| 2     | Lineage Crossover + Extinction     | M3    |
| 3     | Fractal Search + Taste Layer       | M3    |
| 3.5   | Meta-RSI via PBT                   | Opus  |
| 4     | Mandelbrot Visualization           | M3    |
| 4.5   | Eval Progression + Explainability  | M3    |
| 5     | Hardening                          | M3    |
| 6     | Public Benchmark                   | Opus  |
"#;

/// SHA-256 of `PLAN_MD`, lowercase hex. Computed at compile time so
/// the bootstrap path can detect (and refuse to overwrite) an
/// externally-edited PLAN.md on disk.
#[allow(dead_code)]
pub fn plan_sha256() -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(PLAN_MD.as_bytes());
    format!("{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_md_is_not_empty() {
        assert!(PLAN_MD.len() > 1000);
        assert!(PLAN_MD.contains("Bounded-RSI Boundary"));
        assert!(PLAN_MD.contains("Goodhart"));
        assert!(PLAN_MD.contains("Async RSI Engine"));
    }

    #[test]
    fn plan_sha256_is_stable() {
        assert_eq!(plan_sha256(), plan_sha256());
    }
}
