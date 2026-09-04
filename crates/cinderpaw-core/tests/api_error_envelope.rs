//! A1 integration fixture: demonstrates how future migrations of
//! `(StatusCode, String)` call sites in `api.rs` will look once they
//! adopt `ApiError`. **No production code is exercised or modified.**
//!
//! The fixture is intentionally minimal: a stand-in axum router that
//! emits the typed envelope for three representative cases (400, 503,
//! plain string body), plus an end-to-end test that verifies both the
//! wire shape and the legacy-field compatibility note in the module
//! docs.
//!
//! If a future migration regresses the shape, this test fails and the
//! regression is caught before it reaches a real route. It is **not**
//! a replacement for migration-time per-route tests.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use cinderpaw_core::api_error::ApiError;
use serde_json::Value;
use tower::ServiceExt;

fn fixture_router() -> Router {
    Router::new()
        // Migration preview: a 400 BAD_REQUEST migrated to ApiError.
        .route(
            "/demo/bad",
            post(|_: String| async {
                ApiError::bad("invalid_provider_id", "provider id must be lowercase")
                    .with_hint("Use [a-z0-9_-] only")
                    .into_response_with(StatusCode::BAD_REQUEST)
            }),
        )
        // Migration preview: a 503 SERVICE_UNAVAILABLE migrated to
        // ApiError::retryable with backoff.
        .route(
            "/demo/retry",
            get(|| async {
                ApiError::retryable("service_unavailable", "backend restarting", 5000)
                    .into_response_with(StatusCode::SERVICE_UNAVAILABLE)
            }),
        )
        // Negative control: the *current* (un-migrated) behaviour is a
        // plain string body. This MUST NOT regress; if it does, callers
        // that parse plain text on 5xx (TUI's `AcceptsNonJSONFailure`
        // path in `tui/api/byok_save_test.go:140`) break.
        .route(
            "/demo/plain",
            get(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "internal: temporary serialization loss").into_response() }),
        )
}

async fn body_json(response: axum::response::Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("body readable");
    let v: Value = serde_json::from_slice(&bytes).expect("json body");
    (status, v)
}

#[tokio::test]
async fn migrated_400_emits_typed_envelope() {
    let app = fixture_router();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/demo/bad")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("request ok");

    let (status, body) = body_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_provider_id");
    assert_eq!(body["message"], "provider id must be lowercase");
    assert_eq!(body["hint"], "Use [a-z0-9_-] only");
    assert_eq!(body["retryable"], false);
    // retryAfterMs omitted (non-retryable).
    assert!(body.get("retryAfterMs").is_none());
}

#[tokio::test]
async fn migrated_503_emits_retryable_envelope() {
    let app = fixture_router();
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/demo/retry")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("request ok");

    let (status, body) = body_json(response).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "service_unavailable");
    assert_eq!(body["message"], "backend restarting");
    assert_eq!(body["retryable"], true);
    assert_eq!(body["retryAfterMs"], 5000);
    // hint omitted (none set).
    assert!(body.get("hint").is_none());
}

#[tokio::test]
async fn plain_text_500_is_unchanged_by_a1() {
    // Regression guard: A1 does not change the existing behaviour of
    // routes that emit plain-text bodies. The TUI's
    // `TestSaveByokKeyAcceptsNonJSONFailure` depends on this.
    let app = fixture_router();
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/demo/plain")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("request ok");

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("body readable");
    let text = std::str::from_utf8(&bytes).expect("utf8");
    assert!(
        text.contains("serialization loss"),
        "plain-text body must be preserved verbatim, got: {text}"
    );
}

#[tokio::test]
async fn migrated_envelope_does_not_introduce_top_level_ok_field() {
    // MVP wire shape is {code, message, retryable, retryAfterMs?, hint?}.
    // A1 deliberately does NOT add an `ok: false` discriminator because
    // HTTP status already conveys success/failure, and adding `ok`
    // would shadow TUI's existing `ok: bool` field convention in
    // success responses. If a future PR proposes adding `ok`, this
    // test will fail and the proposer must justify the inconsistency.
    let app = fixture_router();
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/demo/retry")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("request ok");

    let (_, body) = body_json(response).await;
    assert!(
        body.get("ok").is_none(),
        "MVP wire shape must not introduce top-level `ok` field; got {body}"
    );
}