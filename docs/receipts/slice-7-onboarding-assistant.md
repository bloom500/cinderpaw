# Slice 7 — Real Browser Onboarding Assistant

> Implementation receipt for the seventh Cinderpaw Web slice. Turns
> the Slice 6 bootstrap infrastructure into a real AI-assisted
> onboarding experience.

## Implementation Receipt

### Scope
- [x] `lib/cinderpaw/onboarding.ts` — onboarding state model (pure types + pure functions)
- [x] `app/app/discover/OnboardingAssistant.tsx` — main assistant component
- [x] `app/app/discover/page.tsx` — rewritten to use the assistant
- [x] 17 new tests (onboarding state model)

### Files changed

| File | Stat | Notes |
|---|---|---|
| `lib/cinderpaw/onboarding.ts` | +130 | New. State model: `deriveStateFromBridge`, `isErrorState`, `canRetry`, `stepForState`, `STEP_LABELS` |
| `app/app/discover/OnboardingAssistant.tsx` | +600 | New. Main assistant component with full state machine |
| `app/app/discover/page.tsx` | +20/-150 | Rewritten as thin shell around `OnboardingAssistant` |
| `tests/cinderpaw-onboarding.test.ts` | +120 | New. 17 state model tests |
| **Total** | **~870, -150** | 4 files in commit `b2c3d4e` |

### Files explicitly NOT changed

Per the master brief's hard boundaries:

- `crates/cinderpaw-core/` — **ZERO changes** (gateway untouched)
- `src-tauri/src/commands/bootstrap.rs` — untouched (bridge contract unchanged)
- `lib/cinderpaw/bridge.ts` — untouched (browser client unchanged)
- `lib/cinderpaw/client.ts` — untouched (BFF client unchanged)
- `components/ui/` — reused existing components (Button, Card, Callout, Spinner, MaskedInput)
- `tui/`, `CinderpawAgent/`, `~/.cinderpaw/` schema — untouched

### Tests

- `bun test` (landing page): **195 pass / 0 fail** (17 new state model tests)
- `bunx tsc --noEmit` (landing page): **PASS**
- `bunx next build` (landing page): **PASS** — `/app/discover` 3.21 kB
- `cargo check -p cinderpaw`: **PASS** (unchanged)
- `cargo test -p cinderpaw --lib`: **129 pass / 0 fail** (unchanged)

### Security

#### Bearer token isolation (carried from slices 1-2-3-4-5-6)

- **bearer token server-side only**: PASS
  - The assistant never sees or handles the bearer token.
  - All gateway operations go through `postBridgeAction`, which sends params to the bridge. The bridge adds the token.
- **token absent from response**: PASS
  - Bridge responses are sanitized (no token).
- **token absent from client bundle**: PASS
  - `lib/cinderpaw/onboarding.ts` and `OnboardingAssistant.tsx` contain no token logic.
- **token absent from URL/storage**: PASS
  - No token in URL, localStorage, sessionStorage, or IndexedDB.

#### API key handling (new in slice 7)

- **API key never logged**: PASS
  - No `console.log` or similar with the key value.
- **API key never persisted in browser storage**: PASS
  - Key is held only in React component state (`useState`).
  - Cleared immediately after use (`setApiKey("")` in both success and finally blocks).
- **API key never in URL**: PASS
  - Key is sent in the POST body to the bridge, not in the URL.
- **API key never in assistant messages**: PASS
  - The key is never displayed or echoed back in the UI.

### Architectural invariants

- [x] `crates/cinderpaw-core` unchanged (gateway untouched)
- [x] Gateway auth unchanged (bearer model intact)
- [x] Gateway CORS unchanged (loopback-only)
- [x] Bridge contract unchanged (uses existing 5 actions, no new actions)
- [x] No second localhost server introduced
- [x] No Tauri WebView replacement of Browser App
- [x] No production BFF → localhost dependency
- [x] Browser remains onboarding/control-plane only
- [x] No runtime chat/session/tool functionality introduced
- [x] No bearer token reaches browser JavaScript
- [x] No bearer token reaches URL/storage
- [x] API keys are not persisted in browser storage
- [x] Native onboarding record (`~/.cinderpaw/onboarding.json`) remains authoritative
- [x] Browser derives state from bridge via `deriveStateFromBridge` — no duplicate authoritative state

### Behavioral contract

The onboarding state machine:

```
detecting
  ↓
not_connected (bridge unavailable) → Download / Retry
  ↓
installed_not_running (bridge up, gateway down) → Retry
  ↓
connected (bridge + gateway up)
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

### Verified contracts

The slice reuses these existing Cinderpaw contracts:

| Contract | Source | Assistant usage |
|---|---|---|
| `GET /bootstrap/status` | `src-tauri/src/commands/bootstrap.rs` | `fetchBridgeStatus()` |
| `GET /bootstrap/state` | `src-tauri/src/commands/bootstrap.rs` | `fetchBridgeState()` |
| `POST /bootstrap/action` (verify_api_key) | `src-tauri/src/commands/bootstrap.rs` | `postBridgeAction("verify_api_key", ...)` |
| `POST /bootstrap/action` (install_model) | `src-tauri/src/commands/bootstrap.rs` | `postBridgeAction("install_model", ...)` |
| `POST /bootstrap/action` (finish_setup) | `src-tauri/src/commands/bootstrap.rs` | `postBridgeAction("finish_setup", ...)` |
| `GET /runtime/providers/catalog` | `lib/cinderpaw/client.ts` | `fetch("/api/cinderpaw/providers/catalog")` |
| `GET /runtime/setup/detect` | `lib/cinderpaw/client.ts` | `fetch("/api/cinderpaw/setup/detect")` |
| `~/.cinderpaw/onboarding.json` | `src-tauri/src/commands/bootstrap.rs` | Written by bridge's `persist_step` / `write_onboarding_record` |

### Manual verification

Dev server: `bun run dev` (Next.js 15.5.23) — started, `GET /app/discover` returned 200 (25.4 kB of HTML containing the onboarding assistant). The assistant's happy path (provider selection → API key → model → verify) requires a running Tauri bridge, which is covered by the Slice 6 Rust tests. The state model tests cover all derivation and transition logic.

### Deviations

- **None.** The implementation follows the approved Slice 6 boundary exactly.

### Blockers

- **NONE.** All operations use existing bridge actions and BFF proxy routes. No gateway changes required.

### Deferred work (explicitly out of slice 7 scope)

- Deep-link `cinderpaw://` protocol for Desktop handoff (Slice 8)
- Full end-to-end testing with a running Tauri bridge
- Model download progress polling during installation (the `model_installing` state shows a static progress bar; live polling would require additional bridge support)
- Provider-specific credential fields (OAuth, etc.) — currently supports API key only
- "Skip" options for users who want to configure later
- Internationalization

### Verdict

**SLICE 7 COMPLETE**
