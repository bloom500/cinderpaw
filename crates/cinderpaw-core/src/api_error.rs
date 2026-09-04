//! Typed error envelope for `/runtime/*` HTTP responses.
//!
//! Adopted in A1 of the browser-app foundation sprint (2026-08-31) as a
//! **contract introduction only**. No production call site is migrated in
//! this PR; the existing 33 inline `(StatusCode, message)` error
//! responses in `api.rs` are untouched. Follow-up PRs (A2, A3, B2, and
//! the broader runtime-error migration tracked in
//! `docs/browser-app-mvp-boundary.md`) will adopt the
//! envelope per call site.
//!
//! Concept adapted from OpenClaw 2.0's typed wire-error layer
//! (`docs.openclaw.ai/gateway/protocol`). No code copied; the Cinderpaw
//! shape is a smaller, focused subset that doesn't disturb the existing
//! `{ok: bool, error: string, message: string, hint: string}` envelope
//! the Go TUI consumes via `SaveByokKeyResult` in `tui/api/client.go`.
//!
//! ## Wire shape (MVP target)
//!
//! ```json
//! {
//!   "code": "keyring_unavailable",
//!   "message": "Couldn't reach the OS credential store.",
//!   "hint": "On a headless server use api_key_source.kind: env",
//!   "retryable": true,
//!   "retryAfterMs": 5000
//! }
//! ```
//!
//! * `code` — stable machine-readable identifier. Localisation belongs
//!   in the client.
//! * `message` — human summary.
//! * `hint` — optional next-step pointer. Never echoes secrets.
//! * `retryable` — defaults to `false`. Set `true` for transient
//!   failures (network, keyring busy, backend restart). Irrecoverable
//!   input (bad provider id, missing field) stays `false`.
//! * `retryAfterMs` — optional backoff hint. Surfaced alongside
//!   `429 / 503 / 504`; the caller may wait longer or shorter, this is
//!   a hint, not a contract.
//!
//! ## Backward compatibility posture
//!
//! A1 does not change any existing response body. Migration of each
//! call site is a separate PR that:
//!   1. Replaces the inline `(StatusCode, String).into_response()` with
//!      `ApiError::bad(...).into_response_with(StatusCode::BAD_REQUEST)`.
//!   2. Keeps the response body's *existing* top-level fields (`error`,
//!      `message`, `hint`) populated identically so the TUI parser does
//!      not regress.
//!   3. Adds the new `code` / `retryable` / `retryAfterMs` fields
//!      alongside.
//!
//! New consumers (browser BFF, retry scheduler) read `code` +
//! `retryable` + `retryAfterMs`. Legacy consumers (Go TUI's
//! `SaveByokKeyResult`) continue to read `error` + `message` + `hint`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

/// Typed error envelope. See module docs for the wire shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApiError {
    /// Stable machine-readable code (e.g. `"keyring_unavailable"`).
    /// Localise in the client.
    pub code: String,
    /// Human-readable summary.
    pub message: String,
    /// Optional next-step pointer. Never echoes secrets.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hint: Option<String>,
    /// Defaults to `false`; opt in for transient failures.
    #[serde(default)]
    pub retryable: bool,
    /// Optional backoff hint in milliseconds. Surfaced alongside
    /// `retryable: true`.
    #[serde(rename = "retryAfterMs", skip_serializing_if = "Option::is_none", default)]
    pub retry_after_ms: Option<u64>,
}

impl ApiError {
    /// Non-retryable error. Use for input validation, missing fields,
    /// structural rejections, and other "caller is stuck" failures.
    pub fn bad(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
            retryable: false,
            retry_after_ms: None,
        }
    }

    /// Retryable error with a suggested backoff. Use for transient
    /// backend / OS-keychain / network failures.
    pub fn retryable(
        code: impl Into<String>,
        message: impl Into<String>,
        retry_after_ms: u64,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
            retryable: true,
            retry_after_ms: Some(retry_after_ms),
        }
    }

    /// Optional next-step hint. Chainable.
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Render as an axum `Response` with the given status code. The
    /// status is independent of `retryable`: a 400 can still be
    /// retryable in principle, and a 503 is almost always retryable.
    ///
    /// The `status` argument decides the HTTP code; `retryable` +
    /// `retry_after_ms` are encoded in the JSON body for the caller.
    pub fn into_response_with(self, status: StatusCode) -> Response {
        (status, Json(self)).into_response()
    }
}

/// Helper for migrating the existing 33 `(StatusCode, String)` call
/// sites in `api.rs`. Each migration replaces the tuple with one of:
///
/// ```ignore
/// ApiError::bad("stable_code", "human message").into_response_with(StatusCode::BAD_REQUEST)
/// ApiError::retryable("stable_code", "human message", 5000)
///     .into_response_with(StatusCode::SERVICE_UNAVAILABLE)
/// ```
///
/// This PR (A1) introduces the type and tests only; the migrations
/// happen in A2 / A3 / B2 / follow-up PRs.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn bad_error_is_not_retryable() {
        let e = ApiError::bad("invalid_provider_id", "provider id must be lowercase");
        assert!(!e.retryable);
        assert!(e.retry_after_ms.is_none());
        assert_eq!(e.code, "invalid_provider_id");
        assert_eq!(e.message, "provider id must be lowercase");
        assert!(e.hint.is_none());
    }

    #[test]
    fn retryable_error_carries_backoff() {
        let e = ApiError::retryable("keyring_unavailable", "couldn't reach keychain", 5000);
        assert!(e.retryable);
        assert_eq!(e.retry_after_ms, Some(5000));
        assert!(e.hint.is_none());
    }

    #[test]
    fn hint_is_chainable() {
        let e = ApiError::bad("invalid_provider_id", "x")
            .with_hint("Use [a-z0-9_-] only");
        assert_eq!(e.hint.as_deref(), Some("Use [a-z0-9_-] only"));
    }

    #[test]
    fn wire_shape_exact_match_non_retryable() {
        let e = ApiError::bad("invalid_provider_id", "provider id must be lowercase")
            .with_hint("Use [a-z0-9_-] only");
        let v: Value = serde_json::to_value(&e).expect("serialize");
        assert_eq!(
            v,
            json!({
                "code": "invalid_provider_id",
                "message": "provider id must be lowercase",
                "hint": "Use [a-z0-9_-] only",
                "retryable": false,
            })
        );
    }

    #[test]
    fn wire_shape_exact_match_retryable() {
        let e = ApiError::retryable("service_unavailable", "backend restarting", 7500);
        let v: Value = serde_json::to_value(&e).expect("serialize");
        assert_eq!(
            v,
            json!({
                "code": "service_unavailable",
                "message": "backend restarting",
                "retryable": true,
                "retryAfterMs": 7500,
            })
        );
    }

    #[test]
    fn wire_shape_omits_optional_fields_when_absent() {
        let e = ApiError::bad("not_found", "missing");
        let v: Value = serde_json::to_value(&e).expect("serialize");
        assert!(v.get("hint").is_none());
        assert!(v.get("retryAfterMs").is_none());
        // retryable defaults to false and IS present in the wire shape
        // (clients should not have to guess whether missing means false).
        assert_eq!(v["retryable"], false);
    }

    #[test]
    fn retryable_default_is_false() {
        let e = ApiError::bad("x", "y");
        assert!(!e.retryable);
    }

    #[test]
    fn retry_after_ms_field_renamed_with_camel_case() {
        let e = ApiError::retryable("rate_limited", "slow down", 1000);
        let s = serde_json::to_string(&e).expect("serialize");
        assert!(
            s.contains("\"retryAfterMs\":1000"),
            "expected camelCase retryAfterMs in JSON, got: {s}"
        );
        assert!(
            !s.contains("retry_after_ms"),
            "snake_case must not leak into wire shape: {s}"
        );
    }

    #[test]
    fn json_roundtrip_preserves_all_fields() {
        let original = ApiError::retryable("rate_limited", "slow down", 1000)
            .with_hint("wait 1s");
        let json_str = serde_json::to_string(&original).expect("serialize");
        let parsed: ApiError = serde_json::from_str(&json_str).expect("parse");
        assert_eq!(parsed, original);
    }

    #[test]
    fn json_roundtrip_non_retryable() {
        let original = ApiError::bad("bad_input", "missing field");
        let json_str = serde_json::to_string(&original).expect("serialize");
        let parsed: ApiError = serde_json::from_str(&json_str).expect("parse");
        assert_eq!(parsed, original);
        assert!(!parsed.retryable);
        assert!(parsed.retry_after_ms.is_none());
        assert!(parsed.hint.is_none());
    }

    #[test]
    fn into_response_preserves_status_and_body() {
        let e = ApiError::retryable("service_unavailable", "backend restarting", 5000);
        let r = e.into_response_with(StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn into_response_works_with_4xx() {
        let e = ApiError::bad("invalid_provider_id", "x");
        let r = e.into_response_with(StatusCode::BAD_REQUEST);
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    }
}