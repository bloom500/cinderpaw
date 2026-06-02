# OpenClaw Full Execution Design

**Date:** 2026-06-02  
**Status:** Approved

## Problem

`run_agent` always routes to local llama.cpp regardless of `preferred_runtime`. The `preferred_runtime = "openclaw"` field is stored but never consulted. After onboarding, even when the warmup badge shows green, clicking Run still hits llama.cpp — not OpenClaw.

## Goal

After a user completes onboarding with OpenClaw running, they have a fully functional agent that executes through the OpenClaw gateway (localhost:18789). Model switching is handled by OpenClaw natively — Feral just routes correctly.

## Architecture

```
run_agent IPC (lib.rs)
  → load cfg
  → preferred_runtime == "openclaw"?
      YES → agents::run_openclaw(cfg, prompt)
                → POST /v1/chat/completions (stream: true)
                → parse SSE → AgentEvent::Token / Final / Error
      NO  → agents::run(cfg, prompt, manager)   [unchanged]
```

## Components

### 1. SSE streaming helper — `openclaw.rs`

```rust
async fn send_openclaw_chat(
    messages: Vec<Message>,
    model: &str,
    user_id: &str,
    endpoint: &str,
    token: Option<&str>,
) -> Result<impl Stream<Item = Result<String>>>
```

- POST `{endpoint}/v1/chat/completions` with `stream: true`
- Auth: `Authorization: Bearer {token}` if token present
- Parse SSE: `data: {...}\n\n` lines, extract `choices[0].delta.content`
- Stop on `data: [DONE]`
- Timeout: 60s (longer than warmup's 15s — real prompts can be slow)
- Error mapping: 401/403 → auth error message, 404 → endpoint hint, connection refused → gateway not running

### 2. `agents::run_openclaw()` — `agents.rs`

```rust
pub fn run_openclaw(cfg: AgentConfig, user_prompt: String) -> mpsc::Receiver<String>
```

- Loads connection settings (endpoint override + token) from `openclaw_connection`
- Resolves model: `cfg.openclaw_model.unwrap_or(DEFAULT_OPENCLAW_MODEL)`
- User field: `feral-agent:<cfg.id>` for session stability
- Messages: `[system, user]` — no tool loop this milestone (OpenClaw handles tools)
- Emits `AgentEvent::Token` per SSE chunk, `AgentEvent::Final` on completion
- On any error: `AgentEvent::Error { message }` with user-friendly text

### 3. Dispatch — `lib.rs`

```rust
// in run_agent:
if cfg.preferred_runtime.as_deref() == Some("openclaw") {
    agents::run_openclaw(cfg, prompt)
} else {
    agents::run(cfg, prompt, state.manager.clone())
}
```

### 4. Warmup sets `preferred_runtime` — `openclaw.rs`

In `openclaw_warmup_agent`, after saving `openclaw_ready`:

- Success → also save `preferred_runtime = Some("openclaw")`
- Failure → also save `preferred_runtime = None`

This means: completing onboarding with OpenClaw running automatically wires the agent to OpenClaw for all future runs.

## Tool Support

Not in this milestone. OpenClaw handles tool execution on its side. Feral sends a single-turn completion (system + user) and streams the response back.

## Error UX

| Condition | Message shown |
|-----------|---------------|
| 401/403 | "OpenClaw auth required — check Settings → OpenClaw" |
| Connection refused | "OpenClaw gateway not running — start with `openclaw start`" |
| 404 | "OpenClaw endpoint not found — check Settings → OpenClaw" |
| Timeout (60s) | "OpenClaw did not respond in time" |

## Testing

- SSE parser: unit tests with raw SSE strings (multi-chunk, `[DONE]`, empty delta)
- `run_openclaw`: mock HTTP server → assert correct events emitted
- Dispatch: `preferred_runtime == "openclaw"` → `run_openclaw` path, else local path
- Warmup side-effect: success → `preferred_runtime` written to disk

## Out of Scope

- Tool loop through OpenClaw
- Runtime selector UI override at call time
- Multi-turn conversation state
- Auto-start OpenClaw process
