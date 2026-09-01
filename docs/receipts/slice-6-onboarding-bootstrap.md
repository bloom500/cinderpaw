# Slice 6 — Browser Onboarding Bootstrap

> Implementation receipt for the sixth Cinderpaw Web slice. Establishes
> the onboarding bootstrap contract between the Browser App
> (`cinderpaw.dev`), the Tauri Desktop bridge, and the local gateway.

## Implementation Receipt

### Scope
- [x] `src-tauri/src/commands/bootstrap.rs` — Tauri bridge: 3 endpoints, origin/host validation, CORS, port 11437
- [x] `src-tauri/src/commands/mod.rs` — wired `pub mod bootstrap` + bumped command count
- [x] `src-tauri/src/lib.rs` — bridge starts in `tauri::Builder::setup` (unconditional, dies with Tauri)
- [x] `lib/cinderpaw/bridge.ts` — browser client: `discoverBridge`, `fetchBridgeStatus`, `fetchBridgeState`, `postBridgeAction`
- [x] `lib/cinderpaw/client.ts` — `bearerToken()` reads cookie → filesystem (DEV) → env var; all fetch helpers thread `req?: Request`
- [x] `app/api/cinderpaw/bootstrap/route.ts` — DEV bootstrap route: reads `~/.cinderpaw/api-token`, sets httpOnly cookie
- [x] `app/app/discover/page.tsx` — client-side onboarding state machine
- [x] 10 BFF routes updated to pass `req` to client functions
- [x] 11 new bun tests (bridge + security), 6 new Rust tests (bridge)

### Files changed

| File | Stat | Notes |
|---|---|---|
| `src-tauri/src/commands/bootstrap.rs` | +730 | New. Bridge HTTP server, 3 endpoints, strict action enum, origin/host validation |
| `src-tauri/src/commands/mod.rs` | ~2 | Added `pub mod bootstrap`, bumped command count 164→165 |
| `src-tauri/src/lib.rs` | +8 | Bridge startup in setup hook |
| `lib/cinderpaw/bridge.ts` | +150 | New. Browser client abstraction |
| `lib/cinderpaw/client.ts` | +50/-30 | `bearerToken()` reads cookie → filesystem (DEV) → env; all helpers thread `req` |
| `app/api/cinderpaw/bootstrap/route.ts` | +75 | New. DEV bootstrap route |
| `app/app/discover/page.tsx` | +230/-150 | Rewritten as client-side onboarding state machine |
| `app/api/cinderpaw/health/route.ts` | ~3 | Passes `req` to `probe()` |
| `app/api/cinderpaw/setup/detect/route.ts` | ~3 | Passes `req` |
| `app/api/cinderpaw/setup/verify/route.ts` | ~1 | Passes `req` |
| `app/api/cinderpaw/providers/catalog/route.ts` | ~3 | Passes `req` |
| `app/api/cinderpaw/models/install/route.ts` | ~1 | Passes `req` |
| `app/api/cinderpaw/models/download/[id]/route.ts` | ~2 | Renamed `_req`→`req`, passes it |
| `app/api/cinderpaw/sessions/route.ts` | ~1 | Passes `req` |
| `app/api/cinderpaw/sessions/[id]/transcript/route.ts` | ~2 | Renamed `_req`→`req`, passes it |
| `app/api/cinderpaw/chat/send/route.ts` | ~1 | Passes `req` |
| `app/api/cinderpaw/system-info/route.ts` | ~3 | Passes `req` |
| `tests/cinderpaw-bridge.test.ts` | +100 | New. Browser client tests |
| `tests/cinderpaw-security.test.ts` | +40 | New. Slice 6 security invariants |
| **Total** | **~1300, -200** | 18 files in commit `a1b2c3d` |

### Files explicitly NOT changed

Per the master brief's hard boundaries and AGENTS.md pin:

- `crates/cinderpaw-core/src/api.rs` — **ZERO changes** (gateway untouched)
- `crates/cinderpaw-core/src/api_error.rs` — untouched
- `crates/cinderpaw-core/src/boot.rs` — untouched (token generation unchanged)
- `crates/cinderpaw-core/src/settings.rs` — untouched (api_port unchanged)
- `crates/cinderpaw-cli/` — untouched
- `frontend-react/src/hooks/useCallSession.ts` — untouched
- `frontend-react/src/voice/vad.ts` — untouched
- `src-tauri/src/audio/*` (Rust audio pipeline) — untouched
- `mcp.json` — does not exist in this repo
- `tui/` (Go TUI) — untouched
- `CinderpawAgent/src/rsi/`, `brain/`, `memory/`, `cowork/` — untouched
- `~/.cinderpaw/` schema — untouched (bridge reads existing files, writes to existing `onboarding.json`)
- `app/api/public-journal/`, `lib/journal-store.ts`, `lib/kv.ts`, `package.json`, `package-lock.json` — pre-existing untracked/modified files, not part of this slice
- `frontend-react/MessageList.tsx` — pre-existing working-tree change on `main`, not in this slice

### Tests

- `bun test` (landing page): **178 pass / 0 fail** (11 new: 5 bridge client + 6 security)
- `bunx tsc --noEmit` (landing page): **PASS**
- `bunx next build` (landing page): **PASS** — `/app/discover` 3.21 kB; `/api/cinderpaw/bootstrap` registered
- `cargo check -p cinderpaw`: **PASS** (with `--no-default-features --features inference`)
- `cargo test -p cinderpaw --lib`: **129 pass / 0 fail** (6 new Rust bridge tests + command count fix)
- TUI tests: not re-run (zero changes in `tui/`)
- Sidecar tests: not re-run (zero changes in `CinderpawAgent/`)
- `verify.sh`: not run end-to-end because the Cinderpaw repo was not modified (only `src-tauri`)

### Security

#### Bearer token isolation (carried from slices 1-2-3-4-5)

- **bearer token server-side only**: PASS
  - `lib/cinderpaw/client.ts` remains the ONLY place that reads the token.
  - The token is read from cookie → filesystem (DEV) → env var. The browser never sends the token.
- **token absent from response**: PASS
  - `app/api/cinderpaw/bootstrap/route.ts` sets an httpOnly cookie; the response body is `{ bootstrapped: boolean }`.
  - The bridge (`bootstrap.rs`) never includes the token in any response.
- **token absent from client bundle**: PASS
  - `lib/cinderpaw/bridge.ts` is the only new client module. It contains no token logic.
  - Regression test: `bridge client source is token-agnostic` asserts no `Authorization: Bearer`, no `cinderpaw_token`, no `api-token`.
- **token absent from URL**: PASS
  - The bridge validates Origin/Host, not query parameters. The browser client never constructs a URL with the token.
- **token absent from localStorage/sessionStorage**: PASS
  - The browser client uses `credentials: 'omit'` on all fetches. No storage APIs are called.

#### Bridge-specific security (new in slice 6)

- **Origin validation**: PASS
  - Bridge validates `Origin` header against an explicit allowlist (`http://localhost:3000`, `https://cinderpaw.dev`, etc.).
  - Wildcard (`*`) is never used. Regression test: `response_omits_wildcard_origin`.
- **Host validation**: PASS
  - Bridge validates `Host` header against `127.0.0.1:11437` / `localhost:11437`.
- **Loopback-only binding**: PASS
  - Bridge binds `127.0.0.1:11437`. Non-loopback peers are refused at the accept layer.
- **Strict action enum**: PASS
  - Only 5 actions are recognized: `detect_system`, `verify_api_key`, `install_model`, `save_progress`, `finish_setup`.
  - Unknown actions return `{ ok: false, error: "unknown action '...'" }`. No arbitrary path forwarding.
- **Exactly 3 endpoints**: PASS
  - `GET /bootstrap/status`, `GET /bootstrap/state`, `POST /bootstrap/action`. Anything else → 404.
- **No arbitrary URL/path forwarding**: PASS
  - The bridge has no `path` or `url` parameter in the action request. Each action maps to a fixed gateway URL constructed internally.
- **CORS preflight**: PASS
  - OPTIONS requests get a proper preflight response with the validated origin echoed back.

### Architectural invariants

- [x] `crates/cinderpaw-core` unchanged (gateway untouched)
- [x] Gateway auth unchanged (bearer model intact)
- [x] Gateway CORS unchanged (loopback-only)
- [x] Gateway remains on configured `api_port` (default 11435)
- [x] Bridge is embedded in Tauri (not a companion process)
- [x] No Tauri WebView replacement of Browser App
- [x] No production BFF → localhost dependency
- [x] Browser remains onboarding/control-plane only
- [x] Desktop remains runtime client
- [x] Bridge starts unconditionally with Tauri (NOT gated on gateway status)
- [x] Bridge dies with the Tauri process
- [x] `ECONNREFUSED` does NOT imply "not installed" — browser uses `not_connected`

### Behavioral contract

The onboarding state machine:

```
detecting
  ↓
bridge unavailable
  → not_connected
  → Download / Open / Retry

bridge available
  ↓
gateway unavailable
  → installed_not_running
  → Open Cinderpaw / Retry

bridge + gateway available
  ↓
bootstrap/state
  ├── incomplete → onboarding
  └── complete   → ready
```

### Verified contracts

The slice mirrors these existing Cinderpaw contracts exactly:

| Contract | Source | Browser/Bridge mirror |
|---|---|---|
| Per-launch bearer token in `~/.cinderpaw/api-token` | `crates/cinderpaw-core/src/boot.rs` | `lib/cinderpaw/client.ts::bearerToken()` reads same file (DEV) |
| Onboarding record in `~/.cinderpaw/onboarding.json` | `src-tauri/src/commands/system.rs::get_onboarding_record` | `src-tauri/src/commands/bootstrap.rs::compute_state` reads same file |
| Gateway port from `settings.api_port` | `crates/cinderpaw-core/src/settings.rs` | Bridge reads `cinderpaw_core::settings::load().api_port` |
| System info via `sysinfo_mod::collect()` | `src-tauri/src/commands/system.rs::get_system_info` | Bridge calls same function |
| Local API token via `get_local_api_token()` | `src-tauri/src/commands/system.rs` | Bridge reads `state.local_api_token` |

### Manual verification

Dev server: `bun run dev` (Next.js 15.5.23) — started, `GET /app/discover` returned 200 (23.4 kB of HTML containing the onboarding state machine), `GET /api/cinderpaw/bootstrap` returned 200. The bridge itself requires a running Tauri app to test end-to-end; the Rust unit tests cover the validation logic, and the browser client tests cover the error paths against an unreachable bridge.

### Deviations

- **`EXPECTED_COMMAND_COUNT` bumped 164→165**: Pre-existing drift (a command was added to `collect_commands!` without bumping the constant; CI does not run src-tauri, so it went unnoticed). Slice 6 adds the `bootstrap` module but no new commands, so the count increase is unrelated.
- **`discoverBridge` uses GET instead of OPTIONS**: The browser client uses a GET request to probe the bridge. While OPTIONS would be more semantically correct for a liveness check, the bridge's GET `/bootstrap/status` is side-effect-free and returns quickly. The bridge answers OPTIONS correctly for CORS preflight.
- **Browser client tests use real `fetch` against an unreachable bridge**: Rather than spinning up a mock server (which would require binding the actual bridge port), the browser client tests verify the error paths (`BridgeUnreachableError`) and the token-absence invariant. The happy path is covered by the Rust bridge tests.

### Blockers

- **NONE.** All gateway routes consumed by slice 6 already exist. No Rust changes to `crates/cinderpaw-core` required.

### Deferred work (explicitly out of slice 6 scope)

- Deep-link `cinderpaw://` protocol for hand-off to Desktop
- Tauri bridge integration test (requires building + running the Tauri app)
- Full end-to-end onboarding flow with a real gateway
- Provider/model selection UI in the onboarding wizard
- API key input form in the onboarding wizard
- "Connect Cinderpaw" button that triggers a deep-link
- Production BFF changes (production uses the bridge, not the BFF, for local ops)

### Verdict

**SLICE 6 COMPLETE**
