//! "Send to Google Docs": one Google login, then one click per document.
//!
//! The login is the standard OAuth flow for an installed app, run inside the
//! built-in browser: Google's consent page opens in the Browser panel, and
//! when the person approves, Google sends the browser to `127.0.0.1:<port>`,
//! where this module is listening for that one request. The refresh token
//! goes to the OS keychain under `google-docs`; nothing else is stored.
//!
//! Scope is `drive.file` only: Cinderpaw sees the files it created and no
//! other file in the person's Drive.
//!
//! The OAuth client (id + secret) is Cinderpaw's registration with Google, not
//! the person's. It is baked in at build time (`CINDERPAW_GOOGLE_CLIENT_ID` /
//! `_SECRET`), with `~/.cinderpaw/google-oauth-client.json` as the developer
//! fallback. Google documents that an installed app's secret is not a secret.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const KEYCHAIN_ID: &str = "google-docs";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

struct Client {
    id: String,
    secret: String,
}

fn client() -> Result<Client, String> {
    // A CI secret that was never added arrives as "" rather than absent, and an
    // empty client id would put a button on screen that Google then rejects.
    let baked = |v: Option<&'static str>| v.filter(|s| !s.trim().is_empty());
    if let (Some(id), Some(secret)) = (baked(option_env!("CINDERPAW_GOOGLE_CLIENT_ID")), baked(option_env!("CINDERPAW_GOOGLE_CLIENT_SECRET"))) {
        return Ok(Client { id: id.into(), secret: secret.into() });
    }
    let path = cinderpaw_core::paths::cinderpaw_dir().join("google-oauth-client.json");
    let text = std::fs::read_to_string(&path).map_err(|_| {
        "This build of Cinderpaw is not registered with Google, so Google Docs cannot be connected.".to_string()
    })?;
    #[derive(Deserialize)]
    struct File { client_id: String, client_secret: String }
    let f: File = serde_json::from_str(&text).map_err(|e| format!("google-oauth-client.json is not readable: {e}"))?;
    Ok(Client { id: f.client_id, secret: f.client_secret })
}

/// Whether this build can talk to Google at all. A build made without the
/// client (a fork, a local build, a release whose CI secret is missing) hides
/// the button instead of offering one that can only fail.
pub fn is_registered() -> bool {
    client().is_ok()
}

pub fn is_connected() -> bool {
    cinderpaw_core::byok::byok_get(KEYCHAIN_ID).is_some_and(|t| !t.trim().is_empty())
}

fn random_token() -> String {
    uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string()
}

fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine as _;
    use sha2::Digest as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()))
}

/// Log the person in. Opens Google's consent page in the built-in browser and
/// waits (up to five minutes) for Google to send it back to us with a code.
pub async fn connect(app: AppHandle) -> Result<(), String> {
    let c = client()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/");
    let state = random_token();
    let verifier = random_token();
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        urlencoding::encode(&c.id), urlencoding::encode(&redirect), urlencoding::encode(SCOPE),
        state, pkce_challenge(&verifier),
    );
    crate::browser::handle(app.clone(), "open", &json!({ "url": auth_url })).await?;

    let code = tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let line = req.lines().next().unwrap_or("");
            let path = line.split_whitespace().nth(1).unwrap_or("/");
            let url = url::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|e| e.to_string())?;
            let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            let (body, result) = match (q.get("code"), q.get("state"), q.get("error")) {
                (Some(code), Some(s), _) if *s == state => ("Connected to Cinderpaw. You can go back to the app.", Some(Ok(code.clone()))),
                (_, _, Some(err)) => ("Google did not connect Cinderpaw.", Some(Err(format!("Google refused: {err}")))),
                _ => ("", None), // a favicon request or a stray hit; keep waiting
            };
            if !body.is_empty() {
                let html = format!("<!doctype html><meta charset=utf-8><body style=\"font:16px system-ui;padding:40px\">{body}</body>");
                let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html).as_bytes()).await;
            }
            if let Some(r) = result { return r; }
        }
    })
    .await
    .map_err(|_| "Google did not answer within five minutes.".to_string())??;

    let tokens: Value = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()), ("client_id", c.id.as_str()), ("client_secret", c.secret.as_str()),
            ("redirect_uri", redirect.as_str()), ("grant_type", "authorization_code"), ("code_verifier", verifier.as_str()),
        ])
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let refresh = tokens.get("refresh_token").and_then(|v| v.as_str())
        .ok_or_else(|| format!("Google gave no refresh token: {}", tokens.get("error_description").and_then(|v| v.as_str()).unwrap_or("unknown reason")))?;
    cinderpaw_core::byok::byok_set(KEYCHAIN_ID, refresh).map_err(|e| format!("could not store the Google token: {e}"))?;
    let _ = app.emit("google://connected", json!({ "connected": true }));
    Ok(())
}

pub fn disconnect() -> Result<(), String> {
    cinderpaw_core::byok::byok_set(KEYCHAIN_ID, "").map_err(|e| e.to_string())
}

async fn access_token() -> Result<String, String> {
    let c = client()?;
    let refresh = cinderpaw_core::byok::byok_get(KEYCHAIN_ID).filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "Google is not connected yet.".to_string())?;
    let v: Value = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[("refresh_token", refresh.as_str()), ("client_id", c.id.as_str()), ("client_secret", c.secret.as_str()), ("grant_type", "refresh_token")])
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    v.get("access_token").and_then(|t| t.as_str()).map(String::from)
        .ok_or_else(|| "Google no longer accepts the saved login; connect again.".to_string())
}

/// Upload one file to the person's Drive. `convert` turns text or HTML into a
/// Google Doc; a PDF is kept as it is (converting it goes through OCR and
/// loses the layout). Returns the link to open it.
pub async fn upload(name: &str, mime: &str, bytes: Vec<u8>, convert: bool) -> Result<String, String> {
    let token = access_token().await?;
    let mut meta = json!({ "name": name });
    if convert { meta["mimeType"] = json!("application/vnd.google-apps.document"); }
    let form = reqwest::multipart::Form::new()
        .part("metadata", reqwest::multipart::Part::text(meta.to_string()).mime_str("application/json; charset=UTF-8").map_err(|e| e.to_string())?)
        .part("file", reqwest::multipart::Part::bytes(bytes).mime_str(mime).map_err(|e| e.to_string())?);
    let res = reqwest::Client::new()
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,mimeType,webViewLink")
        .bearer_auth(token)
        .multipart(form)
        .send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Google refused the upload: {}", v["error"]["message"].as_str().unwrap_or("unknown error")));
    }
    let id = v["id"].as_str().unwrap_or_default();
    Ok(v["webViewLink"].as_str().map(String::from).unwrap_or_else(|| {
        if convert { format!("https://docs.google.com/document/d/{id}/edit") } else { format!("https://drive.google.com/file/d/{id}/view") }
    }))
}
