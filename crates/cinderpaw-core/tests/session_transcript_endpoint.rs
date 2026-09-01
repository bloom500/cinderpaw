//! A3 — `GET /runtime/sessions/:id/transcript` contract tests.
//!
//! Mirrors the conventions of `tests/connectors_endpoints.rs`:
//! hermetic `CINDERPAW_HOME` tempdir, full router with the bearer
//! middleware, axum `oneshot` per request, JSON bodies via serde_json.
//!
//! The browser chat surface consumes this endpoint to backfill the
//! transcript when a saved session is opened or when the tab is
//! refreshed mid-conversation. The test guards four properties the
//! browser relies on:
//!   1. The happy path returns the saved messages with the
//!      expected `{role, content, created_at}` shape.
//!   2. A non-UUID id (or any non-alphanumeric id) is rejected
//!      with 400 before the filesystem is touched — this is the
//!      path-traversal defence the BFF would otherwise need.
//!   3. A missing id returns 404 with a typed error code so the
//!      browser can render an empty chat rather than crash.
//!   4. A corrupt on-disk file returns 502 (data is wrong, not
//!      missing) and never panics.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use tower::ServiceExt;

const TOKEN: &str = "test-token";

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    prev: Option<std::ffi::OsString>,
    _lock: MutexGuard<'static, ()>,
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.prev.take() {
            Some(v) => std::env::set_var("CINDERPAW_HOME", v),
            None => std::env::remove_var("CINDERPAW_HOME"),
        }
    }
}

fn temp_cinderpaw_home() -> (tempfile::TempDir, EnvGuard) {
    let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::Builder::new()
        .prefix("cinderpaw-transcript-test-")
        .tempdir()
        .expect("tempdir");
    let prev = std::env::var_os("CINDERPAW_HOME");
    std::env::set_var("CINDERPAW_HOME", tmp.path());
    (tmp, EnvGuard { prev, _lock: lock })
}

fn build_router() -> axum::Router {
    use cinderpaw_core::api::{router, ApiState};
    use std::sync::Arc;
    let manager = Arc::new(cinderpaw_core::inference::ModelManager::new());
    let settings = cinderpaw_core::settings::Settings::default();
    let state = ApiState {
        manager: manager.clone(),
        token: Arc::from(TOKEN),
        runtime: Arc::new(cinderpaw_core::runtime::RuntimeState::new(
            manager,
            settings,
            Arc::from(TOKEN),
        )),
    };
    router(state)
}

/// Write one session file directly to the temp conversations dir so
/// the test does not depend on the desktop save/load path.
fn write_session(dir: &std::path::Path, id: &str, body: &Value) {
    let conversations = dir.join("conversations");
    std::fs::create_dir_all(&conversations).expect("mkdir conversations");
    let path = conversations.join(format!("{id}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(body).expect("serialise"))
        .expect("write session file");
}

const ID: &str = "099558f2-7fa0-481c-9cce-1a675c2dfb41";

#[tokio::test]
async fn get_session_transcript_returns_saved_messages() {
    let (tmp, _guard) = temp_cinderpaw_home();
    write_session(
        tmp.path(),
        ID,
        &json!({
            "id": ID,
            "title": "Hello, Cinderpaw",
            "created_at": "2026-08-31T08:36:48.832925800+00:00",
            "updated_at": "2026-08-31T08:55:39.853465100+00:00",
            "messages": [
                { "role": "user",      "content": "Hello.", "created_at": 1 },
                { "role": "assistant", "content": "Hi there.", "created_at": 2 },
                { "role": "user",      "content": "How are you?", "created_at": 3 },
                { "role": "assistant", "content": "Doing well.", "created_at": 4 },
            ],
        }),
    );

    let app = build_router();
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/runtime/sessions/{ID}/transcript"))
                .header("Authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&body).expect("valid JSON");

    assert_eq!(value.get("id").and_then(|v| v.as_str()), Some(ID));
    assert_eq!(value.get("title").and_then(|v| v.as_str()), Some("Hello, Cinderpaw"));
    assert_eq!(
        value.get("updated_at").and_then(|v| v.as_str()),
        Some("2026-08-31T08:55:39.853465100+00:00"),
    );

    let messages = value
        .get("messages")
        .and_then(|m| m.as_array())
        .expect("messages array");
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0].get("role").and_then(|v| v.as_str()), Some("user"));
    assert_eq!(messages[0].get("content").and_then(|v| v.as_str()), Some("Hello."));
    assert_eq!(messages[0].get("created_at").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(messages[3].get("role").and_then(|v| v.as_str()), Some("assistant"));
    assert_eq!(messages[3].get("content").and_then(|v| v.as_str()), Some("Doing well."));
}

#[tokio::test]
async fn get_session_transcript_rejects_path_traversal() {
    let (tmp, _guard) = temp_cinderpaw_home();
    // Plant a canary file OUTSIDE the conversations dir. If the path
    // validation is broken, the request will read this and 200.
    let canary = tmp.path().join("canary.txt");
    std::fs::write(&canary, b"THIS MUST NOT BE LEAKED").expect("canary");

    let app = build_router();
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                // axum's Path<String> will reject the raw `..` literal
                // at the routing layer, but we still test the alnum
                // guard by sending a slash-bearing id; the percent
                // form tests that even URL-decoded traversal tokens
                // are caught.
                .uri("/runtime/sessions/..%2F..%2Fcanary/transcript")
                .header("Authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // axum's router resolves `..` to the path with literal dots; the
    // route does not match (no `/transcript` suffix) and returns 404.
    // The canary is never read.
    assert_ne!(resp.status(), StatusCode::OK);

    // Now a non-UUID id that DOES match the route. `abc.def` is
    // alphanumeric-but-dotted, which the alnum guard rejects.
    let resp2 = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/runtime/sessions/abc.def/transcript")
                .header("Authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(resp2.into_body(), 1024 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&body).expect("JSON error envelope");
    assert_eq!(value.get("code").and_then(|v| v.as_str()), Some("invalid_session_id"));

    // And an empty id (percent-decoded empty) hits the empty-string
    // branch of the guard. The router will not match `/runtime/sessions//transcript`
    // (no `:id` segment) so this is 404 at the router level — also
    // safe, also no filesystem access.
}

#[tokio::test]
async fn get_session_transcript_returns_404_for_missing_session() {
    let (_tmp, _guard) = temp_cinderpaw_home();
    let app = build_router();
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/runtime/sessions/{ID}/transcript"))
                .header("Authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&body).expect("JSON error envelope");
    assert_eq!(value.get("code").and_then(|v| v.as_str()), Some("session_not_found"));
    assert_eq!(
        value.get("retryable").and_then(|v| v.as_bool()),
        Some(false),
        "a missing transcript is a user-facing state, not a transient error",
    );
}

#[tokio::test]
async fn get_session_transcript_returns_502_for_corrupt_file() {
    let (tmp, _guard) = temp_cinderpaw_home();
    let conversations = tmp.path().join("conversations");
    std::fs::create_dir_all(&conversations).expect("mkdir");
    std::fs::write(conversations.join(format!("{ID}.json")), b"not json {{{{").expect("write");

    let app = build_router();
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/runtime/sessions/{ID}/transcript"))
                .header("Authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&body).expect("JSON error envelope");
    assert_eq!(value.get("code").and_then(|v| v.as_str()), Some("transcript_corrupt"));
}

#[tokio::test]
async fn get_session_transcript_requires_bearer() {
    let (_tmp, _guard) = temp_cinderpaw_home();
    let app = build_router();
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/runtime/sessions/{ID}/transcript"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}
