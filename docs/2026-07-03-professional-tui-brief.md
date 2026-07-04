# Brief MiniMax — Professional full-screen TUI for `feral chat`

## Context (read this first, then VERIFY in code before writing anything)

`feral` is a headless local AI runtime. `crates/feral-cli/` (Rust) is the single
user-facing binary; it spawns a TS/Bun sidecar and talks to a local gateway HTTP
API on `127.0.0.1:11435` (bearer-token gated). `feral chat` is the terminal face.

The current chat TUI (`crates/feral-cli/src/chat.rs`) works but is a **linear
REPL** (banner → status line → `›` prompt → streamed reply). It looks amateurish.
We want a **professional, full-screen TUI** — think the polish of OpenCode / gitui
/ atuin. Reference for quality (NOT the library to use): github.com/anomalyco/opentui.

**Architecture decision (FIXED): use `ratatui` + `crossterm` in Rust, inside the
existing `feral-cli` crate.** Do NOT introduce a TS/JS TUI (OpenTUI), a new
process, or a new runtime — that would break the single-binary design. The TUI
stays a thin client over the gateway API.

## VERIFY BEFORE CODING (guardrail — do not trust this brief's field names)

Grep the real code and confirm these contracts. If any differ, follow the code,
not this doc, and note the discrepancy:

1. **SSE chat contract** — read `stream_reply` in `crates/feral-cli/src/chat.rs`
   and `runtime_chat` in `crates/feral-core/src/api.rs`. Current understanding:
   - `POST /runtime/chat`, bearer auth, JSON body `{ "content": <str>, "session_id": <str> }`.
   - Response is SSE. Frames: `data: {"choices":[{"delta":{"content":"<tok>"}}]}`,
     an error frame `data: {"error":"<msg>"}`, and terminator `data: [DONE]`.
2. **Status contract** — read `fetch_status` in chat.rs + `runtime_status` in api.rs:
   - `GET /runtime/status` → fields used today: `agent_model`, `model.name`,
     `lora`, `backend`, `sidecar_alive`.
3. **Helpers** — `crates/feral-cli/src/common.rs`: `base_url()`, `read_token()`,
   `api_port()`, `port_in_use()`, and `palette()` (brand colors). REUSE these.
4. **Palette / brand** — confirm the exact hex in `common.rs::palette()`. Known:
   accent ~`#EC8C4C` (soft orange), text ~`#E4DDD2`, meta ~`#6E6A63`, ok ~`#8FB77A`,
   near-black background. The brand is warm-black + soft orange. KEEP IT.
5. **Auto-start / lifecycle** — `chat::run()` already auto-starts the gateway if
   down (see the pre-flight in `run()`), then enters the chat. Preserve that exact
   behavior; only the *rendering* changes.

## Two problems to fix

### 1. It's not full-screen / not professional
Rebuild the chat as a proper full-screen alternate-screen TUI:
- **Layout** (ratatui): a top **header bar** (wordmark `◉ FERAL` + model · lora ·
  backend · online dot from `/runtime/status`), a **scrollable message history**
  region (fills the middle; user turns and assistant turns visually distinct), a
  **multi-line input box** at the bottom, and a thin **footer/help line**
  (`/help · /clear · /model · /exit` etc.).
- **Streaming**: assistant reply streams token-by-token into the history region
  (append to the in-progress message, redraw). No flicker.
- **Scrollback**: PgUp/PgDn / mouse wheel scroll the history; auto-stick to bottom
  while streaming unless the user scrolled up.
- **Resize**: handle terminal resize (ratatui/crossterm resize events) — reflow,
  never corrupt.
- **Input**: multi-line input, Enter to send, Shift+Enter (or Ctrl+J) newline,
  Ctrl+C / Esc to quit gracefully (leave alternate screen, restore terminal).
- **Slash commands** rendered inline: `/help`, `/clear`, `/model`, `/exit`
  (at minimum). `/model` shows the active model from status.

### 2. Reasoning leaks raw (BIG — this is half of why it "looks terrible")
MiniMax-M3 is a reasoning model. Its chain-of-thought printed **before** the
answer (e.g. "The user wrote in Romanian... According to my personalization...")
because `ThinkRenderer` only handles `<think>…</think>` tags, and MiniMax's
reasoning arrives **without** those tags.

- FIRST investigate HOW reasoning arrives on `/runtime/chat`: does the SSE delta
  carry a separate `reasoning_content` (OpenAI reasoning field) distinct from
  `content`, or is reasoning concatenated inline into `content`? Check api.rs
  (`runtime_chat`) and the sidecar's inference path
  (`FeralAgent/src/sandbox/inference-router.ts`, providers).
- If reasoning is a **separate field**: render it in a dim, collapsible
  "thinking" area (collapsed by default, a subtle `▸ thinking…` line that expands
  on a keypress), and render only the answer in full color. Keep the existing
  `<think>`-tag handling too (some models use tags).
- If reasoning is **inline in `content` with no marker**: it CANNOT be separated
  cleanly in the TUI — flag this back as a **sidecar fix** (the sidecar should
  surface `reasoning_content` separately over the SSE). Do NOT hack heuristics
  that guess where reasoning ends. Report the finding; a small sidecar change +
  SSE field is the right fix, and it can be a follow-up.

## Constraints

- Stay inside `crates/feral-cli/`. Add `ratatui` + `crossterm` to
  `crates/feral-cli/Cargo.toml` (crossterm is likely already transitively present;
  check). Keep the reqwest SSE client and the `SseBuffer` parsing you can reuse
  from chat.rs.
- Do NOT change the gateway API, the auto-start/stop flow, `common.rs`, or the
  palette hexes. This is a rendering rewrite of `chat.rs` only (+ maybe a small
  new module like `chat_ui.rs` for widgets — keep files focused).
- The async SSE stream + the crossterm event loop must coexist: run the input/
  render loop on the main thread and the network stream on tokio, communicating
  over an mpsc channel (stream → UI: reasoning/answer tokens, done, error; UI →
  app: user submitted a turn). Don't block the render loop on the network.
- Graceful teardown: ALWAYS restore the terminal (leave alternate screen, disable
  raw mode) on exit AND on panic (install a panic hook or use a guard) — a
  half-restored terminal is the worst failure mode.

## Deliverables

1. Full-screen ratatui chat in `crates/feral-cli/` (rewrite `chat.rs`, optionally
   split widgets into a sibling module).
2. Reasoning separated from answer (or a clear written finding that it needs a
   sidecar SSE change, with the exact spot identified).
3. `cargo build -p feral-cli` clean; `cargo test -p feral-cli` green (keep the
   `cli_tree_is_valid` test passing; add a small unit test for any pure helper —
   e.g. history reflow / reasoning split — but NO TUI-snapshot framework).
4. Short note on how you verified it renders (you can't screenshot a TTY easily;
   describe the manual run: `feral chat`, send a message, resize, scroll, /exit).

## Do NOT

- Do not add OpenTUI / a TS TUI / a second binary / a new runtime.
- Do not change the brand palette or invent new colors beyond dim/emphasis of the
  existing ones.
- Do not touch `find_binary`, the gateway boot, or the SP0 launcher/packaging.
- Do not guess-parse reasoning out of inline content with heuristics — if it's
  inline, report it as a sidecar fix.

## Split (per our delegation model)

MiniMax: the ratatui rendering + event loop + reasoning-rendering (the pure UI
leaf). Opus: keeps the architecture/integration, the sidecar-side reasoning fix if
needed, review + merge. Ping Opus if the SSE reasoning contract is ambiguous —
that's an integration call, not a UI one.
