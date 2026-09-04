//! The eval-gate scorer. Pure function over `EvalOutcome` batches.
//!
//! **Why this lives in Rust, not in the sidecar**: the entire safety
//! story for Bounded-RSI is that the agent cannot edit the formula
//! that decides whether it improved. If the scorer were TypeScript,
//! the agent could rewrite the formula at runtime (it has write
//! access to its own skill files, and the inference router is the
//! only thing it can't bypass). In Rust, the scorer is compiled into
#![allow(dead_code)]
// `score_single` is a convenience wrapper the UI will use to show
// per-task scores next to the composite. The full-suite scoring path
// (`score`) is what the engine actually drives today. Allow keeps
// the build clean until the UI wires the per-task view.
//! the binary the agent never has filesystem access to. The agent
//! can ship better eval *outcomes*; it cannot redefine what "better"
//! means.
//!
//! Formula (from the spec):
//!     score = w1·success_rate − w2·token_cost − w3·error_rate − w4·latency
//!
//! **Range: 0..w_success, NOT 0..100.** The weights default to 55/15/20/10 and
//! they sum to 100, which is where the "normalised to 0..100" claim came from —
//! but only `w_success` ever ADDS; the other three are penalties subtracted
//! from it. A flawless genome (success 1.0, zero cost, zero errors, zero
//! latency) therefore scores 55, and reading that as 55-out-of-100 makes
//! perfect look mediocre.
//!
//! The scale is deliberately left alone rather than rescaled: every champion
//! record ever written stores a score on this scale, and changing it would make
//! the current champion look like a regression against its own history. The
//! ordering — which is all the ratchet uses — has always been correct. Anything
//! that DISPLAYS a score must show it against `w_success`, not against 100.
//!
//! A retune is allowed (SandboxBounds change), but every retune is recorded in
//! the audit chain.

use serde::{Deserialize, Serialize};

use crate::rsi::EvalOutcome;

use super::{ScoreBreakdown, ScorerRaw, ScorerWeights};

/// Score a batch of eval outcomes. Returns the composite + a breakdown
/// of every component. Pure function — no IO, no global state, no
/// mutation. The same input always produces the same output.
pub fn score(outcomes: &[EvalOutcome], weights: &ScorerWeights) -> ScoreBreakdown {
    if outcomes.is_empty() {
        return ScoreBreakdown {
            score: 0.0,
            success_component: 0.0,
            cost_component: 0.0,
            error_component: 0.0,
            latency_component: 0.0,
            raw: ScorerRaw {
                success_rate: 0.0,
                cost_normalized: 0.0,
                error_rate: 0.0,
                latency_normalized: 0.0,
            },
        };
    }

    let raw = compute_raw(outcomes);
    let success_component = weights.w_success * raw.success_rate;
    let cost_component = -weights.w_cost * raw.cost_normalized;
    let error_component = -weights.w_error * raw.error_rate;
    let latency_component = -weights.w_latency * raw.latency_normalized;

    // Clamped at the top by `w_success`, which is the real maximum — clamping
    // at 100 implied a headroom that no input can reach.
    let score = (success_component + cost_component + error_component + latency_component)
        .clamp(0.0, weights.w_success);

    ScoreBreakdown {
        score,
        success_component,
        cost_component,
        error_component,
        latency_component,
        raw,
    }
}

/// Score a single eval outcome. Convenience wrapper — scoring a single
/// task isn't very useful (the ratchet compares genomes across full
/// suites), but the agent sometimes wants a per-task score for
/// debugging and the UI displays it next to the composite.
pub fn score_single(outcome: &EvalOutcome, weights: &ScorerWeights) -> ScoreBreakdown {
    score(std::slice::from_ref(outcome), weights)
}

/// Compute the raw normalised components. Pulled out as its own
/// function so the tests can assert on the building blocks without
/// depending on the weights.
fn compute_raw(outcomes: &[EvalOutcome]) -> ScorerRaw {
    let n = outcomes.len() as f64;
    let successes = outcomes.iter().filter(|o| o.success).count() as f64;
    let errors = outcomes.iter().filter(|o| o.errored).count() as f64;
    let total_tokens: u64 = outcomes.iter().map(|o| o.tokens as u64).sum();

    // Latency as p95-ish — we approximate by taking the max of the
    // top-5% sorted ascending. Cheap, no third-party stats crate, and
    // the difference from true p95 is within rounding for our batch
    // sizes. The agent's use case (small batch eval) tolerates this.
    let mut latencies: Vec<f64> = outcomes.iter().map(|o| o.latency_ms as f64).collect();
    latencies.sort_by(|a, b| a.total_cmp(b));
    let p95_idx = ((latencies.len() as f64) * 0.95).floor() as usize;
    let p95 = latencies
        .get(p95_idx.min(latencies.len().saturating_sub(1)))
        .copied()
        .unwrap_or(0.0);

    // Cost normalisation: tokens / batch_size → avg tokens per task,
    // then divided by a soft budget (4_000 tok/task) and clamped to
    // 0..1. The 4k figure is the same order of magnitude as a Tier 0
    // sanity check response; tune via `ScorerWeights` if you want a
    // tighter or looser cost curve.
    let avg_tokens = total_tokens as f64 / n;
    let mut cost_normalized = (avg_tokens / 4_000.0).clamp(0.0, 1.0);

    // A batch where NOTHING cost anything and NOTHING took any time did not
    // happen. Inference spends tokens and takes milliseconds; a run reporting
    // zero of both across every task is either a broken measurement pipeline or
    // a fabricated one — and both deserve the same answer, because the shape
    // that reaches this function is identical.
    //
    // It matters because zeroes are the ideal input: no cost penalty, no
    // latency penalty, so a made-up batch of successes scores the maximum this
    // formula can produce and wins the ratchet against every honestly-measured
    // champion. Charging full cost and full latency makes the fabrication the
    // WORST thing to submit rather than the best.
    let nothing_measured = !outcomes.is_empty()
        && outcomes.iter().all(|o| o.tokens == 0 && o.latency_ms == 0);
    let mut latency_normalized = (p95 / 2_000.0).clamp(0.0, 1.0);
    if nothing_measured {
        tracing::warn!(
            tasks = outcomes.len(),
            "eval batch reports zero tokens and zero latency for every task — treating it as unmeasured"
        );
        cost_normalized = 1.0;
        latency_normalized = 1.0;
    }

    ScorerRaw {
        success_rate: successes / n,
        cost_normalized,
        error_rate: errors / n,
        latency_normalized,
    }
}

/// Convenience: default weights. Always use the constructor on
/// `ScorerWeights::default()` — this is just here so the tests don't
/// have to spell it out every time.
#[allow(dead_code)]
pub fn default_weights() -> ScorerWeights {
    ScorerWeights::default()
}

/// Snapshot of the scorer formula for audit purposes. The hash of this
/// struct is what `SandboxBounds::scorer_hash` records — when the
/// formula changes (e.g. we add a 5th weight), the hash changes and
/// the audit log records the transition.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ScorerFormula {
    pub weights: ScorerWeights,
    pub token_soft_budget: f64,
    pub latency_soft_budget_ms: f64,
    pub latency_pctile: f64,
}

impl Default for ScorerFormula {
    fn default() -> Self {
        Self {
            weights: ScorerWeights::default(),
            token_soft_budget: 4_000.0,
            latency_soft_budget_ms: 2_000.0,
            latency_pctile: 0.95,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(success: bool, tokens: u32, latency_ms: u32, errored: bool) -> EvalOutcome {
        EvalOutcome {
            task_id: "t".into(),
            tier: 0,
            success,
            latency_ms,
            tokens,
            errored,
            error_message: None,
        }
    }

    #[test]
    fn empty_batch_scores_zero() {
        let b = score(&[], &ScorerWeights::default());
        assert_eq!(b.score, 0.0);
    }

    #[test]
    fn all_success_no_errors_full_score() {
        let outs = vec![mk(true, 1000, 500, false); 5];
        let b = score(&outs, &ScorerWeights::default());
        // success = 1.0 → 55; cost = 1000/4000 = 0.25 → -3.75;
        // error = 0; latency = 500/2000 = 0.25 → -2.5
        // = 55 - 3.75 - 0 - 2.5 = 48.75
        assert!((b.score - 48.75).abs() < 0.001, "got {}", b.score);
    }

    #[test]
    fn all_failure_with_errors_zero_or_low_score() {
        let outs = vec![mk(false, 4000, 2000, true); 5];
        let b = score(&outs, &ScorerWeights::default());
        // success = 0; cost = 4000/4000 = 1.0 → -15; error = 1.0 → -20;
        // latency = 2000/2000 = 1.0 → -10
        // = 0 - 15 - 20 - 10 = -45 → clamped to 0
        assert_eq!(b.score, 0.0);
    }

    #[test]
    fn pure_score_does_not_panic_on_zero_weights() {
        let zero = ScorerWeights {
            w_success: 0.0,
            w_cost: 0.0,
            w_error: 0.0,
            w_latency: 0.0,
        };
        let b = score(&[mk(true, 0, 0, false)], &zero);
        assert_eq!(b.score, 0.0);
    }

    #[test]
    fn a_batch_that_measured_nothing_does_not_score_like_a_perfect_one() {
        // All successes, no tokens, no time — the shape a fabricated batch has,
        // and previously the highest-scoring input this formula accepted.
        let w = ScorerWeights::default();
        let fabricated = score(&vec![mk(true, 0, 0, false); 5], &w);
        let honest = score(&vec![mk(true, 800, 400, false); 5], &w);
        assert!(
            fabricated.score < honest.score,
            "a batch reporting zero cost and zero latency must not beat a measured one              (fabricated={}, honest={})",
            fabricated.score,
            honest.score
        );
    }

    #[test]
    fn score_is_deterministic() {
        let outs = vec![mk(true, 100, 50, false), mk(false, 200, 100, true)];
        let w = ScorerWeights::default();
        let a = score(&outs, &w);
        let b = score(&outs, &w);
        assert_eq!(a.score, b.score);
    }
}
