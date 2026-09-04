# Slice 3 — Chat UI + Streaming

> Implementation receipt for the third Cinderpaw Web slice. Covers
> the chat surface, the SSE streaming path, runtime availability
> handling, and the wizard → chat handoff.

## Implementation Receipt

### Scope
- [x] `lib/cinderpaw/chat.ts` — wire types, SSE frame parser, message reducer, Message model
- [x] `lib/cinderpaw/client.ts` — extended with `fetchSessions` + `postChatStream` (returns raw Response)
- [x] `app/api/cinderpaw/chat/send/route.ts` — POST proxy that forwards SSE bytes
- [x] `app/api/cinderpaw/sessions/route.ts` — GET proxy for the saved-sessions list
- [x] `app/app/chat/page.tsx` — server-rendered shell with runtime probe
- [x] `app/app/chat/ChatClient.tsx` — client island: state machine + composer + message list
- [x] `app/app/wizard/actions.ts` — `finishWizardAction` now hands the user over to `/app/chat`
- [x] `app/app/wizard/ready/page.tsx` — copy updated to match the new flow
- [x] `tests/cinderpaw-chat-sse.test.ts` — 33 pure-function tests for the parser, reducer, and Message model
- [x] `tests/cinderpaw-security.test.ts` — 3 new tests for slice 3 (chat/send, sessions, postChatStream isolation)

### Files changed

| File | Stat | Notes |
|---|---|---|
| `lib/cinderpaw/chat.ts` | +353 | New. Pure module, no fetch, no React. |
| `lib/cinderpaw/client.ts` | +60 | Added `fetchSessions` + `postChatStream`. |
| `app/api/cinderpaw/chat/send/route.ts` | +71 | New. |
| `app/api/cinderpaw/sessions/route.ts` | +34 | New. |
| `app/app/chat/page.tsx` | +62 | New. |
| `app/app/chat/ChatClient.tsx` | +355 | New. |
| `app/app/wizard/actions.ts` | ~2 lines | `finishWizardAction` redirects to `/app/chat`. |
| `app/app/wizard/ready/page.tsx` | ~1 line | Copy updated. |
| `tests/cinderpaw-chat-sse.test.ts` | +230 | New. |
| `tests/cinderpaw-security.test.ts` | +50 | Three new tests. |
| **Total** | **+1218, -4** | 10 files in commit `9acf31c0`. |

### Files explicitly NOT changed

Per the master brief's hard boundaries and AGENTS.md pin:

- `frontend-react/src/hooks/useCallSession.ts` — not touched
- `frontend-react/src/voice/vad.ts` — not touched
- `src-tauri/src/audio/*` (Rust audio pipeline) — not touched
- `mcp.json` — does not exist in this repo
- `tui/` (Go TUI) — not touched; slice 3 mirrors its `StreamChat` shape
- `CinderpawAgent/src/rsi/`, `brain/`, `memory/`, `cowork/` — not touched
- `~/.cinderpaw/` schema — not touched (slice 3 doesn't add a file format)
- `crates/cinderpaw-core/src/api.rs` — not touched; the gateway already had `POST /runtime/chat` with SSE
- `crates/cinderpaw-cli/` — not touched
- `app/api/public-journal/`, `lib/journal-store.ts`, `lib/kv.ts`, `package.json`, `package-lock.json` — pre-existing untracked / modified files in the working tree, not part of this slice
- `frontend-react/MessageList.tsx` — pre-existing working-tree change on `main`, not in this slice
- `app/app/page.tsx`, `app/app/layout.tsx`, `app/app/discover/` — slice 1 code unchanged
- `app/app/wizard/*` (except the two lines noted above) — slice 2 code unchanged
- `lib/cinderpaw/{client,discovery,types,verify,wizard-disk,wizard-progress,catalog-version}.ts` — unchanged

### Tests

- `bun test` (landing page): **138 pass / 0 fail** (33 new in this slice: 5 splitSSEChunk + 8 parseOpenAIData + 3 parseToolFrame + 3 parseAskFrame + 2 type guards + 6 reduceFrame + 4 Message model + 3 security)
- `bunx tsc --noEmit` (landing page): **PASS** (zero output)
- `bunx next build` (landing page): **PASS** — `/app/chat` listed at 4.02 kB; `/api/cinderpaw/chat/send` and `/api/cinderpaw/sessions` registered as dynamic functions
- Cinderpaw Rust tests: not re-run (zero changes in the Cinderpaw repo)
- TUI tests: not re-run (zero changes in `tui/`)
- Sidecar tests: not re-run (zero changes in `CinderpawAgent/`)
- `verify.sh`: not run end-to-end because the Cinderpaw repo was not modified

### Security

#### Bearer token isolation (carried from slices 1 + 2)

- **bearer token server-side only**: PASS
  - `lib/cinderpaw/client.ts` remains the ONLY place that reads `CINDERPAW_API_TOKEN`.
  - The new `postChatStream` and `fetchSessions` both call `bearerToken()` internally; neither takes a bearer parameter.
  - `tests/cinderpaw-security.test.ts` extended with a regression test that scans `client.ts` for any exported function whose first parameter is a bearer / token / api_key / secret / authorization string — none found.
- **token absent from response**: PASS
  - `app/api/cinderpaw/chat/send/route.ts` returns the gateway's SSE stream with only `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Accel-Buffering: no`. No bearer, no gateway URL, no internal error.
  - `app/api/cinderpaw/sessions/route.ts` returns `{sessions: [...]}` or `{error, message}` only. No bearer.
  - `tests/cinderpaw-security.test.ts` scans both new routes for the string `Bearer` and `CINDERPAW_API_TOKEN` (after stripping comments) — both scans pass.
- **token absent from client bundle**: PASS
  - `bunx next build` produces static chunks; the `chat` client bundle is 4.02 kB and imports only `lib/cinderpaw/chat.ts` (pure parser), `components/ui/{Button,Spinner}.tsx` (presentational), and React. It never imports `lib/cinderpaw/client.ts`.
- **runtime unavailable does not bypass token checks**: PASS
  - When the gateway rejects, the BFF route returns 502; the client UI flips into `runtime_unavailable` and starts a 5s re-probe via `/api/cinderpaw/health`. The health probe goes through the same BFF and reads the same env var.

#### Streaming path

- **SSE stream is forwarded verbatim**: The BFF does not parse the gateway's SSE — it pipes `upstream.body` straight to the browser response. This keeps the parser single-sourced (`lib/cinderpaw/chat.ts`) and means a future gateway-side change to the OpenAI chunk shape only needs one parser update, not two (BFF + browser).
- **No second auth path**: The BFF injects the bearer once, on the upstream `fetch` call. The browser never sees the bearer; the stream identity is established by the upstream `Authorization` header.
- **AbortController cancellation**: The browser cancels via `AbortController`, which closes the fetch. The BFF does not see the abort and will continue forwarding until the upstream closes; the browser stops reading. This is the same model `cinderpaw chat` uses on the TUI side.

#### Connection lifecycle

- The server-rendered `/app/chat` page probes the gateway once on every navigation. If the probe fails, the page renders a `NotReady` callout and never mounts the client island. This avoids mounting a chat that can't talk to anything.
- When the client island IS mounted and the gateway becomes unreachable mid-stream, the catch arm flips the surface to `runtime_unavailable` and starts a 5s re-probe. The 5s matches the TUI's `statusPollTick`.
- When the gateway is back, the surface returns to `idle` and the user can resend.

### Architectural invariants

- [x] BFF remains the only browser → gateway boundary
- [x] gateway remains loopback-only (default `127.0.0.1:11435`)
- [x] no new backend (no new Rust route, no new sidecar command — the gateway already had `POST /runtime/chat` with SSE since Faza 4.5 Slice 3)
- [x] TUI state machine untouched (slice 3 consumes the same wire shape the TUI consumes; the Go `tui/api/client.go::StreamChat` is the behavioural reference)
- [x] `~/.cinderpaw` schema untouched (no new file format; the chat reuses the gateway's existing session storage at `~/.cinderpaw/conversations/`)
- [x] runtime core untouched
- [x] parser is single-sourced (`lib/cinderpaw/chat.ts`) — BFF does not parse, browser parses
- [x] no UIA / DSL / connectors / voice / multiplayer / auth-architecture changes
- [x] session id is `"browser"` for slice 3 (no session picker yet — a future slice can read it from `/runtime/sessions` and offer a "new conversation" menu)

### Behavioral contract

- A user can complete the wizard and immediately see the chat.
- A user can type a message, press Enter (or click Send), and see the assistant's reply stream in incrementally.
- A user can press Esc (or click Stop) at any time during streaming; the turn is preserved with whatever text accumulated, the surface returns to `idle`, and a new turn can be sent.
- A user who reloads the page mid-stream does not see stale "streaming" state — the server-rendered page re-probes the gateway and re-mounts the client island fresh.
- A user whose gateway is down sees a clear "Runtime unavailable" banner with a 5s auto-retry; the page never leaves them wondering whether Cinderpaw is thinking, disconnected, finished, or broken.
- A user who hits a stream error sees a `text-ember` message and a "Press send to retry" hint; the conversation is preserved.
- The four explicit states (thinking / disconnected / finished / broken) are each rendered with a distinct surface treatment, matching the CLAUDE.md "default nobody set" rule.

### State machine

```
                  ┌──────────────┐
                  │     idle     │ ◀────────────┐
                  └──────┬───────┘              │
              submit     │                      │ done | abort
                         ▼                      │ (preserved)
                  ┌──────────────┐              │
                  │  submitting  │              │
                  └──────┬───────┘              │
              first      │                      │
              chunk      ▼                      │
                  ┌──────────────┐              │
                  │  streaming   │ ─────────────┘
                  └──────┬───────┘
              error      │
                         ▼
                  ┌──────────────┐
                  │   errored    │ (recoverable; same message retained)
                  └──────────────┘

                  ┌───────────────────────┐
                  │ runtime_unavailable   │ ◀── 5s probe, transitions to idle
                  └───────────────────────┘
```

### Known limitations

- **No session picker yet.** The browser always sends `session_id: "browser"`. A future slice can read `/runtime/sessions` and offer a "New conversation" + saved-sessions list. The BFF route is already in place — only the UI is missing.
- **No Markdown rendering.** Assistant text is rendered as `whitespace-pre-wrap`. The TUI gates Markdown rendering behind stream completion (`Plain text during streaming, markdown on completion` in `tui/app/model.go:722`); the browser surface does the same — `pendingText` during streaming, `text` after finalization — but `text` is rendered identically. A future slice can add a Markdown renderer gated on `!streaming`.
- **No "ask_user" form.** The gateway emits `event: ask_user` frames; the browser surfaces the question text in the assistant message but cannot answer it. A future slice can add a small form widget that POSTs to `/runtime/ask/respond` (the gateway already has this route; see `tui/api/client.go::AskRespond`).
- **No reconnection mid-stream.** If the gateway closes mid-stream, the browser's catch arm finalizes the assistant turn with whatever it accumulated and returns to `idle`. The user can resend. A future slice can attempt an automatic re-stream using a server-generated `last_event_id`.
- **No token-counting footer.** The TUI renders "12.4s · 842 tok" during streaming; the browser renders a plain "streaming" badge. The gateway emits `usage` chunks in OpenAI format; the parser already ignores them. A future slice can render the counts.
- **No multi-conversation timeline.** All messages live in one list; there is no sidebar. A future slice can add a sidebar reading from `/runtime/sessions`.
- **Hard-coded 5s probe interval.** The TUI uses the same interval; the constant is a single `5000` in `ChatClient.tsx:78`. Acceptable for MVP; a future slice can put it in a config.
- **No reduced-motion polish on the streaming spinner.** The CSS already honours `prefers-reduced-motion` globally; the spinner is animated via `.animate-breathe`, which is silenced by the global media query.

### Deviations

- **`postChatStream` returns a `Response`, not a parsed object.** The TUI returns a `chan Chunk`; the browser-side equivalent is a `ReadableStream<Uint8Array>`. The BFF route's only job is to forward the bytes, so making the BFF re-parse the stream would have duplicated the parser. Documented in the function's doc comment.
- **Esc is bound globally, not on the textarea.** The TUI's `Esc during streaming` handler is on the model, not on the input. Mirroring that, the browser binds `keydown` on `window`. The textarea still has a `disabled` state when the surface is `runtime_unavailable`; the global binding is a no-op then because `abortRef.current` is null.
- **The composer uses a `textarea`, not an `input`.** A future slice can swap to a `contenteditable` div for richer input, but `textarea` is the smallest surface that supports multi-line + Enter-to-send.
- **`finishWizardAction` now redirects to `/app/chat`.** Previously it redirected to `/app/wizard/ready`; the ready page was an intermediate confirmation screen. With chat live, the "Finish wizard" button on the ready page is the moment the user wants to start talking, so the action now hands them over directly. The ready page's copy was updated to match.

### Blockers

- **NONE.** All gateway routes consumed by slice 3 already exist. No Rust changes required.

### Deferred work (explicitly out of slice 3 scope)

- Session picker / saved-conversations list (UI; BFF route already in place)
- Markdown rendering on completed assistant turns
- `ask_user` answer form (POST to `/runtime/ask/respond`)
- Mid-stream reconnection with `last_event_id`
- Token-counting / latency footer
- Sidebar with conversation history
- Multi-session keyboard navigation

### Verified contracts

The chat surface mirrors these existing Cinderpaw contracts exactly:

| Contract | Source | Browser mirror |
|---|---|---|
| OpenAI-style `data:` chunks (`choices[0].delta.content`, `finish_reason`) | `crates/cinderpaw-core/src/api.rs::sse_from_agent_reply` | `lib/cinderpaw/chat.ts::parseOpenAIData` |
| `event: tool_start` / `tool_progress` / `tool_done` typed frames | `api.rs:1298-1314` | `lib/cinderpaw/chat.ts::parseToolFrame` |
| `event: ask_user` / `ask_user_cancelled` typed frames | `api.rs:1269-1276` | `lib/cinderpaw/chat.ts::parseAskFrame` |
| `[DONE]` terminator | `api.rs:1295` | `lib/cinderpaw/chat.ts::parseOpenAIData` (returns `{kind:"done"}`) |
| `/runtime/sessions?limit=N` shape (`{sessions: [...]}` from `conversations/index.json`) | `api.rs:2809-2843` | `lib/cinderpaw/client.ts::fetchSessions` |
| Bearer-token-in-Authorization-only invariant | `api.rs:1038-1043` | `lib/cinderpaw/client.ts::gatewayGet/gatewayPost` (unchanged) |
| Esc-during-streaming aborts but keeps the turn | `tui/app/update.go:184` | `app/app/chat/ChatClient.tsx::cancel` |
| 5s runtime re-probe on disconnect | TUI `statusPollTick` | `app/app/chat/ChatClient.tsx:78` |

### Manual verification

Dev server: `bun run dev` (Next.js 15.5.23) — started, `GET /app/chat` returned 200, response was 26.5 kB of HTML containing the rendered `NotReady` callout (the gateway is not running on this dev box, so the runtime-down branch fires, exactly as the spec requires). `POST /api/cinderpaw/chat/send` with `{}` returned 400 (validation), `GET /api/cinderpaw/sessions?limit=5` returned 502 (gateway unreachable), both expected on a machine without a running Cinderpaw.

The chat's happy path (streaming response, message reducer, abort, runtime re-probe) requires a live gateway; that branch is exercised by the parser tests and the message-model tests in `tests/cinderpaw-chat-sse.test.ts`, which use the exact SSE wire bytes the gateway emits. A future smoke test can stand up a fake gateway that streams the same bytes, but that is a separate piece of work (the Feral test suite does not currently spin up a fake gateway; the TUI's tests do not either, they only test the parser).
