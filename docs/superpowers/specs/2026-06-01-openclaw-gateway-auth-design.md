# OpenClaw Gateway Auth — Design Spec
**Date:** 2026-06-01  
**Status:** Approved  
**Scope:** Feral-owned OpenClaw connection settings + auth wiring for test-message

---

## Problem

OpenClaw gateway requires `Authorization: Bearer <token>` by default. The current
`openclaw_test_message` command sends no auth header, so any gateway with auth enabled
returns 401 and the UI shows "Unsupported" with a vague config instruction.

Feral must be able to store a user-supplied token and attach it to the test request —
without ever writing to `~/.openclaw` or modifying OpenClaw's own config.

---

## Decision

Store Feral-owned OpenClaw connection settings in `~/.feral/openclaw_connection.json`.
Mirror the BYOK redaction pattern: the raw token is accepted on Save and used internally,
but is **never returned** to the frontend through any get command.

Trusted-proxy / no-token mode is **implicit**: if no token is saved, the request is still
attempted. On 401/403 the UI shows auth guidance. No explicit checkbox.

---

## Architecture

### 1. Rust — `src-tauri/src/openclaw_connection.rs` (new)

**Stored struct** (never sent to frontend):
```rust
pub struct OpenClawConnectionSettings {
    pub gateway_endpoint_override: Option<String>,
    pub gateway_token: Option<String>,
}
```

**Frontend-facing view** (redacted):
```rust
pub struct OpenClawConnectionView {
    pub endpoint_override: Option<String>,
    pub has_token: bool,
}
```

**Persistence:** `~/.feral/openclaw_connection.json` via `paths::openclaw_connection_path()`.
Uses same `load()/save()` pattern as `byok.rs`. No new dirs needed (`feral_dir()` already exists).

**Token semantics in `save_openclaw_connection_settings`:**
- `token: Some(s)` where `s` trims to non-empty → replace stored token with `s`
- `token: Some(s)` where `s` trims to empty → **do not save**; preserve existing token
- `token: None` → preserve existing token; no change
- Only `clear_openclaw_token()` sets `gateway_token = None`

**Endpoint override semantics:**
- `endpoint_override: Some(s)` where `s` trims to non-empty → validate loopback, store trimmed value
- `endpoint_override: Some(s)` where `s` trims to empty → store `None` (clear override)
- `endpoint_override: None` → preserve existing override (no-op for this field)
- `clear_openclaw_token()` clears the **token only**; endpoint override is never touched by it

### 2. Rust — new path helper (`paths.rs`)

```rust
pub fn openclaw_connection_path() -> PathBuf {
    feral_dir().join("openclaw_connection.json")
}
```

### 3. Rust — three new Tauri commands (registered in `lib.rs`)

| Command | Args | Returns | Notes |
|---------|------|---------|-------|
| `get_openclaw_connection_settings` | — | `OpenClawConnectionView` | Never returns raw token |
| `save_openclaw_connection_settings` | `endpoint_override: Option<String>`, `token: Option<String>` | `()` | Token semantics above |
| `clear_openclaw_token` | — | `()` | Token only; endpoint preserved |

### 4. Rust — modified `openclaw_test_message` (`openclaw.rs`)

1. Load `OpenClawConnectionSettings`
2. Resolve effective endpoint: `connection.gateway_endpoint_override` (if loopback-valid) →
   else `endpoint` param → else `http://localhost:18789`
3. If `gateway_token` is `Some(t)`, add `Authorization: Bearer <token>` header to the reqwest request
4. No other changes; 401/403 already maps to `kind: unsupported` with auth guidance text

**Token security in tests:**
- The `Authorization: Bearer <token>` header attachment test lives in `openclaw.rs` (near
  `send_test_message`), not in `openclaw_connection.rs`. That is where the HTTP request is built.
- Token value is never printed in `tracing` logs or error messages.

### 5. TypeScript — `frontend-react/src/lib/tauri/index.ts`

New type:
```ts
export interface OpenClawConnectionView {
  endpoint_override: string | null;
  has_token: boolean;
}
```

New raw helpers + facade:
```ts
raw.getOpenclawConnectionSettings()
raw.saveOpenclawConnectionSettings(endpointOverride: string | null, token: string | null)
raw.clearOpenclawToken()

tauri.openclaw.getConnectionSettings()
tauri.openclaw.saveConnectionSettings(endpointOverride, token)
tauri.openclaw.clearToken()
```

### 6. UI — `OpenClawAuthPanel` card in `OpenClawTab.tsx`

Inserted **above** the existing "Send test message" panel.

```
┌─ Gateway auth ──────────────────────────────────────────────────────┐
│  Endpoint   http://localhost:18789  (detected / default)            │
│  Override   [________________________] (optional, loopback only)    │
│                                                                      │
│  Token      [________________________] (type="password")            │
│             ● Token saved  /  ○ No token saved                      │
│             placeholder: "Paste gateway token to replace saved…"   │
│                                                                      │
│  [Save token]  [Clear token]  ← Clear token: token only, not URL   │
│                                                                      │
│  Stored in Feral settings only — does not modify OpenClaw config.  │
└──────────────────────────────────────────────────────────────────────┘
```

**UI invariants:**
- Token input is **always empty on mount** — no fake `••••••` pre-fill
- After Save: input cleared; backend refresh; `has_token` badge updates
- `type="password"` ensures browser renders bullets; Feral never injects them
- "Clear token" removes token only; endpoint override field is unaffected
- If test result is `kind: 'unsupported'` and `error_message` contains "401" or "403":
  show inline hint: _"A 401/403 response means auth is required. Paste your gateway token above and save it, then retry the test."_

**State on mount:** calls `getConnectionSettings()` to populate `has_token` badge and endpoint_override field.

---

## Tests

### Rust (`openclaw_connection.rs`)
- `save/load` round-trip preserves all fields
- `clear_token` zeroes `gateway_token`, preserves `gateway_endpoint_override`
- Empty/whitespace token in save → existing token unchanged
- Non-loopback endpoint override → rejected with error
- `endpoint_override: Some("")` → stored as `None`

### Rust (`openclaw.rs` — near `send_test_message`)
- Token present → `Authorization: Bearer <token>` header attached to request
- Token absent → no `Authorization` header sent
- 401 → `kind: unsupported`, error_message contains auth guidance

### TypeScript (`OpenClawTab.test.tsx`)
- Token input has `type="password"`
- After Save resolves: input value is `""`, "Token saved" badge visible
- Raw token string not findable in rendered DOM after save
- Clear token → `clearToken()` called, badge shows "No token saved"
- "Clear token" does NOT clear endpoint override field
- `saveConnectionSettings` called with correct `(endpointOverride, token)` tuple
- `kind: 'unsupported'` + "401" in error_message → auth hint rendered
- Mock includes `getConnectionSettings`, `saveConnectionSettings`, `clearToken`

---

## Security constraints (hard rules)

1. **`get_openclaw_connection_settings` never returns the token** — only `has_token: bool`
2. **Token is one-way**: frontend → backend on Save; backend never echoes it back
3. **No writes to `~/.openclaw`** at any point
4. **Token not logged**: not in `tracing` spans, not in error messages, not in diagnostics
5. **Existing redaction in `openclaw.rs`** already strips `Authorization` headers from diagnostic output — this remains in force

---

## Out of scope (this checkpoint)

- OpenClaw-backed agent routing
- `auth_required` kind variant (keep `unsupported` to avoid scope creep)
- OS keychain / encrypted storage (plain JSON under `~/.feral` is the project standard)
- Reading or writing `~/.openclaw`

---

## Files changed

| File | Change |
|------|--------|
| `src-tauri/src/openclaw_connection.rs` | New — settings struct, load/save, 3 Tauri commands |
| `src-tauri/src/paths.rs` | Add `openclaw_connection_path()` |
| `src-tauri/src/openclaw.rs` | Modify `openclaw_test_message` to load connection settings + attach auth header |
| `src-tauri/src/lib.rs` | Register 3 new commands |
| `frontend-react/src/lib/tauri/index.ts` | Add `OpenClawConnectionView` type + 3 IPC methods |
| `frontend-react/src/components/settings/OpenClawTab.tsx` | Add `OpenClawAuthPanel` card + 401 inline hint |
| `frontend-react/src/components/settings/__tests__/OpenClawTab.test.tsx` | 8 new tests |
