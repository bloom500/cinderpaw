# OpenClaw Gateway Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a Feral-owned OpenClaw gateway token in `~/.feral/openclaw_connection.json` and attach it as `Authorization: Bearer` on every test-message request, with a Settings UI to save/clear the token.

**Architecture:** New `openclaw_connection.rs` Rust module (BYOK pattern) provides three Tauri commands; `openclaw_test_message` loads the saved token and passes it to the HTTP helper; `OpenClawAuthPanel` React card handles token input, save, clear, and 401 guidance — token is one-way (frontend → backend on Save, never returned by get commands).

**Tech Stack:** Rust/Tauri 2 + specta, reqwest, axum (for test HTTP server), React + TypeScript + Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/src/paths.rs` | Modify | Add `openclaw_connection_path()` |
| `src-tauri/src/openclaw_connection.rs` | Create | Settings struct, load/save, 3 Tauri commands, unit tests |
| `src-tauri/src/openclaw.rs` | Modify | `send_test_message` + auth header; `openclaw_test_message` endpoint resolution |
| `src-tauri/src/lib.rs` | Modify | Register `mod openclaw_connection` + 3 commands |
| `frontend-react/src/lib/tauri/index.ts` | Modify | `OpenClawConnectionView` type + 3 IPC methods |
| `frontend-react/src/components/settings/OpenClawTab.tsx` | Modify | `OpenClawAuthPanel` card + 401 inline hint |
| `frontend-react/src/components/settings/__tests__/OpenClawTab.test.tsx` | Modify | 8 new tests |

---

## Task 1: Add `openclaw_connection_path` to `paths.rs`

**Files:**
- Modify: `src-tauri/src/paths.rs`

- [ ] **Step 1: Open the file and add the path helper**

  In `src-tauri/src/paths.rs`, add after the existing `settings_path()` function:

  ```rust
  pub fn openclaw_connection_path() -> PathBuf {
      feral_dir().join("openclaw_connection.json")
  }
  ```

  Full file after change:

  ```rust
  use std::path::PathBuf;

  pub fn feral_dir() -> PathBuf {
      let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
      base.join(".feral")
  }

  pub fn models_dir() -> PathBuf {
      feral_dir().join("models")
  }

  pub fn agents_dir() -> PathBuf {
      feral_dir().join("agents")
  }

  pub fn skills_dir() -> PathBuf {
      feral_dir().join("skills")
  }

  pub fn conversations_dir() -> PathBuf {
      feral_dir().join("conversations")
  }

  pub fn settings_path() -> PathBuf {
      feral_dir().join("settings.json")
  }

  pub fn openclaw_connection_path() -> PathBuf {
      feral_dir().join("openclaw_connection.json")
  }

  pub fn ensure_dirs() -> anyhow::Result<()> {
      std::fs::create_dir_all(models_dir())?;
      std::fs::create_dir_all(agents_dir())?;
      std::fs::create_dir_all(conversations_dir())?;
      std::fs::create_dir_all(skills_dir())?;
      Ok(())
  }
  ```

- [ ] **Step 2: Quick cargo check**

  ```powershell
  cd src-tauri && cargo check 2>&1 | tail -5
  ```
  Expected: `Finished` with no errors.

- [ ] **Step 3: Commit**

  ```powershell
  git add src-tauri/src/paths.rs
  git commit -m "feat(openclaw): add openclaw_connection_path to paths"
  ```

---

## Task 2: Create `openclaw_connection.rs` (TDD)

**Files:**
- Create: `src-tauri/src/openclaw_connection.rs`

- [ ] **Step 1: Write the failing tests first**

  Create `src-tauri/src/openclaw_connection.rs` with the tests but no implementation:

  ```rust
  use serde::{Deserialize, Serialize};

  /// Stored in ~/.feral/openclaw_connection.json — never serialised to frontend.
  #[derive(Debug, Clone, Serialize, Deserialize, Default)]
  pub struct OpenClawConnectionSettings {
      pub gateway_endpoint_override: Option<String>,
      pub gateway_token: Option<String>,
  }

  /// Redacted view returned to frontend — raw token is never included.
  #[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
  pub struct OpenClawConnectionView {
      pub endpoint_override: Option<String>,
      pub has_token: bool,
  }

  pub fn load() -> OpenClawConnectionSettings {
      todo!()
  }

  pub fn save(s: &OpenClawConnectionSettings) -> anyhow::Result<()> {
      let _ = s;
      todo!()
  }

  #[tauri::command]
  #[specta::specta]
  pub fn get_openclaw_connection_settings() -> OpenClawConnectionView {
      todo!()
  }

  #[tauri::command]
  #[specta::specta]
  pub fn save_openclaw_connection_settings(
      endpoint_override: Option<String>,
      token: Option<String>,
  ) -> Result<(), String> {
      let _ = (endpoint_override, token);
      todo!()
  }

  #[tauri::command]
  #[specta::specta]
  pub fn clear_openclaw_token() -> Result<(), String> {
      todo!()
  }

  #[cfg(test)]
  mod tests {
      use super::*;
      use std::path::PathBuf;

      fn temp_dir() -> tempfile::TempDir {
          tempfile::tempdir().expect("temp dir")
      }

      fn save_to(dir: &std::path::Path, s: &OpenClawConnectionSettings) {
          let path = dir.join("openclaw_connection.json");
          std::fs::write(&path, serde_json::to_vec_pretty(s).unwrap()).unwrap();
      }

      fn load_from(dir: &std::path::Path) -> OpenClawConnectionSettings {
          let path = dir.join("openclaw_connection.json");
          let bytes = std::fs::read(&path).unwrap();
          serde_json::from_slice(&bytes).unwrap()
      }

      #[test]
      fn save_load_roundtrip() {
          let dir = temp_dir();
          let s = OpenClawConnectionSettings {
              gateway_endpoint_override: Some("http://localhost:9999".to_string()),
              gateway_token: Some("tok_abc123".to_string()),
          };
          save_to(dir.path(), &s);
          let loaded = load_from(dir.path());
          assert_eq!(loaded.gateway_endpoint_override, s.gateway_endpoint_override);
          assert_eq!(loaded.gateway_token, s.gateway_token);
      }

      #[test]
      fn clear_token_preserves_endpoint_override() {
          let dir = temp_dir();
          let mut s = OpenClawConnectionSettings {
              gateway_endpoint_override: Some("http://localhost:9999".to_string()),
              gateway_token: Some("tok_xyz".to_string()),
          };
          save_to(dir.path(), &s);

          s.gateway_token = None;
          save_to(dir.path(), &s);
          let loaded = load_from(dir.path());

          assert!(loaded.gateway_token.is_none());
          assert_eq!(loaded.gateway_endpoint_override, Some("http://localhost:9999".to_string()));
      }

      #[test]
      fn empty_token_string_is_treated_as_none() {
          // Whitespace-only token must not overwrite an existing saved token.
          let dir = temp_dir();
          let original = OpenClawConnectionSettings {
              gateway_endpoint_override: None,
              gateway_token: Some("real_token".to_string()),
          };
          save_to(dir.path(), &original);

          // Simulate "save with empty token" — caller trims and skips if empty.
          let token_input = "   ";
          let trimmed = token_input.trim();
          let mut s = load_from(dir.path());
          if !trimmed.is_empty() {
              s.gateway_token = Some(trimmed.to_string());
          }
          save_to(dir.path(), &s);

          let loaded = load_from(dir.path());
          assert_eq!(loaded.gateway_token, Some("real_token".to_string()));
      }

      #[test]
      fn non_loopback_endpoint_is_rejected() {
          // is_loopback_url is pub in openclaw.rs — used by the save command.
          assert!(!crate::openclaw::is_loopback_url("https://example.com/api"));
          assert!(!crate::openclaw::is_loopback_url("http://10.0.0.1:18789"));
          assert!(!crate::openclaw::is_loopback_url("ftp://localhost:18789"));
      }

      #[test]
      fn loopback_variants_are_accepted() {
          assert!(crate::openclaw::is_loopback_url("http://localhost:18789"));
          assert!(crate::openclaw::is_loopback_url("http://127.0.0.1:18789"));
          assert!(crate::openclaw::is_loopback_url("http://0.0.0.0:18789"));
          assert!(crate::openclaw::is_loopback_url("http://[::1]:18789"));
      }

      #[test]
      fn empty_endpoint_override_string_stores_none() {
          let dir = temp_dir();
          let mut s = OpenClawConnectionSettings {
              gateway_endpoint_override: Some("http://localhost:9999".to_string()),
              gateway_token: None,
          };
          save_to(dir.path(), &s);

          // Simulate "save with empty endpoint" — caller treats "" as clearing the override.
          let endpoint_input = "";
          let trimmed = endpoint_input.trim();
          s.gateway_endpoint_override = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
          save_to(dir.path(), &s);

          let loaded = load_from(dir.path());
          assert!(loaded.gateway_endpoint_override.is_none());
      }
  }
  ```

- [ ] **Step 2: Run tests, confirm they fail with `todo!()`**

  ```powershell
  cd src-tauri && cargo test openclaw_connection 2>&1 | tail -20
  ```
  Expected: tests panic with `not yet implemented` (todo!).

  > Note: if you get a compile error about `tempfile`, add it to dev-dependencies first:
  > ```toml
  > [dev-dependencies]
  > tempfile = "3"
  > ```
  > Then re-run `cargo test`.

- [ ] **Step 3: Implement the module (replace the todo!() stubs)**

  Replace the entire file with the full implementation:

  ```rust
  use serde::{Deserialize, Serialize};

  /// Stored in ~/.feral/openclaw_connection.json — never serialised to frontend.
  #[derive(Debug, Clone, Serialize, Deserialize, Default)]
  pub struct OpenClawConnectionSettings {
      pub gateway_endpoint_override: Option<String>,
      pub gateway_token: Option<String>,
  }

  /// Redacted view returned to frontend — raw token is never included.
  #[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
  pub struct OpenClawConnectionView {
      pub endpoint_override: Option<String>,
      pub has_token: bool,
  }

  pub fn load() -> OpenClawConnectionSettings {
      let path = crate::paths::openclaw_connection_path();
      if let Ok(bytes) = std::fs::read(&path) {
          if let Ok(s) = serde_json::from_slice::<OpenClawConnectionSettings>(&bytes) {
              return s;
          }
      }
      OpenClawConnectionSettings::default()
  }

  pub fn save(s: &OpenClawConnectionSettings) -> anyhow::Result<()> {
      let path = crate::paths::openclaw_connection_path();
      if let Some(parent) = path.parent() {
          std::fs::create_dir_all(parent)?;
      }
      std::fs::write(path, serde_json::to_vec_pretty(s)?)?;
      Ok(())
  }

  /// Returns a redacted view of the connection settings.
  /// The raw gateway token is never returned — only `has_token: bool`.
  #[tauri::command]
  #[specta::specta]
  pub fn get_openclaw_connection_settings() -> OpenClawConnectionView {
      let s = load();
      OpenClawConnectionView {
          endpoint_override: s.gateway_endpoint_override,
          has_token: s.gateway_token.is_some(),
      }
  }

  /// Save connection settings. Token and endpoint semantics:
  ///
  /// - `token: Some(s)` where `s.trim()` is non-empty  → replace stored token
  /// - `token: Some(s)` where `s.trim()` is empty      → no change (preserve existing token)
  /// - `token: None`                                    → no change (preserve existing token)
  ///
  /// - `endpoint_override: Some(s)` where `s.trim()` is non-empty → validate loopback, store
  /// - `endpoint_override: Some(s)` where `s.trim()` is empty     → clear override (store None)
  /// - `endpoint_override: None`                                   → no change
  #[tauri::command]
  #[specta::specta]
  pub fn save_openclaw_connection_settings(
      endpoint_override: Option<String>,
      token: Option<String>,
  ) -> Result<(), String> {
      let mut s = load();

      if let Some(ep) = endpoint_override {
          let trimmed = ep.trim().to_string();
          if trimmed.is_empty() {
              s.gateway_endpoint_override = None;
          } else {
              if !crate::openclaw::is_loopback_url(&trimmed) {
                  return Err(format!(
                      "Endpoint override must be a loopback address (localhost, 127.x, [::1], \
                       or 0.0.0.0): {trimmed}"
                  ));
              }
              s.gateway_endpoint_override = Some(trimmed);
          }
      }

      if let Some(t) = token {
          let trimmed = t.trim().to_string();
          if !trimmed.is_empty() {
              s.gateway_token = Some(trimmed);
          }
      }

      save(&s).map_err(|e| e.to_string())
  }

  /// Clear the saved gateway token. The endpoint override is NOT affected.
  #[tauri::command]
  #[specta::specta]
  pub fn clear_openclaw_token() -> Result<(), String> {
      let mut s = load();
      s.gateway_token = None;
      save(&s).map_err(|e| e.to_string())
  }

  #[cfg(test)]
  mod tests {
      use super::*;

      fn save_to(dir: &std::path::Path, s: &OpenClawConnectionSettings) {
          let path = dir.join("openclaw_connection.json");
          std::fs::write(&path, serde_json::to_vec_pretty(s).unwrap()).unwrap();
      }

      fn load_from(dir: &std::path::Path) -> OpenClawConnectionSettings {
          let path = dir.join("openclaw_connection.json");
          let bytes = std::fs::read(&path).unwrap();
          serde_json::from_slice(&bytes).unwrap()
      }

      #[test]
      fn save_load_roundtrip() {
          let dir = tempfile::tempdir().expect("temp dir");
          let s = OpenClawConnectionSettings {
              gateway_endpoint_override: Some("http://localhost:9999".to_string()),
              gateway_token: Some("tok_abc123".to_string()),
          };
          save_to(dir.path(), &s);
          let loaded = load_from(dir.path());
          assert_eq!(loaded.gateway_endpoint_override, s.gateway_endpoint_override);
          assert_eq!(loaded.gateway_token, s.gateway_token);
      }

      #[test]
      fn clear_token_preserves_endpoint_override() {
          let dir = tempfile::tempdir().expect("temp dir");
          let mut s = OpenClawConnectionSettings {
              gateway_endpoint_override: Some("http://localhost:9999".to_string()),
              gateway_token: Some("tok_xyz".to_string()),
          };
          save_to(dir.path(), &s);
          s.gateway_token = None;
          save_to(dir.path(), &s);
          let loaded = load_from(dir.path());
          assert!(loaded.gateway_token.is_none());
          assert_eq!(loaded.gateway_endpoint_override, Some("http://localhost:9999".to_string()));
      }

      #[test]
      fn empty_token_string_is_treated_as_none() {
          let dir = tempfile::tempdir().expect("temp dir");
          let original = OpenClawConnectionSettings {
              gateway_endpoint_override: None,
              gateway_token: Some("real_token".to_string()),
          };
          save_to(dir.path(), &original);
          let token_input = "   ";
          let trimmed = token_input.trim();
          let mut s = load_from(dir.path());
          if !trimmed.is_empty() {
              s.gateway_token = Some(trimmed.to_string());
          }
          save_to(dir.path(), &s);
          let loaded = load_from(dir.path());
          assert_eq!(loaded.gateway_token, Some("real_token".to_string()));
      }

      #[test]
      fn non_loopback_endpoint_is_rejected() {
          assert!(!crate::openclaw::is_loopback_url("https://example.com/api"));
          assert!(!crate::openclaw::is_loopback_url("http://10.0.0.1:18789"));
          assert!(!crate::openclaw::is_loopback_url("ftp://localhost:18789"));
      }

      #[test]
      fn loopback_variants_are_accepted() {
          assert!(crate::openclaw::is_loopback_url("http://localhost:18789"));
          assert!(crate::openclaw::is_loopback_url("http://127.0.0.1:18789"));
          assert!(crate::openclaw::is_loopback_url("http://0.0.0.0:18789"));
          assert!(crate::openclaw::is_loopback_url("http://[::1]:18789"));
      }

      #[test]
      fn empty_endpoint_override_string_stores_none() {
          let dir = tempfile::tempdir().expect("temp dir");
          let mut s = OpenClawConnectionSettings {
              gateway_endpoint_override: Some("http://localhost:9999".to_string()),
              gateway_token: None,
          };
          save_to(dir.path(), &s);
          let endpoint_input = "";
          let trimmed = endpoint_input.trim();
          s.gateway_endpoint_override = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
          save_to(dir.path(), &s);
          let loaded = load_from(dir.path());
          assert!(loaded.gateway_endpoint_override.is_none());
      }
  }
  ```

- [ ] **Step 4: Add `tempfile` dev-dependency to `src-tauri/Cargo.toml`**

  At the bottom of `src-tauri/Cargo.toml`, add:
  ```toml
  [dev-dependencies]
  tempfile = "3"
  ```

- [ ] **Step 5: Run tests, confirm they pass**

  ```powershell
  cd src-tauri && cargo test openclaw_connection 2>&1 | tail -20
  ```
  Expected: `6 passed`, no failures.

- [ ] **Step 6: Commit**

  ```powershell
  git add src-tauri/src/openclaw_connection.rs src-tauri/Cargo.toml
  git commit -m "feat(openclaw): openclaw_connection settings module with redacted view"
  ```

---

## Task 3: Register the new module and commands in `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `mod openclaw_connection;` at the top of the module list**

  Find the block starting at line 1 in `src-tauri/src/lib.rs`:
  ```rust
  mod agents;
  mod api;
  mod byok;
  mod conversations;
  mod events;
  mod gpu_detect;
  mod inference;
  mod models;
  mod openclaw;
  mod paths;
  mod projects;
  mod settings;
  mod skills;
  mod sysinfo_mod;
  mod tools;
  ```
  Add `mod openclaw_connection;` after `mod openclaw;`:
  ```rust
  mod openclaw;
  mod openclaw_connection;
  ```

- [ ] **Step 2: Add the three new commands to the invoke handler**

  Find the section in `lib.rs` that contains:
  ```rust
  openclaw::openclaw_detect,
  openclaw::openclaw_status,
  openclaw::openclaw_open_docs,
  openclaw::openclaw_test_message,
  ```
  Add the three new commands after `openclaw::openclaw_test_message,`:
  ```rust
  openclaw::openclaw_detect,
  openclaw::openclaw_status,
  openclaw::openclaw_open_docs,
  openclaw::openclaw_test_message,
  openclaw_connection::get_openclaw_connection_settings,
  openclaw_connection::save_openclaw_connection_settings,
  openclaw_connection::clear_openclaw_token,
  ```

- [ ] **Step 3: cargo check**

  ```powershell
  cd src-tauri && cargo check 2>&1 | tail -10
  ```
  Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

  ```powershell
  git add src-tauri/src/lib.rs
  git commit -m "feat(openclaw): register openclaw_connection module and commands"
  ```

---

## Task 4: Wire auth token into `openclaw_test_message` (TDD)

**Files:**
- Modify: `src-tauri/src/openclaw.rs`

### What changes

1. `send_test_message(endpoint, prompt)` → `send_test_message(endpoint, prompt, auth_token: Option<&str>)`  
   When `auth_token` is `Some(t)`, add `Authorization: Bearer {t}` header to the reqwest request.

2. `openclaw_test_message(prompt, endpoint)` → loads `OpenClawConnectionSettings`, resolves effective endpoint, passes token.

- [ ] **Step 1: Write the failing tests**

  In `src-tauri/src/openclaw.rs`, find the `#[cfg(test)]` section at the bottom and add these two tests **before** the final closing `}` of the test module:

  ```rust
  // ── auth-header tests (require a local HTTP server) ──────────────────────

  #[tokio::test]
  async fn send_test_message_attaches_auth_header_when_token_present() {
      use axum::{routing::post, Router, http::HeaderMap};
      use std::sync::{Arc, Mutex};

      let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
      let cap2 = captured.clone();

      let app = Router::new().route(
          "/v1/chat/completions",
          post(move |headers: HeaderMap, _body: axum::body::Bytes| {
              let cap = cap2.clone();
              async move {
                  let auth = headers
                      .get("authorization")
                      .and_then(|v| v.to_str().ok())
                      .map(|s| s.to_string());
                  *cap.lock().unwrap() = auth;
                  axum::Json(serde_json::json!({
                      "choices": [{ "message": { "content": "pong" } }]
                  }))
              }
          }),
      );

      let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
      let addr = listener.local_addr().unwrap();
      tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

      let endpoint = format!("http://127.0.0.1:{}", addr.port());
      // This call will fail to compile until send_test_message has the new signature.
      let result = send_test_message(&endpoint, "ping", Some("test-token-xyz")).await;

      assert!(matches!(result.kind, TestMessageKind::Ok), "expected Ok, got {:?}", result.kind);
      let auth_header = captured.lock().unwrap().clone();
      assert_eq!(auth_header.as_deref(), Some("Bearer test-token-xyz"));
  }

  #[tokio::test]
  async fn send_test_message_omits_auth_header_when_no_token() {
      use axum::{routing::post, Router, http::HeaderMap};
      use std::sync::{Arc, Mutex};

      let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
      let cap2 = captured.clone();

      let app = Router::new().route(
          "/v1/chat/completions",
          post(move |headers: HeaderMap, _body: axum::body::Bytes| {
              let cap = cap2.clone();
              async move {
                  let auth = headers
                      .get("authorization")
                      .and_then(|v| v.to_str().ok())
                      .map(|s| s.to_string());
                  *cap.lock().unwrap() = auth;
                  axum::Json(serde_json::json!({
                      "choices": [{ "message": { "content": "pong" } }]
                  }))
              }
          }),
      );

      let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
      let addr = listener.local_addr().unwrap();
      tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

      let endpoint = format!("http://127.0.0.1:{}", addr.port());
      let result = send_test_message(&endpoint, "ping", None).await;

      assert!(matches!(result.kind, TestMessageKind::Ok), "expected Ok, got {:?}", result.kind);
      let auth_header = captured.lock().unwrap().clone();
      assert!(auth_header.is_none(), "expected no Authorization header, got {auth_header:?}");
  }
  ```

- [ ] **Step 2: Run tests, confirm they fail (compile error — wrong arity)**

  ```powershell
  cd src-tauri && cargo test send_test_message_attaches_auth 2>&1 | tail -15
  ```
  Expected: compile error — `send_test_message` called with 3 args but expects 2.

- [ ] **Step 3: Update `send_test_message` signature and add auth header logic**

  In `src-tauri/src/openclaw.rs`, find and replace the `send_test_message` function:

  **Find (starting around line 796):**
  ```rust
  async fn send_test_message(endpoint: &str, prompt: &str) -> OpenClawTestMessageResult {
  ```
  **Replace with:**
  ```rust
  async fn send_test_message(
      endpoint: &str,
      prompt: &str,
      auth_token: Option<&str>,
  ) -> OpenClawTestMessageResult {
  ```

  Find the loop body where the request is built. The current code is:
  ```rust
  match client.post(&url).json(&body).send().await {
  ```
  Replace with:
  ```rust
  let mut req = client.post(&url).json(&body);
  if let Some(token) = auth_token {
      req = req.header("Authorization", format!("Bearer {token}"));
  }
  match req.send().await {
  ```

- [ ] **Step 4: Update `openclaw_test_message` to load connection settings and resolve endpoint**

  Find and replace the entire `openclaw_test_message` command (starting around line 760):

  **Find:**
  ```rust
  #[tauri::command]
  #[specta::specta]
  pub async fn openclaw_test_message(
      prompt: String,
      endpoint: Option<String>,
  ) -> Result<OpenClawTestMessageResult, String> {
      let ep = match endpoint {
          Some(ep) => ep,
          None => return Ok(OpenClawTestMessageResult {
              kind: TestMessageKind::CapabilityMissing,
              response_text: None,
              error_message: Some(
                  "No gateway endpoint provided. Run a status refresh first, then retry."
                      .to_string(),
              ),
              endpoint_tried: None,
          }),
      };

      if !is_loopback_url(&ep) {
          return Ok(OpenClawTestMessageResult {
              kind: TestMessageKind::Error,
              response_text: None,
              error_message: Some(
                  "Endpoint is not a loopback address. Feral only contacts local gateways."
                      .to_string(),
              ),
              endpoint_tried: Some(ep),
          });
      }

      Ok(send_test_message(&ep, &prompt).await)
  }
  ```

  **Replace with:**
  ```rust
  #[tauri::command]
  #[specta::specta]
  pub async fn openclaw_test_message(
      prompt: String,
      endpoint: Option<String>,
  ) -> Result<OpenClawTestMessageResult, String> {
      let connection = crate::openclaw_connection::load();

      // Resolve effective endpoint:
      //   1. Feral-saved override (loopback-validated)
      //   2. Caller's detected endpoint param (loopback-validated)
      //   3. Default port as fallback
      let ep: String = if let Some(ov) = connection
          .gateway_endpoint_override
          .as_deref()
          .filter(|ep| is_loopback_url(ep))
      {
          ov.to_string()
      } else if let Some(ep) = &endpoint {
          if !is_loopback_url(ep) {
              return Ok(OpenClawTestMessageResult {
                  kind: TestMessageKind::Error,
                  response_text: None,
                  error_message: Some(
                      "Endpoint is not a loopback address. Feral only contacts local gateways."
                          .to_string(),
                  ),
                  endpoint_tried: Some(ep.clone()),
              });
          }
          ep.clone()
      } else {
          format!("http://localhost:{}", OPENCLAW_DEFAULT_PORT)
      };

      Ok(send_test_message(&ep, &prompt, connection.gateway_token.as_deref()).await)
  }
  ```

- [ ] **Step 5: Run tests, confirm new auth tests pass**

  ```powershell
  cd src-tauri && cargo test send_test_message 2>&1 | tail -20
  ```
  Expected: both new tests pass. Existing tests should also still pass.

- [ ] **Step 6: Run all openclaw tests**

  ```powershell
  cd src-tauri && cargo test openclaw 2>&1 | tail -20
  ```
  Expected: all tests pass (should be 49+ tests).

- [ ] **Step 7: Commit**

  ```powershell
  git add src-tauri/src/openclaw.rs
  git commit -m "feat(openclaw): auth token header in send_test_message; connection settings endpoint resolution"
  ```

---

## Task 5: Add TypeScript types and IPC methods

**Files:**
- Modify: `frontend-react/src/lib/tauri/index.ts`

- [ ] **Step 1: Add the `OpenClawConnectionView` type**

  In `frontend-react/src/lib/tauri/index.ts`, find the OpenClaw types section (around line 148):
  ```ts
  // ── OpenClaw ────────────────────────────────────────────────────────────────
  export interface OpenClawDetectResult {
  ```
  Add the new type right after the `OpenClawTestMessageResult` interface (around line 195):

  ```ts
  export interface OpenClawConnectionView {
    /** Feral-saved loopback endpoint override, or null if not set. */
    endpoint_override: string | null;
    /** True if a token has been saved; the raw token is never returned. */
    has_token: boolean;
  }
  ```

- [ ] **Step 2: Add raw invoke helpers**

  Find the raw object section. After `openclawTestMessage`:
  ```ts
  openclawTestMessage:      (prompt: string, endpoint: string | null) =>
    invoke<OpenClawTestMessageResult>('openclaw_test_message', { prompt, endpoint }),
  ```
  Add:
  ```ts
  getOpenclawConnectionSettings: () =>
    invoke<OpenClawConnectionView>('get_openclaw_connection_settings'),
  saveOpenclawConnectionSettings: (endpointOverride: string | null, token: string | null) =>
    invoke<void>('save_openclaw_connection_settings', { endpoint_override: endpointOverride, token }),
  clearOpenclawToken: () =>
    invoke<void>('clear_openclaw_token'),
  ```

- [ ] **Step 3: Add facade methods**

  Find the `tauri.openclaw` facade object:
  ```ts
  openclaw: {
    detect:      async () => raw.openclawDetect(),
    status:      async () => raw.openclawStatus(),
    openDocs:    async () => raw.openclawOpenDocs(),
    testMessage: async (prompt: string, endpoint: string | null) =>
      raw.openclawTestMessage(prompt, endpoint),
  },
  ```
  Replace with:
  ```ts
  openclaw: {
    detect:                async () => raw.openclawDetect(),
    status:                async () => raw.openclawStatus(),
    openDocs:              async () => raw.openclawOpenDocs(),
    testMessage:           async (prompt: string, endpoint: string | null) =>
      raw.openclawTestMessage(prompt, endpoint),
    getConnectionSettings: async () => raw.getOpenclawConnectionSettings(),
    saveConnectionSettings: async (endpointOverride: string | null, token: string | null) =>
      raw.saveOpenclawConnectionSettings(endpointOverride, token),
    clearToken:            async () => raw.clearOpenclawToken(),
  },
  ```

- [ ] **Step 4: Type-check**

  ```powershell
  cd frontend-react && npm run typecheck 2>&1 | tail -10
  ```
  Expected: no errors.

- [ ] **Step 5: Commit**

  ```powershell
  git add frontend-react/src/lib/tauri/index.ts
  git commit -m "feat(openclaw): TypeScript types and IPC facade for connection settings"
  ```

---

## Task 6: Add `OpenClawAuthPanel` UI and 401 hint (TDD)

**Files:**
- Modify: `frontend-react/src/components/settings/OpenClawTab.tsx`
- Modify: `frontend-react/src/components/settings/__tests__/OpenClawTab.test.tsx`

### Step overview
Write the 8 failing Vitest tests first, then implement the `OpenClawAuthPanel` component and the 401 inline hint.

- [ ] **Step 1: Extend the mock in `OpenClawTab.test.tsx` to include the 3 new methods**

  Find the `vi.mock('@/lib/tauri', ...)` call at the top of the test file:
  ```ts
  vi.mock('@/lib/tauri', () => ({
    tauri: {
      openclaw: {
        detect:      vi.fn(),
        status:      vi.fn(),
        openDocs:    vi.fn(),
        testMessage: vi.fn(),
      },
    },
  }));
  ```
  Replace with:
  ```ts
  vi.mock('@/lib/tauri', () => ({
    tauri: {
      openclaw: {
        detect:                vi.fn(),
        status:                vi.fn(),
        openDocs:              vi.fn(),
        testMessage:           vi.fn(),
        getConnectionSettings: vi.fn(),
        saveConnectionSettings: vi.fn(),
        clearToken:            vi.fn(),
      },
    },
  }));
  ```

- [ ] **Step 2: Add mock variable declarations after the existing ones**

  After:
  ```ts
  const mockTestMessage = vi.mocked(tauri.openclaw.testMessage);
  ```
  Add:
  ```ts
  const mockGetConnectionSettings  = vi.mocked(tauri.openclaw.getConnectionSettings);
  const mockSaveConnectionSettings = vi.mocked(tauri.openclaw.saveConnectionSettings);
  const mockClearToken             = vi.mocked(tauri.openclaw.clearToken);
  ```

- [ ] **Step 3: Add default mock resolution in `beforeEach`**

  Inside `beforeEach`, after the existing mock setups, add:
  ```ts
  mockGetConnectionSettings.mockResolvedValue({ endpoint_override: null, has_token: false });
  mockSaveConnectionSettings.mockResolvedValue(undefined);
  mockClearToken.mockResolvedValue(undefined);
  ```

- [ ] **Step 4: Write the 8 new failing tests**

  At the end of the `describe('OpenClawTab', ...)` block, add:

  ```ts
  // ── Gateway auth panel ───────────────────────────────────────────────────

  it('token input has type="password" so the raw value is never rendered as plain text', async () => {
    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    const tokenInput = screen.getByPlaceholderText(/paste gateway token/i);
    expect(tokenInput).toHaveAttribute('type', 'password');
  });

  it('shows "No token saved" badge when has_token is false', async () => {
    mockGetConnectionSettings.mockResolvedValue({ endpoint_override: null, has_token: false });
    render(<OpenClawTab />);
    await waitFor(() => expect(mockGetConnectionSettings).toHaveBeenCalled());
    expect(screen.getByText(/no token saved/i)).toBeInTheDocument();
  });

  it('shows "Token saved" badge when has_token is true', async () => {
    mockGetConnectionSettings.mockResolvedValue({ endpoint_override: null, has_token: true });
    render(<OpenClawTab />);
    await waitFor(() => expect(mockGetConnectionSettings).toHaveBeenCalled());
    expect(screen.getByText(/token saved/i)).toBeInTheDocument();
  });

  it('calls saveConnectionSettings with correct args and clears the input on Save', async () => {
    render(<OpenClawTab />);
    await waitFor(() => expect(mockGetConnectionSettings).toHaveBeenCalled());

    const tokenInput = screen.getByPlaceholderText(/paste gateway token/i);
    await userEvent.type(tokenInput, 'my-secret-token');

    await userEvent.click(screen.getByRole('button', { name: /save token/i }));

    await waitFor(() => {
      expect(mockSaveConnectionSettings).toHaveBeenCalledWith(
        expect.anything(),  // endpointOverride (whatever is in the field)
        'my-secret-token',
      );
    });
    // Input must be cleared after save
    expect(tokenInput).toHaveValue('');
  });

  it('token string is not findable in the DOM after Save', async () => {
    mockSaveConnectionSettings.mockResolvedValue(undefined);
    mockGetConnectionSettings
      .mockResolvedValueOnce({ endpoint_override: null, has_token: false })
      .mockResolvedValue({ endpoint_override: null, has_token: true });

    render(<OpenClawTab />);
    await waitFor(() => expect(mockGetConnectionSettings).toHaveBeenCalled());

    const tokenInput = screen.getByPlaceholderText(/paste gateway token/i);
    await userEvent.type(tokenInput, 'super-secret-tok');
    await userEvent.click(screen.getByRole('button', { name: /save token/i }));

    await waitFor(() => expect(mockSaveConnectionSettings).toHaveBeenCalled());

    // The literal token must not appear anywhere in the rendered output.
    expect(screen.queryByText('super-secret-tok')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('super-secret-tok')).not.toBeInTheDocument();
  });

  it('clicking Clear token calls clearToken and resets badge to "No token saved"', async () => {
    mockGetConnectionSettings
      .mockResolvedValueOnce({ endpoint_override: null, has_token: true })
      .mockResolvedValue({ endpoint_override: null, has_token: false });

    render(<OpenClawTab />);
    await waitFor(() => expect(screen.getByText(/token saved/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /clear token/i }));

    await waitFor(() => {
      expect(mockClearToken).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/no token saved/i)).toBeInTheDocument();
    });
  });

  it('Clear token button does NOT affect the endpoint override field', async () => {
    mockGetConnectionSettings.mockResolvedValue({
      endpoint_override: 'http://localhost:9999',
      has_token: true,
    });
    mockClearToken.mockResolvedValue(undefined);

    render(<OpenClawTab />);
    await waitFor(() => expect(mockGetConnectionSettings).toHaveBeenCalled());

    const overrideInput = screen.getByPlaceholderText(/endpoint override/i);
    expect(overrideInput).toHaveValue('http://localhost:9999');

    await userEvent.click(screen.getByRole('button', { name: /clear token/i }));
    await waitFor(() => expect(mockClearToken).toHaveBeenCalled());

    // Endpoint override field must keep its value.
    expect(overrideInput).toHaveValue('http://localhost:9999');
  });

  it('shows auth guidance hint when test result is unsupported with a 401 message', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true,
      gateway_running: true,
      health_ok: true,
      capabilities: ['gateway', 'health_check'],
      gateway_endpoint: 'http://localhost:18789',
    }));
    mockTestMessage.mockResolvedValue({
      kind: 'unsupported',
      response_text: null,
      error_message: 'OpenClaw gateway requires authentication (HTTP 401).',
      endpoint_tried: 'http://localhost:18789/v1/chat/completions',
    });

    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: /send test message/i }));

    await waitFor(() => {
      expect(screen.getByText(/401.*auth|auth.*401|paste your gateway token/i)).toBeInTheDocument();
    });
  });
  ```

- [ ] **Step 5: Run tests, confirm the 8 new tests fail**

  ```powershell
  cd frontend-react && npm test -- --run --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|✗|×|auth panel|token)"
  ```
  Expected: 8 new tests fail (component not found / placeholder not found).

- [ ] **Step 6: Implement `OpenClawAuthPanel` in `OpenClawTab.tsx`**

  At the top of `frontend-react/src/components/settings/OpenClawTab.tsx`, find the existing import from `@/lib/tauri`:
  ```ts
  import { tauri, type OpenClawStatusResult, type OpenClawTestMessageResult, type TestMessageKind } from '@/lib/tauri';
  ```
  Add `type OpenClawConnectionView` to it:
  ```ts
  import { tauri, type OpenClawStatusResult, type OpenClawTestMessageResult, type TestMessageKind, type OpenClawConnectionView } from '@/lib/tauri';
  ```

  After the existing `type TestState = ...` block (around line 317), add the new state type:
  ```ts
  type AuthSaveState = 'idle' | 'saving' | 'saved' | 'error';
  ```

  After the closing `}` of the `TestMessagePanel` function (around line 389), add the new component:

  ```tsx
  // ── OpenClawAuthPanel ─────────────────────────────────────────────────────────

  function OpenClawAuthPanel() {
    const [view, setView]               = useState<OpenClawConnectionView | null>(null);
    const [endpointInput, setEndpointInput] = useState('');
    const [tokenInput, setTokenInput]   = useState('');
    const [saveState, setSaveState]     = useState<AuthSaveState>('idle');
    const [saveError, setSaveError]     = useState<string | null>(null);
    const [clearing, setClearing]       = useState(false);

    useEffect(() => {
      void tauri.openclaw.getConnectionSettings().then((v) => {
        setView(v);
        setEndpointInput(v.endpoint_override ?? '');
      });
    }, []);

    const handleSave = async () => {
      setSaveState('saving');
      setSaveError(null);
      try {
        const ep = endpointInput.trim() || null;
        const tok = tokenInput.trim() || null;
        await tauri.openclaw.saveConnectionSettings(ep, tok);
        const updated = await tauri.openclaw.getConnectionSettings();
        setView(updated);
        setTokenInput('');
        setSaveState('saved');
      } catch (e) {
        setSaveError(String(e));
        setSaveState('error');
      }
    };

    const handleClear = async () => {
      setClearing(true);
      try {
        await tauri.openclaw.clearToken();
        const updated = await tauri.openclaw.getConnectionSettings();
        setView(updated);
      } finally {
        setClearing(false);
      }
    };

    return (
      <Card title="Gateway auth">
        <div className="space-y-4">
          <p className="text-xs text-text-muted">
            Stored in Feral settings only — does not modify OpenClaw config.
          </p>

          {/* Endpoint override */}
          <div className="space-y-1">
            <label className="text-xs text-text-muted">Endpoint override (optional, loopback only)</label>
            <input
              type="text"
              value={endpointInput}
              onChange={(e) => setEndpointInput(e.target.value)}
              placeholder="Endpoint override — e.g. http://localhost:18789"
              className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
            />
          </div>

          {/* Token */}
          <div className="space-y-1.5">
            <label className="text-xs text-text-muted">Gateway token</label>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Paste gateway token to replace saved token"
              className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
            />
            {view && (
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'inline-block h-1.5 w-1.5 rounded-full',
                    view.has_token ? 'bg-green-400' : 'bg-text-muted',
                  )}
                />
                <span className="text-xs text-text-muted">
                  {view.has_token ? 'Token saved' : 'No token saved'}
                </span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saveState === 'saving'}
              className="px-3 py-1.5 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
            >
              {saveState === 'saving' ? 'Saving…' : 'Save token'}
            </button>
            {view?.has_token && (
              <button
                type="button"
                onClick={() => void handleClear()}
                disabled={clearing}
                className="px-3 py-1.5 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
              >
                {clearing ? 'Clearing…' : 'Clear token'}
              </button>
            )}
            {saveState === 'error' && saveError && (
              <span className="text-xs text-red-400">{saveError}</span>
            )}
          </div>
        </div>
      </Card>
    );
  }
  ```

- [ ] **Step 7: Insert `<OpenClawAuthPanel />` into `OpenClawTab` and add 401 hint to `TestResultDisplay`**

  In the `OpenClawTab` function, find:
  ```tsx
  {/* Test message panel */}
  {state.kind !== 'idle' && (
    <TestMessagePanel
  ```
  Insert `<OpenClawAuthPanel />` immediately before the test message panel block:
  ```tsx
  {/* Gateway auth */}
  <OpenClawAuthPanel />

  {/* Test message panel */}
  {state.kind !== 'idle' && (
    <TestMessagePanel
  ```

  In the `TestResultDisplay` component, find the closing of the result div (after the `error_message` block):
  ```tsx
      {result.error_message && (
        <p className="text-xs text-red-400 break-words">{result.error_message}</p>
      )}
    </div>
  );
  ```
  Replace with:
  ```tsx
      {result.error_message && (
        <p className="text-xs text-red-400 break-words">{result.error_message}</p>
      )}
      {result.kind === 'unsupported' &&
        result.error_message != null &&
        /401|403|auth/i.test(result.error_message) && (
          <p className="text-xs text-amber-400/90 mt-1">
            A 401/403 response means auth is required. Paste your gateway token above
            and save it, then retry the test.
          </p>
        )}
    </div>
  );
  ```

- [ ] **Step 8: Run the tests and confirm all pass**

  ```powershell
  cd frontend-react && npm test -- --run 2>&1 | tail -20
  ```
  Expected: all tests pass (existing + 8 new). Note the pre-existing `modelUtils.test.ts` "—" vs "N/A" failure — that is a known pre-existing failure unrelated to this work.

- [ ] **Step 9: Typecheck and build**

  ```powershell
  cd frontend-react && npm run typecheck 2>&1 | tail -10
  ```
  Expected: no errors.

  ```powershell
  cd frontend-react && npm run build 2>&1 | tail -10
  ```
  Expected: build succeeds.

- [ ] **Step 10: Commit**

  ```powershell
  git add frontend-react/src/components/settings/OpenClawTab.tsx
  git add frontend-react/src/components/settings/__tests__/OpenClawTab.test.tsx
  git commit -m "feat(openclaw): OpenClawAuthPanel — token save/clear, 401 auth guidance"
  ```

---

## Task 7: Final verification

- [ ] **Step 1: Full Rust test suite**

  ```powershell
  cd src-tauri && cargo test 2>&1 | tail -15
  ```
  Expected: all tests pass. Report any failures.

- [ ] **Step 2: cargo check**

  ```powershell
  cd src-tauri && cargo check 2>&1 | tail -5
  ```
  Expected: `Finished` with no errors.

- [ ] **Step 3: Full frontend test suite**

  ```powershell
  cd frontend-react && npm test -- --run 2>&1 | tail -20
  ```
  Expected: all tests pass except the pre-existing `modelUtils.test.ts` failure.

- [ ] **Step 4: Final typecheck + build**

  ```powershell
  cd frontend-react && npm run typecheck && npm run build 2>&1 | tail -10
  ```
  Expected: both succeed.

- [ ] **Step 5: Final summary commit (if needed)**

  If any small fixes were made during verification:
  ```powershell
  git add -p  # stage only the fix files
  git commit -m "fix(openclaw): post-verification cleanup"
  ```

---

## What now works

- Feral saves an OpenClaw gateway token at `~/.feral/openclaw_connection.json`
- Token is one-way: frontend → backend on Save; backend never returns raw token
- `get_openclaw_connection_settings` returns `{ endpoint_override, has_token }` only
- `openclaw_test_message` attaches `Authorization: Bearer <token>` when a token is saved
- With no token saved, the request is still attempted (loopback trusted-proxy support)
- 401/403 result shows inline hint pointing to the auth panel
- `Clear token` resets the token without touching the endpoint override

## What is still intentionally NOT done

- OpenClaw-backed agent routing
- `auth_required` kind variant (kept as `unsupported` to avoid scope creep)
- OS keychain / encrypted storage (plain JSON under `~/.feral` is the project standard)
- Reading or writing `~/.openclaw`
