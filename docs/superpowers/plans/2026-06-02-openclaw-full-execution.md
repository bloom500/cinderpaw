# OpenClaw Full Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agents with `preferred_runtime = "openclaw"` actually execute through the OpenClaw gateway (localhost:18789) instead of local llama.cpp, so users have a fully functional OpenClaw agent after completing onboarding.

**Architecture:** Add an SSE streaming helper and `run_openclaw()` runner to `openclaw.rs` (which already imports from `agents.rs`), add a dispatch branch in `lib.rs`'s `run_agent`, and fix `openclaw_warmup_agent` to set `preferred_runtime = "openclaw"` on success so onboarding auto-wires the agent.

**Tech Stack:** Rust, reqwest 0.12 (stream feature already enabled), tokio, serde_json, axum (test mock server — already used in existing tests)

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/src/openclaw.rs` | Add `SseChunk`, `parse_sse_line()`, `run_openclaw()`, update `openclaw_warmup_agent` to also set `preferred_runtime` |
| `src-tauri/src/lib.rs` | Dispatch in `run_agent` on `preferred_runtime == "openclaw"` |

No new files. No new Cargo dependencies.

---

## Task 1: SSE line parser (pure, no I/O)

**Files:**
- Modify: `src-tauri/src/openclaw.rs` — add `SseChunk` enum and `parse_sse_line()` near the bottom of the file, before the `// ── Tests` section.

### Context

OpenClaw uses the OpenAI SSE streaming format:
```
data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}

data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}

data: [DONE]
```

Lines not starting with `data: ` are metadata/heartbeats and should be skipped.

- [ ] **Step 1.1: Write the failing tests**

Add at the end of the `#[cfg(test)] mod tests` block in `src-tauri/src/openclaw.rs`:

```rust
    // ── SSE parser ───────────────────────────────────────────────────────────

    #[test]
    fn sse_parse_token_extracts_content() {
        let line = r#"data: {"id":"x","choices":[{"delta":{"content":"Hello"},"index":0}]}"#;
        assert_eq!(parse_sse_line(line), SseChunk::Token("Hello".into()));
    }

    #[test]
    fn sse_parse_done_signal() {
        assert_eq!(parse_sse_line("data: [DONE]"), SseChunk::Done);
        assert_eq!(parse_sse_line("data: [DONE] "), SseChunk::Done);
    }

    #[test]
    fn sse_parse_skip_non_data_lines() {
        assert_eq!(parse_sse_line(""), SseChunk::Skip);
        assert_eq!(parse_sse_line(": ping"), SseChunk::Skip);
        assert_eq!(parse_sse_line("event: message"), SseChunk::Skip);
    }

    #[test]
    fn sse_parse_skip_empty_delta() {
        // finish_reason chunk — delta.content is absent or empty string
        let no_content = r#"data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}"#;
        assert_eq!(parse_sse_line(no_content), SseChunk::Skip);

        let empty_str = r#"data: {"choices":[{"delta":{"content":""},"index":0}]}"#;
        assert_eq!(parse_sse_line(empty_str), SseChunk::Skip);
    }

    #[test]
    fn sse_parse_skip_malformed_json() {
        assert_eq!(parse_sse_line("data: {not json}"), SseChunk::Skip);
    }
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```
cd src-tauri && cargo test sse_parse -- --test-thread=1 2>&1 | tail -20
```

Expected: compile error — `SseChunk` and `parse_sse_line` do not exist yet.

- [ ] **Step 1.3: Add `SseChunk` and `parse_sse_line` to `openclaw.rs`**

Add this block just before the line `// ── HTTP helper ─────` (around line 973):

```rust
// ── SSE streaming ─────────────────────────────────────────────────────────────

/// Result of parsing a single SSE line from a streaming chat completion.
#[derive(Debug, PartialEq)]
enum SseChunk {
    /// A content delta to emit as a token.
    Token(String),
    /// `data: [DONE]` — the stream is finished.
    Done,
    /// Non-data line, empty delta, or parse error — skip silently.
    Skip,
}

/// Parse one line of an OpenAI-compatible Server-Sent Events stream.
fn parse_sse_line(line: &str) -> SseChunk {
    let data = match line.strip_prefix("data: ") {
        Some(d) => d,
        None => return SseChunk::Skip,
    };
    if data.trim() == "[DONE]" {
        return SseChunk::Done;
    }
    let v: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return SseChunk::Skip,
    };
    match v["choices"][0]["delta"]["content"].as_str() {
        Some(s) if !s.is_empty() => SseChunk::Token(s.to_string()),
        _ => SseChunk::Skip,
    }
}
```

- [ ] **Step 1.4: Run tests to confirm they pass**

```
cd src-tauri && cargo test sse_parse -- --test-threads=1 2>&1 | tail -10
```

Expected: `5 tests passed`

- [ ] **Step 1.5: Commit**

```
git add src-tauri/src/openclaw.rs
git commit -m "feat(openclaw): add SSE line parser for streaming chat completions"
```

---

## Task 2: `run_openclaw()` runner

**Files:**
- Modify: `src-tauri/src/openclaw.rs` — add `pub fn run_openclaw()` after `parse_sse_line`.

### Context

`run_openclaw` must emit the same `AgentEvent` JSON strings as `agents::run()` so the frontend's `on_event` channel handler works identically regardless of runtime. `AgentEvent` is already `pub` in `agents.rs`. The existing `openclaw.rs` already imports from `agents.rs` (via `crate::agents::...`) so no circular dependency is introduced.

Timeout: 5 minutes for the full streaming request (long models may be slow). No per-chunk timeout.

- [ ] **Step 2.1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `openclaw.rs`, after the SSE parser tests:

```rust
    // ── run_openclaw ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn run_openclaw_emits_token_and_final_events() {
        use axum::{routing::post, Router};
        use std::net::SocketAddr;

        // SSE body: two token chunks then [DONE]
        let sse_body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"index\":0}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"index\":0}]}\n\n",
            "data: [DONE]\n\n",
        );

        let app = Router::new().route(
            "/v1/chat/completions",
            post(|| async {
                (
                    axum::http::StatusCode::OK,
                    [("content-type", "text/event-stream")],
                    sse_body,
                )
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let cfg = crate::agents::AgentConfig {
            id: "test-run-123".into(),
            name: "Test".into(),
            system_prompt: "You are helpful.".into(),
            model_id: String::new(),
            tools: vec![],
            params: None,
            preferred_runtime: Some("openclaw".into()),
            openclaw_model: None,
            openclaw_ready: None,
        };

        let mut rx = run_openclaw_inner(
            cfg,
            "Hi".into(),
            format!("http://{addr}"),
            None, // no token
        );

        let mut events: Vec<String> = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }

        // Expect two Token events then one Final
        assert_eq!(events.len(), 3, "expected 3 events, got: {:?}", events);
        assert!(events[0].contains("\"kind\":\"token\""), "first event should be token");
        assert!(events[0].contains("Hello"), "first token should be Hello");
        assert!(events[1].contains("\"kind\":\"token\""), "second event should be token");
        assert!(events[1].contains(" world"), "second token should be ' world'");
        assert!(events[2].contains("\"kind\":\"final\""), "last event should be final");
        assert!(events[2].contains("Hello world"), "final text should be accumulated");
    }

    #[tokio::test]
    async fn run_openclaw_emits_error_on_401() {
        use axum::{routing::post, Router};

        let app = Router::new().route(
            "/v1/chat/completions",
            post(|| async { axum::http::StatusCode::UNAUTHORIZED }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let cfg = crate::agents::AgentConfig {
            id: "test-run-401".into(),
            name: "Test".into(),
            system_prompt: String::new(),
            model_id: String::new(),
            tools: vec![],
            params: None,
            preferred_runtime: Some("openclaw".into()),
            openclaw_model: None,
            openclaw_ready: None,
        };

        let mut rx = run_openclaw_inner(
            cfg,
            "Hi".into(),
            format!("http://{addr}"),
            None,
        );

        let mut events: Vec<String> = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }

        assert_eq!(events.len(), 1);
        assert!(events[0].contains("\"kind\":\"error\""), "should be error event");
        assert!(events[0].contains("auth"), "should mention auth");
    }

    #[tokio::test]
    async fn run_openclaw_emits_error_on_connection_refused() {
        // Bind to port 0, record the port, then drop — nothing will be listening.
        let port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };

        let cfg = crate::agents::AgentConfig {
            id: "test-run-refused".into(),
            name: "Test".into(),
            system_prompt: String::new(),
            model_id: String::new(),
            tools: vec![],
            params: None,
            preferred_runtime: Some("openclaw".into()),
            openclaw_model: None,
            openclaw_ready: None,
        };

        let mut rx = run_openclaw_inner(
            cfg,
            "Hi".into(),
            format!("http://127.0.0.1:{port}"),
            None,
        );

        let mut events: Vec<String> = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }

        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert!(ev.contains("\"kind\":\"error\""), "should be error event, got: {ev}");
    }
```

- [ ] **Step 2.2: Run tests to confirm they fail**

```
cd src-tauri && cargo test run_openclaw -- --test-threads=1 2>&1 | tail -20
```

Expected: compile error — `run_openclaw_inner` does not exist yet.

- [ ] **Step 2.3: Add `run_openclaw_inner` and `run_openclaw` to `openclaw.rs`**

Add this block right after the `parse_sse_line` function (before the `// ── HTTP helper` section):

```rust
/// Streaming timeout for a full OpenClaw chat completion.
/// Longer than the test-message timeout — real prompts can take minutes.
const OPENCLAW_STREAM_TIMEOUT_SECS: u64 = 300;

/// Inner runner — takes endpoint and token directly so tests can inject them
/// without touching disk. Called by `run_openclaw` after loading connection settings.
fn run_openclaw_inner(
    cfg: crate::agents::AgentConfig,
    user_prompt: String,
    endpoint: String,
    auth_token: Option<String>,
) -> tokio::sync::mpsc::Receiver<String> {
    use crate::agents::AgentEvent;
    use futures::StreamExt;

    let (tx, rx) = tokio::sync::mpsc::channel::<String>(64);

    tokio::spawn(async move {
        let send_ev = |tx: &tokio::sync::mpsc::Sender<String>, ev: AgentEvent| {
            let json = serde_json::to_string(&ev).unwrap_or_default();
            let tx = tx.clone();
            async move { let _ = tx.send(json).await; }
        };

        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(OPENCLAW_STREAM_TIMEOUT_SECS))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                send_ev(&tx, AgentEvent::Error {
                    message: format!("Failed to build HTTP client: {e}"),
                }).await;
                return;
            }
        };

        let model = cfg.openclaw_model.as_deref()
            .unwrap_or(crate::agents::DEFAULT_OPENCLAW_MODEL)
            .to_string();
        let user_id = crate::agents::openclaw_user_id(&cfg.id);

        let mut messages: Vec<serde_json::Value> = Vec::new();
        let sys = cfg.system_prompt.trim();
        if !sys.is_empty() {
            messages.push(serde_json::json!({"role": "system", "content": sys}));
        }
        messages.push(serde_json::json!({"role": "user", "content": user_prompt}));

        let body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "user": user_id,
        });

        let url = format!("{}/v1/chat/completions", endpoint.trim_end_matches('/'));
        let mut req = client.post(&url).json(&body);
        if let Some(token) = auth_token.as_deref() {
            req = req.header("Authorization", format!("Bearer {token}"));
        }

        let resp = match req.send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let message = match r.status().as_u16() {
                    401 | 403 => "OpenClaw auth required — check Settings → OpenClaw".into(),
                    404 => "OpenClaw endpoint not found — check Settings → OpenClaw".into(),
                    s => format!("OpenClaw returned HTTP {s}"),
                };
                send_ev(&tx, AgentEvent::Error { message }).await;
                return;
            }
            Err(e) if e.is_timeout() => {
                send_ev(&tx, AgentEvent::Error {
                    message: "OpenClaw did not respond in time".into(),
                }).await;
                return;
            }
            Err(e) if e.is_connect() => {
                send_ev(&tx, AgentEvent::Error {
                    message: "OpenClaw gateway not running — start with `openclaw start`".into(),
                }).await;
                return;
            }
            Err(e) => {
                send_ev(&tx, AgentEvent::Error {
                    message: redact_secrets(&e.to_string()),
                }).await;
                return;
            }
        };

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut full_text = String::new();

        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    send_ev(&tx, AgentEvent::Error {
                        message: format!("Stream error: {}", redact_secrets(&e.to_string())),
                    }).await;
                    return;
                }
            };

            buf.push_str(&String::from_utf8_lossy(&bytes[..]));

            loop {
                match buf.find('\n') {
                    None => break,
                    Some(pos) => {
                        let line = buf[..pos].trim_end_matches('\r').to_string();
                        buf = buf[pos + 1..].to_string();
                        match parse_sse_line(&line) {
                            SseChunk::Token(text) => {
                                full_text.push_str(&text);
                                send_ev(&tx, AgentEvent::Token { text }).await;
                            }
                            SseChunk::Done => {
                                send_ev(&tx, AgentEvent::Final { text: full_text }).await;
                                return;
                            }
                            SseChunk::Skip => {}
                        }
                    }
                }
            }
        }

        // Stream closed without [DONE] — emit whatever was accumulated.
        if !full_text.is_empty() {
            send_ev(&tx, AgentEvent::Final { text: full_text }).await;
        }
    });

    rx
}

/// Run an agent through the OpenClaw gateway. Returns a receiver of JSON-encoded
/// `AgentEvent`s — identical shape to `agents::run()` so `run_agent` in lib.rs
/// can use either without knowing which path was taken.
pub fn run_openclaw(
    cfg: crate::agents::AgentConfig,
    user_prompt: String,
) -> tokio::sync::mpsc::Receiver<String> {
    let connection = crate::openclaw_connection::load();
    let endpoint = connection
        .gateway_endpoint_override
        .as_deref()
        .filter(|ep| is_loopback_url(ep))
        .map(str::to_string)
        .unwrap_or_else(|| format!("http://localhost:{}", OPENCLAW_DEFAULT_PORT));
    let token = connection.gateway_token;
    run_openclaw_inner(cfg, user_prompt, endpoint, token)
}
```

- [ ] **Step 2.4: Run tests to confirm they pass**

```
cd src-tauri && cargo test run_openclaw -- --test-threads=1 2>&1 | tail -15
```

Expected: `3 tests passed`

- [ ] **Step 2.5: Commit**

```
git add src-tauri/src/openclaw.rs
git commit -m "feat(openclaw): add run_openclaw SSE streaming agent runner"
```

---

## Task 3: Dispatch in `run_agent`

**Files:**
- Modify: `src-tauri/src/lib.rs` lines ~487–501 (`run_agent` function)

- [ ] **Step 3.1: Replace the `run_agent` body**

Find this block in `src-tauri/src/lib.rs`:

```rust
async fn run_agent(
    state: State<'_, AppState>,
    agent_id: String,
    prompt: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    let list = agents::list().map_err(|e| e.to_string())?;
    let cfg = list.into_iter().find(|a| a.id == agent_id)
        .ok_or_else(|| format!("agent {} not found", agent_id))?;
    let mut rx = agents::run(cfg, prompt, state.manager.clone());
    while let Some(ev) = rx.recv().await {
        let _ = on_event.send(ev);
    }
    Ok(())
}
```

Replace it with:

```rust
async fn run_agent(
    state: State<'_, AppState>,
    agent_id: String,
    prompt: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    let list = agents::list().map_err(|e| e.to_string())?;
    let cfg = list.into_iter().find(|a| a.id == agent_id)
        .ok_or_else(|| format!("agent {} not found", agent_id))?;
    let mut rx = if cfg.preferred_runtime.as_deref() == Some("openclaw") {
        openclaw::run_openclaw(cfg, prompt)
    } else {
        agents::run(cfg, prompt, state.manager.clone())
    };
    while let Some(ev) = rx.recv().await {
        let _ = on_event.send(ev);
    }
    Ok(())
}
```

- [ ] **Step 3.2: Verify it compiles**

```
cd src-tauri && cargo build 2>&1 | tail -15
```

Expected: no errors.

- [ ] **Step 3.3: Commit**

```
git add src-tauri/src/lib.rs
git commit -m "feat(agents): dispatch run_agent to openclaw runner when preferred_runtime=openclaw"
```

---

## Task 4: Warmup sets `preferred_runtime`

**Files:**
- Modify: `src-tauri/src/openclaw.rs` — `openclaw_warmup_agent` function (~line 892–897)

### Context

Currently warmup saves only `openclaw_ready`. After this change it also saves `preferred_runtime`:
- Success → `preferred_runtime = Some("openclaw")` — future `run_agent` calls go through OpenClaw
- Failure → `preferred_runtime = None` — fall back to local llama.cpp

This means: completing onboarding with a running OpenClaw gateway automatically wires the agent.

- [ ] **Step 4.1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `openclaw.rs`:

```rust
    #[test]
    fn warmup_builds_correct_updated_agent_on_success() {
        let agent = crate::agents::AgentConfig {
            id: "wup-test-1".into(),
            name: "W".into(),
            system_prompt: String::new(),
            model_id: String::new(),
            tools: vec![],
            params: None,
            preferred_runtime: None,
            openclaw_model: None,
            openclaw_ready: None,
        };
        let updated = apply_warmup_result(agent, true);
        assert_eq!(updated.openclaw_ready, Some(true));
        assert_eq!(updated.preferred_runtime.as_deref(), Some("openclaw"));
    }

    #[test]
    fn warmup_builds_correct_updated_agent_on_failure() {
        let agent = crate::agents::AgentConfig {
            id: "wup-test-2".into(),
            name: "W".into(),
            system_prompt: String::new(),
            model_id: String::new(),
            tools: vec![],
            params: None,
            preferred_runtime: Some("openclaw".into()), // was previously set
            openclaw_model: None,
            openclaw_ready: Some(true),
        };
        let updated = apply_warmup_result(agent, false);
        assert_eq!(updated.openclaw_ready, Some(false));
        assert!(updated.preferred_runtime.is_none(), "runtime should be cleared on failure");
    }
```

- [ ] **Step 4.2: Run tests to confirm they fail**

```
cd src-tauri && cargo test warmup_builds -- --test-threads=1 2>&1 | tail -10
```

Expected: compile error — `apply_warmup_result` does not exist.

- [ ] **Step 4.3: Extract `apply_warmup_result` and use it in `openclaw_warmup_agent`**

Add the pure helper just before `openclaw_warmup_agent`:

```rust
/// Pure function — builds the updated agent after a warmup result.
/// Extracted so it can be unit-tested without disk I/O.
fn apply_warmup_result(
    mut agent: crate::agents::AgentConfig,
    success: bool,
) -> crate::agents::AgentConfig {
    agent.openclaw_ready = Some(success);
    agent.preferred_runtime = if success {
        Some("openclaw".to_string())
    } else {
        None
    };
    agent
}
```

Then in `openclaw_warmup_agent`, replace:

```rust
    // Persist readiness so the agent card badge stays accurate.
    let ready = matches!(result.kind, TestMessageKind::Ok);
    let mut updated_agent = agent;
    updated_agent.openclaw_ready = Some(ready);
    // Best-effort save — never fail the test call because of a write error.
    let _ = crate::agents::save(&updated_agent);
```

With:

```rust
    // Persist readiness and preferred_runtime so the agent is immediately
    // functional: success wires the agent to OpenClaw, failure falls back to local.
    let ready = matches!(result.kind, TestMessageKind::Ok);
    let updated_agent = apply_warmup_result(agent, ready);
    // Best-effort save — never fail the test call because of a write error.
    let _ = crate::agents::save(&updated_agent);
```

- [ ] **Step 4.4: Run tests to confirm they pass**

```
cd src-tauri && cargo test warmup_builds -- --test-threads=1 2>&1 | tail -10
```

Expected: `2 tests passed`

- [ ] **Step 4.5: Commit**

```
git add src-tauri/src/openclaw.rs
git commit -m "feat(openclaw): warmup sets preferred_runtime=openclaw on success, clears on failure"
```

---

## Task 5: Update module doc comment

**Files:**
- Modify: `src-tauri/src/openclaw.rs` — top-of-file doc comment (lines 1–35)

The module comment currently says `No chat routing, no streaming` — that's no longer true.

- [ ] **Step 5.1: Update the `## Explicit non-goals` section**

Find:

```rust
//! ## Explicit non-goals
//!   * No chat routing, no streaming, no model picker integration.
//!   * No writes to ~/.openclaw or any OpenClaw file.
//!   * No reads of ~/.openclaw/openclaw.json — config is opaque here.
//!   * No auto-start, no daemon supervision, no kill / restart.
```

Replace with:

```rust
//! ## Explicit non-goals
//!   * No writes to ~/.openclaw or any OpenClaw file.
//!   * No reads of ~/.openclaw/openclaw.json — config is opaque here.
//!   * No auto-start, no daemon supervision, no kill / restart.
//!   * No tool loop through OpenClaw (tools run locally; OpenClaw handles its own).
```

- [ ] **Step 5.2: Commit**

```
git add src-tauri/src/openclaw.rs
git commit -m "docs(openclaw): update module non-goals after adding streaming runner"
```

---

## Task 6: Full verification pass

- [ ] **Step 6.1: Run all Rust tests**

```
cd src-tauri && cargo test --all 2>&1 | tail -20
```

Expected: all tests pass, no failures.

- [ ] **Step 6.2: Run frontend tests**

```
cd frontend-react && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6.3: Build check**

```
cd src-tauri && cargo build 2>&1 | tail -10
```

Expected: no errors (warnings OK).

- [ ] **Step 6.4: Final commit if any fixups were needed**

```
git add -p
git commit -m "fix: address verification pass findings"
```

Only needed if step 6.1–6.3 revealed issues that required changes.
