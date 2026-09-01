# project_browser_app_mvp.md

> Boundary document for the Cinderpaw Browser App MVP. Read before touching
> any file under `crates/cinderpaw-core/src/api.rs`, `frontend-react/lib/cinderpaw/*`,
> or any new code under `D:\WEBSITES\Feral Landing Page\app\app\` /
> `app\api\cinderpaw\*`.

**Status:** Locked 2026-08-31. Companion to the Faza 0 report (kept in chat
history; not in-repo until Opus reviews and we promote the conclusions here).

**Predecessors:** `project_openclaw_onboarding_comparison.md` (2026-07-07,
pre-2.0 research, terminal-lane only) and `project_tui_openclaw_parity.md`
(classic wizard parity). This file supersedes neither — it adds the
post-2.0 + browser-surface lane they did not cover.

---

## TL;DR

A browser surface for Cinderpaw is a **typed TS client over the existing
Rust gateway at `127.0.0.1:11435`**, fronted by a thin Next.js BFF inside
the Feral Landing Page. The gateway already exposes every route the
browser needs; the work is to (a) harden the contract (typed errors,
idempotency, transcript replay, connector keychain endpoint) and (b)
write the browser UI that consumes it.

**MVP is desktop-only.** The browser lives on the same machine as the
gateway. Production browser-on-the-internet is a separate release and is
out of scope.

---

## What MVP is and what it is not

### MVP scope (this branch, this release)

- Browser chat at the Feral Landing Page (`/app/chat`), backed by the
  Rust gateway, mirroring TUI chat semantics.
- Browser wizard (4 visible steps, mirroring TUI F3 / F4), ending in a
  real `CINDERPAW_OK` streaming round-trip before the chat opens.
- Browser connector setup that goes through the keychain-backed
  `/runtime/connectors/:id/save` endpoint (no plaintext file writes).
- Recovery auto-retry on backend disconnect (mirror of TUI `StateRecovery`).
- Welcome-back last-task row on first load (mirror of Sprint 3).
- Typed error envelope `{code, retryable, retryAfterMs?}` on every
  `/runtime/*` route.
- Idempotency keys on side-effecting sidecar inbound (`message`,
  `connectors_reload`, `set_model`, `tool_response`).
- `/runtime/sessions/:id/transcript` for backfill on tab refresh.
- `docs/api-contract-v1.md` + Rust contract tests in lieu of OpenAPI
  codegen.

### Out of scope (deferred, do NOT add to MVP)

The following are explicitly frozen out of this branch:

- OpenAPI / JSON-Schema codegen pipeline (deferred; markdown contract +
  Rust tests suffice).
- Inference-first per-candidate verification (OpenClaw 2.0's pattern; we
  keep "detect → configure → verify → mark configured" truth-preserving
  model from TUI F3).
- 3-timestamp session lifecycle (`sessionStartedAt` /
  `lastInteractionAt` / `updatedAt` separate fields).
- Schema-validated config with hot reload + `baseHash` conflict guards.
- `/runtime/memory/*` HTTP surface (currently sidecar-protocol only).
- Per-agent SQLite for sessions + auth profiles (vs JSON files).
- Plugin marketplace, install policy gates, trust provenance.
- Device pairing with ed25519 signed challenge nonces.
- Operator-scope ladder (`operator.read` / `write` / `admin` / …).
- Cloud workers / Crabbox / paired-device execution placement.
- Hosting the gateway so public Vercel can reach it.
- Agent social network ("add friend", multiplayer shared sessions).
- Provider count expansion beyond current 4-6 (OpenAI, Anthropic,
  MiniMax, Ollama, 1 local, optionally OpenRouter).
- Lit + CodeMirror SPA migration; WebSocket multiplexed transport.
- Schema-as-RPC live config editor.

**Rule.** If a pattern from OpenClaw 2.0 is not in the MVP scope list
above, do not pull it into this branch even if it looks attractive.
Steal validated *ideas*, not complexity.

---

## Deployment & credential flow

### Mode A — desktop development (the only mode MVP supports)

```
┌─────────────────────────────────────────┐
│  Browser (Feral site — Next.js dev)     │
│  http://localhost:3000                  │
└──────────────┬──────────────────────────┘
               │ HTTP + EventSource
               │ (cookies httpOnly pt session)
               │ (NO bearer token in browser)
               ▼
┌─────────────────────────────────────────┐
│  Next.js BFF (Feral site)               │
│  http://localhost:3000/api/cinderpaw/*  │
│  reads CINDERPAW_API_TOKEN from .env   │
└──────────────┬──────────────────────────┘
               │ HTTP + SSE pass-through
               │ Authorization: Bearer <api-token>
               ▼
┌─────────────────────────────────────────┐
│  Cinderpaw Rust gateway                 │
│  http://127.0.0.1:11435 (loopback only) │
│  bearer-validated, CORS loopback-only  │
└──────────────┬──────────────────────────┘
               ▼
       Sidecar (Bun/TS, NDJSON)
               ▼
       Cinderpaw runtime
```

**Where the bearer lives:**
- **BFF → gateway:** `process.env.CINDERPAW_API_TOKEN` in Next.js
  `route.ts` handlers (server-side only). Never read in a `'use client'`
  file.
- **Browser → BFF:** `httpOnly`, `sameSite=strict`, `secure` cookie set
  by the BFF after first request validates. Not accessible from
  JavaScript.
- **Test:** every response from `/api/cinderpaw/*` does not echo the
  bearer. Regression test in `frontend-react/tests/cinderpaw-bff-no-token-leak.test.ts`.

### Mode B — public Vercel frontend (DEFERRED, not MVP)

A public Vercel deployment of Feral cannot reach the user's
`127.0.0.1:11435`. Real options for the eventual production browser
release are out of scope here. Likely candidates (not committed to):

- **B.1 Desktop-hosted UI:** Tauri webview serves UI on
  `http://tauri.localhost`; Feral stays as marketing + docs only.
- **B.2 Pairing model:** OpenClaw-style ed25519 device pair; browser is
  one device among many.
- **B.3 Hosted gateway:** Cinderpaw as SaaS with server-side gateway.
- **B.4 Tailscale / SSH tunnel:** niche.

This MVP document does not commit to any of B.1–B.4. The branch exists
only in Mode A.

---

## Boundary: browser ↔ gateway

### Reused as-is (no change)

- All existing `/runtime/*` routes in `crates/cinderpaw-core/src/api.rs`.
- Bearer auth, CORS loopback-only, `X-Cinderpaw-Api-Stability` header.
- Sidecar protocol pinning (`CinderpawAgent/src/protocol.ts`,
  `INBOUND_TYPES` / `OUTBOUND_TYPES`).
- TUI typed SSE client (`tui/api/client.go`) as a worked example.

### Added in this branch (Sprint A — Rust foundation)

| # | Surface | What | Why MVP needs it |
|---|---|---|---|
| **A1** | New module `crates/cinderpaw-core/src/api_error.rs` | Introduces `ApiError` struct, constructors, wire-shape contract `{code, message, retryable, retryAfterMs?, hint?}`. **Zero production call sites migrated in A1.** Existing 33 inline `(StatusCode, String)` responses in `api.rs` are untouched. | Test-only fixture in `tests/api_error_envelope.rs` demonstrates how A2/A3/B2 migrations will look, without touching production routes. |
| **A2** | New route `POST /runtime/connectors/:id/save` | Writes to OS keychain; deprecates plaintext `SaveConnectorConfig` (TUI) | Browser cannot touch `connectors.json` directly; secrets never reach disk plaintext |
| **A3** | New route `GET /runtime/sessions/:id/transcript` | Full conversation backfill on reconnect | Tab refresh = resume, not blank chat |
| **A4'** | `docs/api-contract-v1.md` + `crates/cinderpaw-core/tests/contract_v1.rs` | Versioned markdown contract + Rust integration tests asserting route shapes | Drift detection without OpenAPI overhead |

### Added in this branch (Sprint B — Sidecar)

| # | Surface | What | Why |
|---|---|---|---|
| **B1** | Sidecar inbound side-effecting messages | Idempotency keys, dedup cache | Reconnect-after-restart cannot re-fire sends |
| **B2** | Sidecar outbound errors | Same `{code, retryable, retryAfterMs?}` shape | Symmetry with A1 |
| **B3** | Sidecar `OutboundEvent` | Hand-written Zod schema | Drift detection without codegen |

### Added in this branch (Sprint C — Feral BFF)

| # | Surface | What |
|---|---|---|
| **C1** | `app/app/layout.tsx` + empty page | Cinderpaw UI shell inside Feral site |
| **C2** | `app/api/cinderpaw/health/route.ts` | `GET /runtime/status` proxy |
| **C3** | `app/api/cinderpaw/chat/route.ts` | SSE proxy for `/runtime/chat` |
| **C4** | `app/api/cinderpaw/events/route.ts` | SSE proxy for `/events` |
| **C5** | `lib/cinderpaw/{client,sse}.ts` | Typed TS client; single source of truth for browser |

### Added in this branch (Sprint D — Browser UI)

Mirrors TUI F3 / F4 / Sprint 3 in 9 steps (see chat history). UI does not
add new wizard logic; it consumes the same Rust routes the TUI already
consumes.

### Files explicitly out of bounds for this branch

Per `AGENTS.md` and the project-memory protocol:

- `frontend-react/src/hooks/useCallSession.ts`
- `frontend-react/src/voice/vad.ts`
- Rust audio pipeline (`src-tauri/src/audio/*`)
- `mcp.json`

If a change appears to require touching any of these, stop and ask.

---

## Wizard contract (truth-preserving)

**A wizard step is "configured" only if a real verify operation succeeded
end-to-end.** Detected ≠ configured. Configured ≠ verified. The chat
does not open until the final verify has passed.

Sequence (mirrors TUI F3):

1. **Detect.** Read candidates from `~/.cinderpaw/`, env vars, OS
   keychain.
2. **Configure.** User selects/confirms/enters key per candidate.
3. **Verify.** Real model call with `CINDERPAW_OK` and deterministic
   checksum; streaming round-trip must complete.
4. **Mark configured.** Only after verify green.

**Not adopted from OpenClaw 2.0:** automatic per-candidate verification
inline with skip-on-failure. User picks; wizard does not decide in their
place.

---

## Backward compatibility rules

For every change in this branch:

- **Success shapes preserved** where the TUI depends on them.
- **Errors get the new envelope** `{code, message, retryable, retryAfterMs?, hint?}`.
  Migration of each call site is a separate PR (A2, A3, B2, follow-ups).
- **No breaking change without an explicit test** that asserts the
  TUI's `tui/api/client.go` request/response still parses.
- **No "uniformity for its own sake"** — if the TUI's happy path is
  one shape and a new route needs another shape, that's fine.
- **A1 is contract introduction only.** No production call site is
  migrated in A1; the existing 33 inline `(StatusCode, String)`
  responses in `api.rs` are untouched. Future migrations replace the
  tuple with `ApiError::bad(...).into_response_with(StatusCode)` /
  `ApiError::retryable(..., retry_after_ms).into_response_with(...)`
  per call site.

---

## Reuse & attribution

OpenClaw is MIT-licensed (`THIRD-PARTY-NOTICES.md` confirmed on
2026-08-31). No code is copied verbatim into Cinderpaw. The
*concepts* adapted are noted in commit messages and in
`docs/agents-memory/` only when the adaptation produces a Cinderpaw
idiom; copied strings or verbatim UX copy are flagged with file:line
attribution at the point of use.

Concepts adapted (with attribution in code comments):

- Typed error envelope `{code, retryable, retryAfterMs?}` — adapted
  from OpenClaw 2.0 protocol error layer; not copied.
- Idempotency keys on side-effecting methods — adapted; not copied.
- Per-session transcript replay for reconnect — adapted; not copied.
- Truth-preserving wizard with verify-before-mark-configured — Cinderpaw
  TUI F3 origin; OpenClaw's 2.0 "inference-first" pattern is similar in
  shape but not adopted.

---

## Risk register

1. **Bearer token leaks via DevTools.** Mitigated by BFF + cookie.
   Regression test required (E4).
2. **Plaintext connector secrets written by TUI helper.** Mitigated by
   A2; `SaveConnectorConfig` deprecated in same PR.
3. **SSE reconnect without documented contract.** Mitigated by A4'
   markdown documenting `last_event_id` semantics before any client
   uses it.
4. **Public Vercel can't reach `127.0.0.1`.** Accepted limitation.
   Mode B is explicitly deferred.
5. **Scope creep from OpenClaw research.** Mitigated by this document
   + the explicit out-of-scope list above. Any "while we're here" PR
   that adds a deferred feature must be rejected at review.
6. **CORS on Next dev port vs gateway port.** BFF solves this in dev;
   no browser-direct-to-gateway requests allowed in MVP.

---

## Verification gate

Before merging this branch:

- `./scripts/verify.sh` clean.
- New Rust integration tests for A1, A2, A3 pass.
- `docs/api-contract-v1.md` exists and matches the route shapes.
- Browser regression test for bearer-not-in-client-bundle passes.
- `frontend-react/tests/` + TUI tests (`tui/`) all green — confirms
  backward compatibility.

---

## Slices shipped (2026-08-31)

### Slice 1 — Discovery + App Shell
- **Landing page commit:** `5952182d` — `/app`, `/app/discover`, `lib/cinderpaw/{client,types,discovery}.ts`, BFF `/api/cinderpaw/health`, 5 UI primitives, 15 tests.
- **Cinderpaw commit:** `664531c` — receipt only.
- **Gateway changes:** none. Consumed existing `/runtime/status`, `/runtime/manifest`.

### Slice 2 — Wizard Foundation
- **Landing page commit:** `e18ee139` — 7 wizard pages, 8 BFF routes, `lib/cinderpaw/{catalog-version,wizard-progress,verify,wizard-disk}.ts`, client form with CINDERPAW_OK gate, 22 new tests (105 total).
- **Cinderpaw commit:** `4dd6672` — receipt only.
- **Gateway changes:** none. Consumed existing `/runtime/setup/{detect,verify}`, `/runtime/providers/catalog`, `/system_info`, `/runtime/models/install`, `/runtime/models/download/:id`.

### Slice 3 — Chat UI + Streaming
- **Landing page commit:** `9acf31c0` — `lib/cinderpaw/chat.ts` (pure SSE parser + Message model), `app/api/cinderpaw/{chat/send,sessions}/route.ts` (POST SSE proxy + GET sessions), `app/app/chat/{page,ChatClient}.tsx` (server shell + client island), 33 new tests (138 total).
- **Cinderpaw commit:** this file + `docs/receipts/slice-3-chat-streaming.md`.
- **Gateway changes:** none. Consumed existing `POST /runtime/chat` (SSE since Faza 4.5 Slice 3) and `GET /runtime/sessions?limit=N`.

### Slice 4 — Session Picker + Transcript Replay
- **Cinderpaw commit:** `6f249fa` — gateway A3: `GET /runtime/sessions/:id/transcript` (alnum+dash id guard, reads `~/.cinderpaw/conversations/{id}.json`, A1 typed error envelope on 404/502/503) + 5 integration tests.
- **Landing page commit:** `2359c7e4` — `lib/cinderpaw/{chat,client}.ts` (transcriptToMessages + fetchSessionTranscript), BFF `/api/cinderpaw/sessions/[id]/transcript/route.ts` with id re-validation, `app/app/chat/{page,ChatClient}.tsx` (server pre-load + SessionSidebar + switchToSession + refreshSessions), 7 new tests (145 total).
- **Gateway sidecar changes:** none. The new endpoint is a pure read of the existing on-disk transcript file.
- **TUI / desktop / connector changes:** none. The TUI and desktop chat continue to read the same files via their own loaders.

### Slice 5 — Tool-Call Rendering
- **Landing page commit:** `fe427ee6` — `lib/cinderpaw/chat.ts` (ToolCall type + applyToolFrame pure reducer + previewJson + isWriteSideTool / WRITE_SIDE_TOOLS + durationMs; Message extended with toolCalls: ToolCall[]), `components/ui/ToolCallCard.tsx` (collapsed for write-side tools, live duration counter, expandable args/progress/result/error), `app/app/chat/ChatClient.tsx` wired to applyToolFrame on every tool event, 22 new tests (167 total).
- **Cinderpaw commit:** receipt + boundary doc only.
- **Gateway changes:** none. The browser reads the existing `event: tool_start` / `tool_progress` / `tool_done` SSE frames that the gateway has re-emitted since Faza 4.5 Slice 3.
- **Sidecar / TUI / desktop / connector changes:** none.

### Key decisions locked in
- Wizard progress file format `v4:<step>:<mode>:<choice>` is shared with TUI; both clients read/write the same file.
- BFF writes `~/.cinderpaw/.wizard-progress` directly (atomic 0600) — same legitimacy as TUI which writes directly.
- CINDERPAW_OK gate: browser re-checks the deterministic token client-side; gateway's `ok: true` is necessary but not sufficient.
- Provider catalog version pinned to `byok::CATALOG_VERSION = 1`.
- Local model download path deferred to a later slice.
- Chat session id is hard-coded to `"browser"` in slice 3; a session picker reading `/runtime/sessions` is a later slice.
- Chat BFF forwards SSE bytes verbatim; the parser is single-sourced in `lib/cinderpaw/chat.ts` so a gateway chunk-shape change only updates one file.
- Runtime re-probe on chat disconnect is 5s (matches TUI `statusPollTick`); the constant is a single `5000` in `ChatClient.tsx`.
- Session id is validated as alnum + dash, 1-64 chars, at three layers (client pre-flight, BFF re-validation, gateway alnum guard) — defence in depth against path traversal on `/runtime/sessions/:id/transcript`.
- Transcript response shape is `{id, title, created_at, updated_at, messages: [{role, content, created_at}]}`; legacy `timestamp` field is normalised to `created_at` server-side.
- Tool-call state is in-memory only: the on-disk transcript does NOT carry `toolCalls`. Saved sessions backfill `toolCalls: []`. A future slice can extend the on-disk format additively.
- `WRITE_SIDE_TOOLS` is a hand-written `Set<string>` in `lib/cinderpaw/chat.ts`; cards for these tools are collapsed by default. The list is a snapshot of the CinderpawAgent registry at slice-5 ship time, not a live fetch.
- `applyToolFrame` is pure: returns a new `ToolCall[]` per frame; events for unknown ids are dropped (orphan frames after a session switch); no I/O, no env read, no persistence.

### Pre-existing uncommitted changes in landing page repo
- `app/api/public-journal/ingest/route.ts`, `lib/journal-store.ts`, `package.json`, `package-lock.json`, `lib/kv.ts` — not ours, left untouched.

---

*End of document. Update when MVP scope changes or when Mode B becomes a
real release.*