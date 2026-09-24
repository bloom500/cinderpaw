//! Spec 2026-09-24 §8.2: the browser session is HttpOnly + SameSite=Strict,
//! a foreign Origin or a rebinding Host is refused even with a valid cookie,
//! a code works once, and the bearer path is unchanged.
//!
//! Run: cargo test -p cinderpaw-core --test web_session

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use std::sync::Arc;
use tower::ServiceExt;

use cinderpaw_core::api::{router, ApiState};
use cinderpaw_core::web::{Assets, WebUi, COOKIE};

static ASSETS: Assets = Assets { index_html: "<div id=\"root\"></div>", app_js: "console.log(1)", app_css: "body{}" };
const PORT: u16 = 11435;
const HOST: &str = "127.0.0.1:11435";
const ORIGIN: &str = "http://127.0.0.1:11435";

fn app(with_web: bool, dir: &std::path::Path) -> (axum::Router, Option<Arc<WebUi>>) {
    let manager = Arc::new(cinderpaw_core::inference::ModelManager::new());
    let runtime = Arc::new(cinderpaw_core::runtime::RuntimeState::new(
        manager.clone(),
        cinderpaw_core::settings::Settings::default(),
        Arc::from("test-token"),
    ));
    runtime.api_port_actual.store(PORT, std::sync::atomic::Ordering::SeqCst);
    let web = with_web.then(|| Arc::new(WebUi::new(&ASSETS, dir.join("web-sessions.json"), cinderpaw_core::web::unix_now())));
    let state = ApiState { manager, token: Arc::from("test-token"), runtime, web: web.clone() };
    (router(state), web)
}

async fn send(app: &axum::Router, req: Request<Body>) -> axum::response::Response {
    app.clone().oneshot(req).await.unwrap()
}

async fn signed_in(app: &axum::Router) -> String {
    let code_resp = send(app, Request::post("/web/code").header(header::AUTHORIZATION, "Bearer test-token").body(Body::empty()).unwrap()).await;
    assert_eq!(code_resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(code_resp.into_body(), 1 << 16).await.unwrap();
    let code = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["code"].as_str().unwrap().to_string();
    let resp = send(app, Request::post("/web/session").header(header::HOST, HOST).header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json").body(Body::from(format!("{{\"code\":\"{code}\"}}"))).unwrap()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let set = resp.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().to_string();
    assert!(set.contains("HttpOnly") && set.contains("SameSite=Strict"), "{set}");
    set.split(';').next().unwrap().to_string() // "cinderpaw_session=<id>"
}

fn me(cookie: &str, host: &str, origin: Option<&str>) -> Request<Body> {
    let mut b = Request::get("/runtime/status").header(header::HOST, host).header(header::COOKIE, cookie);
    if let Some(o) = origin { b = b.header(header::ORIGIN, o); }
    b.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn the_page_is_served_without_auth_and_holds_no_token() {
    let d = tempfile::tempdir().unwrap();
    let (app, _) = app(true, d.path());
    let resp = send(&app, Request::get("/").header(header::HOST, HOST).body(Body::empty()).unwrap()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
    assert!(!String::from_utf8_lossy(&body).contains("test-token"));
}

#[tokio::test]
async fn a_cookie_from_our_own_address_works() {
    let d = tempfile::tempdir().unwrap();
    let (app, _) = app(true, d.path());
    let cookie = signed_in(&app).await;
    assert!(cookie.starts_with(COOKIE));
    assert_eq!(send(&app, me(&cookie, HOST, None)).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_foreign_origin_or_rebinding_host_is_refused_even_with_a_valid_cookie() {
    let d = tempfile::tempdir().unwrap();
    let (app, _) = app(true, d.path());
    let cookie = signed_in(&app).await;
    assert_eq!(send(&app, me(&cookie, HOST, Some("http://evil.example"))).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(send(&app, me(&cookie, "evil.example:11435", None)).await.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_code_works_once() {
    let d = tempfile::tempdir().unwrap();
    let (app, web) = app(true, d.path());
    let code = web.unwrap().issue_code(cinderpaw_core::web::unix_now());
    let post = |c: &str| Request::post("/web/session").header(header::HOST, HOST).header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json").body(Body::from(format!("{{\"code\":\"{c}\"}}"))).unwrap();
    assert_eq!(send(&app, post(&code)).await.status(), StatusCode::OK);
    assert_eq!(send(&app, post(&code)).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn minting_a_code_needs_the_bearer_token_not_a_cookie() {
    let d = tempfile::tempdir().unwrap();
    let (app, _) = app(true, d.path());
    let cookie = signed_in(&app).await;
    let req = Request::post("/web/code").header(header::HOST, HOST).header(header::ORIGIN, ORIGIN).header(header::COOKIE, cookie).body(Body::empty()).unwrap();
    assert_eq!(send(&app, req).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_bearer_path_is_unchanged() {
    let d = tempfile::tempdir().unwrap();
    let (app, _) = app(true, d.path());
    let ok = Request::get("/runtime/status").header(header::AUTHORIZATION, "Bearer test-token").body(Body::empty()).unwrap();
    assert_eq!(send(&app, ok).await.status(), StatusCode::OK);
    let none = Request::get("/runtime/status").body(Body::empty()).unwrap();
    assert_eq!(send(&app, none).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn without_a_web_ui_nothing_new_exists() {
    // The Desktop app: the page paths stay behind the token like any path
    // (401 without it), and with the token there is still nothing there.
    let d = tempfile::tempdir().unwrap();
    let (app, _) = app(false, d.path());
    assert_eq!(send(&app, Request::get("/").body(Body::empty()).unwrap()).await.status(), StatusCode::UNAUTHORIZED);
    let with_token = Request::post("/web/code").header(header::AUTHORIZATION, "Bearer test-token").body(Body::empty()).unwrap();
    assert_eq!(send(&app, with_token).await.status(), StatusCode::NOT_FOUND);
}
