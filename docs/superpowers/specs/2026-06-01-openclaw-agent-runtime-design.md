# OpenClaw-backed Agent Runtime — Design Spec
**Date:** 2026-06-01  
**Status:** Approved  
**Scope:** Feral agent onboarding + agent cards + OpenClaw warmup binding

---

## Goal

A newly created Feral agent can become an OpenClaw-backed profile, not just a local-only profile. The experience must be reliable for non-technical users: if OpenClaw is unavailable, the agent is still fully created; if it is available, the agent is automatically tested and marked ready.

---

## Data Model

### `AgentConfig` — one new field

```rust
#[serde(default)]
pub openclaw_ready: Option<bool>
```

- `None` — never tested (new agents before warmup, or old agents loaded from disk)
- `Some(false)` — warmup ran but failed
- `Some(true)` — warmup ran and succeeded; agent is OpenClaw-ready

**Backward compatibility:** `#[serde(default)]` means existing agent JSON files without this field deserialize to `None`. No migration needed.

**Existing fields already in place (from modified agents.rs):**
- `preferred_runtime: Option<String>` — `"local"` | `"openclaw"` | `None`
- `openclaw_model: Option<String>` — resolves to `"openclaw/default"` at call site
- `openclaw_user_id(id)` helper — returns `"feral-agent:<id>"`
- `OPENCLAW_WARMUP_PROMPT` constant

### TypeScript interface update

`frontend-react/src/lib/tauri/index.ts` `AgentConfig` interface gains:
```typescript
openclaw_ready?: boolean | null;
```

---

## Backend — New IPC Command

### `openclaw_warmup_agent(agent_id: String)`

**Location:** `src-tauri/src/openclaw.rs`  
**Registration:** `src-tauri/src/lib.rs` invoke handler list

**Flow:**
1. Load agent by `agent_id` from `agents::list()`. Return error if not found.
2. Resolve OpenClaw endpoint (saved override → default `http://localhost:18789`).
3. Load auth token from `openclaw_connection::load()`.
4. POST `/v1/chat/completions` with:
   - `model`: agent's `openclaw_model` or `"openclaw/default"`
   - `messages`: `[{role: "system", content: agent.system_prompt}, {role: "user", content: OPENCLAW_WARMUP_PROMPT}]`
   - `user`: `openclaw_user_id(&agent_id)` → `"feral-agent:<id>"`
   - `max_tokens`: 150, `stream`: false
5. On success (`kind: ok`): re-save agent with `openclaw_ready = Some(true)`.
6. On failure: re-save agent with `openclaw_ready = Some(false)`.
7. **Never fail silently or corrupt the agent.** Always return a result — warmup failure is not an error from the caller's perspective.

**Return type:** reuse `OpenClawTestMessageResult` (already has kind + response_text + error_message + endpoint_tried).

**Safety constraints honoured:**
- Does not write to `~/.openclaw`
- Does not edit OpenClaw config
- Does not invent undocumented endpoints
- Does not auto-start/stop OpenClaw
- Does not send prompts without an explicit onboarding/test action

---

## Onboarding Flow

### Current steps
Welcome → Pick Preset → Name Agent → Review → **Done**

### New Done screen behaviour

After `agents.save(cfg)` returns successfully:

1. Immediately call `openclaw_detect()` (lightweight ping).
2. **If gateway unreachable:** skip warmup entirely. Show agent as saved, no spinner. Done screen says agent is ready in local mode.
3. **If gateway reachable:** show spinner "Preparing OpenClaw runtime…", call `openclaw_warmup_agent(newAgentId)`.
   - **Warmup OK:** spinner resolves to green badge "OpenClaw ready — this agent is connected."
   - **Warmup failed:** spinner resolves to yellow badge "OpenClaw setup needed — check Settings."
4. In all cases, the "Open agent" / "Done" button is always available. Warmup result is informational, not blocking.

**The agent is always created. OpenClaw is always optional.**

---

## Agent Cards

### Gateway check

`openclaw_detect()` fires **once** when the Agents page mounts, result stored in page-level state. All cards read from this shared result — no per-card network call.

### Badge logic (per card)

| Gateway state | `openclaw_ready` | Badge |
|---|---|---|
| Down / unreachable | any | `Gateway unavailable` (grey) |
| Up | `true` | `OpenClaw ready` (green) |
| Up | `false` or `null` | `Setup needed` (yellow) |

Badge sits in the card header row, next to the tool chips.

### Test button session stability

The existing "Test with OpenClaw" button passes `user: feral-agent:<id>` in the request body so repeated tests from the same agent card land in the same OpenClaw session.

`openclaw_test_agent_message` will also persist `openclaw_ready = true` on success (it currently writes nothing back). This makes the card test and the onboarding warmup behave consistently — both update the stored flag. The frontend refreshes the agent list after a successful test so the badge updates immediately.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| OpenClaw not running at onboarding | Warmup skipped, agent saved as local-only |
| Warmup times out (>15s) | `openclaw_ready = false`, yellow badge, hint shown |
| Auth 401 | `openclaw_ready = false`, yellow badge, "check Settings" hint |
| Agent not found during warmup | IPC returns error string, onboarding shows generic failure |
| Old agent JSON without new field | Loads cleanly, badge shows "Setup needed" (None → not ready) |

---

## Tests

| Test | Expectation |
|---|---|
| Old agent JSON (no `openclaw_ready`) deserializes | Field is `None`, no panic |
| New agent after onboarding | `openclaw_ready` is `Some(true)` or `Some(false)`, never missing |
| Warmup request body | Contains `model: "openclaw/default"` and `user: "feral-agent:<id>"` |
| Warmup fails (mock error) | Agent JSON still present, `openclaw_ready = Some(false)` |
| Agent card badge — gateway down | Renders "Gateway unavailable" regardless of stored flag |
| Agent card badge — ready | Renders "OpenClaw ready" when gateway up + flag true |
| Agent card badge — setup needed | Renders "Setup needed" when gateway up + flag null/false |

---

## Verification Steps

1. `cargo check` — no Rust errors
2. `npm run typecheck` — no TS errors  
3. `npm run build` — clean build
4. Vitest — all agent + openclaw tests pass
5. Manual: create agent with OpenClaw running → Done screen shows ready badge
6. Manual: create agent without OpenClaw → Done screen shows agent saved, no crash

---

## What Remains Intentionally Disabled

- No writes to `~/.openclaw`
- No OpenClaw config modification
- No undocumented OpenClaw endpoints
- No auto-start/stop of OpenClaw process
- No prompts sent without explicit user action (onboarding save or card test button)
- `preferred_runtime` field is stored but not yet used to route actual agent runs — that is a future task
