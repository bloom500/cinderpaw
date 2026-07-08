# `feral chat` TUI (Faza 4.5 Slice 2 follow-up)

**Status:** Single TUI, Go/Bubble Tea (`tui/`), launched as a child
process by `crates/feral-cli/src/chat.rs`. The earlier ratatui
prototype (`chat_ui.rs`) was dead code (unused, never wired past
`mod chat_ui;`) and has been deleted 2026-07-04 — `ratatui`/`crossterm`/
`tui-textarea` deps dropped from `crates/feral-cli/Cargo.toml`.
**Date:** 2026-07-04 (welcome redesign + tool pills landed 2026-07-04)
**Branch / worktree:** `D:\FeralLocalAI` (no separate worktree — UI-only).

## Where it lives

- `crates/feral-cli/src/chat.rs` — ensures the gateway is running,
  then execs `feral-tui.exe` (inherits stdio), never returns.
- `tui/main.go` + `tui/app/` (model.go/update.go/view.go) — Bubble Tea
  `App`: viewport (bubbles), textarea (bubbles), spinner (bubbles),
  Lip Gloss styling (`tui/ui/styles.go`), Glamour markdown rendering
  (`ui.RenderMarkdown`).
- `tui/api/client.go` — talks to the same `/runtime/status` +
  `/runtime/chat` SSE endpoints as before.
- Built with `cd tui && go build -o ../target/debug/feral-tui.exe .`;
  the binary must sit next to `feral-cli`/`feral` in the same dir.

The full investigation into the (now removed) ratatui version is in
`docs/2026-07-03-professional-tui-render-report.md` — historical only,
do not use it to guide changes to the Go TUI.

## What it consumes

- `GET  /runtime/status` — header (model · lora · backend · online ·
  `provider` · `byok_provider` · `agent_model`). The last three are
  new (2026-07-04) and distinguish cloud BYOK sessions from local ones.
- `GET  /runtime/sessions?limit=N` — most-recent conversation rows
  (from `~/.feral/conversations/index.json`), rendered on the welcome
  screen under "recent". New endpoint, see `runtime_sessions` in
  `crates/feral-core/src/api.rs`.
- `POST /runtime/chat` (SSE) — token stream, `delta.content` +
  `delta.reasoning_content` / `<think>` tags parsed in
  `tui/app/update.go`. The host also forwards typed tool frames:
  `event: tool_start` / `event: tool_progress` / `event: tool_done`
  (raw sidecar JSON in the `data:` body), parsed by `parseToolFrame`
  in `tui/api/client.go`. OpenAI-style clients ignore them; the TUI
  renders each one as an inline pill under the assistant turn.

## BYOK cloud model switching

`POST /runtime/set_model` now accepts two formats:
  - **Local GGUF**: `{ "id": "Qwen_Qwen3-4B-Q5_K_M.gguf" }` — loads
    from disk, tells the sidecar to use loopback. Clears BYOK env vars.
  - **Cloud BYOK**: `{ "id": "nvidia:stepfun-ai/step-3.7-flash" }` or
    `{ "id": "minimax:MiniMax-M3" }` — resolves the provider's
    `base_url` from `~/.feral/byok.json`, pulls the API key from the
    OS keychain via `byok_get`, and sends a `set_model` message to the
    sidecar with `provider=| "anthropic"` (from `provider_kind`), `baseUrl`,
    `apiKey`, `model`, `contextWindow` (default 200K). Also sets
    `FERAL_BYOK_PROVIDER` env var so `runtime_status` reports the
    provider id back.

The TUI header + welcome row now show `ByokProvider` (e.g. "nvidia")
instead of the raw backend ("openai_compatible") when a BYOK provider
is active. Pure provider ids (e.g. `nvidia` alone without `:model`) are
accepted and use the provider's `default_model` from byok.json.

Fallback base URLs are hardcoded for well-known providers when byok.json
has null: `minimax → https://api.minimax.chat/v1`,
`groq → https://api.groq.com/openai/v1`. All other providers must have
`base_url` set in byok.json.

## Build + deploy workflow

After any Go or Rust changes:
1. `cd tui && go build -o ../target/debug/feral-tui.exe .`
2. `cargo build -p feral-cli` (from worktree root)
3. Copy both to `C:\Users\Darius\AppData\Roaming\npm\node_modules\feral-agent\vendor\`
4. The Tauri host (`cargo build -p feral` from `src-tauri/`) also links
   `feral-core` and serves the API — rebuild it too if the gateway is
   the Tauri app.

## Welcome screen

`renderWelcomeContent` (`tui/app/view.go`) shows a 6-row ASCII `feral`
mark, a status table (model · lora · backend · session elapsed), recent
sessions, and shortcut hints — centred in the viewport, collapsible on
narrow/short terminals. Recent sessions are fetched once at boot
(`Init` → `fetchSessionsCmd`) and cached for 30 s.

## Tool-call pills

Inline under each assistant turn:
- `● 🔧 web_search("rust vulkan")  ⏱ 0.4s ✓`
- `   └─ retry 2/3`   (only when `tool_progress` arrived)
- `   └─ <err msg>`   (only when the call failed)
- `   <preview…>`     (first ~80 runes of `result`, when present)

Status colours live in `ui/styles.go` — `ToolRunning` (orange),
`ToolDone` (dim), `ToolError` (fail-red). The emoji map is
`tui/ui/tool_emoji.go` and is kept in sync with
`frontend-react/src/components/chat/mascot/emojiForTool.ts`. The
elapsed counter animates via a 200 ms `TickMsg` that re-arms only while
at least one tool is still `ToolRunning` (`toolsRunning` in
`tui/app/model.go`).

## Slash-command autocomplete

`/` opens a popup above the input listing every known command, filtered
as the user types. `Tab` cycles the highlight; `Enter` accepts the
highlighted row (inserting its `Insert` text and keeping the user in
the textarea — a second `Enter` then sends). `Esc` dismisses without
accepting. While the popup is showing the input is **not** consumed by
`textarea` for Tab, so the keystroke never lands as a literal `\t`.

Source of truth for the list is `KnownCommands` in
`tui/app/completions.go`. When you add a new slash command to
`handleSlash` in `update.go`, mirror it there in the same commit.

## Live streaming footer

While `Mode == ModeStreaming`, a 1-row status strip is rendered above
the input box (so the input box itself stays a stable empty placeholder
that doesn't duplicate the spinner):
- `▌ streaming ⣾  312 tok  44.6 t/s  ⏱ 0:07  esc to cancel`

Tokens/tps/elapsed come from `StreamCompletionTokens` /
`StreamStartedAt` / `LastTokenAt` on `App`. The host emits cumulative
`prompt_tokens` / `completion_tokens` in `usage` events — see
`handleStreamChunk` for how the TUI keeps the latest authoritative
value. `tps` is computed on render from `time.Since(StreamStartedAt)`.

Stall hint: if `time.Since(LastTokenAt) > 3s` while still streaming,
the strip adds `⏳ thinking…` in `Warn` colour so the user can tell
the agent is alive but not making token progress (tool call in
flight, GPU stall, etc.).

## Error cards

A host `error` event used to land inline as `\n[error: …]` inside the
assistant turn's text. Now it lands as a bordered `ErrorCard` on the
turn (see `Errors []ErrorCard` in `model.go`). `pushAssistantError`
classifies the message via `inferErrorKind` (timeout / permission /
network / tool / unknown) and pairs it with a context-specific hint
(`Try: shorter prompt`, `Check the sandbox allow-list`, …). The card
is rendered by `renderErrorCard` indented under the turn's tag column.

## Tool-result viewer

`/tools` opens a full-screen overlay (`renderToolViewerOverlay`) that
lists every tool call across the conversation (newest first, capped at
12 visible rows). `↑`/`↓` (or `k`/`j`) navigate; `Enter` toggles an
expanded preview panel showing the tool's full result; `Esc` collapses
the preview first, then closes the overlay on a second press.

The data lives in `ToolViewerState` (`App.ToolViewer`) and is rebuilt
from scratch every time `/tools` fires (`openToolViewer`) — cheap, and
avoids stale-row bugs when tools complete after the overlay was last
open.

Source of truth for which commands open overlays is `handleSlash` in
`update.go`; the autocomplete registry in `KnownCommands` mirrors
the list for the slash popup.

## Resolved (2026-07-07) — local Ollama reasoning now reaches the TUI tag pair

**Decision:** Sidecar-side fix (option 2 above). `OllamaProvider` in
`FeralAgent/src/sandbox/inference-providers.ts` now reads
`message.thinking` and wraps it in `` tags the same
way the cloud path wraps `reasoning_content`. The TUI is unchanged;
its live thinking-splitter picks up the tag pair unchanged.

**Why sidecar-side over host-side:** Ollama's `/api/chat` doesn't
have a `reasoning` field on the OpenAI-style chunk frame the host
emits — reasoning only exists on the Ollama wire. Pushing the change
back to the sidecar (where the Ollama wire is read) keeps the host
unaware of the provider-specific term. Sidecar also stays the single
place every `processLine`-shaped decoder lives.

**Implementation notes:**

- `OllamaProvider.#nonStream` reads `message.thinking` and prepends
  ``...`` so `stripThinking()` strips it from the final
  answer (`agent-loop.ts:1511`).
- `OllamaProvider.#stream` mirrors the cloud path's `inReasoning`
  state — first thinking chunk opens the tag, the first content chunk
  closes it. End-of-stream `closeReasoning()` call covers the
  all-reasoning turn (no answer follows).
- Detection is by API signal (`message.thinking` is present on the
  chunk), not per-model name. The same code path now handles qwen3,
  deepseek-r1, MiniMax-M3 thinking mode, and any future Ollama-native
  reasoning model. Content-only prompts (non-thinking mode on a
  capable model) stream unchanged — no phantom tag is emitted.

**Pinned by `tests/ollama-reasoning.test.ts` (6 tests):**

- non-stream: thinking wraps before the answer; no `thinking` →
  content unchanged
- stream: thinking emits open tag + chunks + close on first content
- stream: end-of-stream close for all-reasoning turns
- stream: thinking + content in the same NDJSON chunk → well-formed
- stream: content-only on a thinking-capable model → unchanged

**No heuristics on the TUI side — confirmed.** `tui/app/update.go`
and the splitters are not modified.

**Discovered while writing the tests:** the markdown pipeline that
generates review specs occasionally encodes these tag pairs as
Unicode glyphs (numbers-in-circles) in helper text. The tests build
the tags from `char` codes so the test file stays ASCII-clean even
when a reviewer asks for the literal text.
