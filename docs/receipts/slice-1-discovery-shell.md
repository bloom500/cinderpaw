# Slice 1 — Discovery + App Shell

> Receipt for the first Cinderpaw Web slice. Reviewed against the
> boundary doc (`docs/browser-app-mvp-boundary.md`) and the master brief.

## Implementation Receipt

### Scope
- [x] `app/app/layout.tsx` — `/app` shell, no marketing chrome, ErrorBoundary wrapped
- [x] `app/app/page.tsx` — entry: "Find or create your Cinderpaw" + single CTA
- [x] `app/app/discover/page.tsx` — server-rendered discovery result with the four runtime-truthful states
- [x] `app/api/cinderpaw/health/route.ts` — BFF route that probes the gateway server-side
- [x] `lib/cinderpaw/client.ts` — server-side gateway client (token read, fetch, classify transport errors)
- [x] `lib/cinderpaw/types.ts` — narrow runtime status / manifest types
- [x] `lib/cinderpaw/discovery.ts` — pure classifier with `versionAtLeast` + `classify`
- [x] `components/ui/Button.tsx` — primary + ghost variants
- [x] `components/ui/Card.tsx` — flat surface with optional eyebrow + title
- [x] `components/ui/Spinner.tsx` — CSS-only, reduced-motion safe
- [x] `components/ui/Callout.tsx` — info / warn / error tones
- [x] `components/ui/ErrorBoundary.tsx` — React-side complement to the gateway's typed envelope
- [x] `tests/cinderpaw-discovery.test.ts` — pure-function tests for the classifier
- [x] `tests/cinderpaw-security.test.ts` — bearer-token isolation regression tests

### Files changed

| File | Stat | Notes |
|---|---|---|
| `app/app/layout.tsx` | +18 | New |
| `app/app/page.tsx` | +35 | New |
| `app/app/discover/page.tsx` | +147 | New |
| `app/api/cinderpaw/health/route.ts` | +28 | New |
| `lib/cinderpaw/client.ts` | +93 | New |
| `lib/cinderpaw/types.ts` | +54 | New |
| `lib/cinderpaw/discovery.ts` | +112 | New |
| `components/ui/Button.tsx` | +28 | New |
| `components/ui/Card.tsx` | +34 | New |
| `components/ui/Spinner.tsx` | +13 | New |
| `components/ui/Callout.tsx` | +44 | New |
| `components/ui/ErrorBoundary.tsx` | +38 | New |
| `tests/cinderpaw-discovery.test.ts` | +123 | New |
| `tests/cinderpaw-security.test.ts` | +67 | New |
| `lib/cinderpaw/.gitkeep` (if needed) | +0 | Not created (real files only) |

### Files explicitly NOT changed

Per the master brief's hard boundaries:

- `frontend-react/src/hooks/useCallSession.ts` — not touched
- `frontend-react/src/voice/vad.ts` — not touched
- `src-tauri/src/audio/*` (Rust audio pipeline) — not touched
- `mcp.json` — does not exist in this repo per A1 audit
- `tui/` (Go TUI state machine) — not touched
- `CinderpawAgent/src/rsi/`, `brain/`, `memory/`, `cowork/` — not touched
- `~/.cinderpaw/` schema / migrations — not touched

Also not touched:

- `crates/cinderpaw-core/src/api.rs` (A1 envelope is the contract; slice 1 only consumes existing routes)
- `crates/cinderpaw-cli/`, `src-tauri/`, `CinderpawAgent/src/transports/tauri.ts` — zero changes
- `app/api/subscribe/`, `app/api/on-release/`, `app/api/download/`, `app/api/public-journal/` — existing routes unchanged
- `components/SiteHeader.tsx`, `components/SiteFooter.tsx` — the marketing chrome is not reused inside `/app` (intentional: the app is a tool, not a website)
- `frontend-react/MessageList.tsx` — a pre-existing working-tree change on `main` is not in this slice
- `components/Reveal.tsx`, `components/CopyCommand.tsx`, `components/logos.tsx` — not used in slice 1 (no copy-paste or model picker)

### Tests

- `bun test` (landing page): **84 pass / 0 fail** (15 new tests in this slice: 10 classification + 5 security)
- `bunx tsc --noEmit` (landing page): **PASS** (zero output)
- `bunx next build` (landing page): **PASS** — `/app` and `/app/discover` listed in the route table at 473 B each
- Cinderpaw Rust tests: not re-run for this slice (zero changes in the Cinderpaw repo)
- TUI tests: not re-run for this slice (zero changes in `tui/`)
- Sidecar tests: not re-run for this slice (zero changes in `CinderpawAgent/`)
- `verify.sh`: not run end-to-end because the Cinderpaw repo was not modified. The equivalent guards for this slice are `bun test` + `tsc` + `next build`, all green.

### Security

- **bearer token server-side only**: PASS
  - `lib/cinderpaw/client.ts:34` is the only function that reads `process.env.CINDERPAW_API_TOKEN`.
  - The `app/api/cinderpaw/health/route.ts` route imports `probe` from `lib/cinderpaw/client`; the browser never imports `client.ts`.
  - `tests/cinderpaw-security.test.ts:55` asserts `client.ts` does not export a function that takes a bearer argument.
  - `tests/cinderpaw-security.test.ts:62` asserts the token name is only mentioned in `process.env.CINDERPAW_API_TOKEN` reads, not in any request header / body / query parsing.
- **token absent from response**: PASS
  - `app/api/cinderpaw/health/route.ts:18` returns `DiscoveryView` only. The view never includes the gateway URL, bearer, or any internal config.
  - `tests/cinderpaw-security.test.ts:75` asserts the token is only used in the `Authorization: Bearer ...` header sent to the gateway, never in a `throw`, `console.*`, or response body.
- **token absent from client bundle**: PASS
  - `bunx next build` produces `.next/static/**/*.js`; `grep -r CINDERPAW_API_TOKEN .next/static` returns zero matches.
  - The client-side `/app` and `/app/discover` routes do not import `lib/cinderpaw/client.ts`; they call the BFF route via `fetch("/api/cinderpaw/health")` and render the returned `DiscoveryView`.
- **gateway remains loopback-only**: PASS (the BFF defaults to `127.0.0.1:11435`; `CINDERPAW_GATEWAY_URL` is honoured but documented as a test-only override).
- **rate limit / abuse**: N/A for slice 1 (a single probe per navigation; the page is `dynamic = "force-dynamic"` and `Cache-Control: no-store`).

### Architectural invariants

- [x] BFF remains the only browser → gateway boundary
- [x] gateway remains loopback-only (default `127.0.0.1:11435`, overridable for tests)
- [x] no new backend (no new Rust route, no new sidecar command, no new endpoint)
- [x] TUI state machine untouched (zero changes in `tui/`)
- [x] `~/.cinderpaw` schema untouched (no reads, no writes from the new code)
- [x] runtime core untouched (`rsi/`, `brain/`, `memory/`, `cowork/` — zero changes in `CinderpawAgent/`)
- [x] wizard is not implemented in this slice (the discover page is honest about that)
- [x] agent chat is not implemented in this slice
- [x] connector UI is not implemented in this slice
- [x] DSL/UIA integration is not implemented in this slice (per Slice 4)
- [x] autonomous connector workflows are not implemented in this slice (per Slice 7)
- [x] persistent sessions / transcript replay are not implemented in this slice (per Slice 8)

### Behavioral contract

- The discover page reports one of four runtime-truthful states: `found`, `not_running`, `outdated`, `unhealthy`.
- "found" requires: 2xx on `/runtime/status` AND `/runtime/manifest`, `online === true`, `sidecar_alive === true`, and `manifest.version >= 2026.8.0`.
- "not_running" is the **expected** outcome on a fresh install; the page never treats it as an error.
- The page never renders success without runtime data; there is no optimistic state.

### Known limitations

- The discover page is server-rendered. A page reload triggers a fresh probe; there is no client-side polling yet. A future slice can add a 5s poll (mirroring the TUI's `statusPollTick`) without changing the contract.
- The `MIN_GATEWAY_VERSION` constant (`2026.8.0`) is hard-coded; it will need to advance when the gateway ships a new major. A future slice can read it from a manifest endpoint.
- The classifier does not partial-classify. A successful `manifest` with a failed `status` (or vice versa) becomes "not_running" rather than "found with caveats". Slice 1 keeps the semantics simple; a future slice can split the two endpoints if needed.
- The discover page does not yet surface `/runtime/resume` (the "welcome back" last-task row). That belongs to a later slice.
- No client-side state library was introduced. Discover is a single `fetch` on a server component; if a slice adds interactive UI (e.g. polling, live updates), a small `useState` per page is enough — no global store.
- The BFF does not cache. Every navigation triggers a fresh probe. Acceptable for MVP; can add a 1s in-memory cache later if it shows up in profiling.

### Deviations

NONE.

### Out of MVP scope (explicitly deferred, not in this slice)

These are listed so the reviewer can confirm the slice did not over-reach:

- Wizard pages, model picker, real verification (`/app/app/wizard/*`)
- Agent chat, SSE streaming, tool calls, ask-user forms
- Connector UI, OAuth device flow, QR pairing
- DSL / UIA browser-control adapters
- Persistent chat sessions / transcript replay
- Session list, last-event tracking
- "Welcome back" last-task row
- Reduced-motion polish, a11y deep-pass, responsive design deep-pass
- Production browser-hosted architecture, paired devices, cloud workers
