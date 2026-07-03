//! Goodhart detector — core safety module.
//!
//! The classical Goodhart pattern: a metric optimised too hard stops
//! measuring what you wanted to measure. For RSI this looks like:
//!
//!   - The agent improves its score on the *easy* eval tier (Tier 1)
//!   - But regresses on the *hard* eval tier (Tier 2) that's supposed
//!     to measure generalisation
//!   - Net: the ratchet advances on Tier 1's improvement, but the
//!     agent is actually narrowing to Tier 1's idiosyncrasies
//!
//! The detector catches this by maintaining a rolling window of the
//! last few `EvalComplete` samples and comparing the Tier 1 / Tier 2
//! deltas. If Tier 1 keeps going up while Tier 2 keeps going down for
//! N consecutive samples, we flag the iteration and surface a warning.
//!
//! **Tier 2 starts empty.** The user populates it in Faza 4.5. Until
//! then every sample has `tier2_delta: None` and the detector skips it.
//! Without this guard the detector would false-positive on the first
//! few samples (Tier 1 baseline is non-zero, Tier 2 baseline is zero,
//! so any Tier 1 improvement looks like divergence).
//!
//! Window size and thresholds come from `SandboxBounds` so the user
//! can retune without code edits. Defaults: 3 consecutive samples,
//! Tier 1 ≥ +2%, Tier 2 ≤ -1%.

use std::collections::VecDeque;

use crate::rsi::types::{GoodhartResult, GoodhartSample};

/// Hard upper bound on the rolling window. The detector never holds
/// more than this many samples; if the window from `SandboxBounds` is
/// ever raised above this, we cap silently. Keeps a future bounds
/// retune from accidentally producing unbounded memory growth.
const MAX_WINDOW: usize = 32;

/// Rolling-window detector state. Owned by `RsiState` in the app
/// process; not persisted across restarts (a fresh window is the
/// right semantic for "did we just diverge?" — the previous session's
/// window is irrelevant).
pub struct GoodhartDetector {
    window: VecDeque<GoodhartSample>,
    window_size: usize,
    tier1_threshold: f64,
    tier2_threshold: f64,
    consecutive_required: u32,
}

impl GoodhartDetector {
    /// Build a detector with the thresholds from the current bounds.
    pub fn new(window_size: u32, tier1_threshold: f64, tier2_threshold: f64, consecutive_required: u32) -> Self {
        let cap = (window_size as usize).clamp(1, MAX_WINDOW);
        Self {
            window: VecDeque::with_capacity(cap),
            window_size: cap,
            tier1_threshold,
            tier2_threshold,
            consecutive_required,
        }
    }

    /// Ingest one sample. Returns the post-ingest result so the caller
    /// can decide whether to stamp the iteration row with
    /// `goodhart_flag = true`.
    pub fn observe(&mut self, sample: GoodhartSample) -> GoodhartResult {
        // Push and trim.
        if self.window.len() >= self.window_size {
            self.window.pop_front();
        }
        self.window.push_back(sample);

        // Mean over the current window — used for the UI. We compute
        // it over the present window even if it's shorter than
        // `consecutive_required` so the progress bar updates smoothly.
        let mut sum_t1 = 0.0;
        let mut sum_t2 = 0.0;
        let mut n_t1 = 0usize;
        let mut n_t2 = 0usize;
        for s in &self.window {
            sum_t1 += s.tier1_delta;
            n_t1 += 1;
            if let Some(t2) = s.tier2_delta {
                sum_t2 += t2;
                n_t2 += 1;
            }
        }
        let mean_t1 = if n_t1 > 0 { sum_t1 / n_t1 as f64 } else { 0.0 };
        let mean_t2 = if n_t2 > 0 { Some(sum_t2 / n_t2 as f64) } else { None };

        // Count the trailing run of "divergent" samples.
        //
        // Divergent sample: Tier 1 delta >= tier1_threshold AND
        // Tier 2 delta IS Some(t) with t <= tier2_threshold.
        //
        // A sample without Tier 2 data is *not* divergent — it neither
        // helps nor hurts the run. This is what makes the detector
        // safe to start using the moment Tier 2 first populates: the
        // first partial sample won't extend the divergent run.
        let mut consecutive: u32 = 0;
        for s in self.window.iter().rev() {
            let t1_ok = s.tier1_delta >= self.tier1_threshold;
            let t2_ok = match s.tier2_delta {
                Some(t) => t <= self.tier2_threshold,
                None => false,
            };
            if t1_ok && t2_ok {
                consecutive += 1;
            } else {
                break;
            }
        }

        // We require the run to span at least `consecutive_required`
        // samples AND we must have at least that many samples in the
        // window (otherwise we'd trigger on a 3-sample run that's
        // really the entire window of a brand-new detector).
        let have_enough_samples = self.window.len() as u32 >= self.consecutive_required;
        let triggered = have_enough_samples && consecutive >= self.consecutive_required;

        GoodhartResult {
            triggered,
            consecutive_divergent: consecutive,
            mean_tier1_delta: mean_t1,
            mean_tier2_delta: mean_t2,
        }
    }

    /// Reset the window. Called when the user resets the RSI session
    /// (rare) or when the strategy-genome layer explicitly requests a
    /// fresh baseline (e.g. after a major PBT sync event).
    pub fn reset(&mut self) {
        self.window.clear();
    }

    /// Current window size (read-only; for tests + UI).
    pub fn window_len(&self) -> usize {
        self.window.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(t1: f64, t2: Option<f64>) -> GoodhartSample {
        GoodhartSample {
            iteration_id: format!("i-{}", uuid::Uuid::new_v4()),
            tier1_delta: t1,
            tier2_delta: t2,
        }
    }

    fn det() -> GoodhartDetector {
        GoodhartDetector::new(8, 0.02, -0.01, 3)
    }

    #[test]
    fn single_divergent_sample_does_not_trigger() {
        let mut d = det();
        let r = d.observe(sample(0.05, Some(-0.05)));
        assert!(!r.triggered);
        assert_eq!(r.consecutive_divergent, 1);
    }

    #[test]
    fn three_consecutive_divergent_samples_trigger() {
        let mut d = det();
        let _ = d.observe(sample(0.03, Some(-0.02)));
        let _ = d.observe(sample(0.04, Some(-0.03)));
        let r = d.observe(sample(0.03, Some(-0.02)));
        assert!(r.triggered);
        assert_eq!(r.consecutive_divergent, 3);
    }

    #[test]
    fn tier2_none_breaks_run() {
        let mut d = det();
        let _ = d.observe(sample(0.03, Some(-0.02)));
        let _ = d.observe(sample(0.04, Some(-0.03)));
        // Third sample has no Tier 2 data — must not extend the run.
        let r = d.observe(sample(0.03, None));
        assert!(!r.triggered);
        assert_eq!(r.consecutive_divergent, 0);
    }

    #[test]
    fn negative_tier1_does_not_count_as_divergent() {
        let mut d = det();
        let _ = d.observe(sample(-0.05, Some(-0.05)));
        let _ = d.observe(sample(-0.05, Some(-0.05)));
        let r = d.observe(sample(-0.05, Some(-0.05)));
        assert!(!r.triggered);
        assert_eq!(r.consecutive_divergent, 0);
    }

    #[test]
    fn reset_clears_window() {
        let mut d = det();
        let _ = d.observe(sample(0.03, Some(-0.02)));
        let _ = d.observe(sample(0.04, Some(-0.03)));
        assert_eq!(d.window_len(), 2);
        d.reset();
        assert_eq!(d.window_len(), 0);
    }

    #[test]
    fn window_respects_max_size() {
        // Window size larger than MAX_WINDOW should be capped to MAX_WINDOW.
        let mut d = GoodhartDetector::new(9999, 0.02, -0.01, 3);
        for _ in 0..(MAX_WINDOW + 5) {
            let _ = d.observe(sample(0.0, None));
        }
        assert_eq!(d.window_len(), MAX_WINDOW);
    }

    #[test]
    fn mean_handles_partial_tier2_data() {
        let mut d = det();
        let _ = d.observe(sample(0.01, Some(-0.02)));
        let _ = d.observe(sample(0.02, None));
        let _ = d.observe(sample(0.03, Some(-0.04)));
        let r = d.observe(sample(0.04, Some(-0.06)));
        // mean_t2 over the 3 with Tier 2 data = (-0.02 + -0.04 + -0.06) / 3 = -0.04
        assert!((r.mean_tier2_delta.unwrap() - (-0.04)).abs() < 1e-9);
    }
}
