# Slice 4 — Session Picker + Transcript Replay

> Implementation receipt for the fourth Cinderpaw Web slice. Covers
> the gateway A3 endpoint (the missing piece needed to backfill a
> conversation), the browser session sidebar, transcript loading,
> and the first-load backfill that makes "tab refresh = resume, not
> blank chat" real.

## Implementation Receipt

### Scope
- [x] `crates/cinderpaw-core/src/api.rs` — `runtime_session_transcript` handler + route `/runtime/sessions/:id/transcript`
- [x] `crates/cinderpaw-core/tests/session_transcript_endpoint.rs` — 5 integration tests (happy path, path-traversal, 404, 502, 401)
- [x] `lib/cinderpaw/client.ts` — `fetchSessionTranscript`, `SessionTranscript`, `TranscriptMessage` types
- [x] `lib/cinderpaw/chat.ts` — `transcriptToMessages(items, now)` normaliser + 4 new tests
- [x] `app/api/cinderpaw/sessions/[id]/transcript/route.ts` — BFF proxy with id re-validation
- [x] `app/app/chat/page.tsx` — pre-loads sessions + most-recent transcript on first render
- [x] `app/app/chat/ChatClient.tsx` — SessionSidebar + switchToSession + refreshSessions
- [x] `tests/cinderpaw-security.test.ts` — 3 new tests for slice 4 (BFF isolation, id pre-flight, no bearer in transcript route)

### Files changed

| File | Stat | Notes |
|---|---|---|
| `crates/cinderpaw-core/src/api.rs` | +90 | New handler + route registration |
| `crates/cinderpaw-core/tests/session_transcript_endpoint.rs` | +233 | New, 5 tests |
| `lib/cinderpaw/client.ts` | +44 | `fetchSessionTranscript` + types |
| `lib/cinderpaw/chat.ts` | +28 | `transcriptToMessages` |
| `app/api/cinderpaw/sessions/[id]/transcript/route.ts` | +52 | New BFF route |
| `app/app/chat/page.tsx` | +60 | Server pre-load |
| `app/app/chat/ChatClient.tsx` | +215 | Sidebar + switch + refresh |
| `tests/cinderpaw-chat-sse.test.ts` | +80 | 4 new transcriptToMessages tests |
| `tests/cinderpaw-security.test.ts` | +55 | 3 new security tests |
| **Total** | **+857, -104** | Rust: 1 commit `6f249fa`. Browser: 1 commit `2359c7e4`. |

### Files explicitly NOT changed

Per the master brief's hard boundaries and AGENTS.md pin:

- `frontend-react/src/hooks/useCallSession.ts` — not touched
- `frontend-react/src/voice/vad.ts` — not touched
- `src-tauri/src/audio/*` (Rust audio pipeline) — not touched
- `mcp.json` — does not exist in this repo
- `tui/` (Go TUI) — not touched; slice 4 mirrors the existing `runtime_sessions` route the TUI already calls
- `CinderpawAgent/src/rsi/`, `brain/`, `memory/`, `cowork/` — not touched
- `~/.cinderpaw/` schema — not touched; the transcript file format is the existing on-disk `conversations/{id}.json` shape
- `crates/cinderpaw-cli/`, `src-tauri/`, `CinderpawAgent/src/transports/tauri.ts` — not touched
- `crates/cinderpaw-core/src/api_error.rs` — not touched; slice 4 consumes the existing `ApiError::bad().into_response_with()` contract
- `app/api/subscribe/`, `app/api/on-release/`, `app/api/download/`, `app/api/public-journal/` — existing routes unchanged
- `components/SiteHeader.tsx`, `components/SiteFooter.tsx` — marketing chrome not reused inside `/app`
- `app/app/page.tsx`, `app/app/layout.tsx`, `app/app/discover/` — slice 1 code unchanged
- `app/app/wizard/*` — slice 2 code unchanged
- `lib/cinderpaw/{discovery,types,verify,wizard-disk,wizard-progress,catalog-version}.ts` — unchanged

### Tests

- `bun test` (landing page): **145 pass / 0 fail** (7 new in this slice: 4 transcriptToMessages + 3 security)
- `bunx tsc --noEmit` (landing page): **PASS**
- `bunx next build` (landing page): **PASS** — `/app/chat` 4.95 kB (+0.93 kB vs slice 3 for sidebar); `/api/cinderpaw/sessions/[id]/transcript` registered
- `cargo test -p cinderpaw-core --test session_transcript_endpoint`: **5 pass / 0 fail**
- `cargo check -p cinderpaw-core`: **PASS**
- TUI tests: not re-run (zero changes in `tui/`)
- Sidecar tests: not re-run (zero changes in `CinderpawAgent/`)
- `verify.sh`: the slice's Rust changes were verified by `cargo check` + the targeted `cargo test --test session_transcript_endpoint`. The wider Rust workspace was not re-checked end-to-end because the slice's Rust surface is the single new handler + route.

### Security

#### Bearer token isolation (carried from slices 1 + 2 + 3)

- **bearer token server-side only**: PASS
  - `lib/cinderpaw/client.ts` remains the ONLY place that reads `CINDERPAW_API_TOKEN`.
  - The new `fetchSessionTranscript` calls `gatewayGet` internally; the id parameter is a session id, not a bearer.
  - `tests/cinderpaw-security.test.ts` scans `client.ts` for any exported function whose first parameter is a bearer / token / api_key / secret / authorization string — none found.
- **token absent from response**: PASS
  - `app/api/cinderpaw/sessions/[id]/transcript/route.ts` returns the gateway's `{id, title, ..., messages: [...]}` payload unchanged. No bearer, no gateway URL, no internal error.
  - `tests/cinderpaw-security.test.ts` strips comments and scans the new route for the strings `Bearer`, `CINDERPAW_API_TOKEN`, `CINDERPAW_GATEWAY_URL` — none found.
- **token absent from client bundle**: PASS
  - `bunx next build` produces static chunks; the `chat` client bundle is 4.95 kB and imports only `lib/cinderpaw/{chat,client}.ts` (pure), `components/ui/{Button,Spinner}.tsx` (presentational), and React. It never embeds the token.
- **runtime unavailable does not bypass token checks**: PASS
  - When the gateway rejects, the BFF route returns 404 (missing session) or 503 (transient). The client UI drops into `runtime_unavailable` and starts a 5s re-probe via `/api/cinderpaw/health`.

#### Path-traversal defence (new in slice 4)

The transcript route reads from `~/.cinderpaw/conversations/{id}.json` where `{id}` is a URL path parameter. A naive handler would happily serve `../../etc/passwd` if a malicious caller (or a curious user with DevTools) crafts a request. The defence is layered:

1. **Client pre-flight.** `fetchSessionTranscript` rejects any id that does not match `/^[A-Za-z0-9-]{1,64}$/` BEFORE the request leaves the browser. A regression test in `tests/cinderpaw-security.test.ts` asserts this regex is present in `client.ts`.
2. **BFF re-validation.** `app/api/cinderpaw/sessions/[id]/transcript/route.ts` re-applies the same regex. A malformed id never reaches the gateway. A regression test asserts the regex is present in the route file.
3. **Gateway alnum guard.** `runtime_session_transcript` validates the id with the same regex before any disk access. A 5th integration test (`get_session_transcript_rejects_path_traversal`) exercises the rejection.
4. **No new keychain / secrets surface.** The transcript file format is read-only here; the gateway's existing `runtime_sessions` (read-only list) and the per-session file itself are the same files the TUI / desktop / connectors use. No new write paths.

#### BFF error mapping (new in slice 4)

| Gateway response | BFF response | Browser behaviour |
|---|---|---|
| 200 OK with messages | 200 OK, forward unchanged | Replace message list with `transcriptToMessages(...)`. |
| 404 + `session_not_found` | 404 (mapped from `GatewayError.reason === "rejected"`) | Render empty chat (the user can still start typing; the session is no longer in the sidebar). |
| 502 + `transcript_corrupt` | 404 (same mapping — gateway surfaces as `rejected`) | Render empty chat. The corrupt file is logged; the user is not blocked. |
| 503 (sidecar down) | 503 + `transcript_unavailable` | `runtime_unavailable` surface + 5s re-probe. |
| 400 (id rejected client-side) | 400 (BFF re-validates) | Empty chat; the picker won't show a corrupt id because the sidebar is loaded from `/runtime/sessions` which the gateway also validates. |

### Architectural invariants

- [x] BFF remains the only browser → gateway boundary
- [x] gateway remains loopback-only (default `127.0.0.1:11435`)
- [x] no new sidecar protocol (the new gateway endpoint is a pure read of an existing on-disk file)
- [x] TUI state machine untouched
- [x] `~/.cinderpaw` schema untouched (the transcript file format is the existing on-disk `conversations/{id}.json` shape; the gateway normalises legacy `timestamp` field to `created_at` for the wire)
- [x] runtime core untouched
- [x] parser is single-sourced (`lib/cinderpaw/chat.ts`)
- [x] path-traversal is defended at three layers: client, BFF, gateway
- [x] no UIA / DSL / connectors / voice / multiplayer / auth-architecture changes
- [x] no new dependency added to either repo

### Behavioral contract

- On first render of `/app/chat`, the server pre-loads the most-recent 20 sessions and the transcript of the most-recent one (capped at 500 messages). The user lands on a backfilled conversation, not a blank chat.
- The sidebar lists the 20 most-recent sessions with relative timestamps ("just now", "5m", "2h", "3d", or a date for older).
- Clicking a sidebar entry: aborts any in-flight turn, replaces the message list with the new session's transcript, sets the active session id so the next send lands in that conversation.
- Clicking "New": aborts any in-flight turn, clears the message list, sets the active id back to the `browser` sentinel. The next send creates a fresh session.
- After a successful send, the sidebar refreshes in the background so the new (or moved) conversation appears without a manual reload.
- A session whose file is missing (the index still lists it but the file was deleted) renders as an empty chat. The user can start typing; the new turn creates a fresh `messages` array under the same id.
- A session whose file is corrupt renders the same way: empty chat, no error banner. The error is logged server-side; the user is not blocked.

### Known limitations

- **No URL state for the active session.** Reloading the tab always lands on the most-recent session. A future slice can add `?session=<id>` (or hash-based routing) so deep links work.
- **No infinite scroll on the sidebar.** The list is hard-capped at 20. A future slice can add a "load more" affordance that re-calls `/runtime/sessions?limit=50`.
- **No `runtime/sessions` polling.** The sidebar refreshes only after the user sends a message. A future slice can add a 30s poll so the sidebar reflects the agent's work in another window without the user having to type.
- **No session rename or delete.** The gateway already has the data; the slice intentionally adds only the read path. Rename and delete are deferred — they are write operations that need a UI affordance and a confirmation flow.
- **No optimistic UI on session switch.** The user sees a "Loading conversation…" spinner for as long as the fetch takes. A future slice can keep the previous messages visible while the new transcript loads, with a small "switching" indicator.
- **Transcript is loaded whole (capped at 500 messages).** A future slice can paginate by passing `?before=<message_id>` to the gateway (not added in slice 4; would need a gateway change).
- **Hard-coded 5s re-probe.** Same as slice 3.

### Deviations

- **The slice's "Welcome back last-task row" feature is folded into the sidebar.** The TUI F4 / Sprint 3 welcomes-back row was a single prominent entry; the browser surface already had a "New conversation" button in the sidebar, so the welcome-back concept is the entire sidebar rather than a separate row. The behaviour is the same (most-recent session on first load) but the chrome is different. Documented in the sidebar's `Conversations` eyebrow label.
- **`transcriptToMessages` is exposed from `lib/cinderpaw/chat.ts`, not a new module.** A future slice can move it; for slice 4 the parser + normaliser belong in the same file because the message model is the parser's output type.
- **`initialSessionId` is the most-recent session, not a URL-pinned one.** The slice does not add `?session=<id>` to the URL because (a) Next.js server components cannot read the URL in this layout without making the page client-side, and (b) the sidebar already lists the most-recent conversation at the top, so the user can switch with one click. URL state is a separate, additive change.
- **The slice's "recovery auto-retry on backend disconnect" is the existing slice-3 5s re-probe.** No new machinery needed — the chat already handles `runtime_unavailable`. The boundary doc's "Recovery auto-retry on backend disconnect (mirror of TUI `StateRecovery`)" is satisfied by the slice-3 surface.

### Blockers

- **NONE.** The slice's Rust change (A3) was the only piece the gateway was missing, and it landed in commit `6f249fa` before the browser work started.

### Deferred work (explicitly out of slice 4 scope)

- URL state (`?session=<id>`) and deep links
- Infinite scroll on the sidebar
- Session rename / delete (write paths)
- Optimistic UI on session switch
- Transcript pagination
- Sidebar polling for other-window activity
- Markdown rendering on completed turns (carried from slice 3)
- `ask_user` answer form (carried from slice 3)
- Mid-stream reconnection with `last_event_id` (carried from slice 3)

### Verified contracts

The session picker + transcript replay mirror these existing Cinderpaw contracts:

| Contract | Source | Browser mirror |
|---|---|---|
| Saved-conversation index | `conversations/index.json` (read by `runtime_sessions`) | `lib/cinderpaw/client.ts::fetchSessions` |
| Per-conversation file shape | `conversations/{id}.json` (read by `commands.conversations.load` on desktop) | `crates/cinderpaw-core/src/api.rs::runtime_session_transcript` |
| `X-Cinderpaw-Api-Stability: unstable` header on `/runtime/*` | `api_stability_header` middleware | unchanged (browser receives it) |
| A1 typed error envelope `{code, retryable, retryAfterMs?}` | `crates/cinderpaw-core/src/api_error.rs` | `app/api/cinderpaw/sessions/[id]/transcript/route.ts` error mapping |
| Bearer-in-Authorization-only invariant | `api.rs::require_token` | `lib/cinderpaw/client.ts::gatewayGet` (unchanged) |
| Idempotency on side-effecting messages (slice 3 carried) | B1 in boundary doc | unchanged (transcript is read-only) |
| Esc-during-streaming aborts but keeps the turn | `tui/app/update.go:184` | `app/app/chat/ChatClient.tsx::cancel` (now also fires on session switch) |
| 5s runtime re-probe on disconnect | TUI `statusPollTick` | `app/app/chat/ChatClient.tsx:probeRuntime` |

### Manual verification

Dev server: `bun run dev` (Next.js 15.5.23) — started, `GET /app/chat` returned 200, response was 26.5 kB of HTML (the gateway is not running on this dev box, so the runtime-down branch fires, exactly as the spec requires; the sidebar therefore does not render, only the `NotReady` callout). `GET /api/cinderpaw/sessions/abc.def/transcript` returned 400 (BFF id guard fired before the gateway was contacted).

The happy path (transcript backfill on first load, sidebar populated with the 20 most-recent sessions, click-to-switch with a fresh fetch, post-send sidebar refresh) requires a live gateway with a populated `conversations/` dir. The Rust side is exercised by the 5 integration tests, which use the real `runtime_session_transcript` handler against a hermetic `CINDERPAW_HOME` tempdir. The browser side is exercised by `transcriptToMessages` tests and the security regression tests. A fake-gateway harness is a separate piece of work; it would close the last gap (full end-to-end on this dev box) but is out of scope for slice 4.
