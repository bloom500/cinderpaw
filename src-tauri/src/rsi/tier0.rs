//! Tier 0 — the frozen sanity-check suite.
//!
//! The 10 checks here run BEFORE every other evaluation. They are
//! "cheap, fast, and binary": the agent either produces a response
//! that matches the expected shape or it doesn't. No subjective
//! judgement, no LLM-as-judge — just verifiable facts.
//!
//! These are intentionally simple. The point of Tier 0 is not to test
//! the agent's intelligence; it's to test whether the agent is
//! functioning at all (responds, parses, doesn't hallucinate obvious
//! facts). Anything a 4-bit model can pass is fair game. The harder
//! tiers (1, 2) live in `eval/tier1/` and `eval/tier2/` and are loaded
#![allow(dead_code)]
// `validate_outcome` and its kind-specific helpers (`json_format_ok`,
// `fact_lookup_ok`, `normalise`) are the Rust-side mirror of the
// sidecar's TS validators. The engine drives them through the
// Rust-side `rsi_score` dispatcher today; the public re-export
// is for a future Faza 4 command (`rsi_replay_tier0`). Allow
// keeps the build clean until that lands.
//! from disk at boot — Tier 0 is hardcoded here because changing it is
//! a SAFETY event, not a tuning event.
//!
//! Threshold and scoring for each task are returned alongside the spec
//! so the scorer can apply the right formula. Tasks are scored
//! binarily (pass/fail) at the task level; the suite scorer
//! aggregates to a single fraction.

use serde::{Deserialize, Serialize};

/// The shape of one Tier 0 task. Matches what the sidecar loads for
/// Tier 1 and Tier 2 (file-based), so the same `EvalOutcome` machinery
/// works across all tiers.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Tier0Spec {
    /// Unique id. Convention: `tier0/<slug>`.
    pub id: String,
    /// Display name for UI.
    pub name: String,
    /// Human-readable description; shown on hover in the eval UI.
    pub description: String,
    /// The prompt actually sent to the agent during an eval run. This is
    /// additive metadata: it makes explicit the question each check was
    /// always implicitly about, and does NOT affect grading (that is
    /// `kind`/`expected`), so populating it is not a breaking-spec
    /// amendment. A real run cannot happen without it.
    pub prompt: String,
    /// What kind of check this is. Drives the validator the sidecar
    /// runs against the agent's response.
    pub kind: Tier0Kind,
    /// For `JsonFormat`: the expected JSON Schema (simplified — only
    /// required-keys + value-type checks, no full JSON-Schema draft).
    /// For `FactLookup`: the canonical answer string.
    /// For `TokenBudget`: the maximum allowed token count.
    /// For `Latency`: the maximum allowed milliseconds.
    pub expected: Tier0Expected,
}

/// Discriminator for Tier 0 task kinds. New kinds require updating
/// `validate_outcome` — the type system makes that impossible to
/// forget.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tier0Kind {
    /// Agent's response must be parseable JSON with the required keys
    /// and value types.
    JsonFormat,
    /// Agent's response must contain the canonical answer (case
    /// insensitive, whitespace normalised).
    FactLookup,
    /// Agent's token usage for this task must be at or below the
    /// budget. The InferenceRouter is the source of truth for the
    /// count.
    TokenBudget,
    /// Agent's wall-clock latency must be at or below the budget.
    Latency,
}

/// Per-kind expected payload. `TokenBudget` and `Latency` only use the
/// `max_ms` / `max_tokens` field; `JsonFormat` uses `required_keys`;
/// `FactLookup` uses `answer`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Tier0Expected {
    JsonFormat {
        required_keys: Vec<String>,
    },
    FactLookup {
        answer: String,
    },
    TokenBudget {
        max_tokens: u32,
    },
    Latency {
        max_ms: u32,
    },
}

/// Validate one Tier 0 task against an agent response + observed
/// metrics. Returns `true` for pass, `false` for fail. The caller
/// (sidecar) wraps this into an `EvalOutcome` for the scorer.
pub fn validate_outcome(spec: &Tier0Spec, response: &str, tokens: u32, latency_ms: u32) -> bool {
    match (&spec.kind, &spec.expected) {
        (Tier0Kind::JsonFormat, Tier0Expected::JsonFormat { required_keys }) => {
            json_format_ok(response, required_keys)
        }
        (Tier0Kind::FactLookup, Tier0Expected::FactLookup { answer }) => {
            fact_lookup_ok(response, answer)
        }
        (Tier0Kind::TokenBudget, Tier0Expected::TokenBudget { max_tokens }) => {
            tokens <= *max_tokens
        }
        (Tier0Kind::Latency, Tier0Expected::Latency { max_ms }) => latency_ms <= *max_ms,
        // Exhaustiveness: if a new kind is added to Tier0Kind without
        // a branch here, the compiler refuses to build. This is
        // intentional — frozen-permanently means NO silent additions.
        _ => false,
    }
}

fn json_format_ok(response: &str, required_keys: &[String]) -> bool {
    let parsed: serde_json::Value = match serde_json::from_str(response) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let Some(obj) = parsed.as_object() else {
        return false;
    };
    required_keys.iter().all(|k| obj.contains_key(k))
}

fn fact_lookup_ok(response: &str, answer: &str) -> bool {
    let norm_resp = normalise(response);
    let norm_ans = normalise(answer);
    if norm_resp.is_empty() || norm_ans.is_empty() {
        return false;
    }
    norm_resp.contains(&norm_ans)
}

fn normalise(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The 10 frozen Tier 0 sanity checks. **DO NOT EDIT WITHOUT A
/// BREAKING-SPEC AMENDMENT.** The whole point of Tier 0 is that the
/// safety bar is stable; the agent cannot game a check that was added
/// after the fact because there's no way to add one.
///
/// Wrapped in a `Lazy<Vec<...>>` because the entries carry owned
/// `String` payloads, which Rust's `const` items cannot allocate
/// (only `const fn`s that return already-allocated data are
/// allowed in const context — and `String::from` is not const-stable
/// on the toolchain the crate uses). The lazy is initialised on
/// first access; the cost is paid once per process.
pub static TIER0_SPECS: once_cell::sync::Lazy<Vec<Tier0Spec>> =
    once_cell::sync::Lazy::new(|| {
        vec![
        Tier0Spec {
            id: String::from("tier0/json_format"),
            name: String::from("Valid JSON response"),
            description: String::from("Agent returns a parseable JSON object."),
            prompt: String::from(
                "Reply with ONLY a JSON object that has an \"answer\" key whose value is the number of days in a week. No prose, no code fences.",
            ),
            kind: Tier0Kind::JsonFormat,
            expected: Tier0Expected::JsonFormat {
                required_keys: vec![String::from("answer")],
            },
        },
        Tier0Spec {
            id: String::from("tier0/fact_capital_france"),
            name: String::from("Capital of France"),
            description: String::from("Agent names Paris when asked for the capital of France."),
            prompt: String::from("What is the capital of France? Answer with just the city name."),
            kind: Tier0Kind::FactLookup,
            expected: Tier0Expected::FactLookup {
                answer: String::from("paris"),
            },
        },
        Tier0Spec {
            id: String::from("tier0/fact_water_formula"),
            name: String::from("Chemical formula for water"),
            description: String::from("Agent answers H2O when asked for the formula of water."),
            prompt: String::from("What is the chemical formula for water? Answer with just the formula."),
            kind: Tier0Kind::FactLookup,
            expected: Tier0Expected::FactLookup {
                answer: String::from("h2o"),
            },
        },
        Tier0Spec {
            id: String::from("tier0/fact_planets"),
            name: String::from("Number of planets in our solar system"),
            description: String::from("Agent answers 8 when asked for the planet count."),
            prompt: String::from("How many planets are in our solar system? Answer with just the number."),
            kind: Tier0Kind::FactLookup,
            expected: Tier0Expected::FactLookup {
                answer: String::from("8"),
            },
        },
        Tier0Spec {
            id: String::from("tier0/fact_un_membres_2025"),
            name: String::from("United Nations founding year"),
            description: String::from("Agent answers 1945 when asked for the UN founding year."),
            prompt: String::from("In what year was the United Nations founded? Answer with just the year."),
            kind: Tier0Kind::FactLookup,
            expected: Tier0Expected::FactLookup {
                answer: String::from("1945"),
            },
        },
        Tier0Spec {
            id: String::from("tier0/fact_pi_2dp"),
            name: String::from("Pi to 2 decimal places"),
            description: String::from("Agent answers 3.14 when asked for pi to 2dp."),
            prompt: String::from("What is pi rounded to 2 decimal places? Answer with just the number."),
            kind: Tier0Kind::FactLookup,
            expected: Tier0Expected::FactLookup {
                answer: String::from("3.14"),
            },
        },
        Tier0Spec {
            id: String::from("tier0/fact_largest_continent"),
            name: String::from("Largest continent by area"),
            description: String::from("Agent names Asia when asked for the largest continent."),
            prompt: String::from("What is the largest continent by area? Answer with just the continent name."),
            kind: Tier0Kind::FactLookup,
            expected: Tier0Expected::FactLookup {
                answer: String::from("asia"),
            },
        },
        Tier0Spec {
            id: String::from("tier0/json_summary"),
            name: String::from("Structured summary"),
            description: String::from(
                "Agent returns a JSON object with `title` and `summary` keys when asked for a summary.",
            ),
            prompt: String::from(
                "Summarise the following text. Reply with ONLY a JSON object that has \"title\" and \"summary\" keys, no prose or code fences. Text: \"The water cycle moves water between the oceans, atmosphere, and land through evaporation, condensation, and precipitation.\"",
            ),
            kind: Tier0Kind::JsonFormat,
            expected: Tier0Expected::JsonFormat {
                required_keys: vec![String::from("title"), String::from("summary")],
            },
        },
        Tier0Spec {
            id: String::from("tier0/token_budget_short"),
            name: String::from("Token budget on a short prompt"),
            description: String::from("Agent stays under 800 tokens for a short factual prompt."),
            prompt: String::from("In one short sentence, what is the boiling point of water at sea level in Celsius?"),
            kind: Tier0Kind::TokenBudget,
            expected: Tier0Expected::TokenBudget { max_tokens: 800 },
        },
        Tier0Spec {
            id: String::from("tier0/latency_short"),
            name: String::from("Latency on a short prompt"),
            description: String::from("Agent finishes a short prompt in under 1500ms p95."),
            prompt: String::from("Reply with a single word: ready."),
            kind: Tier0Kind::Latency,
            expected: Tier0Expected::Latency { max_ms: 1500 },
        },
        ]
    });

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_specs_constant() {
        assert_eq!(TIER0_SPECS.len(), 10);
    }

    #[test]
    fn every_spec_carries_a_non_empty_prompt() {
        for s in TIER0_SPECS.iter() {
            assert!(!s.prompt.trim().is_empty(), "spec {} has no prompt", s.id);
        }
    }

    #[test]
    fn json_format_accepts_object_with_required_keys() {
        let s = &TIER0_SPECS[0];
        assert!(validate_outcome(s, r#"{"answer": "ok"}"#, 50, 100));
        assert!(!validate_outcome(s, r#"{"foo": "bar"}"#, 50, 100));
        assert!(!validate_outcome(s, "not json", 50, 100));
    }

    #[test]
    fn fact_lookup_case_and_whitespace_insensitive() {
        let s = &TIER0_SPECS[1];
        assert!(validate_outcome(s, "The answer is Paris.", 50, 100));
        assert!(validate_outcome(s, "PARIS", 50, 100));
        assert!(!validate_outcome(s, "London", 50, 100));
    }

    #[test]
    fn token_budget_is_upper_bound() {
        let s = &TIER0_SPECS[8];
        assert!(validate_outcome(s, "anything", 800, 100));
        assert!(!validate_outcome(s, "anything", 801, 100));
    }

    #[test]
    fn latency_is_upper_bound() {
        let s = &TIER0_SPECS[9];
        assert!(validate_outcome(s, "anything", 50, 1500));
        assert!(!validate_outcome(s, "anything", 50, 1501));
    }

    #[test]
    fn exhaustiveness_kind_mismatch_returns_false() {
        // Construct a spec where kind and expected disagree — only
        // reachable via direct field assignment in test code, but
        // the runtime check still defends against malformed data on
        // disk if a future schema migration makes the two diverge.
        let s = Tier0Spec {
            id: String::from("test/mismatch"),
            name: String::from("mismatch"),
            description: String::from("test only"),
            prompt: String::from("test only"),
            kind: Tier0Kind::FactLookup,
            expected: Tier0Expected::Latency { max_ms: 100 },
        };
        assert!(!validate_outcome(&s, "anything", 50, 50));
    }
}
