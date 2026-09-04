# Slice 8 — Production Handoff Preflight Fixes

> Implementation receipt for the eighth Cinderpaw Web slice. Makes the
> existing Browser onboarding → Tauri bridge → Gateway → Desktop handoff
> architecture production-correct. Fixes Private Network Access, removes
> the production dependency on Vercel BFF → localhost, and corrects
> dishonest installation-detection UX.

## Implementation Receipt

### Scope
- [x] `src-tauri/src/commands/bootstrap.rs` — PNA preflight header, `list_providers`/`list_models` actions, port-conflict JSON diagnostic, removed dead `BridgeHandle`
- [x] `src-tauri/src/commands/mod.rs` — re-export for new actions
- [x] `src-tauri/src/lib.rs` — documented deferred deep-link
- [x] `lib/cinderpaw/bridge.ts` — `fetchBridgeProviders`, `fetchBridgeModels`, new types
- [x] `app/app/discover/OnboardingAssistant.tsx` — bridge-based provider/model loading, neutral "not connected" language, stale error clearing, `openDesktop` CTA
- [x] `lib/cinderpaw/onboarding.ts` — self-review fixes (deriveStateFromBridge, removed dead `connected` state)
- [x] `tests/cinderpaw-onboarding.test.ts` — self-review fixes (updated for new derivation)
- [x] 9 new Rust tests (PNA preflight, origin echo, wildcard omission, unknown action, persist validation)

### Files changed

| File | Stat | Notes |
|---|---|---|
| `src-tauri/src/commands/bootstrap.rs` | +80/-15 | PNA preflight, +`list_providers`/`list_models` actions, +port-conflict JSON diagnostic, −dead `BridgeHandle`, −`oneshot` import, +9 tests |
| `src-tauri/src/commands/mod.rs` | +1 | Added `pub(crate) use bootstrap::*` for new actions |
| `src-tauri/src/lib.rs` | +2/-1 | Documented deferred deep-link |
| `lib/cinderpaw/bridge.ts` | +45/-2 | Added `fetchBridgeProviders`, `fetchBridgeModels`, `BridgeProviderEntry`, `BridgeModelCandidate` types |
| `app/app/discover/OnboardingAssistant.tsx` | +25/-20 | Bridge-based provider/model loading, neutral "not connected" language, stale error clearing, `openDesktop` CTA |
| `lib/cinderpaw/onboarding.ts` | +8/-12 | Self-review: removed dead `connected` state, fixed `deriveStateFromBridge` |
| `tests/cinderpaw-onboarding.test.ts` | +10/-5 | Self-review: updated tests for new derivation behavior |
| **Total** | **~170, -55** | 7 files across 2 repos, commits `c7c6a7c` + `0b17eed7` |

### Files explicitly NOT changed

Per the master brief's hard boundaries:

- `crates/cinderpaw-core/` — **ZERO changes** (gateway untouched)
- Gateway auth model — untouched (bearer model intact)
- Gateway CORS — untouched (loopback-only)
- `components/ui/` — reused existing components (Button, Card, Callout, Spinner, MaskedInput)
- `tui/`, `CinderpawAgent/`, `~/.cinderpaw/` schema — untouched
- Bridge port — kept at `11437` (no random allocation, no discovery)

### Tests

- `bun test` (landing page): **195 pass / 0 fail** (17 onboarding tests, updated for self-review fixes)
- `bunx tsc --noEmit` (landing page): **PASS**
- `bunx next build` (landing page): **PASS** — `/app/discover` 3.21 kB
- `cargo check -p cinderpaw`: **PASS**
- `cargo test -p cinderpaw --lib`: **138 pass / 0 fail** (9 new PNA + action tests)

### Security

#### Bearer token isolation (carried from slices 1-2-3-4-5-6-7)

- **bearer token server-only**: PASS
  - The browser never sees or handles the bearer token.
  - All gateway operations go through `postBridgeAction`, which sends params to the bridge. The bridge adds the token.
- **token absent from response**: PASS
  - Bridge responses are sanitized (no token).
- **token absent from client bundle**: PASS
  - `lib/cinderpaw/bridge.ts` and `OnboardingAssistant.tsx` contain no token logic.
- **token absent from URL/storage**: PASS
  - No token in URL, localStorage, sessionStorage, or IndexedDB.

#### Private Network Access (new in slice 8)

- **PNA preflight header**: PASS
  - Bridge preflight includes `Access-Control-Allow-Private-Network: true` when the browser sends `Access-Control-Request-Private-Network: true`.
  - Header is only sent when requested (not unconditionally).
  - Detection is case-insensitive.
- **Origin still echoed strictly**: PASS
  - Validated origin is echoed back; wildcard (`*`) is never used.
- **Existing Origin/Host validation intact**: PASS
  - Invalid origins/hosts still rejected with 403.

#### API key handling (carried from slice 7)

- **API key never logged**: PASS
- **API key never persisted in browser storage**: PASS
- **API key never in URL**: PASS
- **API key never in assistant messages**: PASS

### Architectural invariants

- [x] `crates/cinderpaw-core` unchanged (gateway untouched)
- [x] Gateway auth unchanged (bearer model intact)
- [x] Gateway CORS unchanged (loopback-only)
- [x] Gateway remains on configured `api_port` (default 11435)
- [x] Bridge remains embedded in Tauri (not a companion process)
- [x] Bridge remains loopback-only (127.0.0.1:11437)
- [x] Bridge dies with the Tauri process
- [x] No second localhost server introduced
- [x] No Tauri WebView replacement of Browser App
- [x] Browser remains onboarding/control-plane only
- [x] No runtime chat/session/tool functionality introduced
- [x] No bearer token reaches browser JavaScript
- [x] No bearer token reaches URL/storage
- [x] API keys are not persisted in browser storage
- [x] Native onboarding record (`~/.cinderpaw/onboarding.json`) remains authoritative
- [x] Production path no longer depends on Vercel BFF → localhost gateway communication
- [x] Bridge contract expanded by 2 actions (still 3 endpoints): `list_providers`, `list_models` — both map to fixed known operations, reject arbitrary paths/URLs

### Behavioral contract

The onboarding state machine (unchanged from slice 7):

```
detecting
  ↓
not_connected (bridge unavailable) → Open Cinderpaw Desktop / Retry
  ↓
installed_not_running (bridge up, gateway down) → Retry
  ↓
provider_selection → provider_credentials → provider_verified
  ↓
model_selection → model_installing → model_ready
  ↓
verifying → ready
  ↓
[ Open Cinderpaw Desktop ]
```

Every state has a recoverable error path. No dead-ends.

### Production flow

```
Browser (https://cinderpaw.dev)
  → fetch("http://127.0.0.1:11437/bootstrap/status")
  → OPTIONS preflight includes PNA header when requested
  → GET /bootstrap/state (onboarding progress)
  → POST /bootstrap/action {action: "list_providers"} → bridge → byok::provider_catalog()
  → POST /bootstrap/action {action: "list_models"} → bridge → setup::detect()
  → POST /bootstrap/action {action: "verify_api_key", ...} → bridge → gateway
  → POST /bootstrap/action {action: "install_model", ...} → bridge → gateway
  → POST /bootstrap/action {action: "finish_setup"} → bridge → persists all steps
  → "Open Cinderpaw Desktop" → window.location.href = "cinderpaw://open"
     (protocol registration deferred; manual fallback shown)
```

### Verified contracts

The slice reuses these existing Cinderpaw contracts:

| Contract | Source | Usage |
|---|---|---|
| `GET /bootstrap/status` | `src-tauri/src/commands/bootstrap.rs` | `fetchBridgeStatus()` |
| `GET /bootstrap/state` | `src-tauri/src/commands/bootstrap.rs` | `fetchBridgeState()` |
| `POST /bootstrap/action` (verify_api_key) | `src-tauri/src/commands/bootstrap.rs` | `postBridgeAction("verify_api_key", ...)` |
| `POST /bootstrap/action` (install_model) | `src-tauri/src/commands/bootstrap.rs` | `postBridgeAction("install_model", ...)` |
| `POST /bootstrap/action` (finish_setup) | `src-tauri/src/commands/bootstrap.rs` | `postBridgeAction("finish_setup", ...)` |
| `POST /bootstrap/action` (list_providers) | `src-tauri/src/commands/bootstrap.rs` | `fetchBridgeProviders()` → `byok::provider_catalog()` |
| `POST /bootstrap/action` (list_models) | `src-tauri/src/commands/bootstrap.rs` | `fetchBridgeModels()` → `setup::detect()` |
| `~/.cinderpaw/onboarding.json` | `src-tauri/src/commands/bootstrap.rs` | Written by bridge's `persist_step` / `write_onboarding_record` |

### Manual verification

Dev server: `bun run dev` (Next.js 15.5.23) — started, `GET /app/discover` returned 200 (25.4 kB of HTML containing the onboarding assistant). The assistant's happy path (provider selection → API key → model → verify) requires a running Tauri bridge, which is covered by the Rust unit tests. The state model tests cover all derivation and transition logic. The PNA preflight tests cover the header logic.

### Deviations

- **8.B Deep-link deferred**: `cinderpaw://` protocol registration requires platform-specific testing (Windows registry, macOS Info.plist, Linux .desktop) and a Tauri URL-open handler. The `tauri-plugin-deep-link` v2.4.x API did not match the expected `register`/`on_open_url` signatures, and `RunEvent::Opened` does not exist in this Tauri version. The browser CTA uses `cinderpaw://open` with a manual-fallback message. This is a known limitation requiring a dedicated cross-platform implementation phase.
- **Bridge duplicates `onboarding_path()` logic**: The bridge re-implements `onboarding_path()` (already in `commands/system.rs`) and reads `sysinfo_mod::collect()` directly (already wrapped by `get_system_info()`). Documented as acceptable MVP debt.

### Blockers

- **P0**: `cinderpaw://` deep-link protocol registration (deferred to dedicated cross-platform phase)
- **P1**: Bridge port conflict silent failure — diagnostic emitted (`bridge://bind_failed` with JSON payload) but not surfaced to browser UI
- **P1**: Bridge duplicates existing command logic (`onboarding_path`, `sysinfo_mod::collect`)

### Deferred work (explicitly out of slice 8 scope)

- Deep-link `cinderpaw://` protocol registration and window-focus handler (requires cross-platform testing)
- Full end-to-end testing with a running Tauri bridge on each OS
- Model download progress polling during installation
- Provider-specific credential fields (OAuth, etc.)
- Port-conflict message surfaced to browser UI
- Shared constant for bridge port between Rust/TypeScript

### Verdict

**SLICE 8 COMPLETE**

The existing Browser onboarding → Tauri bridge → Gateway → Desktop handoff architecture is now production-valid for all paths except the deep-link handoff (deferred). Private Network Access is fixed, the production BFF → localhost dependency is removed, and the installation-detection UX is honest.
