# Feral TUI Specification v1.0

**Status:** SPEC ONLY — see §23 "Do NOT implement yet".
**Scope:** the terminal face of Feral — `feral chat` / `feral-tui` — a thin client over the local gateway HTTP API (`127.0.0.1:11435`, bearer-token gated).
**Substrate (fixed):** Go + Bubble Tea + Lip Gloss + Glamour, in `tui/`. The Rust `chat.rs` REPL is the legacy fallback; this spec describes the Bubble Tea client. The TUI never talks to models directly — everything goes through `/runtime/*` and `/events`.
**Audience:** any implementing model (Sonnet, Opus, MiniMax, GPT). Build to this contract, not to your own interpretation. Where this spec conflicts with the code, follow the code and file a discrepancy note.

---

## 0. Philosophy

**Feral's TUI is a conversation, not a dashboard.** The reference class is Claude Code and Warp: a quiet, flat, text-first surface where the only thing that visually dominates is the dialogue itself.

Principles, each with its WHY:

1. **Conversation-first.** The transcript owns ≥90% of vertical space at all times. *Why:* the user's mental model is "I'm talking to my agent," not "I'm operating a control panel." Every pixel spent on chrome is attention taken from the reply being read.
2. **No visual noise.** No borders around messages, no filled background bars, no per-tool emoji, no ASCII logos in the steady state. *Why:* boxes and bars create edges the eye must parse; in a stream of text, edges are cognitive taxes paid on every frame. (Already enforced: the 2026-07-04 flatten pass deleted all borders/backgrounds.)
3. **No decorative UI.** Every glyph on screen must carry state or meaning. The `⏺` tool mark carries status via color; the `›` prompt carries "you type here"; the header dot carries liveness. Nothing exists "to look nice." *Why:* decoration ages into clutter and breaks in ASCII/NO_COLOR modes; meaning survives both.
4. **Minimal cognitive load.** One idea per line. State is communicated by *position* (header = ambient, footer = transient, transcript = history) and *color temperature* (orange = active, dim gray = settled, red = broken) before it is communicated by words. *Why:* users scan, they don't read chrome.
5. **The agent feels alive without being flashy.** Aliveness comes from *latency honesty* — a breathing spinner within 100 ms of any wait, streaming tokens the moment they exist, runtime events surfacing as one dim line — never from animation for its own sake. *Why:* perceived responsiveness is the product; animation that doesn't encode progress is noise (the bouncing mascot was deleted for exactly this reason).
6. **Silence is the default.** Background activity (dreams, indexing, genome ticks) renders as at most one dim, ephemeral line — or nothing. *Why:* Feral is self-improving in the background by design; if the background shouts, the foreground conversation dies.
7. **Everything degrades.** Color → NO_COLOR, Unicode → ASCII, 120 cols → 60 cols, mouse → keyboard. No feature exists only in the rich path. *Why:* Feral targets non-technical users on whatever terminal they happen to have (target-audience decision: non-tech is primary).

**Anti-goals:** panes/splits (tmux is not the model), status dashboards, charts, mouse-first interaction, themes/skins beyond the brand palette.

---

## 1. Information Architecture

### Screen hierarchy (top → bottom priority)

| Zone | Content | Visibility |
|---|---|---|
| Transcript | user turns, assistant turns, tool lines, inline event lines | always; owns all leftover height |
| Input row | `›` prompt + textarea (grows to 6 lines max) | always |
| Header (1 line) | `feral · model · lora · backend · ● state` | always, exactly one line, never wraps |
| Footer (1 line) | contextual hint OR flash message OR progress | always, exactly one line |
| Overlays | help, history, tool viewer, model picker, completions, wizard | contextual, modal, dismiss with Esc |

### Visual priorities
1. The assistant's current reply (streaming text).
2. The user's input row.
3. Error lines (red, but flat — never a box).
4. Everything else is dim (`Meta` gray).

### Always visible
- Header (identity + liveness). One line, ever. **Acceptance: header never exceeds one line at any width ≥ 40 cols** (truncate segments right-to-left: backend → lora → model, keep `feral` + state dot last).
- Input row with `›`.
- Footer hint line.

### Contextual (appears only when relevant)
- Completions popup: only while input starts with `/`.
- Thinking line (`▸ thinking…`): only while reasoning tokens arrive and `/reasoning off` (default collapsed).
- Tool result previews: only after a tool ran.
- Runtime event lines: only when an event fires.
- Overlays: only on explicit request (F1, `/tools`, `/model`, `/sessions`).

### Disappears automatically
- Flash messages: after 5 s (already implemented via spinner-tick expiry).
- Completions popup: on Esc, on send, or when prefix matches nothing.
- Spinner rows: replaced in place by the first streamed token.
- Progress indicators: replaced by their terminal state line (`✓ downloaded qwen3.5-7b · 4.1 GB`).

### Information density rules
- Max 3 metadata items per line; overflow is dropped, not wrapped.
- Tool lines: 1 line for the call + at most 3 indented `⎿` result lines; longer output lives behind `/tools` (tool viewer overlay).
- Reasoning: collapsed to one dim line by default; expanded view is dim/italic, never full-color.
- Timestamps: never shown inline (they're noise); available in `/sessions` and `/tools` overlays.

---

## 2. Complete User Journey

Every numbered state below is a screen or transition the implementation must produce. Format: **State — what's on screen — how it exits.**

### J1. Install
`npm install -g feral` (npm wrapper shipping platform binaries) or direct binary download. No TUI yet; install output is npm's own. *Constraint:* postinstall prints exactly one line: `run: feral` — nothing else, no banner.

### J2. First launch (`feral` / `feral chat`, no config on disk)
1. **Boot flash** (<200 ms budget): blank alternate screen, header renders immediately with `feral · — · — · — · ○ starting`.
2. Gateway not running → auto-start (existing `chat::run()` preflight behavior is preserved). Footer shows `starting runtime…` with spinner.
3. No config detected → **Setup Wizard** (see §13) opens as a full-transcript-area flow (not a separate binary, not a modal box — flat wizard screens in the transcript zone).
4. Wizard completes → **Welcome screen** (J4).

### J3. Subsequent launch
1. Header up immediately with cached last-known status (dim), then live status replaces it after the first `/runtime/status` poll succeeds.
2. Gateway already up → straight to Welcome in <500 ms. Gateway down → auto-start with footer spinner, transcript stays empty (no wall of boot logs — logs live in `feral logs`).

### J4. Welcome screen (empty session)
Flat, centered block in the transcript zone (already implemented shape):
```
✻ feral chat

model    qwen3.5-7b
backend  local · vulkan
lora     personal-v3

recent
  yesterday · "fix the deploy script" · 24 turns
  jul 2     · "trip planning"          · 8 turns

/ for commands · F1 for shortcuts
```
Exits when the first message is submitted (block scrolls away, never reappears in-session).

### J5. Provider selection / model download (wizard or `/model`)
See §13. Download renders as a single footer progress line (`↓ qwen3.5-7b  38% · 1.6/4.1 GB · 12 MB/s`), transcript remains usable if a cloud fallback is configured, otherwise input is disabled with placeholder `downloading model — chat unlocks when ready`.

### J6. First message
1. User types; completions popup if it starts with `/`.
2. Enter → user turn appears in transcript (indented, plain text, `›` gutter mark dim).
3. Footer → `thinking…` + spinner within 100 ms.
4. If reasoning arrives: one dim `▸ thinking…` line in the transcript (see §9).
5. First answer token replaces the spinner; streaming per §7.
6. Stream ends → footer reverts to hint line; input refocused.

### J7. Long conversations
- Transcript virtualizes: only visible lines + margin are rendered per frame (see §19).
- Scrollback per §7 (FollowBottom semantics, already implemented).
- At ~80% of the model's context window, one dim inline line: `◦ context 80% full — /compact to summarize, /new for a fresh session`. Never a modal, never blocks.

### J8. Connector usage (Discord/Telegram/WhatsApp message arrives mid-session)
One dim inline event line (§11), e.g. `◦ telegram · reply sent to @dan (persona: sales)`. Chat is never interrupted; no focus steal.

### J9. Shutdown
- `Ctrl+C` on empty input / `Ctrl+D` on empty input / `/exit`: leave alternate screen, restore terminal, print one plain goodbye line to the normal screen: `session saved · resume with: feral chat`. Gateway keeps running (headless by design) unless launched with `--ephemeral`.
- `Ctrl+C` with text in input: clears input (first press), quits (second press within 1 s) — mirroring Claude Code.
- Panic/crash: panic hook restores the terminal *always*. A half-restored terminal is the worst possible failure mode. **Acceptance: kill -SEGV the process → next shell prompt is not raw-mode corrupted.**

Every transition above must be reachable and none may leave the terminal in raw mode.

---

## 3. State Machine

One top-level FSM drives what the footer + input show. States are exhaustive; the UI must not invent intermediate visuals outside these.

```
Boot → Initializing → {SetupWizard} → Ready
Ready → Thinking → Streaming → {ToolRunning ⇄ Streaming} → Ready
any → Error → Recovery → Ready
Ready → Idle (no keypress 60 s) → Ready (any key)
any → Shutdown
```

| State | Footer shows | Input | Entered by | Exits to |
|---|---|---|---|---|
| **Boot** | `starting…` | disabled | process start | Initializing |
| **Initializing** | spinner + `connecting to runtime` | disabled | boot done | LoadingRuntime / Ready |
| **LoadingRuntime** | spinner + `starting runtime…` | disabled | gateway down | DetectingHardware / Ready |
| **DetectingHardware** | `detecting hardware…` | disabled | first-run only | DownloadingModel / SetupWizard |
| **DownloadingModel** | progress line (`↓ name  % · GB · MB/s`) | disabled or cloud-fallback enabled | wizard / `/model` | LoadingModel |
| **LoadingModel** | spinner + `loading qwen3.5-7b…` | disabled | download done / model switch | LoadingMemory |
| **LoadingMemory** | spinner + `loading memory…` | disabled | model loaded | Ready |
| **Ready** | hint line (`F1 for shortcuts · Ctrl+C to exit`) | enabled, focused | any completed work | Thinking / Idle / Shutdown |
| **Thinking** | spinner + `thinking…` (+ elapsed after 3 s: `thinking · 4 s`) | enabled (queue next msg) | message sent | Streaming / Error |
| **Streaming** | `esc to interrupt` | enabled (Esc = cancel) | first token | ToolRunning / Ready |
| **ToolRunning** | spinner + `running <tool>…` | enabled (Esc = cancel) | tool_call frame | Streaming / Error |
| **Waiting** | `waiting for approval — y/n` | y/n only | tool needs confirm | ToolRunning / Streaming |
| **Idle** | hint line, dimmer; status poll drops to 30 s | enabled | 60 s no input | Ready |
| **Error** | red one-liner + hint (`r to retry`) | enabled | any failure | Recovery / Ready |
| **Recovery** | spinner + `reconnecting… (attempt 2)` | enabled | auto after Error | Ready / Error |
| **Shutdown** | — | — | Ctrl+C/Ctrl+D//exit | process exit |

Rules:
- State is a single enum in the app model; renderers switch on it. No boolean soup.
- Transitions are driven by SSE frames, HTTP results, and key events only.
- Error never dead-ends: every Error state names its recovery action in the footer (§14).
- **Acceptance: at no point do two states' footers render simultaneously.**

---

## 4. Layout

Exact layout at any terminal size (`W×H`), top to bottom:

```
row 1        : header (1 line, exactly)
rows 2..H-i-2: transcript viewport (all leftover height)
row H-i-1    : separator — one blank line (NOT a rule/border)
rows H-i..H-1: input (i = 1..6 lines, grows with content)
row H        : footer (1 line, exactly)
```

- **Header:** ` feral  model <name>  lora <name>  backend <name>` left; `● online` right; single space padding; plain text on the terminal's own background. No fill, no border.
- **Transcript:** flat lines. User turns: 2-space indent, dim `›` gutter. Assistant turns: 2-space indent, no gutter mark, full `Text` color, Glamour-rendered markdown. Tool lines per §8. Event lines per §11. One blank line between turns; no blank line between a tool call and its `⎿` results.
- **Input:** `› ` prompt glyph (accent) + textarea. Grows 1→6 lines; beyond 6 it scrolls internally. While streaming: placeholder `…  (esc to interrupt)`.
- **Footer:** one line, `Meta` gray. Priority when contending: error > progress > flash > state text > hint. Exactly one wins.
- **Status line:** the footer *is* the status line. There is no second status bar.
- **Notifications:** inline dim event lines in the transcript (§11/§15) — never toasts, never corner popups (there are no corners to own in a terminal).
- **Progress indicators:** footer-only for global work (download, reload); inline `⏺`-line for per-tool work.
- **Overlays:** centered `lipgloss.Place` blocks, flat (no borders — already enforced), max width `min(W-8, 100)`, max height `H-6`, scroll internally. Backdrop is the dimmed transcript (no fill).

Ambiguity budget: zero. Any screen not derivable from this table is out of spec.

---

## 5. Rendering Rules

- **Spacing:** 1 blank line between turns; 0 between a call and its results; 1 above and below the welcome block; footer/header never have blank padding rows.
- **Indentation:** transcript content indents 2 spaces. Tool result lines indent 2 further (`  ⎿ …` under `⏺ …`). Continuation lines of a wrapped message align to the content column (2), not column 0. Pinned by test (`view_render_test.go` indentation test exists — extend, don't regress).
- **Margins:** 1-space left/right margin on header and footer; transcript wraps at `W-4`.
- **ANSI colors:** brand palette only (from `tui/ui/styles.go`, mirrors `common.rs::palette()`):
  - `Accent` #EC8C4C (soft orange) — active/attention: prompt glyph, running tool mark, brand word.
  - `Text` #E4DDD2 (warm off-white) — assistant text.
  - `Meta` #6E6A63 (warm gray) — everything settled: hints, tool results, event lines, user turns.
  - `Ok` #8FB77A — success glyphs only.
  - `Fail` (existing red) — errors only.
  - `Warn` (existing yellow) — degraded-but-working only.
  - Background: terminal's own. Never paint one.
  - Dim/bold variants of these are allowed; new hues are not.
- **Unicode set (entire allowed inventory):** `› ⏺ ⎿ ▸ ▾ ● ○ ◦ ✻ ✓ ✗ ↓ ↑ …` + spinner frames (braille `⠋⠙⠹…`). Nothing else. Every glyph maps to an ASCII fallback:
  `› → >` · `⏺ → *` · `⎿ → \`-` · `▸/▾ → +/-` · `●/○ → o/.` · `◦ → -` · `✻ → *` · `✓/✗ → ok/x` · `↓/↑ → v/^` · `… → ...` · spinner → `|/-\`.
- **ASCII mode** activates on `FERAL_ASCII=1`, `TERM=dumb`, or detected non-UTF-8 locale. One code path: glyphs come from a `glyphs` table with two columns, not scattered literals.

---

## 6. Typography

| Element | Treatment |
|---|---|
| Headers (overlay titles) | lowercase, `Accent`, no box: `help`, `sessions` |
| Prompt | `› ` accent, bold off |
| User turns | `Meta` gray (settled history), plain — the user knows what they said |
| Assistant replies | `Text` color, Glamour markdown (see below) |
| Tool calls | `⏺ name(arg)` — mark colored by status, name bold `Text`, args `Meta` |
| Tool results | `⎿ …` all `Meta` |
| System messages / events | `◦ …` all `Meta`, one line |
| Warnings | `Warn` colored glyph + `Meta` text: `◦ context 80% full…` |
| Errors | `⏺ error · kind` in `Fail` bold, message plain `Fail`, hint `Meta` (flat card, already implemented) |
| Reasoning | `Meta` + italic, always — reasoning is never full-color |
| Markdown in replies | Glamour with brand-mapped theme: code blocks get 2-space indent + `Meta`-dim syntax accents, **no background fill**, headings = bold `Text` (not colored), links underlined `Accent`, tables pass through with `overflow` guard (wrap cells, never overflow W) |

Rule of thumb: at a squint, the screen is gray with one orange focal point (wherever work is happening) and white where the answer is.

---

## 7. Streaming

- **Token streaming:** append tokens to the in-progress assistant message; re-render only the tail region (viewport diffing — Bubble Tea `SetContent` with `PrevContent` guard, already in place). Batch: render at most once per 33 ms (30 fps cap) regardless of token rate; tokens buffer between frames.
- **Cursor:** a `▍` block glyph trails the last streamed character (accent, blinking off — blink is noise). Removed on stream end.
- **Scrolling / auto-scroll:** `FollowBottom` semantics (implemented, keep):
  - Following (default): new tokens keep the view pinned to bottom.
  - User scrolls up (PgUp / wheel): following disengages instantly; stream continues off-screen.
  - User returns to bottom: following re-engages.
  - New user message / clear / new: following force-re-engages.
  - **Acceptance: streaming never moves the viewport while the user is scrolled up.** (Regression-tested — keep the test.)
- **Manual scroll:** PgUp/PgDn = page, mouse wheel = 3 lines, Ctrl+Home/End = top/bottom. Overlays capture scroll; the transcript never scrolls behind a modal (implemented — keep).
- **Cancellation:** Esc during Thinking/Streaming/ToolRunning aborts the HTTP stream, keeps partial output, and appends one dim line: `◦ interrupted`. Partial text stays in history (it's real context).
- **Interruptions (network drop mid-stream):** partial output kept, `⏺ error · connection lost` flat card appended, state → Error → Recovery (auto-retry does NOT auto-resend the message; the user's input is restored into the textarea for one-keypress resend).
- **Reasoning stream:** if the SSE carries `reasoning_content` deltas, they feed the thinking line (§9), not the answer body. Inline unmarked reasoning is a *sidecar* bug, never TUI heuristics (standing decision from the 2026-07-03 brief).

---

## 8. Tool UX

Universal shape — every tool, no exceptions, no per-tool renderers:

```
⏺ memory_search("deploy script")            ⏱ 0.4s ✓
  ⎿ 3 results · top: project_deploy (0.91)
```

- Mark color: `Accent` running → `Meta` done → `Fail` error. The eye reads state from color before text.
- One call line + ≤3 `⎿` lines (first lines of output, truncated at width). Full output: `/tools` overlay (scrollable viewer, exists).
- Long-running tools (>2 s): elapsed ticks live on the call line.
- Parallel tool calls stack as consecutive `⏺` lines; results attach under their own call.

Per-domain flavoring is in the *argument text only*, never in new glyphs or colors:

| Tool family | Call line reads | Result line reads |
|---|---|---|
| memory search | `⏺ memory_search("…")` | `⎿ 3 results · top: <name> (score)` |
| filesystem | `⏺ read_file(src/api.rs)` | `⎿ 212 lines` |
| browser | `⏺ browse(github.com/…)` | `⎿ page loaded · 42 KB text` |
| discord/telegram/whatsapp | `⏺ telegram_send(@dan)` | `⎿ sent` |
| MCP tools | `⏺ mcp:linear.create_issue(…)` | `⎿ FER-142 created` |
| dreams | `⏺ dream_cycle()` | `⎿ 2 insights → memory` |
| LoRA | `⏺ lora_train(532 pairs)` | `⎿ eval Δ +4.2% · pending approval` |
| genomes / meta | `⏺ genome_tick(L4)` | `⎿ fitness 0.83 → 0.85 · ratchet` |

**Noise ceiling:** a turn with 10 tool calls occupies ≤ 20 transcript lines. If a tool would exceed its 3-line budget, the 3rd line becomes `⎿ … (+412 lines · /tools)`.

**Confirmation-gated tools** (shell, destructive ops): the call line renders, then a `Waiting` footer (`run shell_exec? y/n`); `n` renders `⎿ declined` in `Meta`. Never a modal dialog.

---

## 9. Thinking UX

- **Reasoning is hidden by default.** While reasoning tokens arrive, exactly one line shows in the transcript at the answer's position:
  `▸ thinking…` (dim, with braille spinner replacing `▸` while active; elapsed appended after 3 s: `▸ thinking · 7 s`).
- **Expand:** `Ctrl+R` or `/reasoning on` flips to expanded mode (session-sticky): reasoning streams live as dim italic text under a `▾ thinking` header, then the answer follows in full color. Collapse again with the same key — collapsed reasoning is retained and re-expandable per turn via the `/tools` viewer.
- **Progress feedback / latency hiding:** the user must never stare at a frozen screen:
  - 0–100 ms: nothing (avoid flicker).
  - 100 ms+: footer spinner + `thinking…`.
  - 3 s+: elapsed counter appears.
  - 15 s+ with zero tokens: footer appends `· still working (esc to interrupt)`.
- **Idle behavior:** in Idle state the spinner never runs; status polling drops to 30 s; no animation of any kind on an idle screen. *Why:* an idle TUI burning CPU on animation is the opposite of "quiet."

---

## 10. Brain Stack Integration

The Brain (Faza 4.6 capability router) makes routing decisions; the TUI's job is to make them *legible without being loud*. All Brain surfacing is `Meta`-dim and inline.

| Brain event | Rendering |
|---|---|
| Routing decision (per message) | nothing by default — routing is ambient. Header model segment always reflects the *actually used* model for the last turn. |
| Provider/model switch mid-session | one dim line before the reply: `◦ routed to minimax-m3 (long-context task)` |
| Fallback (primary failed) | `◦ local model unavailable → minimax-m3 (fallback)` in `Warn` glyph + `Meta` text |
| Local ⇄ cloud transition | the header backend segment changes (`local · vulkan` ⇄ `cloud · minimax`) + one dim line at the switch |
| Confidence | never a number in the transcript. Low classifier confidence routes conservatively; only surfaced in `/status` detail (`routing: capability=code · confidence low → default model`) |
| Retry (circuit breaker) | `◦ retrying via <provider> (attempt 2)` — one line per retry, max 3, then Error |

`/providers` lists providers with health dots (`● ok · ○ cooling down (429) · ✗ unreachable`). **Acceptance: a provider switch is reflected in the header in <100 ms of the SSE event that announces it.**

---

## 11. Runtime Events

Source: `GET /events` SSE (exists). All runtime events share one shape — the `◦` line — inserted at the bottom of the transcript *between* turns (never splitting a streaming reply; events arriving mid-stream queue and flush when the stream ends).

| Event | Line |
|---|---|
| Dream started | `◦ dreaming…` (only if it will show a result; otherwise silent) |
| Dream finished | `◦ dream: 2 insights added to memory` |
| Memory indexing | silent under 5 s; else `◦ indexing memory… done (12 s)` collapsed into one line on completion |
| LoRA training progress | footer progress line while foreground-relevant; on completion: `◦ lora: eval +4.2% — approve in /lora` |
| Genome evolution (L1–L4) | `◦ genome: <layer> fitness 0.83 → 0.85 (ratchet kept)` |
| Meta evolution (L6 epoch) | `◦ meta: epoch 7 — mutation budget tightened` |
| Connector events | `◦ telegram: reply sent to @dan` / `◦ discord: reconnected` |

Rules:
- Max 1 event line per event; bursts coalesce (`◦ 3 connector events · /status for detail`).
- Events never steal focus, never scroll a user pinned in scrollback (FollowBottom applies to them too), never beep.
- A user who never reads a `◦` line loses nothing functionally — they are receipts, not prompts.

---

## 12. Slash Commands

Registry-driven: `KnownCommands` in `tui/app/completions.go` is the single source; popup + dispatcher stay in sync in the same commit (existing rule — keep). Typing `/` opens the completions popup (filter-by-prefix, Tab/Enter accepts, Esc dismisses).

Existing commands keep their behavior: `/help /? /tools /new /reset /sessions /status /whoami /reasoning /usage /clear /cls /model[ list|status|<id>] /stop /context /tasks /exit /quit`.

New commands this spec adds:

| Command | UX |
|---|---|
| `/doctor` | runs gateway `doctor` checks; renders each as `✓/✗ check-name · detail`, flat list in transcript |
| `/setup` | re-enters the Setup Wizard (§13) at the provider step |
| `/providers` | provider list + health dots + which is default (see §10) |
| `/connectors` | list connectors with `●/○` state; `/connectors reload` triggers gateway reload, result as one `◦` line |
| `/memory` | memory stats + last-indexed; `/memory search <q>` runs a search rendered as a tool line |
| `/dream` | `/dream` shows last dream summary; `/dream now` triggers one, progress per §11 |
| `/genome` | current genome layers + fitness, one line per layer, dim |
| `/meta` | meta-evolution epoch status (mirrors `feral meta`) |
| `/lora` | training status + pending approval; approve/reject inline (`y/n` footer prompt) |
| `/compact` | summarize-and-truncate current session context; renders `◦ compacted: 41 turns → summary (3.1k tokens freed)` |
| `/history` | alias of `/sessions` |

Command output is always transcript content (scrolls away naturally) except pickers (`/model`, `/sessions`), which are overlays. Unknown command: `◦ unknown command /foo — /help` (dim, not red; a typo is not an error).

---

## 13. Setup Wizard UX

Runs in the transcript zone as sequential flat screens — the same visual language as chat, so the wizard *teaches* the interface while configuring it. Every screen: title line, body, and a footer showing `enter continue · esc back`. Arrow keys + enter; number keys as accelerators. No boxes.

**W1. Hardware detection** (automatic, ~2 s)
```
✻ setting up feral

detecting hardware…
  ✓ gpu    nvidia rtx 4070 · 12 GB · vulkan
  ✓ ram    64 GB
  ✓ disk   412 GB free
```
Auto-advances. Failure of any probe degrades gracefully (`○ gpu none detected — cpu mode`), never blocks.

**W2. Model choice** (the fork non-tech users must survive)
```
how should feral think?

  1. local — private, free, runs on your gpu   (recommended for this machine)
     qwen3.5-7b · 4.1 GB download
  2. cloud — bring your own api key
     minimax · anthropic · openai
  3. both — local first, cloud fallback
```
Recommendation is computed from W1 (VRAM ≥ 8 GB → local recommended; else cloud). One keystroke selects.

**W3a. Local path → model download**
Footer progress line (§5); body shows what's happening in plain language (`downloading the model — about 3 minutes on your connection`). HuggingFace token prompt appears ONLY if the chosen model is gated; default recommended model must be ungated so non-tech users never see a token prompt.

**W3b. Cloud path → provider + API validation**
Provider list → paste key (masked input `••••…`) → immediate live validation call → `✓ key works · minimax-m3 available` or `✗ key rejected — check it and paste again` (stay on screen, don't restart wizard). Key goes to the OS keychain (existing BYOK flow), never to a config file — say so on screen: `stored in your system keychain`.

**W4. Connector setup** — one screen, entirely skippable: `connect chat apps later with /connectors — skipping`. Auto-advances after 2 s or on enter. *Why: time-to-first-message is the wizard's only KPI; connectors are post-first-value.*

**W5. Finish**
```
✓ feral is ready

say something.
```
Drops directly into Ready with the input focused. No summary screen, no docs links, no confetti.

Wizard rules: Esc = back one step (never quits the app from inside the wizard; W1's Esc does nothing); Ctrl+C = quit with terminal restored and wizard progress persisted (resumes at last completed step on next launch); every screen renders correctly at 80×24.

---

## 14. Error UX

One shape for all errors (the flat error card, implemented): `⏺ error · kind` + message + a hint line *that always names the next action*. No stack traces in the transcript (they go to `feral logs`). Errors never modal, never clear the screen, never lose user input.

| Failure | Kind line | Hint line | Behavior |
|---|---|---|---|
| Missing model | `error · no model` | `pick one with /model — or /setup` | input stays enabled for slash commands |
| Offline (no network, cloud provider) | `error · offline` | `local model still works — /model list` (or `retrying when network returns` if no local) | Recovery polls quietly; `◦ back online` when restored |
| Provider unavailable (5xx) | `error · provider down` | `retrying via fallback…` | auto-fallback per §10; only errors if all routes fail |
| Rate limit (429) | `error · rate limited` | `cooling down 30 s — or /model to switch` | countdown ticks in the hint; auto-retry once at 0 |
| Gateway down (mid-session) | `error · runtime lost` | `restarting runtime…` | auto-restart (bounded: 3 attempts, backoff); then `runtime won't start — feral doctor` |
| Connector disconnected | not an error card — one `Warn` event line: `◦ telegram disconnected — reconnecting` | — | chat unaffected |
| Bad config | `error · config` | `<field>: <problem> — fix in <path> or run /setup` | name the exact field, never "invalid config" |
| Corrupted memory | `error · memory` | `chat works without memory — /doctor to repair` | degrade: chat continues memoryless; repair is explicit, never automatic (data destruction requires consent) |

Principles: (1) every error names its recovery in the same breath; (2) auto-recover only when it's free and safe (reconnect, retry) — never when it destroys data (memory repair, config rewrite); (3) after 3 failed auto-recoveries, stop and hand the user one command (`feral doctor`).

---

## 15. Notifications

Three tiers, no others:

| Tier | Vehicle | Lifetime | Examples |
|---|---|---|---|
| **Ephemeral** | footer flash | 5 s, auto-expire (implemented) | `copied`, `model switched`, `session saved` |
| **Persistent-passive** | `◦` transcript line | scrolls with history, forever | all §11 runtime events, `◦ interrupted` |
| **Persistent-active** | footer, sticky until acted on | until keypress/resolution | `lora eval ready — approve? y/n`, error footers |

- **Priority:** persistent-active > progress > ephemeral. A flash never covers an approval prompt.
- **Dismissible:** persistent-active dismisses with Esc (defers, re-raisable via its slash command: `/lora`); ephemeral needs no dismissal; transcript lines aren't dismissible (they're history).
- Terminal bell: never. OS notifications: out of scope for the TUI (desktop app's job).

---

## 16. Keyboard UX

| Key | Action |
|---|---|
| `Enter` | send message / accept completion / confirm in wizard |
| `Shift+Enter` / `Ctrl+J` | newline in input |
| `Esc` | interrupt stream → dismiss overlay → dismiss completions → clear input (in that priority) |
| `Ctrl+C` | clear input; on empty input: quit (press-twice-within-1 s guard when text present) |
| `Ctrl+D` | quit (empty input only; otherwise no-op) |
| `Ctrl+L` | clear screen (visual only — history preserved, `/clear` clears history) |
| `Ctrl+R` | toggle reasoning visibility (mirrors `/reasoning`) |
| `↑ / ↓` | on empty input: walk input history (session-persistent, stored with session file); with text: move cursor in textarea |
| `PgUp/PgDn`, wheel | transcript scroll (§7) |
| `Ctrl+Home/End` | transcript top / bottom |
| `Tab` | accept selected completion; in wizard: next field |
| `F1` | help overlay |
| `y / n` | answer active approval prompt (only when one is active) |

- **History:** last 200 inputs, deduped consecutive, `↑` from empty input only (so arrows still edit multi-line text).
- **Autocomplete / tab completion:** slash commands (existing) + argument completion where the registry knows the domain: `/model <Tab>` completes installed model ids, `/connectors <Tab>` completes connector names. Popup max 8 rows, scrolls.
- All keys must work on Windows Terminal, macOS Terminal.app, and common Linux terminals; anything crossterm/Bubble Tea can't deliver reliably (e.g. `Shift+Enter` on some terminals) must have the listed fallback (`Ctrl+J`).

---

## 17. Responsiveness

Reflow on every `WindowSizeMsg`; layout math is pure functions of `W×H` (no cached widths).

| Width | Adaptation |
|---|---|
| ≥120 (incl. ultrawide) | transcript text wraps at `min(W-4, 110)` columns, left-anchored — never stretch prose full-width (unreadable); header shows all segments |
| 100 | full layout, no change |
| 80 (baseline — everything must be fully usable here) | full layout; header may drop `lora` segment |
| 60–79 | header drops to `feral · model · ●`; tool tail (`⏱ 0.4s ✓`) moves onto the `⎿` line; completions popup full-width |
| 40–59 | header = `feral · ●`; footer hints shorten to key names only |
| <40 or height <10 | freeze frame with one line: `terminal too small (min 40×10)` — recover instantly on resize |

Height: input growth caps at `min(6, H/4)` lines; overlays cap at `H-6`; welcome block hides the `recent` section below `H=14` (implemented — keep).

**Acceptance: resizing during streaming corrupts nothing** — mid-stream `WindowSizeMsg` reflows the partial message correctly.

---

## 18. Accessibility

- **NO_COLOR** (env, standard): all `lipgloss` styles collapse to plain text + bold. State that color carried must survive: tool status via glyph text (`✓/✗/…` after the mark), liveness via `online/offline` word (already word + dot). **Acceptance: every state in §3 is distinguishable with color off.**
- **ASCII mode:** §5's fallback table, via one `glyphs` lookup. `FERAL_ASCII=1` forces it; non-UTF-8 locale auto-detects it.
- **Low-bandwidth terminals (ssh, mosh):** the 30 fps render cap (§7) plus viewport diffing bounds redraw volume; a `FERAL_FPS=5` env knob lowers the cap for thin pipes.
- **Screen readers:** a TUI's alternate screen is hostile to screen readers; provide `feral chat --plain` — the linear no-alternate-screen REPL mode (the legacy `chat.rs` interaction shape): plain stdout transcript, no cursor tricks, no spinner (replaced by `thinking...` printed once). This is the accessibility contract, not an afterthought — keep it working.
- **Color blindness:** state never rides on hue alone — running/done/error tool marks differ by *accompanying glyph* (`⏱`+elapsed vs `✓` vs `✗`) and errors carry the word `error`. Orange/gray/red are additionally luminance-separated on the warm-black background.

---

## 19. Performance Budget

Hard numbers; each gets a test or a measured check in CI where feasible.

| Metric | Budget |
|---|---|
| Cold start → header visible | <200 ms (gateway already up) |
| Cold start → Ready | <500 ms (gateway up), <5 s (gateway auto-start, excl. model load) |
| Key echo latency | <16 ms (typing must never feel mediated) |
| Redraw frequency | ≤30 fps cap while streaming; 0 fps when Idle (no timers except the 30 s status poll) |
| Render cost per frame | <5 ms at 120×40 with a 500-message transcript (virtualize: render only visible lines + 1 page margin; do NOT re-render the full history string per token) |
| Scroll response | <16 ms per wheel/PgUp event at 500 messages |
| Streaming | no dropped tokens at 200 tok/s; UI batches, network reader never blocks on render (existing channel split — keep) |
| Memory | <50 MB RSS for a 1000-turn session (transcript stored as message structs, rendered lazily) |
| Provider-switch → header update | <100 ms from SSE event |

**Acceptance: a 500-message conversation remains responsive** (typing, scrolling, streaming all within budgets above). The current `buildChatContent` rebuilds the whole transcript string on change — this breaks the render budget at scale and must be replaced by incremental/virtualized rendering in the phase that claims this budget (P2).

---

## 20. Architecture

- **Pattern:** Elm architecture (Bubble Tea) — single `App` model, `Update(msg) → (model, cmd)`, pure `View()`. Keep it; it is the spec's concurrency story.
- **Renderer:** `View()` composes zone renderers (`renderHeader/Transcript/Input/Footer/Overlay`) — pure functions of the model, no I/O, no clocks (time enters as messages). All styles in `tui/ui/styles.go`; all glyphs in one `glyphs` table (new, per §5).
- **Event bus:** everything is a `tea.Msg`. Three producers feed the program: (1) crossterm input, (2) the chat SSE stream (`ChatDeltaMsg`, `ChatReasoningMsg`, `ToolCallMsg`, `ToolResultMsg`, `ChatDoneMsg`, `ChatErrMsg`), (3) the runtime `/events` SSE (`RuntimeEventMsg{kind, payload}`) + a status poll ticker. Producers run as `tea.Cmd` goroutines writing via `Program.Send`; none may block `Update`.
- **UI state:** one `State` enum (§3) + zone-local sub-state (overlay structs, completion state, FollowBottom). No derived state stored that a pure function of messages could compute.
- **Message model:** `Turn{Role, Blocks[]}` where a block is `Text | Reasoning | ToolCall{name,args,status,result,elapsed} | Event | ErrorCard`. Rendering iterates blocks; streaming mutates the last block. This is the extension point (§21).
- **API layer:** `tui/api/client.go` remains the only file that knows HTTP/SSE. It exposes typed methods + channels, never leaks `http.Response`. New endpoints (events, doctor, connectors, lora, dream, genome, meta) are added here only.
- **Plugin points:** (a) `KnownCommands` registry → dispatcher map, (b) `RuntimeEventMsg.kind` → one-line formatter map, (c) block renderer switch. Adding a feature = one entry in each relevant map, zero layout changes.

---

## 21. Extensibility

How each future thing plugs in **without redesign** — if any of these requires touching §4 layout, the design has failed:

- **New tool:** nothing to do. Tools render generically (§8); optional: one entry in a `toolResultSummarizer` map for a nicer `⎿` line.
- **New provider:** gateway concern. TUI picks it up via `/runtime/status` + `/providers`; header renders whatever backend string arrives.
- **New connector:** one formatter entry for its `RuntimeEventMsg` kind + it appears in `/connectors` automatically from the gateway list.
- **New Brain module:** its decisions arrive as runtime events → one formatter entry (§10 table row).
- **New slash command:** one `KnownCommands` entry + one dispatcher case, same commit (enforced by existing sync rule + test).
- **New runtime event type:** unknown kinds render as `◦ <kind>` dim — forward-compatible by default; a formatter entry upgrades them.
- **New UI panels:** the only sanctioned container is the overlay (§4). New panel = new overlay struct + F-key or slash command. The 5-zone layout itself is closed for modification.

---

## 22. Acceptance Tests

Every feature ships with observable criteria. The full list (union of the per-section **Acceptance** lines plus global invariants):

**Layout invariants**
1. Header never exceeds one line at any width ≥40.
2. Footer never exceeds one line; only one footer message renders at a time.
3. No border or background-fill characters appear anywhere (grep the frame for box-drawing chars: only `⎿` allowed).
4. Tool output never shifts previous messages (appending is monotonic; earlier lines are immutable once rendered).

**Streaming**
5. Streaming never moves the viewport while the user is scrolled up.
6. No redraw flicker: streaming redraws only the dirty tail region; full-frame redraws only on resize/overlay toggle.
7. Esc during any stream stops output within 100 ms and appends `◦ interrupted`.
8. A resize mid-stream reflows without corruption or lost text.

**Performance**
9. A 500-message conversation stays within all §19 budgets (typing echo <16 ms, scroll <16 ms/event).
10. Provider switches appear in the header in under 100 ms.
11. Idle state runs zero animation timers (verify: no ticks scheduled except the 30 s poll).

**State machine**
12. Every §3 state is reachable and every state's footer text matches the table.
13. Killing the gateway mid-session produces `error · runtime lost` → auto-restart → `◦ back online`, without losing the transcript or the input buffer.
14. Every error card's hint names an action that exists.

**Input**
15. Ctrl+C with text clears input; second Ctrl+C within 1 s quits; terminal is always restored (including on panic — SIGSEGV test).
16. `↑` on empty input recalls history; `↑` with text moves the cursor.
17. `/` always opens completions; the popup never covers the input row.

**Degradation**
18. NO_COLOR: all §3 states remain distinguishable.
19. FERAL_ASCII=1: no non-ASCII byte is emitted (automatable: capture frame, assert `all(b < 128)`).
20. 80×24 supports the entire journey (§2) including the full wizard.
21. <40 cols shows the too-small frame and recovers on resize.

**Wizard**
22. Fresh machine → first assistant reply, local path: ≤4 keystrokes beyond typing the message (launch → enter → 1 → wait → type). Cloud path: those plus one paste.
23. Wizard interrupted with Ctrl+C resumes at the last completed step.
24. An invalid API key re-prompts on the same screen with the validation error inline.

**Events**
25. A dream/genome/meta/connector event during streaming appears only after the stream ends, as one `◦` line.
26. 10 events in one second coalesce into one summary line.

Automate what the existing harness supports (frame-dump tests like `TestPrintScreens`, `view_render_test.go` string assertions, the FollowBottom regression test); the rest are scripted manual checks listed in the phase exit criteria.

---

## 23. Do NOT Implement Yet

**This document describes the finished product, not the next PR.** No one — Claude, Sonnet, Opus, MiniMax, GPT — should attempt to build all of this in one pass. Implementation proceeds in phases; each phase lands, gets smoked live against a running gateway, and gets its acceptance subset green before the next begins. An implementer picks up exactly one phase, builds only what that phase names, and treats everything else in this spec as context — not as license.

### P0 — Consolidate the core (mostly exists)
The flatten pass + interaction fixes already shipped. P0 closes the gaps in what exists:
- State enum (§3) replacing ad-hoc booleans; footer driven by it.
- Glyph table + ASCII mode + NO_COLOR audit (§5, §18).
- Esc-priority chain + Ctrl+C double-press + input history (§16).
- Streaming cursor `▍`, 30 fps batching, `◦ interrupted` line (§7).
- Error cards for the §14 table's top 4 rows (no model, offline, gateway lost, rate limit) with recovery loop.
- Acceptance subset: 1–8, 12–17, 18–19.

### P1 — Runtime surface
- `/events` SSE consumer + `RuntimeEventMsg` formatter map (§11).
- Thinking UX (§9) end-to-end, incl. the sidecar `reasoning_content` contract (sidecar fix is in-scope for P1 if reasoning still arrives inline).
- New slash commands: `/doctor /providers /connectors /memory /dream /lora /compact` (§12) over existing gateway endpoints; commands whose endpoint doesn't exist yet land gateway-first.
- Tool UX polish: elapsed ticker, 3-line budget + `/tools` overflow, approval prompts (§8, §15).
- Acceptance subset: 25–26, 14 (full table), 10.

### P2 — Scale + Brain
- Virtualized transcript rendering (kills the `buildChatContent` full-rebuild) to meet §19 at 500+ messages.
- Brain Stack surfacing (§10) as the Brain lands (Faza 4.6) — routing lines, fallback lines, header backend live-switch.
- Responsiveness matrix below 80 cols (§17).
- Acceptance subset: 9, 11, 20–21.

### P3 — First-run product
- Setup Wizard (§13) full flow, resumable, incl. model download progress + BYOK validation.
- `feral chat --plain` screen-reader mode (§18).
- npm-wrapper first-launch journey (§2 J1–J3) polished end-to-end.
- Acceptance subset: 22–24, full journey walkthrough (§2) as the release gate.

---
---

# Part II — Design & Implementation Manual

Part I says *what* the TUI is. Part II says *exactly how it looks and exactly how each look is built* in Bubble Tea + Lip Gloss. The contract for this part: **every design rule comes with its implementation** — the component that owns it, the style that paints it, and the render path that draws it. A model reading only Part II six months from now must produce the same TUI, not a reinterpretation.

Reference class: Claude Code's terminal UX (see §33 for what we take and what we don't). Ground truth for names: `tui/app/*.go` and `tui/ui/styles.go` as they exist on branch `feat/faza4-5-runtime-extraction`. Where Part II names a style or component that doesn't exist yet, it is marked **(new)**.

---

## 24. Bubble Tea Architecture

### 24.1 Program shape

One `tea.Program`, alternate screen, mouse cell motion for wheel scroll:

```go
p := tea.NewProgram(app.New(baseURL, token, status),
    tea.WithAltScreen(),
    tea.WithMouseCellMotion(),
)
```

The Elm loop is the whole concurrency story: **all state lives in one `App` struct** (`tui/app/model.go`), **all mutation happens in `Update`**, **`View` is a pure function** of the model. Goroutines (SSE readers, HTTP calls, tickers) never touch the model — they deliver `tea.Msg` values via `tea.Cmd` returns or `Program.Send`, and `Update` applies them on the single loop thread. This is a hard rule: any code path that mutates `App` outside `Update` is a bug, full stop.

### 24.2 The main model

`App` (exists, `model.go:157`) — the single top-level model. Its fields group into five zones plus machinery:

| Group | Fields (existing / target) | Owned by |
|---|---|---|
| Identity | `baseURL`, `token`, cached `StatusSnapshot` | header |
| Transcript | `Turns []Turn`, `viewport.Model`, `FollowBottom bool` | transcript |
| Input | `textarea.Model`, input history ring **(new)** | input row |
| Machinery | `Mode` → replace with `State` enum (§3) **(P0)**, `spinner.Model`, flash + expiry, width/height | footer |
| Overlays | `helpOpen`, `historyOpen`, `ToolViewerState`, `ModelPickerState`, completion state, wizard state **(new)** | overlay layer |

Rule: **no derived state is stored.** Anything computable from `Turns` + `State` (e.g. "is a tool running") is a method (`toolsRunning()`, exists), not a field. Stored booleans that shadow the FSM are the "boolean soup" §3 bans; P0 replaces `Mode` + ad-hoc flags with the single `State` enum.

### 24.3 Bubbles used (and how)

| Bubble | Instance | Configuration rules |
|---|---|---|
| `viewport.Model` | transcript | `SetContent` only when content actually changed (guard with a prev-hash, exists); `GotoBottom()` only when `FollowBottom` is true. Never `HighPerformanceRendering` (broken with alt-screen resize on Windows Terminal). |
| `textarea.Model` | input | `CharLimit(0)`, `ShowLineNumbers(false)`, `MaxHeight(6)`, prompt set to empty string — the `› ` glyph is rendered by us (`ui.InputPrompt`) so the accent color and ASCII fallback go through the glyph table, not through textarea's prompt facility. Placeholder styled `ui.InputPlaceholder`. |
| `spinner.Model` | footer + thinking line | Frames: braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80 ms (`spinner.Dot` equivalent); style `ui.SpinnerStyle` (Accent). **One spinner instance**, shared: it renders in at most one place per frame (footer OR thinking line — the FSM decides), so one ticker suffices. Ticker runs only in states that show it (§31.6). |
| `help.Model` | not used | The F1 help overlay is a hand-rendered flat list (`renderHelpOverlay`, exists). `bubbles/help` draws a mini two-row hint bar we don't want — the footer hint line already fills that role. Keep hand-rendered. |
| `key.Binding` (keymap) | `tui/app/keymap.go` **(new)** | All bindings from §16 defined as `key.Binding` with help text, in one `KeyMap` struct. `Update` matches with `key.Matches(msg, keys.Send)` — never raw string comparison on `msg.String()` scattered through `Update` (that's what exists today; P0 migrates). The help overlay renders from the same `KeyMap`, so keys and help can't drift. |

### 24.4 Update loop — message routing

`Update` is a router, not a worker. Top-level order (must be exactly this — it encodes the Esc-priority chain and modal capture):

```
1. tea.WindowSizeMsg   → recompute layout, reflow, pass to viewport/textarea; return
2. spinner.TickMsg      → advance spinner only if current State shows one
3. Overlay open?        → route keys/scroll to overlay handler; swallow everything
                          except its dismiss keys. Transcript never scrolls
                          behind a modal (exists — keep).
4. tea.KeyMsg           → keymap match → intent (SendMsg, Interrupt, …)
5. Stream messages      → StreamChunkMsg / StreamDoneMsg / tool msgs → mutate
                          last Turn's blocks, mark transcript dirty
6. Runtime events       → RuntimeEventMsg (P1) → queue or append ◦ line (§11)
7. Async results        → ModelListMsg, SessionsMsg, FlashMsg, HTTP errors
```

Every branch returns `(model, cmd)`; long work never happens inline. Anything that could block ≥1 ms (HTTP, disk) is a `tea.Cmd`.

### 24.5 Event routing — the three producers

```
 crossterm/stdin ──────────────► tea.KeyMsg / tea.MouseMsg / WindowSizeMsg
 chat SSE (POST /runtime/chat) ► StreamChunkMsg{delta} / ChatReasoningMsg
   reader goroutine              ToolCallMsg / ToolResultMsg / StreamDoneMsg / ChatErrMsg
 runtime SSE (GET /events) ────► RuntimeEventMsg{Kind, Payload}   (P1)
   reader goroutine
 status poll (ticker Cmd) ─────► StatusMsg{snapshot}   every 5 s Ready / 30 s Idle
```

The two SSE readers live in `tui/api/client.go` — the **only** file that imports `net/http`. They parse frames into typed structs and push them over a channel that a `tea.Cmd` drains (`waitForChunk` pattern: the Cmd returns one msg, `Update` re-issues the Cmd — standard Bubble Tea streaming loop). The reader never blocks on render: the channel is buffered (cap 256) and the reader drops *nothing* — if the UI is behind, tokens coalesce at the batcher (§31.3), not at the socket.

### 24.6 Renderer pipeline / view composition

`View()` (exists, `view.go:14`) composes five pure zone renderers, joined vertically, then overlays:

```go
func (a *App) View() string {
    header  := a.renderHeader()          // 1 line
    body    := a.viewport.View()         // transcript zone (viewport owns scroll)
    input   := a.renderInput(h)          // 1..6 lines, "› " + textarea
    footer  := a.renderFooter()          // 1 line, FSM-driven
    frame   := lipgloss.JoinVertical(lipgloss.Left, header, body, sep, input, footer)
    if overlay := a.activeOverlay(); overlay != "" {
        return lipgloss.Place(a.width, a.height, lipgloss.Center, lipgloss.Center,
            overlay)                     // backdrop = dimmed frame, no fill
    }
    return frame
}
```

Zone renderers take no arguments except the model (`a`) and derived widths; they do **no I/O and read no clocks** — elapsed times are computed from timestamps already stored on the model by messages (`ToolCall.endedOrNow()`, exists). Transcript content is *not* rebuilt inside `View()`: `buildChatContent()`/`rebuildViewport()` run in `Update` only when a message dirtied the transcript, and `View` just returns `viewport.View()` over the cached content. (P2 replaces the full rebuild with block-level caching — §34.2.)

---

## 25. Lip Gloss Design Tokens

Tokens are the *only* place colors and metrics are defined. Styles (§26) reference tokens; renderers reference styles; **no renderer ever contains a hex literal, a raw color, or a magic width.** Enforced by review + a grep test: `grep -n '#[0-9A-Fa-f]\{6\}' tui/app/` must return nothing.

### 25.1 Color tokens (`tui/ui/styles.go` — exists, keep values)

| Token | Value | Meaning — when to use | Never use for |
|---|---|---|---|
| `Accent` | `#EC8C4C` | *work is happening here*: prompt glyph, running tool mark, spinner, brand word, selected item | body text, results, anything settled |
| `AccentHi` | `#F2A466` | hover/selected emphasis, overlay titles | running-state (that's Accent) |
| `AccentDim` | `#89532F` | de-emphasized accent (streaming cursor trail if needed) | text |
| `Text` | `#E4DDD2` | the answer: assistant body, tool names, values | chrome, hints |
| `Meta` | `#7A746B` | everything settled: hints, results, events, user turns, footers | errors, active work |
| `Ok` | `#8FB77A` | success glyphs (`✓`, online dot) only | prose |
| `Warn` | `#D6A95A` | degraded-but-working glyph + flash | errors (that's Fail) |
| `Fail` | `#D16B5A` | errors only: error mark, offline dot, diff deletions | emphasis |
| *(background)* | — | **none. Ever.** The terminal's own background is the canvas. | — |

One sanctioned exception: `KbdStyle`'s `#1b1b1f` key-cap background in the help overlay (exists). It stays because a key cap *is* its shape; nothing else may paint a background.

`lipgloss.Color` values are `AdaptiveColor`-free on purpose: Feral's brand is warm-dark; on a light terminal the palette still reads (all tokens ≥ WCAG 3:1 against both extremes was checked at flatten time). NO_COLOR handling is not per-token — it's global (§30.8).

### 25.2 Metric tokens

| Token | Value | Used by |
|---|---|---|
| `TagWidth` | 9 (exists) | legacy two-column tags — **being retired**; Part I §5's 2-space indent + `›` gutter is the target. Migration note: `TagYou`/`TagFeral` are deleted when the gutter lands; `TagIndent` in `view.go` follows. |
| `ContentIndent` **(new)** | 2 | transcript content column |
| `ResultIndent` **(new)** | 4 | `⎿` result lines (ContentIndent + 2) |
| `MaxProseWidth` **(new)** | 110 | wrap cap on wide terminals (§17) |
| `InputMaxLines` **(new)** | 6 | textarea growth cap |
| `OverlayMaxWidth` **(new)** | `min(W-8, 100)` | all overlays |
| `FrameCap` **(new)** | 33 ms | streaming render batch (§31.3) |
| `FlashTTL` | 5 s (exists as spinner-tick expiry) | footer flash |

### 25.3 Glyph tokens **(new, P0)** — `tui/ui/glyphs.go`

```go
type GlyphSet struct{ Prompt, ToolMark, Result, ThinkClosed, ThinkOpen,
    On, Off, Event, Spark, OK, Err, Down, Up, Ellipsis, Cursor string
    Spinner []string }

var Unicode = GlyphSet{ "›", "⏺", "⎿", "▸", "▾", "●", "○", "◦", "✻",
    "✓", "✗", "↓", "↑", "…", "▍", brailleFrames }
var Ascii   = GlyphSet{ ">", "*", "`-", "+", "-", "o", ".", "-", "*",
    "ok", "x", "v", "^", "...", "|", []string{"|","/","-","\\"} }

var G = pick() // FERAL_ASCII=1 / TERM=dumb / non-UTF-8 locale → Ascii
```

Renderers use `ui.G.ToolMark`, never the literal `⏺`. This is the entire ASCII-mode implementation — one table, one switch, zero scattered literals (§5). Styles that currently bake glyphs in via `SetString` (`ToolMark`, `InputPrompt`, `ThinkingCollapsed`, `Cursor`, `StatusOnline`) migrate to `style.Render(ui.G.X)` so glyph and color decouple.

---

## 26. Lip Gloss Design System — the style catalog

Every visual element, its style name, and its full Lip Gloss definition. This table **is** `tui/ui/styles.go` — the file and the table must match 1:1 (existing styles keep their names; **(new)** marks additions; styles absent from this table get deleted).

Global rules first, because they are what make it a *system*:

- **No borders.** `Border(...)` appears nowhere. The only child-connector is the `⎿` glyph. *(Implementation: grep-test for `Border` in `tui/`, allowed count: 0.)*
- **No backgrounds** except `KbdStyle` (§25.1). *(grep-test for `Background(`, allowed count: 1.)*
- **No margins via style.** Vertical rhythm comes from explicit blank lines in renderers (§30.1) — `Margin()` in a style makes spacing invisible to the layout math. Horizontal inset comes from `Padding(0, n)` on zone containers only (header/footer/input/overlay), never on inline text styles.
- **Bold is rare.** Bold = "this is a *name*": tool names, error kinds, overlay titles, the brand word. Body text is never bold.
- **Italic = "not the answer":** reasoning, placeholders, notes, hints-inside-cards.
- **Width/Align** only on the retiring tag styles and overlay titles; prose is never `Align(Center)`.

| Element | Style name | Definition (Foreground / attrs / spacing) |
|---|---|---|
| **Header** | | |
| container | `HeaderStyle` | no color (segments carry their own); `Padding(0,1)` |
| brand word | `BrandStyle` | `Accent`, Bold |
| segment text | `MetaStyle` | `Meta` |
| segment value | **(new)** `HeaderValue` | `Text` |
| liveness dot | `StatusOnline` / `StatusOffline` | `Ok` dot / `Fail` dot + word `online`/`offline` in `Meta` |
| **Footer** | | |
| container/hint | `FooterStyle` | `Meta`; `Padding(0,1)` |
| flash | `FlashStyle` | `Warn` |
| spinner | `SpinnerStyle` | `Accent` |
| stream state word | `StreamStatus` | `Accent` |
| stream numbers | `StreamNumber` | `Text` |
| stream dim parts | `StreamDim` / `StreamHint` | `Meta` |
| stalled note | `StreamStalled` | `Warn`, Italic |
| progress line | **(new)** `ProgressStyle` | `Meta` text, `Accent` for the moving figure (`38%`) |
| approval prompt | **(new)** `ApprovalStyle` | `Warn` glyph + `Text` question + `Meta` keys |
| **Transcript — turns** | | |
| user turn text | `UserContent` → retarget to `Meta` | user turns are settled history (§6); gutter `›` in `Meta` |
| assistant text | `FeralContent` | `Text`; body via Glamour (§30.2) |
| streaming cursor | `Cursor` | `Accent`, glyph `G.Cursor`, no blink |
| **Transcript — tools** | | |
| mark, running | `ToolRunning` | `Accent` (paints `G.ToolMark`) |
| mark, done | `ToolDone` | `Meta` |
| mark, error | `ToolError` | `Fail` |
| tool name | `ToolName` | `Text`, Bold |
| tool args | `ToolArg` | `Meta` |
| elapsed/status tail | `ToolNote` | `Meta`, Italic |
| result line | `ToolResult` | `Meta` (paints `G.Result` + text) |
| diff add/del/hunk/file | `DiffAdd`/`DiffDel`/`DiffHunk`/`DiffFile` | `Ok` / `Fail` / `Meta` Italic / `AccentHi` Bold |
| **Transcript — thinking** | | |
| collapsed line | `ThinkingCollapsed` | `Meta` (glyph `G.ThinkClosed`) |
| expanded header | `ThinkingHeader` | `Meta` (glyph `G.ThinkOpen`) |
| reasoning body | `ThinkingContent` | `Meta`, Italic — never full-color (§9) |
| **Transcript — events** | | |
| event line | **(new)** `EventStyle` | `Meta`; glyph `G.Event` prefix |
| warn event glyph | **(new)** `EventWarnMark` | `Warn` (text stays `Meta`) |
| **Errors** | | |
| kind line | `ErrorTitle` | `Fail`, Bold (`⏺ error · kind`) |
| message | `ErrorMsg` | `Text` |
| hint | `ErrorHint` | `Meta`, Italic |
| **Success** | | |
| success glyph | **(new)** `OkMark` | `Ok` (paints `G.OK`; text after it is `Meta`) |
| **Input** | | |
| prompt glyph | `InputPrompt` | `Accent` (paints `G.Prompt`) |
| container | `InputStyle` | `Padding(0,1)` |
| placeholder | `InputPlaceholder` | `Meta`, Italic |
| **Welcome** | | |
| tagline | `WelcomeTagline` | `AccentHi` |
| labels | `WelcomeLabel` | `Meta`, `Width(9)`, right-aligned |
| values | `WelcomeValue` | `Text` |
| section head | `WelcomeSection` | `Meta`, Bold |
| **Overlays** | | |
| title | `HelpTitle`/`ToolViewerTitle` | `AccentHi`, Bold, lowercase text |
| key | `HelpKey` | `Accent` |
| desc/row | `HelpDesc`/`ToolViewerRow` | `Text` |
| meta/preview | `HelpMeta`/`ToolViewerMeta`/`ToolViewerPreview` | `Meta` (+Italic for preview) |
| selection | `ToolViewerSel`/`CompletionSel` | `Accent`, Bold |
| key cap | `KbdStyle` | `Text` on `#1b1b1f`, `Padding(0,1)` — the one background |
| **Completions** | | |
| container | `CompletionBox` | `Padding(0,1)`, no border |
| item / desc / hint | `CompletionItem`/`CompletionDesc`/`CompletionHint` | `Text` / `Meta` / `Meta` Italic |
| **Wizard (new, P3)** | | |
| title | `WizardTitle` | `AccentHi` (`✻ setting up feral`) |
| body | `WizardBody` | `Text` |
| option number | `WizardKey` | `Accent` |
| recommendation | `WizardNote` | `Meta`, Italic |

Padding/margin summary (the complete inventory — anything else is out of spec): header `(0,1)` · footer `(0,1)` · input `(0,1)` · overlay boxes `(0,2)` · key caps `(0,1)` · completions `(0,1)`. No style carries `Margin`.

---

## 27. Component Tree & Responsibilities

```
App (tea.Model — model.go)
├── Header                 renderHeader()        identity + liveness, 1 line
├── ChatViewport           viewport.Model        owns scroll + FollowBottom
│   ├── WelcomeBlock       renderWelcomeContent() empty-session only
│   ├── Turn[]             buildChatContent()    each Turn renders its Blocks:
│   │   ├── TextBlock      Glamour markdown      user/assistant prose
│   │   ├── ReasoningBlock thinking line/body    §9
│   │   ├── ToolCallBlock  renderToolPill()      ⏺ line + ⎿ results §8
│   │   ├── EventBlock     formatRuntimeEvent()  ◦ lines §11 (new, P1)
│   │   └── ErrorCard      renderErrorCard()     §14
│   └── ContextWarning     one ◦ line at 80% context (new, P1)
├── (blank separator line — not a component, one "\n")
├── InputBox               renderInput()         "› " + textarea.Model, 1–6 lines
│   └── CompletionPopup    renderCompletions()   anchored above input, ≤8 rows
├── Footer                 renderFooter()        ONE of, by priority:
│   │                                            error > approval > progress >
│   │                                            flash > state text > hint
│   ├── FlashMessage       setFlash()/expiry     5 s TTL (exists)
│   ├── ProgressRenderer   (new)                 ↓ name  % · GB · MB/s
│   ├── StreamStatus       renderStreamingStatus() tokens/tps/elapsed (exists)
│   └── ApprovalPrompt     (new)                 y/n gate §8/§15
└── OverlayHost            View() Place()        modal, max 1 open, Esc closes
    ├── HelpOverlay        renderHelpOverlay()
    ├── SessionsOverlay    renderHistoryOverlay()
    ├── ToolViewer         renderToolViewerOverlay()
    ├── ModelPicker        renderModelPickerOverlay()
    └── SetupWizard        (new, P3 — full transcript-zone flow, §13)
```

"Component" here means *a pure render function + the model fields it reads* — Bubble Tea has no component objects, and we do not invent a framework on top of it (nested `tea.Model`s with message re-wrapping is complexity we explicitly reject; the app is small enough for one model). The tree above is a **rendering ownership map**: exactly one function is allowed to emit each element.

`NotificationQueue` from the wishlist is **not a component** — it's a slice on `App` (`pendingEvents []RuntimeEvent`) drained by `finishStream()` (§11's "events queue during streaming" rule) plus the flash TTL that exists. No queue object, no goroutine.

---

## 28. Mockups

All at 80×24 unless stated. `▁` marks the bottom of the frame in these mockups only (not rendered). Colors annotated in brackets on the right margin where not obvious; annotations are not rendered. Blank transcript space is real blank space — the TUI does not fill it.

### 28.1 Startup (gateway already running — J3)

```
 feral  qwen3.5-7b · lora personal-v3 · local · vulkan            ● online

  ✻ feral chat

  model    qwen3.5-7b
  backend  local · vulkan
  lora     personal-v3

  recent
    yesterday · "fix the deploy script" · 24 turns
    jul 2     · "trip planning"          · 8 turns

  / for commands · F1 for shortcuts




 ›

 F1 for shortcuts · Ctrl+C to exit
```

Header `Meta` with `Text` values; brand + `›` in `Accent`; `●` in `Ok`. During auto-start of the gateway, the same frame with header `feral · — · — · ○ starting` and footer `⠹ starting runtime…`.

### 28.2 Setup wizard — model choice (W2)

```
 feral  — · — · —                                                ○ starting

  ✻ setting up feral

  how should feral think?

    1. local — private, free, runs on your gpu   (recommended for this machine)
       qwen3.5-7b · 4.1 GB download
    2. cloud — bring your own api key
       minimax · anthropic · openai
    3. both — local first, cloud fallback




 ›

 enter continue · esc back
```

Numbers in `Accent` (`WizardKey`); recommendation note `Meta` italic. The wizard **is the transcript zone** — header/input/footer stay, teaching the layout before the first message.

### 28.3 Chat (steady state)

```
 feral  qwen3.5-7b · lora personal-v3 · local · vulkan            ● online

  › what changed in the deploy script yesterday?                    [Meta]

  Three things changed in yesterday's commit:                       [Text]

  1. The retry loop now backs off exponentially (2s → 32s).
  2. `DEPLOY_ENV` defaults to `staging` when unset.
  3. The health check hits `/runtime/status` instead of `/ping`.

  Want me to walk through the retry change in detail?

 ›

 F1 for shortcuts · Ctrl+C to exit
```

User turn: 2-space indent, dim `›` gutter, `Meta`. Assistant: 2-space indent, `Text`, Glamour markdown. One blank line between turns.

### 28.4 Streaming

```
  › summarize the genome architecture

  The genome system is layered: L1 handles prompt-level knobs, L2 the
  LoRA adapters, L4 architecture parameters, and L6 governs mutation
  budgets across all of them. Each layer ratchets independently▍

 ›  …  (esc to interrupt)

 ⠹ streaming · 214 tok · 42 tok/s · 5 s                    esc to interrupt
```

`▍` cursor in `Accent` trails the last character, no blink. Footer: spinner + `streaming` (`Accent`), numbers (`Text`), hint (`Meta`). Input shows the italic placeholder.

### 28.5 Thinking (collapsed, default)

```
  › why did the eval gate reject the adapter?

  ⠼ thinking · 7 s                                                  [Meta]

 ›

 ⠼ thinking · 7 s                                          esc to interrupt
```

One dim line at the answer's position; spinner glyph replaces `▸` while active; elapsed appears at 3 s. Expanded (`Ctrl+R`):

```
  ▾ thinking                                                        [Meta]
    The eval harness compares perplexity deltas across the held-out   [Meta,
    set. A rejection usually means the adapter regressed on…          italic]

  The adapter was rejected because the A/B eval showed a…            [Text]
```

### 28.6 Tool running

```
  › find my notes about the deploy script

  ⏺ memory_search("deploy script")                          ⏱ 0.4s   [Accent]
    ⎿ 3 results · top: project_deploy (0.91)                         [Meta]
  ⏺ read_file(docs/deploy-notes.md)                                  [Accent]

 ›

 ⠴ running read_file…                                      esc to interrupt
```

Running mark `Accent`, finished mark `Meta`, elapsed tail on the call line, results indented under their own call. Parallel calls stack.

### 28.7 Dream event

```
  Done — the notes are in docs/deploy-notes.md.

  ◦ dream: 2 insights added to memory                                [Meta]

 ›
```

### 28.8 Genome event

```
  ◦ genome: L2 fitness 0.83 → 0.85 (ratchet kept)                    [Meta]
```

### 28.9 Meta evolution (L6)

```
  ◦ meta: epoch 7 — mutation budget tightened                        [Meta]
```

### 28.10 Connector event

```
  ◦ telegram: reply sent to @dan (persona: sales)                    [Meta]
```

All four above are the same `EventBlock` — one `◦` line, `Meta`, between turns, queued if a stream is live. A burst coalesces: `◦ 3 connector events · /status for detail`.

### 28.11 Slash commands (completions open)

```
 ›  /mo

   /model     switch or list models                                 [sel: Accent]
   /memory    memory stats and search

 tab to accept · esc to dismiss
```

Popup sits directly above the input row, never covers it, max 8 rows, filter-as-you-type. Selected row `Accent` bold, descriptions `Meta`.

### 28.12 Error

```
  ⏺ error · rate limited                                            [Fail bold]
  MiniMax returned 429 — too many requests.                          [Text]
  cooling down 27 s — or /model to switch                            [Meta italic]

 ›

 F1 for shortcuts · Ctrl+C to exit
```

Flat card: three lines, no border, countdown ticks in the hint. Input stays enabled.

### 28.13 Doctor (`/doctor`)

```
  › /doctor

  ✓ gateway      reachable · 127.0.0.1:11435                        [✓ Ok]
  ✓ model        qwen3.5-7b loaded · vulkan
  ✓ memory       index fresh · 4 812 entries
  ✗ connector    telegram unreachable — check token in /connectors  [✗ Fail]
  ✓ disk         412 GB free

 ›
```

Transcript content (scrolls away); glyphs carry pass/fail, text stays `Meta`/`Text`.

### 28.14 Shutdown

Alternate screen closes; on the normal screen, one line, plain:

```
session saved · resume with: feral chat
```

Nothing else — no stats, no banner, no farewell paragraph.

---

## 29. Responsive Rules — concrete behavior per width

Implementation: all widths derive from the last `tea.WindowSizeMsg` (`a.width`); layout is pure math, recomputed on every resize; wrapped transcript content re-reflows (cached per-width, §34.2). The width thresholds live in one function `layoutFor(w, h int) Layout` **(new)** so the matrix is testable without a terminal.

| Width | Header | Transcript | Tools | Footer |
|---|---|---|---|---|
| **≥160 (ultrawide)** | all segments | prose wraps at `min(W-4, 110)` cols, **left-anchored** — never stretch to full width; the right side stays empty | tail (`⏱ 0.4s ✓`) right-aligned at col 110 | hint fully worded |
| **120** | all segments | wrap at 110 | same | same |
| **100** | all segments | wrap at 96 | same | same |
| **80 (baseline)** | may drop `lora` segment | wrap at 76 | same | same |
| **60–79** | `feral · model · ●` | wrap at W-4 | tail moves onto the `⎿` line | hints shorten (`F1 · ^C`) |
| **40–59** | `feral · ●` | wrap at W-4 | args truncated harder (`clampLen`) | key names only |
| **<40 or H<10** | — | single line: `terminal too small (min 40×10)` | — | — |

Height rules: input cap `min(6, H/4)`; overlays `H-6`; welcome hides `recent` below `H=14` (exists). Ultrawide is deliberately boring: more width buys margin, not more columns — no second pane ever appears (§32).

Truncation is always **right-to-left by segment priority** (drop backend, then lora, then shorten model name with `…`), implemented in `renderHeader` as a loop that drops segments until the rendered width fits — never character-truncate mid-segment except the model name.

---

## 30. Rendering Rules — how each content type is drawn

### 30.1 Vertical rhythm
One blank line between turns; zero between a `⏺` call and its `⎿` results; one around the welcome block. Implemented as explicit `"\n"` joins in `buildChatContent` — never `Margin()` styles (§26). The separator above the input is one blank line, not a rule character.

### 30.2 Markdown (assistant prose)
Glamour, custom brand theme **(new, replaces `WithAutoStyle`)**: a `glamour.WithStyles(feralStyleConfig)` JSON mapping — headings bold `Text` (not colored, no `#` prefix rendering), links underlined `Accent`, code spans `AccentHi` on no background, blockquotes `Meta` italic with a 2-space indent instead of a `│` bar. Rendered per-block with `WithWordWrap(wrapWidth)` at the current layout width; output cached on the `Turn` keyed by width (`renderMarkdownCached`, exists).

### 30.3 Code blocks
Glamour handles fencing; theme overrides: 2-space indent, `Meta`-dim syntax accents, **no background fill**, no line numbers. A code block wider than the wrap width scrolls… nowhere — it hard-wraps; terminals don't do horizontal scroll regions and we don't fake one (§32).

### 30.4 Tables
Glamour table rendering passes through with a guard: if the rendered table exceeds the wrap width, cells wrap (Glamour's default); the renderer never emits a line longer than `W-4`. Acceptance: no line in any frame exceeds terminal width (automatable on frame dumps).

### 30.5 Lists & quotes
Glamour defaults with the theme above. Nested lists indent 2 per level. Quotes are `Meta` italic — visually "someone else said this," same register as reasoning.

### 30.6 Tool output
Never markdown-rendered (tool results are data, not prose): raw text, `Meta`, first ≤3 lines, each `clampLen`-truncated to width. Diff-looking output gets line-tinted via `looksLikeDiff`/`renderDiffLine` (exists). Full output only in the `/tools` viewer.

### 30.7 Multiline input & wrapping
The textarea wraps internally (bubbles handles it); transcript wrapping uses `reflow()` (exists — rune-safe, test-pinned) at the content column: continuation lines align to col 2, results to col 4. **Wrapping is never done by Lip Gloss `Width()`** on prose styles — `reflow` owns it, so ANSI sequences and double-width runes stay correct.

### 30.8 Streaming text
Tokens append to the last `TextBlock`; the batcher (§31.3) re-renders only from the last stable line down. Markdown is re-rendered *per completed block, on stream end* — during streaming the tail renders as plain `Text` (markdown of a half-open code fence is garbage; Claude Code does the same). On `StreamDoneMsg` the block re-renders once through Glamour and replaces the plain tail. NO_COLOR: `lipgloss.SetColorProfile(termenv.Ascii)` once at startup when `NO_COLOR` is set — every style collapses globally; no per-style handling.

---

## 31. Animation Rules

The complete animation inventory. Anything animated that is not in this table is a spec violation.

| # | Animation | Spec | Implementation |
|---|---|---|---|
| 31.1 | Cursor `▍` | static (no blink) while streaming; removed on done | appended glyph in the tail render; no timer |
| 31.2 | Spinner | braille frames, 80 ms/frame, `Accent`; shown in exactly one place per frame | one `spinner.Model`; `spinner.TickMsg` re-issued only in states that display it |
| 31.3 | Stream cadence | render ≤ once per 33 ms (30 fps) regardless of token rate | tokens accumulate in a buffer on `App`; a `frameTick` Cmd fires at 33 ms while streaming; `Update` flushes buffer → viewport. No per-token `SetContent`. |
| 31.4 | Flash timeout | 5 s TTL, then footer reverts to hint | expiry checked on spinner/frame ticks (exists) — no dedicated timer |
| 31.5 | Progress updates | download/progress lines re-render at most 4×/s; figures only (`38% · 1.6/4.1 GB · 12 MB/s`), no bar characters, no ETA guesses | progress msgs coalesce in Update; render gated by last-render timestamp on the model (time from msgs, not `time.Now` in View) |
| 31.6 | Thinking indicator | spinner replaces `▸` while reasoning streams; elapsed appended after 3 s; `still working` note at 15 s with zero tokens | same shared spinner; thresholds computed from `thinkingStarted` timestamp against tick msg time |
| 31.7 | Idle | **zero animation.** No spinner, no ticks except the 30 s status poll | entering Idle cancels the spinner ticker; acceptance test asserts no scheduled ticks (§22 #11) |

Rule of thumb: every animation encodes *progress or liveness*; nothing moves to look alive. No easing, no fades (terminals can't), no marquee text, no typewriter effects on non-streamed text.

---

## 32. Design Constraints — what must NOT exist

Hard bans. A PR introducing any of these is rejected regardless of how good it looks.

1. **No nested boxes.** Nothing draws a box; therefore nothing nests one. `⎿` is the only parent-child visual.
2. **No dashboards.** No screen whose purpose is "glance at many numbers." Status lives in `/status` (transcript text) and the header.
3. **No sidebars, no multiple panes, no splits.** One column, ever. tmux users already have tmux.
4. **No emoji.** The glyph table (§25.3) is the complete inventory. Not in tool lines, not in events, not in the wizard, not "just one 🎉" on setup completion.
5. **No gradients, no rainbow, no per-letter coloring.** Eight color tokens, used per §25.1.
6. **No decorative borders / rules / ASCII art** in steady state. The `✻` on welcome/wizard titles is the entire ornament budget.
7. **No floating windows / toasts / corner popups.** A terminal has no corners to own. Transient = footer; persistent = transcript line; modal = centered overlay.
8. **No popups except modal overlays**, and only the five in §27 (+ future overlays per §21's sanctioned path). Only one open at a time; Esc always closes.
9. **No painted backgrounds** (§25.1's single key-cap exception).
10. **No bell, no OS notifications** from the TUI.
11. **No typewriter/fade/marquee effects** (§31).
12. **No horizontal scrolling** anywhere; content wraps or truncates with `…`.
13. **No timestamps inline** in the transcript (overlay detail only).
14. **No second status bar.** The footer is the status line; the header is identity. A third chrome line may never exist.

Enforcement where automatable: grep-tests for `Border(`, `Background(` (count ≤1), box-drawing characters in frame dumps (§22 #3), non-ASCII bytes in `FERAL_ASCII` frames (§22 #19).

---

## 33. Claude Code Comparison

What Claude Code's TUI gets right, what we take, what we deliberately don't.

### What Claude Code does well (and we adopt)
- **The transcript is the app.** No chrome competes with the conversation. → §0.1, §4.
- **`⏺` tool lines with `⎿` child results** — tool activity reads as receipts, not as UI. → §8 verbatim shape.
- **Color-as-status on the tool mark** (running/done/error) so state is legible pre-reading. → §8.
- **Collapsed thinking with opt-in expansion** — reasoning is available, never imposed. → §9.
- **The footer as the single transient surface** (spinner, hints, interrupts). → §4, §15.
- **Esc as the universal "stop/close/back"** with a strict priority chain. → §16.
- **Ctrl+C double-press guard** protecting typed input. → §16.
- **Plain-text degradation** and terminal restoration discipline. → §18, §2 J9.

### What we deliberately do NOT copy
- **Permission-prompt-heavy flow.** Claude Code interrupts constantly for tool approval because its blast radius is your filesystem and shell. Feral's default tools are self-owned (memory, dreams, its own runtime); only shell/destructive ops gate (§8). Fewer interrupts is a *feature of the domain*, not laxity.
- **Todo lists / plan mode / task UI.** Claude Code is a coding agent; work-decomposition UI earns its lines there. Feral is a companion — task scaffolding UI would be cosplay. If the agent plans, it says so in prose.
- **Model/cost telemetry in the transcript** (context %, cost lines). Feral is local-first and free by default; cost anxiety UI is anti-brand. Context pressure surfaces once, dimly, at 80% (§2 J7).
- **The `✳` busy-banner line with rotating verbs** ("Reticulating…"). Charming once, noise forever. Our footer says what is actually happening (`thinking · 4 s`, `running read_file…`) — honesty over whimsy.
- **Markdown-rendered *user* input.** User turns render plain (§6) — what you typed is what you see.

### Where Feral must be different (not just trimmed)
- **Runtime events are first-class.** Claude Code has no background organism; Feral does (dreams, genomes, LoRA, connectors). The `◦` event line (§11) has no Claude Code equivalent — it is Feral's signature element: *the visible heartbeat of a self-improving system, at one dim line of cost.*
- **The header is an organism status, not a session label:** model · lora · backend · liveness — it answers "what brain is running right now," which in Feral can change mid-session (§10).
- **Setup wizard for non-tech users** (§13). Claude Code assumes a developer; Feral's primary audience isn't. The wizard is part of the product, not an installer afterthought.
- **Brand voice:** warm palette (orange/warm-gray on the terminal's own dark), lowercase headings, `✻` welcome mark — quiet warmth vs Claude Code's utilitarian neutrality.

---

## 34. Bubble Tea Best Practices (binding, not advisory)

1. **Never rebuild the viewport per token.** Buffer tokens, flush at 33 ms (§31.3), and `SetContent` only when content changed (prev-hash guard, exists). The current `buildChatContent` full-transcript rebuild is the known violation — P2 removes it.
2. **Cache rendered blocks.** Each `Turn` caches its rendered string keyed by `(width, dirty)` (`renderMarkdownCached`, exists — extend to all block types). A 500-message transcript re-renders only the streaming tail; scrolling renders from cache. This *is* the virtualization plan: cache + `strings.Join` of visible slice + margin.
3. **FollowBottom, not GotoBottom-always.** Auto-scroll only when the user was at bottom (implemented, regression-tested — keep the test).
4. **Time enters as messages.** `View` and renderers never call `time.Now()`; elapsed values are computed in `Update` against tick-msg timestamps and stored on the model. This keeps `View` pure and frame-dump tests deterministic.
5. **No goroutine touches the model.** SSE readers → channels → Cmds → msgs (§24.5). `Program.Send` is the only cross-thread door.
6. **Cmds for anything ≥1 ms.** HTTP, disk, even session-file writes.
7. **One tick source per concern**, and ticks only while their state needs them: spinner tick (active states only), frame tick (streaming only), status poll (5 s / 30 s Idle). Idle = zero timers (§31.7).
8. **Resize is a full-invalidate:** drop all width-keyed caches, reflow, one full redraw. Everything else is incremental.
9. **Restore the terminal on every exit path.** `tea.WithAltScreen` handles clean exits; a deferred recover + `p.Kill()`/manual `termenv` restore handles panics (§2 J9 acceptance: SIGSEGV leaves a sane shell).
10. **Test on frame dumps.** `TestPrintScreens` + string-assertion tests (exist) are the harness: every new visual element ships with a frame assertion, ANSI-stripped via the existing helper.

---

## 35. Future-proofing — how upcoming systems appear without redesign

Every future surface maps to one of exactly three existing vehicles: **header segment** (ambient identity), **`◦` event line** (receipts), **slash command → transcript text or overlay** (on-demand detail). Nothing below adds a zone, a pane, or a new visual primitive — that is the test of §21 ("if it touches §4, the design has failed").

| System | Ambient (header) | Receipt (◦ line) | On-demand (command) |
|---|---|---|---|
| **L4 architecture evolution** | — | `◦ genome: L4 arch candidate accepted (fitness 0.79 → 0.81)` | `/genome` row |
| **L5 governance** | — | `◦ governance: policy wall updated — 2 rules tightened` | `/genome` or `/meta` detail |
| **L6 meta evolution** | — | `◦ meta: epoch 8 — exploration budget +5%` (§28.9) | `/meta` |
| **Dreams** | — | `◦ dream: 2 insights added to memory` (§28.7) | `/dream`, `/dream now` |
| **LoRA** | `lora personal-v3` segment (exists) | `◦ lora: eval +4.2% — approve in /lora` | `/lora` + y/n approval footer |
| **FMS (fractal memory)** | — | `◦ indexing memory… done (12 s)` | `/memory`, `/memory search <q>` (renders as a §8 tool line) |
| **BRSI / code-RSI** | — | `◦ rsi: proposal pending — feral rsi to review` (approval stays in the CLI/desktop, not the chat TUI) | `/status` detail |
| **Connectors** | — | `◦ telegram: reply sent to @dan` (§28.10) | `/connectors [reload]` |
| **MCP tools** | — | tool line, not event: `⏺ mcp:linear.create_issue(…)` → `⎿ FER-142 created` | `/tools` viewer |
| **Brain Stack routing** | backend segment live-switches (`local · vulkan` ⇄ `cloud · minimax`) | `◦ routed to minimax-m3 (long-context task)` | `/providers` health list |

Implementation cost of each future row, by design: **one entry in the `RuntimeEventMsg.kind → formatter` map** (receipts), **zero** for header (it renders whatever `/runtime/status` reports), **one `KnownCommands` entry + one dispatcher case** (commands). Unknown event kinds already render as `◦ <kind>` (§21) — so a gateway that ships L7 before the TUI updates degrades to a dim, honest, unstyled receipt instead of breaking.

The invariant to protect: **Feral can grow a whole new organ and the TUI's answer is one dim line and one slash command.** The day that stops being enough is the day to write a new spec — not to bolt a panel onto this one.
