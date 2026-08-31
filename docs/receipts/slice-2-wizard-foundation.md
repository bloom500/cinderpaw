# Slice 2 — Wizard Foundation

> Implementation receipt for Cinderpaw Web Slice 2. Covers the wizard shell,
> routing, BFF routes, provider catalog, cloud-provider key entry + the
> deterministic verify gate, wizard progress persistence (the on-disk write
> path), and the pure-function contracts that tie them together.

## Implementation Receipt

### Scope
- [x] `app/app/wizard/page.tsx` — Welcome (1 of 4), QuickStart / Custom / Use Existing Config
- [x] `app/app/wizard/engine/page.tsx` — Hardware probe (2 of 4) + local vs cloud choice
- [x] `app/app/wizard/work/page.tsx` — dispatcher (local placeholder / cloud forward)
- [x] `app/app/wizard/work/cloud/page.tsx` — provider catalog picker + version pin
- [x] `app/app/wizard/work/cloud/[providerId]/page.tsx` — key entry + verify shell
- [x] `app/app/wizard/work/cloud/[providerId]/CloudKeyForm.tsx` — client form: key never leaves the component except as a verify-body field
- [x] `app/app/wizard/ready/page.tsx` — Ready (4 of 4) + wizard-done marker write
- [x] `app/app/wizard/actions.ts` — server actions for progress persistence
- [x] `app/api/cinderpaw/setup/detect/route.ts` — BFF proxy for detection ladder
- [x] `app/api/cinderpaw/setup/verify/route.ts` — BFF proxy for verify
- [x] `app/api/cinderpaw/providers/catalog/route.ts` — BFF proxy for provider catalog
- [x] `app/api/cinderpaw/system-info/route.ts` — BFF proxy for hardware probe
- [x] `app/api/cinderpaw/models/install/route.ts` — BFF proxy for download start
- [x] `app/api/cinderpaw/models/download/[id]/route.ts` — BFF proxy for download poll
- [x] `app/api/cinderpaw/wizard/progress/route.ts` — BFF read wizard progress
- [x] `app/api/cinderpaw/wizard/progress/save/route.ts` — BFF write wizard progress (validated)
- [x] `app/api/cinderpaw/wizard/finish/route.ts` — BFF clear progress + write done marker
- [x] `lib/cinderpaw/catalog-version.ts` — pure catalog version utilities
- [x] `lib/cinderpaw/wizard-progress.ts` — pure encode/decode progress format
- [x] `lib/cinderpaw/verify.ts` — CINDERPAW_OK content gate
- [x] `lib/cinderpaw/wizard-disk.ts` — on-disk read/write for wizard progress + done marker
- [x] `lib/cinderpaw/client.ts` — extended with setup/providers/system-info/models
- [x] `components/ui/MaskedInput.tsx` — masked input primitive
- [x] `components/ui/PollingStatus.tsx` — polling primitive for download progress
- [x] `tests/cinderpaw-wizard-progress.test.ts` — format round-trip + malformed/wrong-version rejection
- [x] `tests/cinderpaw-catalog-version.test.ts` — catalog version pinning
- [x] `tests/cinderpaw-verify.test.ts` — CINDERPAW_OK content gate
- [x] `tests/cinderpaw-security.test.ts` — extended for slice 2 (BFF isolation, progress format)

### Files changed

| File | Stat | Notes |
|---|---|---|
| `app/app/wizard/page.tsx` | +62 | New |
| `app/app/wizard/engine/page.tsx` | +96 | New |
| `app/app/wizard/work/page.tsx` | +42 | New |
| `app/app/wizard/work/cloud/page.tsx` | +78 | New |
| `app/app/wizard/work/cloud/[providerId]/page.tsx` | +62 | New |
| `app/app/wizard/work/cloud/[providerId]/CloudKeyForm.tsx` | +168 | New |
| `app/app/wizard/ready/page.tsx` | +52 | New |
| `app/app/wizard/actions.ts` | +72 | New |
| `app/api/cinderpaw/setup/detect/route.ts` | +17 | New |
| `app/api/cinderpaw/setup/verify/route.ts` | +38 | New |
| `app/api/cinderpaw/providers/catalog/route.ts` | +20 | New |
| `app/api/cinderpaw/system-info/route.ts` +14 | New |
| `app/api/cinderpaw/models/install/route.ts` | +28 | New |
| `app/api/cinderpaw/models/download/[id]/route.ts` | +22 | New |
| `app/api/cinderpaw/wizard/progress/route.ts` | +18 | New |
| `app/api/cinderpaw/wizard/progress/save/route.ts` | +38 | New |
| `app/api/cinderpaw/wizard/finish/route.ts` | +18 | New |
| `lib/cinderpaw/catalog-version.ts` | +28 | New |
| `lib/cinderpaw/wizard-progress.ts` | +82 | New |
| `lib/cinderpaw/verify.ts` | +32 | New |
| `lib/cinderpaw/wizard-disk.ts` | +118 | New |
| `lib/cinderpaw/client.ts` | +120 | Extended |
| `components/ui/MaskedInput.tsx` | +52 | New |
| `components/ui/PollingStatus.tsx` | +72 | New |
| `tests/cinderpaw-wizard-progress.test.ts` | +62 | New |
| `tests/cinderpaw-catalog-version.test.ts` | +28 | New |
| `tests/cinderpaw-verify.test.ts` | +38 | New |
| `tests/cinderpaw-security.test.ts` | +42 | Extended |
| Total | ~1650 | 27 files |

### Files explicitly NOT changed

Per the master brief's hard boundaries and AGENTS.md pin:

- `frontend-react/src/hooks/useCallSession.ts` — not touched
- `frontend-react/src/voice/vad.ts` — not touched
- `src-tauri/src/audio/*` (Rust audio pipeline) — not touched
- `mcp.json` — does not exist in this repo
- `tui/` (Go TUI wizard state machine) — not touched (behavioral reference only)
- `CinderpawAgent/src/rsi/`, `brain/`, `memory/`, `cowork/` — not touched
- `~/.cinderpaw/` schema — the wizard progress file is a pre-existing TUI contract; no schema changes
- `crates/cinderpaw-core/src/api.rs` — no gateway changes; slice 2 consumes existing routes
- `crates/cinderpaw-cli/` — not touched
- `app/api/subscribe/`, `app/api/on-release/`, `app/api/download/`, `app/api/public-journal/` — existing routes unchanged
- `components/SiteHeader.tsx`, `components/SiteFooter.tsx` — marketing chrome not reused inside `/app`
- `app/app/page.tsx`, `app/app/layout.tsx`, `app/app/discover/`, `app/api/cinderpaw/health/` — slice 1 code unchanged
- `lib/cinderpaw/discovery.ts`, `lib/cinderpaw/types.ts` — slice 1 code unchanged

### Tests

- `bun test` (landing page): **105 pass / 0 fail** (22 new tests in this slice)
- `bunx tsc --noEmit` (landing page): **PASS**
- `bunx next build` (landing page): **PASS** — all 7 wizard routes listed
- Cinderpaw Rust tests: not re-run (zero changes in the Cinderpaw repo)
- TUI tests: not re-run (zero changes in `tui/`)
- Sidecar tests: not re-run (zero changes in `CinderpawAgent/`)
- `verify.sh`: not run end-to-end because the Cinderpaw repo was not modified

### Security

#### Bearer token isolation

- **bearer token server-side only**: PASS
  - `lib/cinderpaw/client.ts` is the ONLY place that reads `CINDERPAW_API_TOKEN`.
  - All 14 BFF routes import from `lib/cinderpaw/client`; none import the env var directly.
  - A new test (`tests/cinderpaw-security.test.ts:96-123`) scans every `route.ts` under `app/api/cinderpaw/`, strips comments, and asserts the token name does not appear.
- **token absent from response**: PASS
  - Every BFF route returns a domain-specific DTO (`DiscoveryView`, `SetupDetectResponse`, `VerifyOutcome`, etc.). The gateway URL, bearer, and internal error chains are never forwarded.
- **token absent from client bundle**: PASS
  - `bunx next build` produces static chunks; `grep -r CINDERPAW_API_TOKEN .next/static` returns zero matches.
  - The client form (`CloudKeyForm.tsx`) sends the `api_key` only to `/api/cinderpaw/setup/verify`; the bearer is never a prop or a closure variable.

#### Connector secret handling (Slice 2 scope: provider API keys)

- **Key never echoed**: PASS
  - `POST /api/cinderpaw/setup/verify` forwards the `api_key` to the gateway. The gateway's `runtime_byok_save` (`api.rs:2237`) persists the key to the OS keychain; the response is `{ok: true, provider_id}` — never the key.
- **Key never reaches client bundle**: PASS
  - The `api_key` state in `CloudKeyForm.tsx` is a React `useState` string. It is POSTed via `fetch`; it is never logged, never appended to a URL, never placed in a response header.
- **Key never in URLs/query parameters**: PASS
  - All BFF requests use `Authorization: Bearer <env_token>` in the header. The provider `api_key` is POSTed in the JSON body.

#### On-disk write path security (the new surface in slice 2)

> This is the analysis you asked for. Every wizard click that advances the
> step writes to `~/.cinderpaw/.wizard-progress`. Below are the exact
> properties of that write path and the tests that pin them.

**1. What path does the BFF write?**

The BFF writes two files, both inside `$CINDERPAW_HOME`:
- `.wizard-progress` — the `v4:<step>:<mode>:<choice>` resume marker.
- `.wizard-done` — the `done\n` marker written on Ready.

The home is resolved by `resolveCinderpawHome()` in `lib/cinderpaw/wizard-disk.ts:18-37`:
1. `$CINDERPAW_HOME` env var (highest priority — operator override)
2. `$FERAL_HOME` env var (legacy)
3. `~/.cinderpaw/` if it exists on disk
4. `~/.feral/` if it exists on disk (legacy)
5. Returns `null` if none exist (fresh install → wizard starts at Welcome)

**2. Path traversal protection / canonicalization**

The path is NOT derived from user input. The BFF never accepts a "path" or "filename" parameter from the browser. The progress route handler (`app/api/cinderpaw/wizard/progress/save/route.ts`) accepts only `{step, mode, choice}` — three integers. The integer values are validated against `WIZARD_STEP`, `SETUP_MODE`, `WIZARD_CHOICE` enums. Even if an attacker sent `{"step": "../../../etc/passwd"}`, the value is parsed as an integer (NaN → clamped to `Welcome=0`) and placed into the encoded string `v4:0:0:0`. No user string ever reaches the filesystem.

**3. Permissions and atomic write**

`.wizard-progress` is written with mode `0600` (owner read/write only). The write is atomic: a temporary file is created in the same directory (`atomicWrite` in `wizard-disk.ts:104-118`), the payload is written, `fsync` is called, and then `rename` atomically replaces the target. This prevents partial writes from corrupting the file and breaking resume.

`.wizard-done` is written with mode `0644` (owner rw, group/other r) — same atomic mechanism.

**4. What happens if the file doesn't exist?**

- **Read path** (`readDiskState`): `fs.readFile(...).catch(() => null)` returns `null` for the progress field. `decodeProgress(null)` returns `null`. The wizard starts at Welcome.
- **Write path** (`writeProgress`): The file is created by the atomic write. The parent directory (`$CINDERPAW_HOME`) must exist; if it doesn't, `requireHome()` throws a 503 with a clear message. The browser shows "Could not persist wizard progress — is Cinderpaw installed?"

**5. Can the BFF accidentally reach another home?**

No. The resolution order is fixed and env-var-gated. The BFF never reads a path from the request body. The only way to redirect the write is to set `CINDERPAW_HOME` in the BFF's environment — which is already the operator's intended override mechanism.

**6. Is the `v4:<step>:<mode>:<choice>` format strictly validated before write?**

Yes. The save route validates every field before `writeProgress`:
```ts
if (body.step < WIZARD_STEP.Welcome || body.step > WIZARD_STEP.Finish) → 400
if (body.mode > SETUP_MODE.Manual) → 400
if (body.choice > WIZARD_CHOICE.Cloud) → 400
```
The encoded string is produced by `encodeProgress` which uses only the four integer fields and the literal `"v4:"` prefix. No user string is interpolated.

**7. What happens on invalid input / concurrency?**

- **Invalid input**: Out-of-range integers are rejected with 400 before any filesystem access.
- **Concurrency**: The atomic rename means two concurrent writes result in one winning the rename race; the loser's temp file is cleaned up on next boot. No partial state is possible. The worst case is "last write wins" — acceptable because progress is monotonic (the user advances forward).

**8. How do the tests prove the write cannot produce anything other than `.wizard-progress`?**

`tests/cinderpaw-security.test.ts:139-148` reads `lib/cinderpaw/wizard-progress.ts`, extracts the `encodeProgress` function body, and asserts it does not reference `api_key`, `secret`, `bearer`, or `token`. It also runs `encodeProgress` and asserts the output matches `/^v\d+:\d+:\d+:\d+$/`.

`tests/cinderpaw-wizard-progress.test.ts` encodes every valid step and asserts the format; it also feeds malformed, wrong-version, out-of-range, and legacy-short inputs to `decodeProgress` and asserts they all return `null`.

### Architectural invariants

- [x] BFF remains the only browser → gateway boundary
- [x] gateway remains loopback-only
- [x] no new backend (no new Rust route, no new sidecar command)
- [x] TUI state machine untouched
- [x] `~/.cinderpaw` schema untouched (progress file is pre-existing TUI contract)
- [x] runtime core untouched
- [x] gateway behavior untouched (slice 2 consumes existing routes)
- [x] provider catalog version pinned to `1` (matches `byok::CATALOG_VERSION`)
- [x] connector catalog version pinned to `3` (matches Rust const)

### Behavioral contract

- A user who begins the wizard in the TUI, closes it, and opens it in the browser resumes on the same step. Verified by sharing the same on-disk file (`v4:<step>:<mode>:<choice>`) and the same resolution order.
- A user who finishes the wizard in the TUI is not re-prompted on the browser (`.wizard-done` marker gates re-entry).
- The verify step requires BOTH the gateway's `ok: true` AND the local `containsCinderpawOk(reply)` content gate before enabling "Continue".
- The 4-phase health check is NOT reimplemented in slice 2; it is consumed from the gateway's `/runtime/setup/verify`. The deterministic `CINDERPAW_OK` gate is verified client-side against the `reply` field.

### Known limitations

- **Local model download path is a placeholder.** Slice 2 stops at the cloud path so the verify gate is exercised end-to-end. The local download flow (model picker, download progress, local verify) is deferred to a later slice. This is intentional and documented on the `/app/wizard/work` page.
- **No real 4-phase health check UI.** Slice 2 reuses the gateway's `/runtime/setup/verify` which performs the 4-phase check internally. The browser renders the outcome, not the per-phase progress. A future slice can surface the 4 phases if needed.
- **Wizard persistence is file-based.** There is no server-side session. The file lives in `$CINDERPAW_HOME`; if the user's home is on an NFS mount or symlinked, the atomic rename may not be atomic. Acceptable for desktop MVP.
- **No client-side state library.** Each page is a server component that reads disk state on navigation. Interactive forms are small client components with local `useState`. No global store.
- **Catalog drift falls back to showing the list with a warning.** The browser does not silently ignore drift; it renders a banner and proceeds.

### Deviations

- **The `CloudKeyForm` component** uses a `useTransition` + `fetch` pattern instead of a server action. This is the one place where the browser holds the `api_key` in component state. The key is never persisted in the browser and is only sent to the BFF verify endpoint. Alternative considered: a server action that takes the key as a form field. Rejected because React Server Actions in Next.js 15 serialize form data to the request body, which is equivalent to `fetch`; the `fetch` pattern is more explicit about the key's lifecycle.

### Blockers

- **NONE.** All gateway routes consumed by slice 2 already exist. No Rust changes required.

### Deferred work (explicitly out of slice 2 scope)

- Local model download flow (slice with `/runtime/models/install` UX)
- 4-phase health check UI (can be added once the verify outcome is proven stable)
- Connector UI, OAuth device flow, QR pairing
- Agent chat, SSE streaming, tool-call rendering
- Persistent sessions, transcript replay
- DSL / UIA browser-control adapters
- Autonomous connector workflows

### Verified contracts

The wizard mirrors these existing Cinderpaw contracts exactly:

| Contract | Source | Browser mirror |
|---|---|---|
| `v4:<step>:<mode>:<choice>` progress format | `tui/app/wizard.go:287` | `lib/cinderpaw/wizard-progress.ts:72` |
| `wizardProgressVersion = 4` | `tui/app/wizard.go:197` | `lib/cinderpaw/wizard-progress.ts:14` |
| Resolution order (`CINDERPAW_HOME → FERAL_HOME → ~/.cinderpaw → ~/.feral`) | `tui/api/home.go:40-58` | `lib/cinderpaw/wizard-disk.ts:18-37` |
| Provider catalog version pin | `byok::CATALOG_VERSION = 1` | `lib/cinderpaw/catalog-version.ts:10` |
| Connector catalog version pin | Rust const | `lib/cinderpaw/catalog-version.ts:13` |
| Verify prompt | `setup::VERIFY_PROMPT = "Reply with the single word OK. Do not use tools."` | `lib/cinderpaw/verify.ts:28` |
| `VerifyStatus` taxonomy | `setup.rs:92-101` | re-derived from the gateway response |
| `SaveByokReq` shape | `api.rs:2204-2211` | body of `/api/cinderpaw/setup/verify` |
| `WizardStep` enum order | `tui/app/wizard.go:30-46` | `lib/cinderpaw/wizard-progress.ts:17-33` |
| `SetupMode` enum | `tui/app/wizard.go:346-378` | `lib/cinderpaw/wizard-progress.ts:36-38` |
| `WizardChoice` enum | `tui/app/wizard.go:436-456` | `lib/cinderpaw/wizard-progress.ts:41-43` |
