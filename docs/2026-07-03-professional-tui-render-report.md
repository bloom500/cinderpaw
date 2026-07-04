# `feral chat` full-screen TUI — render report

**Date:** 2026-07-03
**Scope:** Faza 4.5 Slice 2 follow-up (per `docs/2026-07-03-professional-tui-brief.md`).
**Branch / worktree:** `D:\FeralLocalAI` (no separate worktree — UI-only slice).

## What landed

`crates/feral-cli/src/chat.rs` is rewritten as a full-screen ratatui
TUI. `crates/feral-cli/src/chat_ui.rs` is a new sibling module that
owns widgets, the `App` model, and the pure helpers (`reflow`,
`TagSplitter`, `SseBuffer`, `extract_chunk`, slash-command
dispatch). The previous REPL's `ThinkRenderer` / `SseBuffer` /
`fetch_status` contracts were re-used / re-routed — the actual HTTP
and SSE parsing logic is identical, only the rendering layer is new.

New deps (in `crates/feral-cli/Cargo.toml`):

```toml
ratatui = { version = "0.29", default-features = false, features = ["crossterm"] }
crossterm = "0.28"
unicode-width = "0.2"
```

All three are pure additions; nothing in `common.rs`, the auto-start
flow, `find_binary`, or the SP0 launcher is touched.

### Layout

```
┌────────────────────────────────────────────────────────────┐  1 line: header
│ ◉ FERAL  model … lora … backend …                ● online  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  (scrollable history — user + assistant turns,             │
│   reasoning shown as a dim ▸ thinking… line that expands   │
│   on `t`, or full dim block if already expanded)           │
│                                                            │
├────────────────────────────────────────────────────────────┤  3 lines: input
│  › hello world                                            │
│                                                            │
├────────────────────────────────────────────────────────────┤  1 line: footer
│ /help · /clear · /model · /exit · PgUp/PgDn scroll · t…    │
└────────────────────────────────────────────────────────────┘
```

### Streaming architecture

- The async SSE pump runs on the tokio worker pool (it was already
  there in the REPL). The pump forwards tokens over an mpsc channel
  (`tokio::sync::mpsc`, 256-buffered, `StreamEvent` items: `Reasoning`,
  `Answer`, `Usage`, `Done`, `Error`).
- The main thread runs the render loop: draw → drain channel (non-blocking)
  → poll crossterm (33 ms timeout) → repeat. The render loop NEVER
  blocks on the network.
- The user can only submit one turn at a time (`Mode::Streaming`).
  While streaming, the input box shows "… streaming (Ctrl+C to cancel)"
  and the only accepted keys are `t` (toggle thinking), PgUp/PgDn.
  Ctrl+C / Esc cancel the in-flight pump and quit.

### Teardown

- A `TerminalGuard` RAII type wraps an `Arc<Mutex<Terminal<…>>>`. Its
  `Drop` body disables mouse capture, disables raw mode, leaves the
  alternate screen, and shows the cursor.
- A `std::panic::set_hook` also calls teardown (then prints the panic
  message and delegates to the previous hook). The combination means
  every exit path — normal return, early `break`, panic — restores the
  terminal. This was the worst failure mode of the previous REPL.

### Resize / mouse / keys

- `Event::Resize` is consumed but does nothing; ratatui reflows on the
  next draw.
- Mouse capture is on: `MouseEventKind::ScrollUp` / `ScrollDown` scroll
  the history by 3 rows.
- Keys: `Enter` submit, `Shift+Enter` / `Ctrl+J` newline, `Backspace`
  / `Delete` / arrows / `Home` / `End` for the input cursor, `t` to
  toggle the thinking pane on the latest turn, PgUp / PgDn / mouse
  wheel to scroll the history. `Ctrl+C` / `Esc` quit.

## Reasoning handling — investigation

The brief asked: does reasoning arrive on `/runtime/chat` as a separate
field (`reasoning_content`) or inline in `content`?

### What I found in the code (this branch, today)

1. **The sidecar already wraps cloud-side `reasoning_content` in
   `<think>…</think>` tags** before emitting chunks.
   `FeralAgent/src/sandbox/inference-providers.ts:374-378` (non-stream
   path) and `:454-498` (stream path) take whatever the upstream
   OpenAI-compat server returns in `delta.reasoning_content` and feed
   it through `emitPiece` with `<think>` / `</think>` wrapping.

2. **The sidecar's local Ollama path does NOT do this.**
   `FeralAgent/src/sandbox/inference-providers.ts:220` (the local
   `processLine`) only reads `message.content`:
   ```ts
   const token = (chunk as { message?: { content?: string } }).message?.content ?? "";
   ```
   It does not look at any reasoning field. For a local model like
   MiniMax-M3 that emits reasoning inline in `content` (no `<think>`
   tags), this reasoning lands verbatim in the visible text on the wire.

3. **The host's `/runtime/chat` SSE builder only exposes
   `delta.content`.** `crates/feral-core/src/api.rs:668-672`
   (`sse_from_agent_reply`) constructs the chunk frame as:
   ```rust
   "choices": [{ "index": 0, "delta": { "content": content } }],
   ```
   Even if the sidecar emitted a separate `reasoning` field in the
   `feral://agent-output` bus, the host strips it on the way out.

### What the TUI does today

- It already reads a `reasoning_content` SSE field if the host ever
  starts forwarding one (`extract_chunk` → `ChunkFields::reasoning`).
  That fragment is routed to `StreamEvent::Reasoning` and lands in a
  dim, collapsible "thinking" pane per turn. `t` toggles.
- It still applies a `<think>…</think>` tag splitter on
  `delta.content` (the cloud sidecar's behavior). This is the same
  approach the previous REPL used — and it correctly handles models
  that emit reasoning inside tags, whether local or cloud.

### What still leaks — and the sidecar fix

For a **local Ollama model that emits reasoning inline in `content`
without `<think>` markers** (the case the brief flagged for
MiniMax-M3), the TUI has no way to split reasoning from answer. The
content lands in the answer pane as-is. The brief is explicit: "Do
NOT guess-parse reasoning out of inline content with heuristics."

Two clean follow-ups, ordered by size:

1. **(host-side, ~5 lines)** `crates/feral-core/src/api.rs` should
   forward any `reasoning` field from the sidecar's `feral://agent-output`
   `chunk` events as `delta.reasoning_content` in the OpenAI-style
   chunk frame. The TUI is already wired to read that field and route
   it to the thinking pane. This is the right fix IF the sidecar
   starts separating reasoning on its own.

2. **(sidecar-side, ~15 lines)** `FeralAgent/src/sandbox/inference-providers.ts`
   should handle the local Ollama reasoning case symmetrically with
   the cloud case. Two options:
   - **(a) wrap heuristically** — when the local model is known to
     emit reasoning in a recognizable shape (e.g. a `[THINK]…[/THINK]`
     band, or a `model.architecture == "qwen3"` hint), wrap it in
     `<think>…</think>` before the `onToken` callback. This is
     "tame heuristics" — only opt-in per model, and only on shapes
     the model docs explicitly define.
   - **(b) expose `reasoning_content` on the bus** — emit the
     reasoning fragment as a separate `chunk` field (or a new
     `reasoning_chunk` event) so the host can forward it. Requires
     the sidecar to know which tokens are reasoning, which again is
     per-model (qwen3, deepseek-r1, etc. have their own markers).

   Either way, the TUI needs no change — it already handles the
   `delta.reasoning_content` path and the `<think>`-tag path.

This is an integration decision (per the brief: "Ping-uiește Opus
dacă contractul de reasoning e ambiguu — e decizie de integrare.").
I'm leaving it for Opus to weigh in on which sidecar path to take.

## How I verified it renders

I can't screenshot a TTY here. The verification path I used:

1. `cargo build -p feral-cli` clean (only the pre-existing
   `max_contexts` dead-code warning in `feral-core`; nothing new in
   `chat.rs` or `chat_ui.rs`).
2. `cargo test -p feral-cli` → 15/15 passing:
   - `cli_tree_is_valid` (the pre-existing clap regression guard).
   - 11 new unit tests in `chat_ui::tests` for `reflow`, `TagSplitter`,
     `SseBuffer`, `extract_chunk`, and the `App` slash-command /
     submit / cursor model.
3. Binary smoke-test: `target/debug/feral-cli.exe --help` and
   `… chat --help` produce the expected help text. I did NOT
   exercise the live TUI end-to-end because (a) this dev box has no
   live gateway / model loaded, and (b) headless TUI runs need a
   pty, which I don't have here.

## Manual run to actually see the TUI

The next agent / Opus should run:

```powershell
# from D:\FeralLocalAI
$env:FERAL_NO_COLOR = "0"  # keep the brand palette
cargo run -p feral-cli -- chat
```

Then:
- Type a message, press Enter → expect the response to stream in the
  "◆ feral …" turn, tokens appending live, no flicker.
- Press Shift+Enter or Ctrl+J → newline, no submit.
- PageUp / PageDown / mouse wheel → history scrolls; auto-stick
  resumes on scroll-to-bottom.
- Type `t` after the first response → expands the dim thinking pane
  (or, if the model emits no reasoning, no-op).
- Type `/model` → footer flashes the model / lora / backend / online
  line for ~5 seconds.
- Type `/clear` → history empties, footer flashes "cleared".
- Type `/help` → opens the help overlay; press `/help` again to close.
- Type `/exit` (or Ctrl+C / Esc) → alt-screen exits, terminal is
  restored, "stay feral. ↝" is printed to stderr.
- Resize the window mid-stream → history reflows; new layout on the
  next token.
- From another terminal: `kill -9 <pid>` of the sidecar mid-stream →
  pump returns the `Error` path, footer flashes the error, input
  unlocks.
