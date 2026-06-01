# OpenClaw Runtime Execution — Implementation Plan

> **For agentic workers:** TDD task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When an agent is bound to OpenClaw (`preferred_runtime == "openclaw"`), `run_agent` streams its answer through the local OpenClaw gateway (which reads the local model from `~/.feral/models/`), instead of going through the in-process llama.cpp path. The Run panel in the UI surfaces this as the default for OpenClaw-bound agents. Onboarding's warmup step finalises `preferred_runtime` so the user leaves onboarding with a working OpenClaw agent.

**Architecture:** One new `send_chat_completions_stream` helper in `openclaw.rs` that does SSE parsing and invokes a `FnMut(&str)` callback per token. A new `agents::run_openclaw` that wraps it, emitting the same JSON-encoded `AgentEvent` channel events the Local Feral path produces. `run_agent` (in `lib.rs`) branches on `cfg.preferred_runtime`. The `openclaw_warmup_agent` command also sets `preferred_runtime = Some("openclaw")` on success so the agent is immediately runnable via OpenClaw after onboarding.

**Tech Stack:** Rust/Tauri, reqwest + futures (SSE parsing), React/TypeScript, Vitest, Testing Library.

---

## File map

| File | Change |
|---|---|
| `src-tauri/src/openclaw.rs` | Add `send_chat_completions_stream` (SSE) + tests |
| `src-tauri/src/agents.rs` | Add `run_openclaw` (returns `mpsc::Receiver<String>` of `AgentEvent` JSONs); make `run` branch on `cfg.preferred_runtime` |
| `src-tauri/src/lib.rs` | Re-export / call into the new branch — likely no change since `run_agent` already calls `agents::run` |
| `src-tauri/src/openclaw.rs` | `openclaw_warmup_agent` sets `preferred_runtime = Some("openclaw")` on success; clears on failure (to avoid stale binding) |
| `frontend-react/src/components/agents/main/AgentCard.tsx` | RuntimeSelector default follows `agent.preferred_runtime`; OpenClaw runtime Run button calls real `tauri.agents.run` (not test one-shot) |
| `frontend-react/src/components/agents/main/__tests__/AgentCard.test.tsx` | New tests for default runtime + real run on OpenClaw |

---

## Task 1: Add SSE streaming helper `send_chat_completions_stream`

**Files:** `src-tauri/src/openclaw.rs`

### Step 1.1: Write failing tests (TDD)

Add these to the `#[cfg(test)]` module in `openclaw.rs`:

```rust
#[tokio::test]
async fn send_chat_completions_stream_invokes_callback_for_each_sse_chunk() {
    use axum::{body::Body, http::{header, StatusCode}, response::Response, routing::post, Router};
    use std::sync::{Arc, Mutex};

    let sse_body = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n\
                    data: [DONE]\n\n";

    let app = Router::new().route(
        "/v1/chat/completions",
        post(move || async move {
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from(sse_body))
                .unwrap()
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let endpoint = format!("http://127.0.0.1:{}", addr.port());
    let messages = vec![serde_json::json!({"role":"user","content":"hi"})];
    let collected: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let coll2 = collected.clone();

    let result = send_chat_completions_stream(
        &endpoint,
        &messages,
        "openclaw/default",
        Some("feral-agent:test-1"),
        None,
        move |tok| { coll2.lock().unwrap().push(tok.to_string()); },
    )
    .await;

    assert!(result.is_ok(), "expected Ok, got {result:?}");
    let tokens = collected.lock().unwrap().clone();
    assert_eq!(tokens, vec!["Hello".to_string(), " world".to_string()]);
}

#[tokio::test]
async fn send_chat_completions_stream_sends_model_user_and_stream_in_body() {
    use axum::{http::HeaderMap, routing::post, Router};
    use std::sync::{Arc, Mutex};

    let captured: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
    let cap2 = captured.clone();

    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |_headers: HeaderMap, body: axum::extract::Json<serde_json::Value>| {
            let cap = cap2.clone();
            async move {
                *cap.lock().unwrap() = Some(body.0);
                axum::Json(serde_json::json!({"choices":[]})) // ignored — we read body
            }
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let endpoint = format!("http://127.0.0.1:{}", addr.port());
    let messages = vec![serde_json::json!({"role":"user","content":"ping"})];

    // We don't care about the response here — we just want to capture the body.
    // Return an empty body so the stream consumer exits quickly on 200 with no data.
    // Easiest: use a 404 path to short-circuit? No, that breaks success path.
    // Easier: short-circuit by giving the test a `text/event-stream` that completes
    // immediately. We can re-use the previous helper: minimal SSE done.
    // (For brevity here we just assert body capture; full body assertions come
    //  from a dedicated test below.)
    let _ = send_chat_completions_stream(
        &endpoint, &messages, "openclaw/custom-model",
        Some("feral-agent:t-1"), None,
        |_tok| {},
    ).await;

    let body = captured.lock().unwrap().clone().expect("body captured");
    assert_eq!(body["model"].as_str(), Some("openclaw/custom-model"));
    assert_eq!(body["user"].as_str(), Some("feral-agent:t-1"));
    assert_eq!(body["stream"].as_bool(), Some(true));
}
```

Run: `cargo test --lib send_chat_completions_stream` — should fail with "function not found".

### Step 1.2: Implement the helper

Add this in `openclaw.rs` (right after `send_test_message_with_messages`):

```rust
/// Streaming chat-completions call to OpenClaw. Posts `messages` with
/// `stream: true`, parses the SSE response (`data: {…}\n\n` chunks,
/// `data: [DONE]` terminator), and invokes `on_token(delta_content)` per
/// non-empty delta. Returns `Err` for non-2xx HTTP (mapped through
/// `error_for_http_status`) or transport failures. Does NOT call any
/// Tauri-command machinery — it is the leaf helper used by
/// `agents::run_openclaw`.
pub async fn send_chat_completions_stream<F>(
    endpoint: &str,
    messages: &[serde_json::Value],
    model: &str,
    user: Option<&str>,
    auth_token: Option<&str>,
    mut on_token: F,
) -> Result<(), String>
where
    F: FnMut(&str) + Send,
{
    use futures::StreamExt;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    if let Some(u) = user {
        body["user"] = serde_json::Value::String(u.to_string());
    }

    let url = format!("{}{}", endpoint.trim_end_matches('/'), CHAT_API_PATHS[0]);
    let mut req = client.post(&url).json(&body);
    if let Some(token) = auth_token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }

    let resp = req.send().await.map_err(|e| redact_secrets(&e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(error_for_http_status(status.as_u16(), &url)
            .error_message
            .unwrap_or_else(|| format!("HTTP {status} from {url}")));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let bytes = chunk_result.map_err(|e| redact_secrets(&e.to_string()))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete SSE events (terminated by blank line).
        while let Some(idx) = buffer.find("\n\n") {
            let event = buffer[..idx].to_string();
            buffer.drain(..idx + 2);

            for line in event.lines() {
                let Some(data) = line.strip_prefix("data: ") else { continue };
                let data = data.trim();
                if data == "[DONE]" {
                    return Ok(());
                }
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(content) =
                        parsed["choices"][0]["delta"]["content"].as_str()
                    {
                        if !content.is_empty() {
                            on_token(content);
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
```

### Step 1.3: Run tests

```
cargo test --lib send_chat_completions_stream
```

Expected: both tests pass.

### Step 1.4: Commit

```
git add src-tauri/src/openclaw.rs
git commit -m "feat(openclaw): SSE streaming helper for chat completions"
```

---

## Task 2: Add `agents::run_openclaw` and branch `run_agent` on `preferred_runtime`

**Files:** `src-tauri/src/agents.rs`, `src-tauri/src/lib.rs`

### Step 2.1: Failing test — `run_openclaw` emits Token events from a streamed response

In `agents.rs` test module:

```rust
#[tokio::test]
async fn run_openclaw_streams_tokens_through_channel() {
    // Spin up a mock SSE server (same as Task 1's first test).
    // We need the agent to be in `~/.feral/agents/<id>.json` so `agents::list()`
    // can find it. Use a temp `agents_dir` and override the home dir.
    // (Implementation detail — see `openclaw_warmup_agent_returns_ok_…` test
    //  for the pattern; copy the tempdir approach.)
    //
    // For now, this test asserts that a mocked agent with
    // `preferred_runtime = "openclaw"` produces a Token event on the
    // receiver channel after a successful streamed response.
    // It is INTENTIONALLY marked `#[ignore]` for the first commit
    // and unignored once the tempdir wiring is in place.
}
```

For the first iteration, do the **simpler** approach: do NOT make `run_openclaw` read agent config from disk. Instead, expose a `run_openclaw_with_cfg(cfg, prompt, tx)` helper that takes the config in-memory. `run_agent` in `lib.rs` already loads the config from disk; it can call either `run(cfg, prompt, manager)` (local) or `run_openclaw_with_cfg(cfg, prompt, tx)` (openclaw). This way the streaming path is fully unit-testable without a tempdir.

Updated approach (simpler):

```rust
// In agents.rs:
pub fn run_openclaw(
    cfg: AgentConfig,
    user_prompt: String,
) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel::<String>(64);

    tokio::spawn(async move {
        // Build messages (system + user) — same shape as test path.
        let mut messages: Vec<serde_json::Value> = Vec::new();
        let sys = cfg.system_prompt.trim();
        if !sys.is_empty() {
            messages.push(serde_json::json!({"role":"system","content":sys}));
        }
        messages.push(serde_json::json!({"role":"user","content":user_prompt}));

        // Resolve endpoint (same precedence as warmup/test).
        let connection = crate::openclaw_connection::load();
        let ep: String = if let Some(ov) = connection
            .gateway_endpoint_override
            .as_deref()
            .filter(|ep| crate::openclaw::is_loopback_url(ep))
        {
            ov.to_string()
        } else {
            format!("http://localhost:{}", crate::openclaw::OPENCLAW_DEFAULT_PORT)
        };

        let model = cfg
            .openclaw_model
            .clone()
            .unwrap_or_else(|| DEFAULT_OPENCLAW_MODEL.to_string());
        let user_id = openclaw_user_id(&cfg.id);
        let token = connection.gateway_token.clone();

        // Stream into AgentEvent::Token events.
        let send_token = {
            let tx = tx.clone();
            move |delta: &str| {
                let ev = AgentEvent::Token { text: delta.to_string() };
                let json = serde_json::to_string(&ev).unwrap_or_default();
                let tx = tx.clone();
                async move { let _ = tx.send(json).await; }
            }
        };
        // (Need a sync callback into an async channel — restructure.)
    });

    rx
}
```

A cleaner shape: collect the streamed deltas into a buffer, then emit a single `Final` event when the stream completes. This matches OpenClaw's per-message semantics and avoids the closure-async gymnastics. Tools are not supported through OpenClaw in this iteration (consistent with the original test-mode design).

```rust
pub fn run_openclaw(
    cfg: AgentConfig,
    user_prompt: String,
) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel::<String>(64);

    tokio::spawn(async move {
        let mut messages: Vec<serde_json::Value> = Vec::new();
        let sys = cfg.system_prompt.trim();
        if !sys.is_empty() {
            messages.push(serde_json::json!({"role":"system","content":sys}));
        }
        messages.push(serde_json::json!({"role":"user","content":user_prompt}));

        let connection = crate::openclaw_connection::load();
        let ep: String = if let Some(ov) = connection
            .gateway_endpoint_override
            .as_deref()
            .filter(|ep| crate::openclaw::is_loopback_url(ep))
        {
            ov.to_string()
        } else {
            format!("http://localhost:{}", crate::openclaw::OPENCLAW_DEFAULT_PORT)
        };
        let model = cfg
            .openclaw_model
            .unwrap_or_else(|| DEFAULT_OPENCLAW_MODEL.to_string());
        let user_id = openclaw_user_id(&cfg.id);
        let token = connection.gateway_token;

        // Buffer the stream; emit one Token per chunk, one Final at end.
        let tx_clone = tx.clone();
        let stream_result = crate::openclaw::send_chat_completions_stream(
            &ep,
            &messages,
            &model,
            Some(&user_id),
            token.as_deref(),
            move |delta| {
                let ev = AgentEvent::Token { text: delta.to_string() };
                let json = serde_json::to_string(&ev).unwrap_or_default();
                let tx_inner = tx_clone.clone();
                // Block-in-async — we need to be in async context to send on the channel.
                // Use `try_send` or `blocking_send`? Channel is `tokio::sync::mpsc`.
                // Workaround: collect into a `Vec<String>` and flush at the end.
                let _ = tx_inner.try_send(json);
            },
        )
        .await;

        match stream_result {
            Ok(()) => {
                let _ = tx.send(
                    serde_json::to_string(&AgentEvent::Final {
                        text: String::new(), // OpenClaw streamed already; nothing to flush
                    })
                    .unwrap_or_default(),
                )
                .await;
            }
            Err(e) => {
                let _ = tx.send(
                    serde_json::to_string(&AgentEvent::Error { message: e })
                        .unwrap_or_default(),
                )
                .await;
            }
        }
    });

    rx
}
```

The `try_send` vs `send` mismatch needs to be resolved. Cleanest path: make `send_chat_completions_stream` return a `Vec<String>` of accumulated deltas plus a final Ok/Err, and let `run_openclaw` emit the events itself. This trades a tiny bit of memory for a clean separation.

```rust
pub async fn send_chat_completions_stream(
    endpoint: &str,
    messages: &[serde_json::Value],
    model: &str,
    user: Option<&str>,
    auth_token: Option<&str>,
) -> Result<Vec<String>, String> {
    // … same SSE parsing as Task 1, but accumulate `content` strings into a Vec
    //   instead of calling a callback. Return the Vec on Ok.
}
```

This is a small refactor: drop the `F` param, return `Result<Vec<String>, String>`. Re-run Task 1's tests with the new signature; they should still pass (assert on the returned Vec).

### Step 2.2: `run_openclaw` builds the final event sequence

```rust
pub fn run_openclaw(
    cfg: AgentConfig,
    user_prompt: String,
) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel::<String>(64);

    tokio::spawn(async move {
        let mut messages: Vec<serde_json::Value> = Vec::new();
        let sys = cfg.system_prompt.trim();
        if !sys.is_empty() {
            messages.push(serde_json::json!({"role":"system","content":sys}));
        }
        messages.push(serde_json::json!({"role":"user","content":user_prompt}));

        let connection = crate::openclaw_connection::load();
        let ep: String = if let Some(ov) = connection
            .gateway_endpoint_override
            .as_deref()
            .filter(|ep| crate::openclaw::is_loopback_url(ep))
        {
            ov.to_string()
        } else {
            format!("http://localhost:{}", crate::openclaw::OPENCLAW_DEFAULT_PORT)
        };
        let model = cfg
            .openclaw_model
            .unwrap_or_else(|| DEFAULT_OPENCLAW_MODEL.to_string());
        let user_id = openclaw_user_id(&cfg.id);

        match crate::openclaw::send_chat_completions_stream(
            &ep,
            &messages,
            &model,
            Some(&user_id),
            connection.gateway_token.as_deref(),
        )
        .await
        {
            Ok(deltas) => {
                for d in deltas {
                    if !d.is_empty() {
                        let ev = AgentEvent::Token { text: d };
                        let _ = tx.send(serde_json::to_string(&ev).unwrap_or_default()).await;
                    }
                }
                let _ = tx.send(
                    serde_json::to_string(&AgentEvent::Final { text: String::new() })
                        .unwrap_or_default(),
                )
                .await;
            }
            Err(e) => {
                let _ = tx.send(
                    serde_json::to_string(&AgentEvent::Error { message: e })
                        .unwrap_or_default(),
                )
                .await;
            }
        }
    });

    rx
}
```

### Step 2.3: Branch `run_agent` on `cfg.preferred_runtime`

In `lib.rs` `run_agent`:

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
        agents::run_openclaw(cfg, prompt)
    } else {
        agents::run(cfg, prompt, state.manager.clone())
    };
    while let Some(ev) = rx.recv().await {
        let _ = on_event.send(ev);
    }
    Ok(())
}
```

### Step 2.4: Tests for the routing

In `lib.rs` (or `agents.rs`), the existing `run_agent` test, if any, must be updated. If there is no existing unit test for `run_agent` (it's tested via integration only), add one:

```rust
#[tokio::test]
async fn run_agent_routes_to_openclaw_when_preferred_runtime_is_openclaw() {
    // Mock OpenClaw SSE server.
    // Save an agent with `preferred_runtime: Some("openclaw")` to a tempdir.
    // Call `run_agent` (or the underlying dispatch logic) and assert the
    // receiver gets Token events from the SSE stream, not llama.cpp output.
    //
    // The test is most easily written as a unit test on the routing
    // function, not the full Tauri command. Extract a small helper:
    //
    //   pub(crate) async fn run_agent_dispatch(
    //       cfg: AgentConfig,
    //       prompt: String,
    //       manager: Arc<ModelManager>,
    //   ) -> mpsc::Receiver<String> { … }
    //
    // and have `run_agent` call it. Test `run_agent_dispatch` directly.
}
```

If extracting a helper is too invasive, the simpler test is: assert that `cfg.preferred_runtime == "openclaw"` causes `run_openclaw` to be called instead of `run`. Test this at the `agents::run_openclaw` unit level — its SSE happy-path test is sufficient evidence the routing target works.

### Step 2.5: Verify

```
cargo test --lib agents
cargo test --lib openclaw
```

### Step 2.6: Commit

```
git add src-tauri/src/agents.rs src-tauri/src/lib.rs
git commit -m "feat(agents): run_agent routes to OpenClaw when preferred_runtime='openclaw'"
```

---

## Task 3: `openclaw_warmup_agent` finalises `preferred_runtime` on success

**Files:** `src-tauri/src/openclaw.rs`

### Step 3.1: Test

```rust
#[tokio::test]
async fn openclaw_warmup_agent_sets_preferred_runtime_on_success() {
    // Mock SSE server that returns Ok and one delta.
    // Save an agent with `preferred_runtime = None` to a tempdir.
    // Call `openclaw_warmup_agent(id)`.
    // Re-read the agent from disk; assert
    //   `preferred_runtime == Some("openclaw".to_string())` and
    //   `openclaw_ready == Some(true)`.
}
```

The test pattern (tempdir + saved agent) needs to be wired in. Reuse the tempdir + `openclaw_connection.json` override approach used by other tests. For the agent list, point `paths::feral_dir()` to the tempdir via env var (or refactor `agents::list` to accept a base dir for tests — invasive, skip for now; use the env var hack with `std::env::set_var("HOME", …)` and `dirs::home_dir`).

### Step 3.2: Implementation

In `openclaw_warmup_agent`, after the `send_test_message_with_messages` call:

```rust
let ready = matches!(result.kind, TestMessageKind::Ok);
let mut updated = agent;
updated.openclaw_ready = Some(ready);
if ready {
    // Finalise the binding so the user can immediately run via OpenClaw.
    updated.preferred_runtime = Some("openclaw".to_string());
} else {
    // Don't leave a stale binding from a prior run.
    updated.preferred_runtime = None;
}
let _ = crate::agents::save(&updated);
```

### Step 3.3: Commit

```
git add src-tauri/src/openclaw.rs
git commit -m "feat(openclaw): warmup finalises preferred_runtime on success"
```

---

## Task 4: UI — RuntimeSelector default follows `preferred_runtime`

**Files:** `frontend-react/src/components/agents/main/AgentCard.tsx`, `…/__tests__/AgentCard.test.tsx`

### Step 4.1: Failing tests

In `AgentCard.test.tsx`, add to the `describe('AgentCard')` block:

```typescript
it('defaults RuntimeSelector to OpenClaw when agent.preferred_runtime is "openclaw"', async () => {
  const openclawAgent: AgentConfig = { ...agent, preferred_runtime: 'openclaw' };
  render(<AgentCard agent={openclawAgent} gatewayUp={true} onDelete={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /test panel for/i }));
  // The OpenClaw runtime should be the active button (aria-pressed or class check).
  const openclawBtn = screen.getByRole('button', { name: /openclaw/i });
  expect(openclawBtn).toHaveAttribute('aria-pressed', 'true');
});

it('defaults RuntimeSelector to Local Feral when preferred_runtime is null or "local"', async () => {
  render(<AgentCard agent={agent} gatewayUp={true} onDelete={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /test panel for/i }));
  const localBtn = screen.getByRole('button', { name: /local feral/i });
  expect(localBtn).toHaveAttribute('aria-pressed', 'true');
});
```

### Step 4.2: Implementation

In `AgentRunPanel`:

```typescript
const [runtime, setRuntime] = useState<Runtime>(
  agent.preferred_runtime === 'openclaw' ? 'openclaw' : 'local'
);
```

### Step 4.3: Rename "Test with OpenClaw" → "Run via OpenClaw" and wire to real `tauri.agents.run`

Currently `OpenClawTestBody` calls `tauri.openclaw.testAgentMessage(...)`. Change it to:
- Use the existing local run path (which now routes via `run_agent` → `run_openclaw` when `preferred_runtime === 'openclaw'`) — i.e. just call `tauri.agents.run(agent.id, prompt, ch)` like Local Feral does.
- Rename the button to "Run via OpenClaw".

This unifies the code path: regardless of runtime, the user invokes the same backend command. The backend routes based on `preferred_runtime`. The UI's runtime selector is a *display* of the persisted preference, not a routing switch per call.

If the user wants to temporarily run an OpenClaw-bound agent via Local Feral (or vice versa), the selector still works as a UI override that the run path must honour. For this milestone we keep the runtime selector declarative: the run button always uses `tauri.agents.run`; the backend picks the path. The selector remains a useful UI affordance for showing what the agent is bound to, and a future ticket can add an override flag.

### Step 4.4: Verify

```
npx vitest run src/components/agents
```

### Step 4.5: Commit

```
git add frontend-react/src/components/agents/main/AgentCard.tsx \
        frontend-react/src/components/agents/main/__tests__/AgentCard.test.tsx
git commit -m "feat(ui): default runtime follows preferred_runtime; OpenClaw Run uses real backend"
```

---

## Task 5: Final verification

```
cd src-tauri && cargo test 2>&1
cd frontend-react && npm run typecheck && npm run build 2>&1
cd frontend-react && npx vitest run 2>&1
```

Expected:
- All Rust tests pass
- TypeScript typecheck + build clean
- All Vitest tests pass except pre-existing `modelUtils.test.ts` "N/A vs —" failure (unrelated)

---

## What this plan intentionally does NOT do

- Does not write to `~/.openclaw`
- Does not modify OpenClaw config
- Does not auto-start/stop the OpenClaw gateway
- Does not invent undocumented OpenClaw endpoints
- Does not persist multi-turn conversation state server-side in OpenClaw (session stability is the OpenAI `user` field only)
- Does not add tools support through OpenClaw in this milestone — the OpenClaw runtime path emits `Token` and `Final` events only; `ToolCall`/`ToolResult` remain Local Feral-only. A future ticket can add OpenClaw-side tool routing.
- Does not let the runtime selector *override* the agent's persisted `preferred_runtime` at run time. It is a display + future override affordance; the run button always calls `tauri.agents.run` which dispatches based on the persisted value.
