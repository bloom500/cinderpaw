//! Inference performance policy — single source of truth for TTFT /
//! total / stall deadlines, scaled by target (local vs cloud) and
//! overridable via env. Mirrors the sidecar
//! `CinderpawAgent/src/sandbox/perf-policy.ts` and the frontend
//! `frontend-react/src/lib/perfPolicy.ts` so the three layers agree on
//! what "TTFT" and "total" mean.
//!
//! Defaults are deliberately generous: a legitimately slow-but-working
//! local model on weak hardware MUST NOT be killed mid-prefill. TTFT
//! scales with `prompt_tokens` (4 ms/token by default, capped at the
//! configured `total_deadline_ms`) so a 16k-token agent prompt gets a
//! 154 s budget, not a 90 s one — and the heartbeat proves liveness,
//! so the watchdog trips only on real stalls.
//!
//! Calibration knobs are env-overridable per the spec. None of these
//! values are user-visible in v1 (Settings UI is YAGNI per the spec's
//! Out-of-scope section); power users can still tune via env vars.

use serde::{Deserialize, Serialize};
use std::env;

/// Resolved env values. Production callers use [`perf_policy`], which
/// reads the process env directly. Tests use [`perf_policy_with_env`]
/// so they can run in parallel without racing on process-global env
/// (Rust tests in `cargo test` run multi-threaded by default and
/// `std::env::set_var` is process-global, so a mutex around it would
/// just serialize every unrelated test in the suite).
#[derive(Debug, Clone, Copy, Default)]
pub struct EnvOverrides {
    pub ttft_ms: Option<u64>,
    pub total_ms: Option<u64>,
    pub stall_ms: Option<u64>,
    /// Legacy `FERAL_CLOUD_IDLE_TIMEOUT_MS`. Only honored on cloud.
    pub cloud_idle_ms: Option<u64>,
}

impl EnvOverrides {
    /// Snapshot the relevant env vars. Cheap; doesn't lock anything.
    pub fn from_env() -> Self {
        Self {
            ttft_ms: read_env_optional("FERAL_TTFT_DEADLINE_MS"),
            total_ms: read_env_optional("FERAL_TOTAL_DEADLINE_MS"),
            stall_ms: read_env_optional("FERAL_STALL_MS"),
            cloud_idle_ms: read_env_optional("FERAL_CLOUD_IDLE_TIMEOUT_MS"),
        }
    }
}

/// Calibration knobs. Mirror `perf-policy.ts` DEFAULTS exactly so the
/// three layers stay in lockstep — drift here is a real bug.
mod defaults {
    pub(super) const LOCAL_TTFT_DEADLINE_MS: u64 = 90_000;
    pub(super) const LOCAL_TOTAL_DEADLINE_MS: u64 = 300_000;
    pub(super) const LOCAL_STALL_MS: u64 = 45_000;

    pub(super) const CLOUD_TTFT_DEADLINE_MS: u64 = 30_000;
    pub(super) const CLOUD_TOTAL_DEADLINE_MS: u64 = 120_000;
    pub(super) const CLOUD_STALL_MS: u64 = 30_000;

    /// Milliseconds added to prompt-token count for TTFT scaling.
    pub(super) const PER_TOKEN_PREFILL_MS: u64 = 4;

    /// Heartbeat cadence for stream-progress events.
    pub(super) const HEARTBEAT_MS: u64 = 750;
}

/// Resolved policy for one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerfPolicy {
    /// Max wall-clock from request start to first emitted token.
    pub ttft_deadline_ms: u64,
    /// Max wall-clock for the whole completion (first-token + generation).
    pub total_deadline_ms: u64,
    /// Max idle gap between consecutive tokens.
    pub stall_ms: u64,
    /// Heartbeat cadence for stream-progress events.
    pub heartbeat_ms: u64,
}

impl PerfPolicy {
    /// Compute the *effective* TTFT after scaling with prompt size.
    /// `prompt_tokens == 0` → unscaled base.
    pub fn effective_ttft(&self, prompt_tokens: u32) -> u64 {
        let base = self.ttft_deadline_ms;
        if prompt_tokens == 0 {
            return base;
        }
        let scaled = base
            .saturating_add(u64::from(prompt_tokens) * defaults::PER_TOKEN_PREFILL_MS);
        scaled.min(self.total_deadline_ms)
    }
}

/// Read a positive integer from env. `None` for missing or invalid values.
fn read_env_optional(name: &str) -> Option<u64> {
    env::var(name)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
}

/// Resolve the perf policy for one request, reading process env.
///
/// `is_cloud == false` → use the local defaults (90 s TTFT, 300 s total,
/// 45 s stall).
/// `is_cloud == true`  → use the cloud defaults (30 s TTFT, 120 s total,
/// 30 s stall).
///
/// Env precedence: any positive integer in the matching env var wins;
/// otherwise the target-specific default. `FERAL_STALL_MS` (the new
/// general stall setting) takes precedence over the legacy
/// `FERAL_CLOUD_IDLE_TIMEOUT_MS` when both are set, so an operator
/// migrating doesn't see surprising flip-flops.
pub fn perf_policy(is_cloud: bool) -> PerfPolicy {
    perf_policy_with_env(is_cloud, &EnvOverrides::from_env())
}

/// Resolve the perf policy from an explicit env snapshot. Tests call
/// this directly so they don't race on `std::env` (process-global).
pub fn perf_policy_with_env(is_cloud: bool, env: &EnvOverrides) -> PerfPolicy {
    let (base_ttft, base_total, base_stall) = if is_cloud {
        (
            defaults::CLOUD_TTFT_DEADLINE_MS,
            defaults::CLOUD_TOTAL_DEADLINE_MS,
            defaults::CLOUD_STALL_MS,
        )
    } else {
        (
            defaults::LOCAL_TTFT_DEADLINE_MS,
            defaults::LOCAL_TOTAL_DEADLINE_MS,
            defaults::LOCAL_STALL_MS,
        )
    };

    let ttft_deadline_ms = env.ttft_ms.unwrap_or(base_ttft);
    let total_deadline_ms = env.total_ms.unwrap_or(base_total);

    // Stall precedence: `FERAL_STALL_MS` (new, general) wins; the legacy
    // `FERAL_CLOUD_IDLE_TIMEOUT_MS` (cloud-only) is the back-compat knob.
    let stall_ms = env
        .stall_ms
        .or(if is_cloud { env.cloud_idle_ms } else { None })
        .unwrap_or(base_stall);

    PerfPolicy {
        ttft_deadline_ms,
        total_deadline_ms,
        stall_ms,
        heartbeat_ms: defaults::HEARTBEAT_MS,
    }
}

// ── Deadline reasons ─────────────────────────────────────────────────────

/// Stable, machine-readable reason a watchdog tripped. The bracketed
/// prefix in [`deadline_message`] is the wire token; everything after
/// it is the human copy the UI renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeadlineReason {
    /// The model never produced its first token within `ttft_deadline_ms`.
    TtftTimeout,
    /// The whole request ran past `total_deadline_ms`.
    TotalTimeout,
    /// No token arrived within `stall_ms` of the previous one.
    StallTimeout,
    /// The local model wasn't loaded / wedged before the request started
    /// (surfaced by the readiness preflight, not the watchdog).
    EngineUnready,
}

impl DeadlineReason {
    /// Stable machine prefix used inside the `cinderpaw://stream-error`
    /// payload's `error` string. Order matches the TS `deadlineMessage`.
    pub fn as_prefix(&self) -> &'static str {
        match self {
            Self::TtftTimeout => "ttft_timeout",
            Self::TotalTimeout => "total_timeout",
            Self::StallTimeout => "stall_timeout",
            Self::EngineUnready => "engine_unready",
        }
    }
}

/// Render the human-readable line carried by `cinderpaw://stream-error`
/// (and the sidecar's outbound `error` events). The leading bracketed
/// prefix is the machine token the UI's `humanizeError` matcher keys on.
pub fn deadline_message(reason: DeadlineReason, policy: &PerfPolicy) -> String {
    let seconds = |ms: u64| ms / 1000;
    match reason {
        DeadlineReason::TtftTimeout => format!(
            "[ttft_timeout] The model didn't start responding within {}s. \
             The prompt may be too long or the model too large for this hardware — \
             try a shorter prompt, a smaller model, or a cloud key.",
            seconds(policy.ttft_deadline_ms)
        ),
        DeadlineReason::TotalTimeout => format!(
            "[total_timeout] Generation ran past the {}s limit and was stopped. \
             Try a smaller model or shorter output.",
            seconds(policy.total_deadline_ms)
        ),
        DeadlineReason::StallTimeout => format!(
            "[stall_timeout] The model stopped producing output (no tokens for {}s). \
             It may have wedged — reloading is recommended.",
            seconds(policy.stall_ms)
        ),
        DeadlineReason::EngineUnready => "[engine_unready] The local model isn't loaded \
             or stopped responding. Reload it and try again."
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_env() -> EnvOverrides {
        EnvOverrides::default()
    }

    #[test]
    fn local_defaults_match_spec_table() {
        let p = perf_policy_with_env(false, &empty_env());
        assert_eq!(p.ttft_deadline_ms, defaults::LOCAL_TTFT_DEADLINE_MS);
        assert_eq!(p.total_deadline_ms, defaults::LOCAL_TOTAL_DEADLINE_MS);
        assert_eq!(p.stall_ms, defaults::LOCAL_STALL_MS);
        assert_eq!(p.heartbeat_ms, defaults::HEARTBEAT_MS);
    }

    #[test]
    fn cloud_defaults_match_spec_table() {
        let p = perf_policy_with_env(true, &empty_env());
        assert_eq!(p.ttft_deadline_ms, defaults::CLOUD_TTFT_DEADLINE_MS);
        assert_eq!(p.total_deadline_ms, defaults::CLOUD_TOTAL_DEADLINE_MS);
        assert_eq!(p.stall_ms, defaults::CLOUD_STALL_MS);
    }

    #[test]
    fn cloud_is_tighter_than_local() {
        let local = perf_policy_with_env(false, &empty_env());
        let cloud = perf_policy_with_env(true, &empty_env());
        assert!(cloud.ttft_deadline_ms < local.ttft_deadline_ms);
        assert!(cloud.total_deadline_ms < local.total_deadline_ms);
        assert!(cloud.stall_ms <= local.stall_ms);
    }

    #[test]
    fn env_overrides_win() {
        let env = EnvOverrides {
            ttft_ms: Some(12_345),
            total_ms: Some(600_000),
            stall_ms: Some(9_999),
            cloud_idle_ms: None,
        };
        let p = perf_policy_with_env(false, &env);
        assert_eq!(p.ttft_deadline_ms, 12_345);
        assert_eq!(p.total_deadline_ms, 600_000);
        assert_eq!(p.stall_ms, 9_999);
    }

    #[test]
    fn invalid_env_falls_back() {
        // EnvOverrides pre-parses values, so the resolver never sees
        // invalid strings — but the parsing helper itself must reject
        // non-positive or non-numeric input. Mirror the TS test here.
        assert_eq!(read_env_optional("FERAL_DOES_NOT_EXIST_XYZ"), None);
        // Set a malformed value to verify `read_env_optional` returns None.
        // We touch process env in this one test; it's serial because we
        // also `remove_var` immediately after.
        env::set_var("__FERAL_TEST_BAD__", "not-a-number");
        assert_eq!(read_env_optional("__FERAL_TEST_BAD__"), None);
        env::set_var("__FERAL_TEST_BAD__", "-100");
        assert_eq!(read_env_optional("__FERAL_TEST_BAD__"), None);
        env::set_var("__FERAL_TEST_BAD__", "0");
        assert_eq!(read_env_optional("__FERAL_TEST_BAD__"), None);
        env::set_var("__FERAL_TEST_BAD__", "12345");
        assert_eq!(read_env_optional("__FERAL_TEST_BAD__"), Some(12_345));
        env::remove_var("__FERAL_TEST_BAD__");

        // Resolver falls back when override is None — same outcome.
        let p = perf_policy_with_env(false, &empty_env());
        assert_eq!(p.ttft_deadline_ms, defaults::LOCAL_TTFT_DEADLINE_MS);
    }

    #[test]
    fn stall_ms_wins_over_legacy_cloud_idle_when_both_set() {
        let env = EnvOverrides {
            ttft_ms: None,
            total_ms: None,
            stall_ms: Some(8_888),
            cloud_idle_ms: Some(7_777),
        };
        let p = perf_policy_with_env(true, &env);
        assert_eq!(p.stall_ms, 8_888);
    }

    #[test]
    fn legacy_cloud_idle_still_works_when_stall_ms_unset() {
        let env = EnvOverrides {
            ttft_ms: None,
            total_ms: None,
            stall_ms: None,
            cloud_idle_ms: Some(7_777),
        };
        let p = perf_policy_with_env(true, &env);
        assert_eq!(p.stall_ms, 7_777);
    }

    #[test]
    fn legacy_cloud_idle_does_not_apply_to_local() {
        let env = EnvOverrides {
            ttft_ms: None,
            total_ms: None,
            stall_ms: None,
            cloud_idle_ms: Some(7_777),
        };
        let p = perf_policy_with_env(false, &env);
        // Local target → legacy cloud knob ignored, default local stall.
        assert_eq!(p.stall_ms, defaults::LOCAL_STALL_MS);
    }

    #[test]
    fn ttft_scales_with_prompt_tokens() {
        let p = perf_policy_with_env(false, &empty_env());
        // 1000-token prompt adds 4 s to local TTFT.
        assert_eq!(
            p.effective_ttft(1000),
            defaults::LOCAL_TTFT_DEADLINE_MS + 1000 * defaults::PER_TOKEN_PREFILL_MS
        );
    }

    #[test]
    fn ttft_scale_caps_at_total_deadline() {
        let env = EnvOverrides {
            ttft_ms: None,
            total_ms: Some(120_000),
            stall_ms: None,
            cloud_idle_ms: None,
        };
        let p = perf_policy_with_env(false, &env);
        // A 1M-token prompt would otherwise scale to ~4.09M ms.
        assert_eq!(p.effective_ttft(1_000_000), p.total_deadline_ms);
    }

    #[test]
    fn ttft_zero_tokens_is_unscaled() {
        let p = perf_policy_with_env(false, &empty_env());
        assert_eq!(p.effective_ttft(0), p.ttft_deadline_ms);
    }

    #[test]
    fn ttft_saturating_add_does_not_overflow() {
        let p = perf_policy_with_env(false, &empty_env());
        // u32::MAX tokens × 4 ms/token would overflow u64 if we used +.
        // We use saturating_add + min(total), so the result is bounded
        // by total_deadline_ms regardless of input size.
        let got = p.effective_ttft(u32::MAX);
        assert_eq!(got, p.total_deadline_ms);
    }

    #[test]
    fn deadline_message_starts_with_machine_prefix() {
        let p = perf_policy_with_env(false, &empty_env());
        for (reason, expected_prefix) in [
            (DeadlineReason::TtftTimeout, "[ttft_timeout]"),
            (DeadlineReason::TotalTimeout, "[total_timeout]"),
            (DeadlineReason::StallTimeout, "[stall_timeout]"),
            (DeadlineReason::EngineUnready, "[engine_unready]"),
        ] {
            let m = deadline_message(reason, &p);
            assert!(
                m.starts_with(expected_prefix),
                "expected `{}` to start with `{}`, got: `{}`",
                reason.as_prefix(),
                expected_prefix,
                m
            );
        }
    }

    #[test]
    fn deadline_reason_prefix_matches_serde() {
        // The prefix is what the frontend's humanizeError matcher keys
        // on — it MUST match the snake_case serde rename.
        assert_eq!(DeadlineReason::TtftTimeout.as_prefix(), "ttft_timeout");
        assert_eq!(DeadlineReason::TotalTimeout.as_prefix(), "total_timeout");
        assert_eq!(DeadlineReason::StallTimeout.as_prefix(), "stall_timeout");
        assert_eq!(DeadlineReason::EngineUnready.as_prefix(), "engine_unready");

        let json = serde_json::to_string(&DeadlineReason::TtftTimeout).unwrap();
        assert_eq!(json, "\"ttft_timeout\"");
    }
}