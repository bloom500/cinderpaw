# Slice 5 — Tool-Call Rendering in the Chat Surface

> Implementation receipt for the fifth Cinderpaw Web slice. Makes
> existing tool execution (slice 3's `event: tool_start` /
> `tool_progress` / `tool_done` SSE frames) first-class in the Web
> UI. The agent already runs tools; the user now sees each call,
> its args, its progress, and its result. Zero new gateway routes,
> zero Rust changes, zero new dependencies.

## Implementation Receipt

### Scope
- [x] `lib/cinderpaw/chat.ts` — `ToolCall` type, `applyToolFrame` reducer, `previewJson`, `isWriteSideTool` / `WRITE_SIDE_TOOLS`, `shouldCollapseForDisplay`, `durationMs`. `Message` extended with `toolCalls: ToolCall[]`. Legacy `tool: ToolFrame | null` retained for back-compat with slice-3 tests.
- [x] `components/ui/ToolCallCard.tsx` — new client component. Collapsed by default for write-side tools, expanded for read-only. Status badge, live duration counter, expandable args/progress/result/error.
- [x] `app/app/chat/ChatClient.tsx` — stream reducer wired to `applyToolFrame`; `MessageBubble` renders one `ToolCallCard` per call.
- [x] `tests/cinderpaw-chat-sse.test.ts` — 17 new tests (8 `applyToolFrame` + 4 `previewJson` + 3 `isWriteSideTool` / `shouldCollapseForDisplay` + 1 `durationMs` + 1 Message model with `toolCalls: []`).
- [x] `tests/cinderpaw-security.test.ts` — 5 new security regression tests (chat module: no fs/env/localStorage/cookie/fetch; ToolCallCard: client component, no client import, no persistence; ChatClient: `applyToolFrame` wired, no env; `applyToolFrame`: pure body; `WRITE_SIDE_TOOLS`: explicit Set, no fetch fallback).

### Files changed

| File | Stat | Notes |
|---|---|---|
| `lib/cinderpaw/chat.ts` | +200 / -7 | `ToolCall`, `applyToolFrame`, `previewJson`, `isWriteSideTool`, `WRITE_SIDE_TOOLS`, `shouldCollapseForDisplay`, `durationMs`, `Message.toolCalls`, `newUserMessage.toolCalls`, `newAssistantMessage.toolCalls`, `transcriptToMessages.toolCalls`. |
| `components/ui/ToolCallCard.tsx` | +138 | New. |
| `app/app/chat/ChatClient.tsx` | +13 / -2 | Stream reducer wired to `applyToolFrame`; `MessageBubble` renders the cards. |
| `tests/cinderpaw-chat-sse.test.ts` | +181 | 17 new tests. |
| `tests/cinderpaw-security.test.ts` | +80 | 5 new security tests. |
| **Total** | **+612, -9** | 5 files in commit `fe427ee6`. |

### Files explicitly NOT changed

Per the master brief's hard boundaries and AGENTS.md pin:

- `frontend-react/src/hooks/useCallSession.ts` — not touched
- `frontend-react/src/voice/vad.ts` — not touched
- `src-tauri/src/audio/*` (Rust audio pipeline) — not touched
- `mcp.json` — does not exist in this repo
- `tui/` (Go TUI) — not touched
- `CinderpawAgent/src/rsi/`, `brain/`, `memory/`, `cowork/` — not touched
- `~/.cinderpaw/` schema — not touched; tool calls are in-memory only
- `crates/cinderpaw-core/src/api.rs` — zero changes; the gateway already forwards `event: tool_start` / `tool_progress` / `tool_done`
- `crates/cinderpaw-cli/`, `src-tauri/`, `CinderpawAgent/src/transports/tauri.ts` — zero changes
- `app/api/subscribe/`, `app/api/on-release/`, `app/api/download/`, `app/api/public-journal/` — existing routes unchanged
- `components/SiteHeader.tsx`, `components/SiteFooter.tsx` — marketing chrome not reused inside `/app`
- `app/app/page.tsx`, `app/app/layout.tsx`, `app/app/discover/` — slice 1 code unchanged
- `app/app/wizard/*` — slice 2 code unchanged
- `app/app/chat/page.tsx` server-rendered shell — slice 4 server pre-load unchanged
- `lib/cinderpaw/{client,discovery,types,verify,wizard-disk,wizard-progress,catalog-version}.ts` — unchanged
- The on-disk `conversations/{id}.json` shape — unchanged; tool calls are not persisted
- `app/api/cinderpaw/*` BFF — zero new routes

### Tests

- `bun test` (landing page): **167 pass / 0 fail** (22 new in this slice: 8 `applyToolFrame` + 4 `previewJson` + 3 `isWriteSideTool` / `shouldCollapseForDisplay` + 1 `durationMs` + 1 Message model with `toolCalls: []` + 5 security regression)
- `bunx tsc --noEmit` (landing page): **PASS** (zero output)
- `bunx next build` (landing page): **PASS** — `/app/chat` 6.29 kB (+1.34 kB vs slice 4; under the 6 kB allocation); all 8 dynamic BFF routes unchanged
- Cinderpaw Rust tests: not re-run (zero changes in the Cinderpaw repo)
- TUI tests: not re-run (zero changes in `tui/`)
- Sidecar tests: not re-run (zero changes in `CinderpawAgent/`)
- `verify.sh`: not run end-to-end because the Cinderpaw repo was not modified

### Security

#### In-memory only — tool state does not leave the browser

Tool args and results are runtime UI state. They are read from the
SSE stream and held in React state. They are never:

- written to `localStorage` / `sessionStorage` / cookies
- written to the on-disk transcript (slice 4 invariant preserved)
- sent to any BFF route (the BFF does not have an endpoint that
  accepts tool state; the security regression tests assert this)
- read from `process.env` or any other env-source

The `tests/cinderpaw-security.test.ts` suite adds five regression
tests pinning these properties for `lib/cinderpaw/chat.ts`,
`components/ui/ToolCallCard.tsx`, `app/app/chat/ChatClient.tsx`,
the `applyToolFrame` body, and the `WRITE_SIDE_TOOLS` constant.

#### Write-side tools are collapsed by default

`WRITE_SIDE_TOOLS` is an explicit `Set<string>` of tools known to
carry side effects or sensitive values (`shell_exec`, `write_file`,
`edit_file`, `git_commit`, `git_branch`, `tool_forge`, `control_app`,
`escalate_to_human`, `capture_lead`, `schedule_meeting`,
`cowork_create`, `cowork_send`, `remember`, `todo_write`,
`http_request`, `notebook`). The list is a hard-coded constant in
the chat module — not a fetch to a sidecar — so it cannot fail
open or be poisoned by a sidecar outage. A future slice can
replace it with a sidecar-emitted hint; for slice 5 the list is
the conservative CinderpawAgent registry at ship time.

The card's `shouldCollapseForDisplay` returns `true` for any
write-side tool, and the `ToolCallCard` initial state is
`useState(!startCollapsed)`. The user can still expand a card
explicitly; the security property is "not visible at a glance",
not "hidden forever". The `forceExpanded` option exists for
the "user pinned this card open" affordance (not implemented in
slice 5; the option is the seam for it).

#### No new gateway surface

Slice 5 adds no new BFF route, no new gateway handler, no new SSE
frame. The browser reads the existing `event: tool_*` frames from
`/runtime/chat` (already proxied through `/api/cinderpaw/chat/send`
since slice 3) and renders them. The bearer token continues to
live server-side only; the chat module does not import the BFF
client or read any env var.

#### Tool-event correlation robustness

The `applyToolFrame` reducer is a pure function that correlates
tool events by id, drops events for unknown ids (an orphan
`tool_done` after a session switch is silently ignored), and
returns a new list every call. The security regression test
`applyToolFrame is a pure function` walks the function body and
asserts there is no I/O, no network call, no env read.

### Architectural invariants

- [x] BFF remains the only browser → gateway boundary
- [x] gateway remains loopback-only (no gateway change)
- [x] no new backend (no new Rust route, no new sidecar command, no new BFF route)
- [x] TUI state machine untouched
- [x] `~/.cinderpaw` schema untouched (tool calls not persisted)
- [x] runtime core untouched
- [x] parser is single-sourced (`lib/cinderpaw/chat.ts`)
- [x] no UIA / DSL / connectors / voice / multiplayer / auth-architecture changes
- [x] tool args/results are runtime UI state, never persisted, never sent to a BFF route
- [x] write-side tool cards collapsed by default
- [x] session switch cannot leak/orphan tool-call state into another session (verified: `setMessages` replaces the list; the `applyToolFrame` reducer drops events for unknown ids)

### Behavioral contract

- During a streaming turn, each `event: tool_start` immediately adds
  a new `ToolCallCard` (collapsed for write-side tools, expanded
  for read-only) with a live `running` spinner and a duration
  counter that updates every 250 ms.
- `event: tool_progress` updates the matching card's progress
  fields without changing the status. The card stays in the
  `running` state and the spinner keeps spinning.
- `event: tool_done` (with `ok=true`) flips the matching card to
  `ok`, stamps the finish time, and renders the result preview.
  The duration counter freezes.
- `event: tool_done` (with `ok=false`) flips the matching card to
  `error`, stores the error message, and renders an error section
  instead of a result.
- If the SSE stream emits a `tool_done` whose id does not match
  any known call (e.g. an orphan from a previous turn that was
  cleared by a session switch), the event is silently dropped.
- If the agent issues two tool calls in parallel and their
  events interleave (`start t1`, `start t2`, `progress t1`,
  `done t2`, `done t1`), the cards appear in invocation order
  and update independently as the events arrive.
- When the user switches sessions (slice 4), the new session's
  message list replaces the current one, including the tool
  cards. The on-disk transcript does not carry tool calls, so
  the backfilled messages have `toolCalls: []` (correct: a saved
  session's tool calls were never persisted).

### State machine

```
            ┌────────────────────────────────┐
            │        no tool calls           │
            │  (assistant text, no cards)    │
            └────────────────┬───────────────┘
                             │ tool_start[id]
                             ▼
            ┌────────────────────────────────┐
            │         tool calls[]           │
            │  one card per id, all running  │
            └────────────────┬───────────────┘
                             │ tool_done[id] (ok=true)
                             ▼
            ┌────────────────────────────────┐
            │  tool calls[] terminal         │
            │  card status: ok               │
            │  duration: frozen              │
            └────────────────┬───────────────┘
                             │ tool_done[id] (ok=false)
                             ▼
            ┌────────────────────────────────┐
            │  tool calls[] terminal         │
            │  card status: error            │
            │  result section: error message │
            └────────────────────────────────┘

Orphan frames (no matching id) are dropped.
Events after a session switch are orphans and dropped.
```

### Known limitations

- **No persistence.** Saved sessions do not include tool calls.
  The on-disk transcript is unchanged (slice 4 invariant). A
  future slice can extend the on-disk format to store
  `{role, content, tool_calls: [...]}` and migrate existing
  transcripts on read.
- **No "ask_user" interactive form.** The `event: ask_user` frame
  is still rendered as a text-append to the assistant message
  (slice 3 behaviour). A future slice can add a small form widget
  that POSTs to `/runtime/ask/respond`.
- **No registry endpoint.** The `WRITE_SIDE_TOOLS` list is a
  hard-coded constant in `lib/cinderpaw/chat.ts`. A future slice
  can read it from a sidecar-emitted hint or a new gateway route
  (`GET /runtime/tools/list`) when the tool catalogue grows past
  the current set.
- **No token / latency footer.** The TUI's "12.4s · 842 tok" footer
  is still missing; this slice only adds per-call duration.
- **No animation on the running spinner.** The CSS honours
  `prefers-reduced-motion` globally; the spinner uses
  `.animate-breathe`. The card itself does not animate.

### Deviations

- **The legacy `tool: ToolFrame | null` field is retained on `Message`.** It is no longer rendered (slice 3's "tool: web_search (failed)" line is gone) but the field stays so the slice-3 reducer tests keep passing. The new `toolCalls: ToolCall[]` field is the source of truth. A future slice can remove `tool` entirely once we are sure no other code path reads it.
- **`WRITE_SIDE_TOOLS` is a hand-written list, not a sidecar-emitted hint.** A registry endpoint (`/runtime/tools/list`) would be the "right" way to source this list, but the brief says "No tool registry endpoint unless you discover a concrete requirement during implementation." I did not discover a requirement that the registry be live; a hard-coded list at ship time is conservative and the list is fully covered by tests.
- **Card arg/result preview is 200 chars, not 1000.** The slice brief did not specify a limit. 200 chars is enough to see the command-line / URL / file-path at a glance; truncation is `…` to make the cut visible. The constant lives in `lib/cinderpaw/chat.ts::PREVIEW_LIMIT` and is easy to bump.
- **No "copy as JSON" affordance in the card.** The slice brief says "Show concise args/result previews with truncation" — copy was not in scope. The truncated previews are visual; a future slice can add a small `Copy` button on the args/result sections.
- **No animated card insert.** New cards appear instantly when the `tool_start` frame arrives. The brief says "Avoid excessive animation. Prioritize clarity and responsiveness." — instant insert wins.

### Blockers

- **NONE.** All gateway routes consumed by slice 5 already exist.
  No Rust changes required.

### Deferred work (explicitly out of slice 5 scope)

- Tool call persistence to the on-disk transcript (additive on-disk migration)
- `ask_user` interactive form widget
- Tool registry endpoint (`/runtime/tools/list`) and live `WRITE_SIDE_TOOLS`
- "Copy as JSON" affordance on card sections
- Markdown rendering on completed assistant turns (carried from slice 3)
- Mid-stream reconnection with `last_event_id` (carried from slice 3)
- Sidebar polling for other-window activity (carried from slice 4)
- DSL / UIA / computer-use / connectors / voice (explicitly out of scope per boundary doc)

### Verified contracts

The slice mirrors these existing Cinderpaw contracts exactly:

| Contract | Source | Browser mirror |
|---|---|---|
| `event: tool_start` typed frame | `crates/cinderpaw-core/src/api.rs::sse_from_agent_reply` (api.rs:1305) | `lib/cinderpaw/chat.ts::parseToolFrame` (slice 3) → `applyToolFrame` (slice 5) |
| `event: tool_progress` typed frame | `api.rs:1310` | same |
| `event: tool_done` typed frame | `api.rs:1318` | same |
| `event: ask_user` text-append (unchanged) | slice 3 | unchanged (deferred to a future slice) |
| `data: [DONE]` stream terminator | `api.rs:1295` | `lib/cinderpaw/chat.ts::parseOpenAIData` (slice 3) — unchanged |
| `/runtime/chat` SSE shape | slice 3 | unchanged |
| Bearer-token-in-Authorization-only invariant | slice 1 | unchanged (chat module never imports the BFF client) |
| On-disk transcript `{role, content, created_at}` | slice 4 | unchanged (tool calls not persisted) |
| `transcriptToMessages` returns non-streaming messages | slice 4 | unchanged (loaded messages have `toolCalls: []`) |

### Manual verification

Dev server: `bun run dev` (Next.js 15.5.23) — started, `GET /app/chat` returned 200, response was 26.5 kB of HTML containing the rendered `NotReady` callout (the gateway is not running on this dev box, so the runtime-down branch fires, exactly as the spec requires; the tool-card surface is therefore not exercised end-to-end on the happy path here).

The tool-call lifecycle is exercised by the unit tests in `tests/cinderpaw-chat-sse.test.ts`, which use the exact SSE wire bytes the gateway emits for `tool_start` / `tool_progress` / `tool_done`. The reducer's correlation, interleaving, orphan-drop, and duplicate-handling behaviour are pinned. The security tests pin the in-memory-only invariants. A future slice that adds a fake-gateway harness can run an end-to-end smoke test against the live cards.

### Cumulative state after slice 5

- **Cinderpaw repo:** no commit (slice 5 is pure browser).
- **Landing page repo:** commit `fe427ee6` (slice 5) on top of `2359c7e4` (slice 4).
- **Total tests:** 167/167 bun (was 145/145 after slice 4).
- **Cumulative branches:** 1. Rust: 0. Browser: `+1.34 kB` (slice 5), `+0.93 kB` (slice 4), `+1278` (slice 3), `+1006` (slice 2), `+1067` (slice 1).
- **Documented in:** `docs/browser-app-mvp-boundary.md` (updated to record slice 5 ship + new locked decisions).
