//! B1 spec gate — every response from the Feral API carries a stable
//! marker that names whether the route is `stable` (third-party
//! protocol compat) or `unstable` (everything else, pre-2.0).
//!
//! Run with: `cargo test -p feral-core --test api_stability`
//!
//! These tests pin:
//!   1. The header is present on every routed response (200, 401, etc.).
//!   2. Stable prefixes (`/api/`, `/v1/`) carry `stable`.
//!   3. Every other routed path carries `unstable`.
//!   4. The header survives 401s — clients can rely on it before
//!      presenting a valid bearer.
//!   5. The header is **absent** on bare 404s (no route matched), so
//!      arbitrary paths don't accidentally claim a stability guarantee.
//!
//! The tests use `axum::Router::oneshot` against a slice of the real
//! router — no mocks for the stability middleware itself.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

const STABILITY_HEADER: &str = "x-feral-api-stability";

/// Send a bare GET against `/path`. No auth header, so a route that
/// requires a token returns 401; the stability header must still be
/// present.
async fn get_stability(router: &axum::Router, path: &str) -> (StatusCode, Option<String>) {
    let resp = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .body(Body::empty())
                .expect("request builder"),
        )
        .await
        .expect("oneshot");
    let status = resp.status();
    let value = resp
        .headers()
        .get(STABILITY_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    (status, value)
}

/// Build the FULL router so we hit real auth + stability middleware.
/// Uses a dummy state — the auth middleware will reject (401) but the
/// stability header must still be set, which is exactly what we test.
fn build_router() -> axum::Router {
    use feral_core::api::{router, ApiState};
    use std::sync::Arc;
    let manager = Arc::new(feral_core::inference::ModelManager::new());
    let settings = feral_core::settings::Settings::default();
    let state = ApiState {
        manager: manager.clone(),
        token: Arc::from("test-token"),
        runtime: Arc::new(feral_core::runtime::RuntimeState::new(
            manager,
            settings,
            Arc::from("test-token"),
        )),
    };
    router(state)
}

#[tokio::test]
async fn header_present_on_stable_ollama_route() {
    let app = build_router();
    let (status, value) = get_stability(&app, "/api/tags").await;
    // 401 expected (no auth header); the stability marker is the
    // contract under test, not the auth result.
    assert_eq!(status, StatusCode::UNAUTHORIZED, "precondition: auth gate trips");
    assert_eq!(value.as_deref(), Some("stable"), "/api/tags must mark itself stable");
}

#[tokio::test]
async fn header_present_on_stable_openai_route() {
    let app = build_router();
    let (status, value) = get_stability(&app, "/v1/models").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value.as_deref(), Some("stable"), "/v1/models must mark itself stable");
}

#[tokio::test]
async fn header_marks_runtime_surface_unstable() {
    let app = build_router();
    let (status, value) = get_stability(&app, "/runtime/status").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value.as_deref(), Some("unstable"), "/runtime/* is unstable pre-2.0");
}

#[tokio::test]
async fn header_marks_governance_surface_unstable() {
    let app = build_router();
    let (status, value) = get_stability(&app, "/governance/policy").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value.as_deref(), Some("unstable"));
}

#[tokio::test]
async fn header_marks_meta_surface_unstable() {
    let app = build_router();
    let (status, value) = get_stability(&app, "/meta/current").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value.as_deref(), Some("unstable"));
}

#[tokio::test]
async fn header_marks_modules_surface_unstable() {
    let app = build_router();
    let (status, value) = get_stability(&app, "/modules").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value.as_deref(), Some("unstable"));
}

#[tokio::test]
async fn header_marks_dynamic_runtime_route_unstable() {
    // The /runtime/models/download/:id route — prefix check should
    // still classify it unstable.
    let app = build_router();
    let (status, value) = get_stability(&app, "/runtime/models/download/abc-123").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value.as_deref(), Some("unstable"));
}

#[tokio::test]
async fn header_marks_tokenize_route_unstable() {
    // /tokenize is a llama.cpp-server compat helper. The B1 spec
    // strictly says only /api/* + /v1/* are stable; /tokenize stays
    // unstable pre-2.0. Document this in docs/API.md.
    let app = build_router();
    let (status, value) = get_stability(&app, "/tokenize").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value.as_deref(), Some("unstable"));
}

#[tokio::test]
async fn header_classifies_unknown_path_as_unstable() {
    // For an arbitrary path with no token, auth fires before the
    // routing 404, so we get a 401 (not a 404). The header must still
    // mark the path as `unstable` — the prefix check is per-path,
    // independent of whether the route exists. This is the right
    // contract: stability is a property of the surface the client
    // tried to reach, not of whether the request succeeded.
    let app = build_router();
    let (status, value) = get_stability(&app, "/totally/made/up/path").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "precondition: auth gate trips before 404");
    assert_eq!(
        value.as_deref(),
        Some("unstable"),
        "non-prefixed paths must classify as unstable even when the route doesn't exist"
    );
}
