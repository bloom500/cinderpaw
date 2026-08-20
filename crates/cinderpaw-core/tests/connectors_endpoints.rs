//! R6 — `/runtime/connectors` GET/POST contract tests.
//!
//! Mirrors `tests/api_stability.rs`'s full-router + bearer-token pattern
//! and `tests/byok_save_provider.rs`'s hermetic `FERAL_HOME` tempdir
//! pattern (both established conventions; not new ones invented here).

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use tower::ServiceExt;

const TOKEN: &str = "test-token";

/// Process-global serialisation for tests that mutate `FERAL_HOME`.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Restores the prior `FERAL_HOME` (or removes it) when dropped. Held across
/// `.await` points for the lifetime of the test body — safe here because
/// `#[tokio::test]` defaults to a current-thread runtime (no `Send` bound on
/// the test future), matching `rsi::test_support::with_temp_feral_home`'s
/// same-crate equivalent.
struct EnvGuard {
    prev: Option<std::ffi::OsString>,
    _lock: MutexGuard<'static, ()>,
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.prev.take() {
            Some(v) => std::env::set_var("FERAL_HOME", v),
            None => std::env::remove_var("FERAL_HOME"),
        }
    }
}

fn temp_feral_home() -> (tempfile::TempDir, EnvGuard) {
    let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::Builder::new()
        .prefix("feral-connectors-test-")
        .tempdir()
        .expect("tempdir");
    let prev = std::env::var_os("FERAL_HOME");
    std::env::set_var("FERAL_HOME", tmp.path());
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

#[tokio::test]
async fn get_runtime_connectors_never_returns_secret_values() {
    let (_tmp, _guard) = temp_feral_home();
    let app = build_router();

    let post_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime/connectors")
                .header("Authorization", format!("Bearer {TOKEN}"))
                .header("Content-Type", "application/json")
                .body(Body::from(
                    json!({
                        "id": "discord",
                        "enabled": true,
                        "secrets": { "DISCORD_TOKEN": "sekret-value-12345" }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(post_resp.status(), StatusCode::OK);
    let post_body = to_bytes(post_resp.into_body(), 1024 * 1024).await.unwrap();
    let post_text = String::from_utf8_lossy(&post_body);
    assert!(
        !post_text.contains("sekret-value-12345"),
        "POST response must not echo the raw secret: {post_text}"
    );

    let get_resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/connectors")
                .header("Authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_resp.status(), StatusCode::OK);
    let get_body = to_bytes(get_resp.into_body(), 1024 * 1024).await.unwrap();
    let get_text = String::from_utf8_lossy(&get_body);
    assert!(
        !get_text.contains("sekret-value-12345"),
        "GET response must never contain the raw secret value: {get_text}"
    );

    let value: Value = serde_json::from_str(&get_text).expect("valid JSON");
    let discord = value
        .as_array()
        .expect("array")
        .iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some("discord"))
        .expect("discord entry present");
    let filled = discord.get("filled").and_then(|f| f.as_array()).expect("filled array");
    assert!(
        filled.iter().any(|v| v.as_str() == Some("DISCORD_TOKEN")),
        "discord.filled must report DISCORD_TOKEN, got {discord:?}"
    );
    assert_eq!(discord.get("enabled").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn post_runtime_connectors_rejects_unknown_id() {
    let (_tmp, _guard) = temp_feral_home();
    let app = build_router();
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/runtime/connectors")
                .header("Authorization", format!("Bearer {TOKEN}"))
                .header("Content-Type", "application/json")
                .body(Body::from(json!({ "id": "not-a-real-connector" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}
