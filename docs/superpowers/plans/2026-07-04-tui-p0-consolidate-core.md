# Feral TUI — P0 "Consolidate the Core" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close P0's gaps in the Go/Bubble Tea TUI at `tui/` per `docs/2026-07-04-feral-tui-spec.md` §23 P0: a real `State` enum driving the footer/input, a centralized glyph table with ASCII/NO_COLOR support, the Esc-priority chain + Ctrl+C double-press guard + input history, 30fps streaming batching with an `◦ interrupted` line, and error cards for the top 4 `§14` rows. Ship P0's acceptance subset (spec §22 items 1–8, 12–17, 18–19) before any P1 work starts.

**Architecture:** Pure additive/refactor work inside the existing Elm-architecture (`tea.Model`) app — one `App` struct, one `Update`, one pure `View`. No new packages beyond `tui/ui/glyphs.go`; no new goroutines; no new dependencies (stdlib + existing bubbletea/lipgloss/bubbles only).

**Tech Stack:** Go, Bubble Tea, Lip Gloss, Glamour (unchanged).

## Global Constraints

- No `lipgloss.Color`/hex literal or magic glyph string may appear directly in `tui/app/*.go` — glyphs come from `ui.G.*` (§25.3), colors from the existing `tui/ui/styles.go` tokens (§25.1). Enforced by the grep tests in Task 7.
- No new `.Border(...)` or `.Background(...)` calls (existing count: 0 borders, 1 background — `KbdStyle`). Do not raise either count.
- Every animation must map to one of spec §31's rows; do not add a timer/ticker that isn't in that table.
- `View()` and its renderers never call `time.Now()` freshly for *new* timers — reuse the existing pattern already in this codebase of computing `time.Since(storedTimestamp)` inline (this repo does not yet follow spec §34.4's "time enters as messages" purism; do not invent a new message-passing mechanism for this in P0 — that is a larger refactor out of scope here).
- Keep all 5 existing test files (`view_render_test.go`, `overlay_test.go`, `completions_test.go`, `visual_smoke_test.go`, `view_test.go`) green throughout. Where a test references `a.Mode`/`ModeStreaming`, it is updated in the same task that renames the type — never left broken between tasks.

## Filed discrepancies (spec vs. code — not fixed by this plan, noted per spec's own §0.6 instruction to "follow the code... and file a discrepancy note")

1. **Transcript layout mismatch.** Spec §4/§6/§25.2 describes the *current* transcript as "2-space indent, dim `›` gutter" for user turns and no per-role tag. The actual code (`tui/app/model.go` `buildChatContent`) still renders two-column tags (`ui.TagYou`/`ui.TagFeral`, `"you"`/`"◆ feral"`, `TagWidth=9`) — the "flatten pass" removed borders/backgrounds but not the tag columns. This migration is not in P0's explicit bullet list (§23), so it is **out of scope for this plan**. Flagged for the next phase that touches `buildChatContent` (P2 already plans to rewrite it for virtualization — natural place to land the gutter migration too).
2. **Overlay `─` dividers.** `renderToolViewerOverlay`/`renderModelPickerOverlay` draw manual `─` rule lines as section dividers. Spec §22 acceptance #3 reads literally as "no box-drawing chars anywhere." This plan's Task 7 grep-test scopes acceptance #3 to the **steady-state frame only** (header/transcript/input/footer with no overlay open) — the separator between chat and input (§4) is fixed to a blank line in Task 2, which is the concrete, contained violation. Overlay divider cleanup is deferred to whenever the overlays are next touched (not named in P0's bullets).
3. **`StateThinking`, `StateToolRunning`, `StateIdle` are declared but not transitioned into.** This plan's `handleSubmit` goes `Ready → Streaming` directly (no pre-first-token `Thinking` phase); per-tool status stays on `ToolCall.Status`, not a global `ToolRunning` FSM state; and there is no 60s-idle timer. Wiring those three is P1 ("Tool UX polish") and P2 (§22 acceptance #11, "Idle state runs zero animation timers," is explicitly assigned to P2's subset, not P0's) territory — not named in P0's bullets. §22 acceptance #12 ("every state reachable, footer text matches the table") is satisfied by this plan only for the states P0 actually enters: `Ready, Streaming, Error, Recovery, Shutdown`.
4. **Full gateway-restart recovery loop (§14 "runtime lost" row).** The TUI has no channel today to observe or trigger an actual gateway restart (that lives in `feral-cli`/gateway process management, not `tui/`). This plan implements the *classification + static hint* for `runtime_lost`/`offline` kinds, and a real client-side countdown+auto-retry for `rate_limited` (fully observable/actionable from the TUI alone). The bounded-3-attempts auto-restart described in §14 needs `/events` SSE (P1) or a gateway-side hook; tracked as P1 follow-up, not silently dropped.

---

### Task 1: `State` enum replacing `Mode`

**Files:**
- Create: `tui/app/state.go`
- Create: `tui/app/state_test.go`
- Modify: `tui/app/model.go` (remove `Mode` type/consts, add `State` field, retarget `IsStreaming`)
- Modify: `tui/app/update.go` (every `a.Mode`/`ModeEditing`/`ModeStreaming`/`ModeQuitting` reference)
- Modify: `tui/app/view_render_test.go:64` (`a.Mode = ModeStreaming` → `a.State = StateStreaming`)
- Modify: `tui/app/visual_smoke_test.go:53,63` (same rename)

**Interfaces:**
- Produces: `type State int` with consts `StateBoot, StateInitializing, StateLoadingRuntime, StateDetectingHardware, StateDownloadingModel, StateLoadingModel, StateLoadingMemory, StateReady, StateThinking, StateStreaming, StateToolRunning, StateWaiting, StateIdle, StateError, StateRecovery, StateShutdown` (spec §3 table, in table order). Method `func (s State) FooterHint() string`.
- Produces: `App.State State` field (replaces `App.Mode Mode`).
- Consumes (later tasks): Task 4 adds `StateWaiting`-adjacent Ctrl-C/Esc handling; Task 5 transitions into/out of `StateThinking`/`StateStreaming`/`StateToolRunning`; Task 6 transitions into `StateError`/`StateRecovery`; Task 4 also sets `StateShutdown` before quitting.

- [ ] **Step 1: Write the failing test**

```go
// tui/app/state_test.go
package app

import "testing"

func TestStateFooterHintMatchesSpecTable(t *testing.T) {
	cases := []struct {
		state State
		want  string
	}{
		{StateReady, "F1 for shortcuts · Ctrl+C to exit"},
		{StateThinking, "thinking…"},
		{StateStreaming, "esc to interrupt"},
		{StateToolRunning, "running…"},
		{StateIdle, "F1 for shortcuts · Ctrl+C to exit"},
		{StateRecovery, "reconnecting…"},
	}
	for _, c := range cases {
		if got := c.state.FooterHint(); got != c.want {
			t.Fatalf("State(%d).FooterHint() = %q, want %q", c.state, got, c.want)
		}
	}
}

func TestNewAppStartsReady(t *testing.T) {
	a := newTestApp()
	if a.State != StateReady {
		t.Fatalf("newTestApp() State = %v, want StateReady", a.State)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tui && go test ./app/... -run 'TestStateFooterHintMatchesSpecTable|TestNewAppStartsReady' -v`
Expected: build failure — `State`/`StateReady`/etc. undefined.

- [ ] **Step 3: Create the State enum**

```go
// tui/app/state.go
package app

// State is the single top-level FSM (spec §3) that drives what the footer
// and input show. Renderers switch on State; no other field on App may
// shadow what State already encodes ("boolean soup" is banned by §3).
//
// StateLoadingRuntime, StateDetectingHardware, StateDownloadingModel,
// StateLoadingModel, and StateLoadingMemory are wizard/first-run states
// (spec §13, phase P3). They are declared here for completeness with the
// spec's exhaustive table but are unreachable until the Setup Wizard lands —
// main.go's synchronous preflight (gateway-up check, status fetch) currently
// happens before the Bubble Tea program even starts, so this app never
// observes Boot/Initializing/LoadingRuntime today either. New() starts
// directly in StateReady.
type State int

const (
	StateBoot State = iota
	StateInitializing
	StateLoadingRuntime
	StateDetectingHardware
	StateDownloadingModel
	StateLoadingModel
	StateLoadingMemory
	StateReady
	StateThinking
	StateStreaming
	StateToolRunning
	StateWaiting
	StateIdle
	StateError
	StateRecovery
	StateShutdown
)

// FooterHint returns the default footer text for a state per spec §3's
// table. States whose footer needs live data (Error's kind/hint, Recovery's
// attempt count, DownloadingModel's progress line) are rendered by
// dedicated functions in view.go that call this only as their fallback.
func (s State) FooterHint() string {
	switch s {
	case StateBoot:
		return "starting…"
	case StateInitializing:
		return "connecting to runtime"
	case StateLoadingRuntime:
		return "starting runtime…"
	case StateDetectingHardware:
		return "detecting hardware…"
	case StateLoadingModel:
		return "loading model…"
	case StateLoadingMemory:
		return "loading memory…"
	case StateReady, StateIdle:
		return "F1 for shortcuts · Ctrl+C to exit"
	case StateThinking:
		return "thinking…"
	case StateStreaming:
		return "esc to interrupt"
	case StateToolRunning:
		return "running…"
	case StateWaiting:
		return "waiting for approval — y/n"
	case StateRecovery:
		return "reconnecting…"
	default:
		return ""
	}
}
```

- [ ] **Step 4: Migrate `App` and all references**

In `tui/app/model.go`, delete the `Mode`/`ModeEditing`/`ModeStreaming`/`ModeQuitting` block (lines 17-26 today: `type Mode int` and the `const` block) and change the `App` struct field:

```go
// before: Mode  Mode
State State
```

Retarget:

```go
func (a *App) IsStreaming() bool { return a.State == StateStreaming }
```

`New()` sets the initial state:

```go
return &App{
	Status:       status,
	BaseURL:      baseURL,
	Token:        token,
	Input:        ti,
	ChatVP:       vp,
	Loader:       sp,
	StartedAt:    time.Now(),
	FollowBottom: true,
	Cwd:          cwd,
	State:        StateReady,
}
```

In `tui/app/update.go`, replace every occurrence (mechanical, same meaning, needed just to keep the package compiling — deleting the `Mode` type means every reference must go in this same task):
- `a.Mode == ModeQuitting` → `a.State == StateShutdown`
- `a.Mode == ModeStreaming` → `a.State == StateStreaming`
- `a.Mode = ModeQuitting` → `a.State = StateShutdown`
- `a.Mode = ModeStreaming` → `a.State = StateStreaming`
- `a.Mode != ModeEditing` → `a.State != StateReady`
- `a.Mode == ModeEditing` → `a.State == StateReady`
- `a.Mode = ModeEditing` → `a.State = StateReady`

This is a **provisional** mapping for the `esc` case and the post-switch input gate — good enough to compile and keep today's (buggy) behavior unchanged for one commit. Task 4 immediately rewrites both: today, Esc does nothing during streaming (no interrupt) and quits the app on a bare press with no overlay open, and the post-switch gate would newly block typing whenever `StateError` is set once Task 6 introduces that state (errors must never disable input per spec §14) — none of that is spec-correct per §16, and Task 4 fixes it in the same file it's already touching for the double-press guard. Don't hand-wring over the intermediate state here; it's one commit that keeps `go build` green, immediately corrected next.

In `tui/app/view_render_test.go:64`: `a.Mode = ModeStreaming` → `a.State = StateStreaming`.
In `tui/app/visual_smoke_test.go:53` and `:63`: same rename.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tui && go build ./... && go test ./... -v`
Expected: PASS, including the two new tests. (`toolsRunning()`/other `Mode`-adjacent logic is untouched — only the enum backing changed.)

- [ ] **Step 6: Commit**

```bash
git add tui/app/state.go tui/app/state_test.go tui/app/model.go tui/app/update.go tui/app/view_render_test.go tui/app/visual_smoke_test.go
git commit -m "feat(tui): replace ad-hoc Mode with spec-driven State enum"
```

---

### Task 2: Glyph table + ASCII mode + fix the separator/cursor glyphs

**Files:**
- Create: `tui/ui/glyphs.go`
- Create: `tui/ui/glyphs_test.go`
- Modify: `tui/ui/styles.go` (strip baked-in `SetString` glyphs from styles; keep colors only)
- Modify: `tui/app/view.go` (replace every literal glyph with `ui.G.*`; replace the `─` separator with a blank line per §4)
- Modify: `tui/app/model.go` (`buildChatContent`'s literal glyphs → `ui.G.*`)

**Interfaces:**
- Produces: `ui.GlyphSet` type, `ui.Unicode`/`ui.Ascii` vars, `ui.G` (the picked set), `ui.G.Pick(env func(string) string) GlyphSet` (exported for testing without mutating process env).
- Consumes: Task 1's `State` type is unaffected by this task; Task 5/6 will use `ui.G.Event`/`ui.G.Cursor` etc.

- [ ] **Step 1: Write the failing test**

```go
// tui/ui/glyphs_test.go
package ui

import "testing"

func TestPickDefaultsToUnicode(t *testing.T) {
	env := map[string]string{}
	g := pickWith(func(k string) string { return env[k] })
	if g.ToolMark != "⏺" {
		t.Fatalf("default ToolMark = %q, want ⏺", g.ToolMark)
	}
}

func TestPickASCIIViaEnv(t *testing.T) {
	env := map[string]string{"FERAL_ASCII": "1"}
	g := pickWith(func(k string) string { return env[k] })
	if g.ToolMark != "*" {
		t.Fatalf("FERAL_ASCII=1 ToolMark = %q, want *", g.ToolMark)
	}
	if g.Cursor != "|" || g.Prompt != ">" {
		t.Fatalf("ascii set not fully applied: %+v", g)
	}
}

func TestPickASCIIViaDumbTerm(t *testing.T) {
	env := map[string]string{"TERM": "dumb"}
	g := pickWith(func(k string) string { return env[k] })
	if g.ToolMark != "*" {
		t.Fatalf("TERM=dumb ToolMark = %q, want *", g.ToolMark)
	}
}

// noAsciiByte asserts every rune in every field (and every spinner frame)
// of the Ascii set is < 128 — the automatable half of spec §22 acceptance
// #19 (FERAL_ASCII=1 emits zero non-ASCII bytes).
func TestAsciiSetIsPureASCII(t *testing.T) {
	check := func(name, s string) {
		for _, r := range s {
			if r > 127 {
				t.Fatalf("Ascii.%s contains non-ASCII rune %q", name, r)
			}
		}
	}
	check("Prompt", Ascii.Prompt)
	check("ToolMark", Ascii.ToolMark)
	check("Result", Ascii.Result)
	check("ThinkClosed", Ascii.ThinkClosed)
	check("ThinkOpen", Ascii.ThinkOpen)
	check("On", Ascii.On)
	check("Off", Ascii.Off)
	check("Event", Ascii.Event)
	check("Spark", Ascii.Spark)
	check("OK", Ascii.OK)
	check("Err", Ascii.Err)
	check("Down", Ascii.Down)
	check("Up", Ascii.Up)
	check("Ellipsis", Ascii.Ellipsis)
	check("Cursor", Ascii.Cursor)
	for i, f := range Ascii.Spinner {
		check("Spinner["+string(rune('0'+i))+"]", f)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tui && go test ./ui/... -run 'TestPick|TestAsciiSetIsPureASCII' -v`
Expected: build failure — `pickWith`/`GlyphSet`/`Ascii`/`Unicode` undefined.

- [ ] **Step 3: Create the glyph table**

```go
// tui/ui/glyphs.go
package ui

import (
	"os"
	"strings"
)

// GlyphSet is the complete glyph inventory (spec §5/§25.3). Renderers use
// ui.G.X, never a literal glyph — this is the entire ASCII-mode
// implementation: one table, one switch, zero scattered literals.
type GlyphSet struct {
	Prompt      string // ›  / >
	ToolMark    string // ⏺  / *
	Result      string // ⎿  / `-
	ThinkClosed string // ▸  / +
	ThinkOpen   string // ▾  / -
	On          string // ●  / o
	Off         string // ○  / .
	Event       string // ◦  / -
	Spark       string // ✻  / *
	OK          string // ✓  / ok
	Err         string // ✗  / x
	Down        string // ↓  / v
	Up          string // ↑  / ^
	Ellipsis    string // …  / ...
	Cursor      string // ▍  / |
	Spinner     []string
}

var Unicode = GlyphSet{
	Prompt: "›", ToolMark: "⏺", Result: "⎿", ThinkClosed: "▸", ThinkOpen: "▾",
	On: "●", Off: "○", Event: "◦", Spark: "✻", OK: "✓", Err: "✗",
	Down: "↓", Up: "↑", Ellipsis: "…", Cursor: "▍",
	Spinner: []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"},
}

var Ascii = GlyphSet{
	Prompt: ">", ToolMark: "*", Result: "`-", ThinkClosed: "+", ThinkOpen: "-",
	On: "o", Off: ".", Event: "-", Spark: "*", OK: "ok", Err: "x",
	Down: "v", Up: "^", Ellipsis: "...", Cursor: "|",
	Spinner: []string{"|", "/", "-", "\\"},
}

// pickWith selects Ascii when FERAL_ASCII=1, TERM=dumb, or the locale isn't
// UTF-8 — env is injected so tests don't need to mutate process env.
func pickWith(env func(string) string) GlyphSet {
	if env("FERAL_ASCII") == "1" {
		return Ascii
	}
	if env("TERM") == "dumb" {
		return Ascii
	}
	locale := env("LC_ALL")
	if locale == "" {
		locale = env("LANG")
	}
	if locale != "" && !strings.Contains(strings.ToUpper(locale), "UTF-8") &&
		!strings.Contains(strings.ToUpper(locale), "UTF8") {
		return Ascii
	}
	return Unicode
}

// G is the process-wide picked glyph set, resolved once at package init
// from the real environment.
var G = pickWith(os.Getenv)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tui && go test ./ui/... -run 'TestPick|TestAsciiSetIsPureASCII' -v`
Expected: PASS.

- [ ] **Step 5: Strip baked-in glyphs from styles.go**

In `tui/ui/styles.go`, remove `.SetString(...)` from the styles that currently bake a glyph in, so glyph and color decouple (spec §25.3's migration note). Replace:

```go
// before:
StatusOnline  = lipgloss.NewStyle().Foreground(Ok).SetString("●")
StatusOffline = lipgloss.NewStyle().Foreground(Fail).SetString("●")
...
Cursor   = lipgloss.NewStyle().Foreground(Accent).SetString("▌")
...
ToolMark   = lipgloss.NewStyle().SetString("⏺")
ToolResult = lipgloss.NewStyle().Foreground(Meta).SetString("⎿")
...
ThinkingHeader    = lipgloss.NewStyle().Foreground(Meta).SetString("▾ thinking")
...
ThinkingCollapsed = lipgloss.NewStyle().Foreground(Meta).SetString("▸ thinking…")
...
InputPrompt      = lipgloss.NewStyle().Foreground(Accent).SetString("›")
```

with (color-only, no glyph baked in):

```go
StatusOnline  = lipgloss.NewStyle().Foreground(Ok)
StatusOffline = lipgloss.NewStyle().Foreground(Fail)
...
Cursor   = lipgloss.NewStyle().Foreground(Accent)
...
ToolMark   = lipgloss.NewStyle()
ToolResult = lipgloss.NewStyle().Foreground(Meta)
...
ThinkingHeader    = lipgloss.NewStyle().Foreground(Meta)
...
ThinkingCollapsed = lipgloss.NewStyle().Foreground(Meta)
...
InputPrompt      = lipgloss.NewStyle().Foreground(Accent)
```

Every call site that used `.String()` on these styles to get the baked-in glyph (e.g. `ui.ToolMark.String()`, `ui.StatusOnline.String()`, `ui.Cursor.String()`, `ui.InputPrompt.String()`, `ui.ThinkingCollapsed.String()`, `ui.ThinkingHeader.String()`, `ui.ToolResult.String()`) now must render `ui.STYLE.Render(ui.G.X)` explicitly — done in Step 6/7 below.

- [ ] **Step 6: Update `view.go` call sites and remove the `─` separator**

In `tui/app/view.go`:

```go
// before (line 56):
sep := ui.SeparatorStyle.Render(strings.Repeat("─", a.Width))
```
```go
// after — spec §4: "separator — one blank line (NOT a rule/border)"
sep := ""
```

```go
// before (renderHeader, lines 239-243):
dot := ui.StatusOffline.String()
state := "no sidecar"
if a.Status.Online {
	dot = ui.StatusOnline.String()
	state = "online"
}
```
```go
// after:
dot := ui.StatusOffline.Render(ui.G.On)
state := "no sidecar"
if a.Status.Online {
	dot = ui.StatusOnline.Render(ui.G.On)
	state = "online"
}
```
(Note: both branches render `ui.G.On` — spec §3/§18 carry offline-vs-online via the accompanying *word* ("online"/"no sidecar") plus color, not via `●` vs `○`; keep the existing word-based distinction, just fix the glyph source. `ui.StatusOffline` is `Fail`-colored so NO_COLOR readers still lose nothing per §18's acceptance line — the word carries it.)

```go
// before (renderInput, lines 268-278): ui.InputPrompt.String()
return ui.InputStyle.Width(a.Width).Height(h).Render(ui.InputPrompt.String() + " " + placeholder)
...
return ui.InputStyle.Width(a.Width).Height(h).Render(ui.InputPrompt.String() + " " + a.Input.View())
```
```go
// after:
return ui.InputStyle.Width(a.Width).Height(h).Render(ui.InputPrompt.Render(ui.G.Prompt) + " " + placeholder)
...
return ui.InputStyle.Width(a.Width).Height(h).Render(ui.InputPrompt.Render(ui.G.Prompt) + " " + a.Input.View())
```

```go
// before (renderWelcomeContent, line 98):
lines = append(lines, ui.WelcomeTagline.Render("✻ feral chat"))
```
```go
// after:
lines = append(lines, ui.WelcomeTagline.Render(ui.G.Spark+" feral chat"))
```

```go
// before (renderWelcomeSessions, line 167): "  ▸ %s   %s"
out = append(out, fmt.Sprintf("  ▸ %s   %s", ...))
```
```go
// after:
out = append(out, fmt.Sprintf("  %s %s   %s", ui.G.ThinkClosed, ...))
```

```go
// before (formatToolViewerRow, line 563): ui.ToolMark.String()
return fmt.Sprintf("%s %s%s   %s", ui.ToolMark.String(), name, arg, elapsed)
```
```go
// after:
return fmt.Sprintf("%s %s%s   %s", ui.ToolMark.Render(ui.G.ToolMark), name, arg, elapsed)
```

```go
// before (formatToolViewerPreview, line 585): " ▸ result ──"
out = append(out, ui.ToolViewerMeta.Render(" ▸ result ──"))
```
```go
// after:
out = append(out, ui.ToolViewerMeta.Render(" "+ui.G.ThinkClosed+" result --"))
```

```go
// before (renderToolPill, lines 833-839):
mark := statusStyle.Render(ui.ToolMark.String())
tail := statusStyle.Render(fmt.Sprintf("⏱ %s %s", elapsed, statusGlyph))
first := fmt.Sprintf("%s %s%s  %s", mark, name, arg, tail)
out := []string{first}
if t.Note != "" {
	out = append(out, "  "+ui.ToolResult.String()+" "+ui.ToolNote.Render(t.Note))
}
if t.Status == ToolError && t.ErrMsg != "" {
	out = append(out, "  "+ui.ToolResult.String()+" "+ui.ToolError.Render(t.ErrMsg))
}
```
```go
// after:
mark := statusStyle.Render(ui.ToolMark.Render(ui.G.ToolMark))
tail := statusStyle.Render(fmt.Sprintf("⏱ %s %s", elapsed, statusGlyph))
first := fmt.Sprintf("%s %s%s  %s", mark, name, arg, tail)
out := []string{first}
if t.Note != "" {
	out = append(out, "  "+ui.ToolResult.Render(ui.G.Result)+" "+ui.ToolNote.Render(t.Note))
}
if t.Status == ToolError && t.ErrMsg != "" {
	out = append(out, "  "+ui.ToolResult.Render(ui.G.Result)+" "+ui.ToolError.Render(t.ErrMsg))
}
```
And the `t.Preview` branch a few lines below (line 847): `"  "+ui.ToolResult.String()+" "` → `"  "+ui.ToolResult.Render(ui.G.Result)+" "`.

```go
// before (collapsedToolSummary, line 811):
ui.ToolDone.Render(ui.ToolMark.String()),
```
```go
// after:
ui.ToolDone.Render(ui.ToolMark.Render(ui.G.ToolMark)),
```

```go
// before (renderErrorCard, line 684): "⏺ error"
mark := ui.ErrorTitle.Render("⏺ error")
```
```go
// after:
mark := ui.ErrorTitle.Render(ui.G.ToolMark + " error")
```

- [ ] **Step 7: Update `model.go`'s `buildChatContent` glyph literals**

```go
// before (lines 374, 386, 405-406):
b.WriteString(gutter + ui.ThinkingHeader.String())
...
b.WriteString(gutter + ui.ThinkingCollapsed.String() + " " + first)
...
if turn.Streaming && i == len(lines)-1 {
	line += ui.Cursor.String()
}
```
```go
// after:
b.WriteString(gutter + ui.ThinkingHeader.Render(ui.G.ThinkOpen+" thinking"))
...
b.WriteString(gutter + ui.ThinkingCollapsed.Render(ui.G.ThinkClosed+" thinking…") + " " + first)
...
if turn.Streaming && i == len(lines)-1 {
	line += ui.Cursor.Render(ui.G.Cursor)
}
```

```go
// before (line 448): "✻ "+turn.Meta
b.WriteString(gutter + ui.MetaStyle.Render("✻ "+turn.Meta))
```
```go
// after:
b.WriteString(gutter + ui.MetaStyle.Render(ui.G.Spark+" "+turn.Meta))
```

- [ ] **Step 8: Run the full suite and eyeball the frame dump**

Run: `cd tui && go build ./... && go test ./... -v`
Expected: PASS. Then `go test ./app/... -run TestPrintScreens -v` and confirm no `─` rule line appears between the transcript and the input row, and the cursor renders as `▍` (or `|` under `FERAL_ASCII=1`).

- [ ] **Step 9: Commit**

```bash
git add tui/ui/glyphs.go tui/ui/glyphs_test.go tui/ui/styles.go tui/app/view.go tui/app/model.go
git commit -m "feat(tui): centralize glyphs into ui.G, add ASCII mode, fix flat separator"
```

---

### Task 3: NO_COLOR global switch

**Files:**
- Modify: `tui/ui/styles.go` (add NO_COLOR check to the existing `init()`)
- Create: `tui/ui/nocolor_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: process-wide color profile downgrade when `NO_COLOR` is set — no new exported symbol, this is a side effect of package init plus one exported helper for testability: `func ApplyNoColor(env func(string) string)`.

- [ ] **Step 1: Write the failing test**

```go
// tui/ui/nocolor_test.go
package ui

import (
	"strings"
	"testing"
)

// TestNoColorStripsAnsi is the automatable half of spec §22 acceptance #18:
// with NO_COLOR set, a rendered style must carry zero ANSI escape bytes.
func TestNoColorStripsAnsi(t *testing.T) {
	ApplyNoColor(func(k string) string {
		if k == "NO_COLOR" {
			return "1"
		}
		return ""
	})
	defer ApplyNoColor(func(string) string { return "" }) // reset for other tests

	out := ToolRunning.Render("x")
	if strings.Contains(out, "\x1b[") {
		t.Fatalf("expected no ANSI escapes under NO_COLOR, got %q", out)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tui && go test ./ui/... -run TestNoColorStripsAnsi -v`
Expected: FAIL — `ApplyNoColor` undefined, or (if it happened to compile against something else) the render still contains escapes.

- [ ] **Step 3: Implement**

In `tui/ui/styles.go`, add the import and the function, and call it once at package init:

```go
import (
	"os"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)
```

```go
// ApplyNoColor collapses every lipgloss style process-wide to plain
// text+bold when NO_COLOR is set (spec §18, §30.8) — one global switch,
// not per-style handling. env is injected so tests can exercise both
// branches without mutating the real process environment.
func ApplyNoColor(env func(string) string) {
	if env("NO_COLOR") != "" {
		lipgloss.SetColorProfile(termenv.Ascii)
	} else {
		lipgloss.SetColorProfile(termenv.TrueColor)
	}
}

func init() {
	ApplyNoColor(os.Getenv)

	r, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(10000),
	)
	if err == nil {
		glamourRenderer = r
	}
}
```

Add the `termenv` import — `github.com/muesli/termenv v0.16.0` is already in `tui/go.mod` as an indirect dependency (pulled in by lipgloss/bubbletea), so this adds no new dependency, just promotes it to direct on the next `go mod tidy`:

```go
import "github.com/muesli/termenv"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tui && go test ./ui/... -run TestNoColorStripsAnsi -v`
Expected: PASS. Then `go build ./...` to confirm the `termenv` import resolved.

- [ ] **Step 5: Commit**

```bash
git add tui/ui/styles.go tui/ui/nocolor_test.go tui/go.mod tui/go.sum
git commit -m "feat(tui): honor NO_COLOR globally via one color-profile switch"
```

---

### Task 4: Esc-priority chain rewrite + Ctrl+C double-press guard + Ctrl+D + input history

**Files:**
- Modify: `tui/app/model.go` (add `CtrlCArmedAt time.Time`, `InputHistory []string`, `HistoryIdx int` fields)
- Modify: `tui/app/update.go` (`esc` case rewrite, new `ctrl+d` case, Ctrl+C branch, `up`/`down` branch, post-switch input gate, `handleSubmit`)
- Create: `tui/app/history_test.go`

**Interfaces:**
- Produces: `App.pushHistory(raw string)` (unexported, called from `handleSubmit`), `App.historyUp()`/`App.historyDown()` (unexported, called from the `up`/`down` key branch when input is empty and no overlay is open), `App.handleCtrlC()`.
- Consumes: `App.State` (Task 1) to gate when Ctrl+C/Esc/Ctrl+D apply.

Spec §16's Esc row is a strict priority chain ending in **clear input**, not quit: "interrupt stream → dismiss overlay → dismiss completions → clear input." Quitting is Ctrl+C/Ctrl+D/`/exit`'s job (spec §2 J9). Task 1 left the `esc` case and the post-switch input gate on a provisional Mode→State rename that preserves today's actual (spec-incorrect) behavior — no stream interrupt on Esc, and Esc quits the app when nothing else is open. This task fixes both in the same pass as the rest of §16.

- [ ] **Step 1: Write the failing test**

```go
// tui/app/history_test.go
package app

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestPushHistoryDedupsConsecutive(t *testing.T) {
	a := newTestApp()
	a.pushHistory("hello")
	a.pushHistory("hello")
	a.pushHistory("world")
	if len(a.InputHistory) != 2 {
		t.Fatalf("expected 2 entries after consecutive dedup, got %d: %v", len(a.InputHistory), a.InputHistory)
	}
}

func TestPushHistoryCapsAt200(t *testing.T) {
	a := newTestApp()
	for i := 0; i < 250; i++ {
		a.pushHistory("msg" + string(rune('a'+i%26)) + string(rune(i)))
	}
	if len(a.InputHistory) != 200 {
		t.Fatalf("expected cap of 200, got %d", len(a.InputHistory))
	}
}

func TestHistoryUpDownWalksNewestFirst(t *testing.T) {
	a := newTestApp()
	a.pushHistory("first")
	a.pushHistory("second")
	a.Input.SetValue("")
	a.historyUp()
	if got := a.Input.Value(); got != "second" {
		t.Fatalf("first historyUp() = %q, want %q", got, "second")
	}
	a.historyUp()
	if got := a.Input.Value(); got != "first" {
		t.Fatalf("second historyUp() = %q, want %q", got, "first")
	}
	a.historyDown()
	if got := a.Input.Value(); got != "second" {
		t.Fatalf("historyDown() = %q, want %q", got, "second")
	}
}

func TestCtrlCFirstPressClearsInputSecondQuits(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("half-typed message")
	a.handleCtrlC()
	if a.Input.Value() != "" {
		t.Fatalf("first Ctrl+C should clear input, got %q", a.Input.Value())
	}
	if a.State == StateShutdown {
		t.Fatal("first Ctrl+C with text should not quit")
	}
	a.handleCtrlC()
	if a.State != StateShutdown {
		t.Fatal("second Ctrl+C within the grace window should quit")
	}
}

func TestCtrlCOnEmptyInputQuitsImmediately(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("")
	a.handleCtrlC()
	if a.State != StateShutdown {
		t.Fatal("Ctrl+C on empty input should quit on the first press")
	}
}

func TestEscDuringStreamingInterruptsNotQuits(t *testing.T) {
	// Only checks that Esc calls the stop path and never quits — the
	// resulting "◦ interrupted" transcript line is asserted once Task 5
	// adds the Turn.Interrupted field and wires stopStream() to set it;
	// since this test drives Esc through the same stopStream() call,
	// Task 5's change covers this path automatically without a retest here.
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if a.State == StateShutdown {
		t.Fatal("Esc during streaming should interrupt, not quit")
	}
	if a.State == StateStreaming {
		t.Fatal("Esc during streaming should leave StateStreaming (stopStream finishes the turn)")
	}
}

func TestEscWithNothingOpenClearsInputNotQuit(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("some text")
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if a.Input.Value() != "" {
		t.Fatalf("Esc should clear input, got %q", a.Input.Value())
	}
	if a.State == StateShutdown {
		t.Fatal("a bare Esc must never quit the app (spec §16 — that's Ctrl+C/Ctrl+D's job)")
	}
}

func TestEscOnEmptyInputDoesNotQuit(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("")
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if a.State == StateShutdown {
		t.Fatal("Esc on empty input must not quit either")
	}
}

func TestCtrlDQuitsOnlyOnEmptyInput(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("typing")
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyCtrlD})
	if a.State == StateShutdown {
		t.Fatal("Ctrl+D with text present should be a no-op")
	}
	a.Input.SetValue("")
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyCtrlD})
	if a.State != StateShutdown {
		t.Fatal("Ctrl+D on empty input should quit")
	}
}
```

(These four exercise `Update` end-to-end rather than calling a handler directly, since the bug being fixed is in the key-routing itself. They need `tea "github.com/charmbracelet/bubbletea"` imported in `history_test.go`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tui && go test ./app/... -run 'TestPushHistory|TestHistoryUpDown|TestCtrlC|TestEsc' -v`
Expected: build failure — `pushHistory`/`historyUp`/`historyDown`/`handleCtrlC` undefined. Once those compile (after Step 3), `TestEscDuringStreamingInterruptsNotQuits`/`TestEscWithNothingOpenClearsInputNotQuit`/`TestCtrlDQuitsOnlyOnEmptyInput` still FAIL until Step 5 rewrites the `esc`/`ctrl+d` handling.

- [ ] **Step 3: Add fields**

In `tui/app/model.go`'s `App` struct, add:

```go
// CtrlCArmedAt is non-zero for 1s after a Ctrl+C press that only cleared
// the input (rather than quitting) — a second press before it lapses
// quits, mirroring Claude Code (spec §16).
CtrlCArmedAt time.Time

// InputHistory is up to the last 200 distinct-from-previous submitted
// inputs (slash commands and messages alike), newest last. HistoryIdx is
// -1 when not currently browsing; otherwise an index into InputHistory
// counting back from the end (0 = most recent).
InputHistory []string
HistoryIdx   int
```

In `New()`, initialize `HistoryIdx: -1` in the returned `&App{...}` literal.

- [ ] **Step 4: Implement history + Ctrl+C**

Append to `tui/app/update.go`:

```go
const inputHistoryCap = 200

// pushHistory records a submitted input for ↑/↓ recall (spec §16), deduping
// only against the immediately preceding entry (a user repeating the same
// message minutes apart is a legitimate distinct entry).
func (a *App) pushHistory(raw string) {
	if raw == "" {
		return
	}
	if n := len(a.InputHistory); n > 0 && a.InputHistory[n-1] == raw {
		a.HistoryIdx = -1
		return
	}
	a.InputHistory = append(a.InputHistory, raw)
	if len(a.InputHistory) > inputHistoryCap {
		a.InputHistory = a.InputHistory[len(a.InputHistory)-inputHistoryCap:]
	}
	a.HistoryIdx = -1
}

// historyUp/historyDown walk InputHistory from most-recent backward/forward.
// Only called from the `up`/`down` key branch when the textarea is empty
// and no overlay owns the arrow keys (spec §16: "↑/↓ on empty input: walk
// input history; with text: move cursor in textarea").
func (a *App) historyUp() {
	if len(a.InputHistory) == 0 {
		return
	}
	if a.HistoryIdx+1 >= len(a.InputHistory) {
		return
	}
	a.HistoryIdx++
	a.Input.SetValue(a.InputHistory[len(a.InputHistory)-1-a.HistoryIdx])
	a.Input.CursorEnd()
}

func (a *App) historyDown() {
	if a.HistoryIdx < 0 {
		return
	}
	a.HistoryIdx--
	if a.HistoryIdx < 0 {
		a.Input.SetValue("")
		return
	}
	a.Input.SetValue(a.InputHistory[len(a.InputHistory)-1-a.HistoryIdx])
	a.Input.CursorEnd()
}

// handleCtrlC implements the two-stage guard (spec §16): first press on
// non-empty input clears it and arms a 1s grace window; a second press
// inside that window, or any press on empty input, quits.
func (a *App) handleCtrlC() {
	if a.State == StateStreaming {
		a.stopStream()
	}
	if a.Input.Value() != "" {
		armed := !a.CtrlCArmedAt.IsZero() && time.Since(a.CtrlCArmedAt) < time.Second
		if armed {
			a.State = StateShutdown
			return
		}
		a.Input.Reset()
		a.CtrlCArmedAt = time.Now()
		return
	}
	a.State = StateShutdown
}
```

Replace the `case "ctrl+c":` branch in `Update`'s `tea.KeyMsg` switch:

```go
// before:
case "ctrl+c":
	if a.Mode == ModeStreaming {
		a.stopStream()
	}
	a.Mode = ModeQuitting
	return a, tea.Quit
```
```go
// after:
case "ctrl+c":
	a.handleCtrlC()
	if a.State == StateShutdown {
		return a, tea.Quit
	}
	return a, nil
```

Wire history into the `up`/`down` branch — insert the empty-input check *before* the existing overlay-navigation checks (overlays still win when open, since `ToolViewer.Show`/`ModelPicker.Show` are checked first and return early already; history only needs to apply in the final fallthrough case for the plain-editing state):

```go
// before:
case "up", "k":
	if a.ToolViewer.Show && len(a.ToolViewer.Rows) > 0 {
		...
	}
	if a.ModelPicker.Show && !a.ModelPicker.Loading && len(a.ModelPicker.Rows) > 0 {
		...
	}

case "down", "j":
	if a.ToolViewer.Show && len(a.ToolViewer.Rows) > 0 {
		...
	}
	if a.ModelPicker.Show && !a.ModelPicker.Loading && len(a.ModelPicker.Rows) > 0 {
		...
	}
```
```go
// after — add the plain "up"/"down" (no vim "k"/"j" here: those are also
// valid textarea input characters, so history recall is bound to the
// literal arrow keys only, not their vim aliases):
case "up":
	if a.ToolViewer.Show && len(a.ToolViewer.Rows) > 0 {
		if a.ToolViewer.Idx > 0 {
			a.ToolViewer.Idx--
		}
		return a, nil
	}
	if a.ModelPicker.Show && !a.ModelPicker.Loading && len(a.ModelPicker.Rows) > 0 {
		if a.ModelPicker.Idx > 0 {
			a.ModelPicker.Idx--
		}
		return a, nil
	}
	if a.Input.Value() == "" {
		a.historyUp()
		return a, nil
	}

case "down":
	if a.ToolViewer.Show && len(a.ToolViewer.Rows) > 0 {
		if a.ToolViewer.Idx < len(a.ToolViewer.Rows)-1 {
			a.ToolViewer.Idx++
		}
		return a, nil
	}
	if a.ModelPicker.Show && !a.ModelPicker.Loading && len(a.ModelPicker.Rows) > 0 {
		if a.ModelPicker.Idx < len(a.ModelPicker.Rows)-1 {
			a.ModelPicker.Idx++
		}
		return a, nil
	}
	if a.Input.Value() == "" {
		a.historyDown()
		return a, nil
	}

case "k", "j":
	// vim-style overlay nav only — never touches history (they're valid
	// textarea characters), so no plain-editing branch here.
	if a.ToolViewer.Show && len(a.ToolViewer.Rows) > 0 {
		if key == "k" && a.ToolViewer.Idx > 0 {
			a.ToolViewer.Idx--
		} else if key == "j" && a.ToolViewer.Idx < len(a.ToolViewer.Rows)-1 {
			a.ToolViewer.Idx++
		}
		return a, nil
	}
	if a.ModelPicker.Show && !a.ModelPicker.Loading && len(a.ModelPicker.Rows) > 0 {
		if key == "k" && a.ModelPicker.Idx > 0 {
			a.ModelPicker.Idx--
		} else if key == "j" && a.ModelPicker.Idx < len(a.ModelPicker.Rows)-1 {
			a.ModelPicker.Idx++
		}
		return a, nil
	}
```

Call `a.pushHistory(raw)` in `handleSubmit` right before `a.Input.Reset()`:

```go
// before:
a.Input.Reset()
a.Completion.Show = false
```
```go
// after:
a.pushHistory(raw)
a.Input.Reset()
a.Completion.Show = false
```

(Slash commands also flow through `handleSubmit`'s early return into `a.handleSlash(raw[1:])` before reaching `a.Input.Reset()` — add `a.pushHistory(raw)` there too, right after `a.Completion.Show = false` in that branch, so `/model qwen` is recallable via `↑` same as a chat message.)

- [ ] **Step 5: Rewrite the `esc` case, add `ctrl+d`, fix the input gate**

Replace the entire `case "esc":` branch:

```go
// before:
case "esc":
	if a.ShowHelp {
		a.ShowHelp = false
		return a, nil
	}
	if a.ShowHistory {
		a.ShowHistory = false
		return a, nil
	}
	// Model picker: single Esc closes (no two-stage dismiss —
	// the overlay has no expanded preview panel).
	if a.ModelPicker.Show {
		a.ModelPicker.Show = false
		return a, nil
	}
	// Tool viewer: first Esc collapses the expanded preview if
	// one is showing, second Esc closes the overlay. Two-stage
	// dismiss matches how claude-code-style overlays behave and
	// gives the user a way to back out without losing context.
	if a.ToolViewer.Show {
		if a.ToolViewer.Expanded {
			a.ToolViewer.Expanded = false
		} else {
			a.ToolViewer.Show = false
		}
		return a, nil
	}
	// Esc dismisses the autocomplete popup before quitting the TUI
	// — feels right (one key closes the temp UI, two keys quit),
	// and matches how overlay-closes-then-quit already works.
	if a.Completion.Show {
		a.Completion.Show = false
		a.Completion.List = nil
		a.Completion.Idx = 0
		return a, nil
	}
	if a.Mode != ModeEditing {
		return a, nil
	}
	a.Mode = ModeQuitting
	return a, tea.Quit
```
```go
// after — spec §16's Esc priority chain, in order: interrupt stream →
// dismiss overlay → dismiss completions → clear input. Esc never quits;
// that's Ctrl+C/Ctrl+D/`/exit`'s job (spec §2 J9).
case "esc":
	if a.State == StateStreaming || a.State == StateToolRunning || a.State == StateThinking {
		a.stopStream()
		return a, nil
	}
	if a.ShowHelp {
		a.ShowHelp = false
		return a, nil
	}
	if a.ShowHistory {
		a.ShowHistory = false
		return a, nil
	}
	if a.ModelPicker.Show {
		a.ModelPicker.Show = false
		return a, nil
	}
	if a.ToolViewer.Show {
		if a.ToolViewer.Expanded {
			a.ToolViewer.Expanded = false
		} else {
			a.ToolViewer.Show = false
		}
		return a, nil
	}
	if a.Completion.Show {
		a.Completion.Show = false
		a.Completion.List = nil
		a.Completion.Idx = 0
		return a, nil
	}
	a.Input.Reset()
	return a, nil
```

(The `StateToolRunning`/`StateThinking` checks above are forward-compatible, not dead-code padding: nothing in this P0 plan actually transitions `App.State` into either value yet — `handleSubmit` goes straight `Ready → Streaming`, and per-tool status lives on `ToolCall.Status`, not the global FSM. Wiring a real `Thinking` pre-first-token phase and a global `ToolRunning` footer state is P1 "Tool UX polish" territory (§23), not named in P0's bullets. Leaving the check here costs nothing today and means P1 doesn't have to remember to also patch the Esc chain when it does wire those transitions.)

Add a `ctrl+d` case right after `ctrl+c` (spec §16: "quit (empty input only; otherwise no-op)"):

```go
case "ctrl+d":
	if a.Input.Value() == "" {
		a.State = StateShutdown
		return a, tea.Quit
	}
	return a, nil
```

Fix the post-switch input gate so an error no longer disables typing (today's `ModeEditing` check happened to also cover this, since there was no separate error mode — now that Task 6 introduces `StateError`, gating on `Ready`-only would regress it):

```go
// before:
if a.Mode == ModeEditing {
	var cmd tea.Cmd
	a.Input, cmd = a.Input.Update(msg)
	a.recomputeCompletion()
	return a, cmd
}
return a, nil
```
```go
// after:
if a.State != StateShutdown {
	var cmd tea.Cmd
	a.Input, cmd = a.Input.Update(msg)
	a.recomputeCompletion()
	return a, cmd
}
return a, nil
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd tui && go build ./... && go test ./... -v`
Expected: PASS — including `TestEscDuringStreamingInterruptsNotQuits`, `TestEscWithNothingOpenClearsInputNotQuit`, `TestEscOnEmptyInputDoesNotQuit`, `TestCtrlDQuitsOnlyOnEmptyInput`.

- [ ] **Step 7: Commit**

```bash
git add tui/app/model.go tui/app/update.go tui/app/history_test.go
git commit -m "fix(tui): Esc interrupts+clears instead of quitting, add Ctrl+D, Ctrl+C double-press guard, input history"
```

---

### Task 5: 30fps streaming batch + `◦ interrupted` line

**Files:**
- Modify: `tui/app/model.go` (add `pendingText strings.Builder`, `pendingReasoning strings.Builder`, `lastFrameFlush time.Time`, `Turn.Interrupted bool`; add `frameTick` transitions)
- Modify: `tui/app/update.go` (`handleStreamChunk` buffers instead of writing straight to `Turn`; new `FrameTickMsg` + `frameTick()` cmd; `stopStream` sets `Interrupted`)
- Modify: `tui/app/model.go`'s `buildChatContent` (render the `◦ interrupted` line)
- Create: `tui/app/streaming_test.go`

**Interfaces:**
- Produces: `type FrameTickMsg time.Time`, `func frameTick() tea.Cmd` (33ms), `App.flushPending()` (moves buffered text/reasoning into the streaming turn), `Turn.Interrupted bool`.
- Consumes: `App.State == StateStreaming` (Task 1) gates whether `frameTick` keeps re-issuing itself.

- [ ] **Step 1: Write the failing test**

```go
// tui/app/streaming_test.go
package app

import (
	"strings"
	"testing"

	"feral-tui/api"
)

func TestStreamChunksBufferUntilFlush(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming
	a.handleStreamChunk(api.Chunk{Content: "hello "})
	a.handleStreamChunk(api.Chunk{Content: "world"})
	last := &a.Turns[len(a.Turns)-1]
	if last.Text != "" {
		t.Fatalf("Text should stay empty until flushPending, got %q", last.Text)
	}
	a.flushPending()
	if last.Text != "hello world" {
		t.Fatalf("after flushPending Text = %q, want %q", last.Text, "hello world")
	}
}

func TestStopStreamMarksInterrupted(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming
	a.handleStreamChunk(api.Chunk{Content: "partial"})
	a.flushPending()
	a.stopStream()
	last := &a.Turns[len(a.Turns)-1]
	if !last.Interrupted {
		t.Fatal("stopStream should mark the turn Interrupted")
	}
	if last.Text != "partial" {
		t.Fatalf("partial text must survive interruption, got %q", last.Text)
	}
	content := a.buildChatContent()
	if !strings.Contains(content, "interrupted") {
		t.Fatalf("expected an interrupted line in transcript content, got:\n%s", content)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tui && go test ./app/... -run 'TestStreamChunksBufferUntilFlush|TestStopStreamMarksInterrupted' -v`
Expected: build failure — `flushPending`/`Turn.Interrupted` undefined; `Content` field on `api.Chunk` assumed to already exist (it does — used throughout `update.go` today).

- [ ] **Step 3: Add fields**

In `tui/app/model.go`, add to `Turn`:

```go
// Interrupted is set when the user cancelled this turn mid-stream (Esc or
// Ctrl+C). Rendered as one dim "◦ interrupted" line after the turn's
// content — the partial text itself is never discarded (spec §7).
Interrupted bool
```

Add to `App`:

```go
// pendingText/pendingReasoning buffer incoming stream deltas between
// frame flushes so the viewport rebuilds at most once per 33ms (spec
// §7/§31.3) instead of on every token. lastFrameFlush is a monotonic guard
// consulted only by the frameTick handler — it is not read by View().
pendingText      strings.Builder
pendingReasoning strings.Builder
lastFrameFlush   time.Time
```

- [ ] **Step 4: Implement buffering + frame tick**

In `tui/app/update.go`, change `pushAssistantText`/`pushAssistantReasoning` to buffer instead of writing directly:

```go
// before:
func (a *App) pushAssistantText(piece string) {
	for i := range a.Turns {
		t := &a.Turns[len(a.Turns)-1-i]
		if t.Role == RoleAssistant && t.Streaming {
			t.Text += piece
			return
		}
	}
}
```
```go
// after:
func (a *App) pushAssistantText(piece string) {
	a.pendingText.WriteString(piece)
}
```

```go
// before:
func (a *App) pushAssistantReasoning(piece string) {
	for i := range a.Turns {
		t := &a.Turns[len(a.Turns)-1-i]
		if t.Role == RoleAssistant && t.Reasoning != "" {
			...
```

Wait — re-read: `pushAssistantReasoning` appends to `t.Reasoning`, keep the same lookup shape but buffer:

```go
// after:
func (a *App) pushAssistantReasoning(piece string) {
	a.pendingReasoning.WriteString(piece)
}
```

Add `flushPending`, called by the new frame ticker (and once synchronously on `StreamDoneMsg` so the tail always lands even if the stream ends between ticks):

```go
// flushPending moves buffered stream deltas into the trailing assistant
// turn. Called by FrameTickMsg (≤ once per 33ms while streaming) and once
// more on StreamDoneMsg so no buffered tail is ever lost.
func (a *App) flushPending() {
	text := a.pendingText.String()
	reasoning := a.pendingReasoning.String()
	if text == "" && reasoning == "" {
		return
	}
	a.pendingText.Reset()
	a.pendingReasoning.Reset()
	for i := range a.Turns {
		t := &a.Turns[len(a.Turns)-1-i]
		if t.Role != RoleAssistant {
			continue
		}
		if text != "" {
			t.Text += text
		}
		if reasoning != "" {
			t.Reasoning += reasoning
		}
		return
	}
}

// FrameTickMsg drives the 30fps streaming render cap (spec §7/§31.3): one
// ticker, only re-issued while State == StateStreaming.
type FrameTickMsg time.Time

func frameTick() tea.Cmd {
	return tea.Tick(33*time.Millisecond, func(t time.Time) tea.Msg {
		return FrameTickMsg(t)
	})
}
```

Add a case to `Update`'s message switch:

```go
case FrameTickMsg:
	if a.State != StateStreaming {
		return a, nil
	}
	a.flushPending()
	a.rebuildViewport()
	return a, frameTick()
```

Start the ticker when streaming begins — in `handleSubmit`, after `a.State = StateStreaming` (renamed already by Task 1), return a batched command instead of just `a.startStream(raw)`:

```go
// before:
a.beginAssistant()
a.Mode = ModeStreaming
a.FollowBottom = true
a.rebuildViewport()
return a.startStream(raw)
```
```go
// after:
a.beginAssistant()
a.State = StateStreaming
a.FollowBottom = true
a.rebuildViewport()
return tea.Batch(a.startStream(raw), frameTick())
```

In `StreamChunkMsg`'s handler, drop the unconditional `a.rebuildViewport()` — rebuilding now only happens on `FrameTickMsg` and on stream end:

```go
// before:
case StreamChunkMsg:
	a.handleStreamChunk(msg.Chunk)
	a.rebuildViewport()
	return a, nil
```
```go
// after:
case StreamChunkMsg:
	a.handleStreamChunk(msg.Chunk)
	return a, nil
```

Tool-call structural events (start/done/progress) still mutate `Turn.Tools` synchronously inside `handleStreamChunk` (unchanged) — only the *text/reasoning token* path is buffered, per spec §7's literal wording ("append tokens to the in-progress assistant message... Batch"). Tool pills are comparatively rare (not per-token) so they don't need the 33ms gate; they'll simply render on the next `FrameTickMsg` (≤33ms later) or on `StreamDoneMsg`.

In `stopStream`, mark the turn `Interrupted` and flush any partial buffered text first (so nothing typed-but-unflushed is lost on cancel):

```go
// before:
func (a *App) stopStream() {
	a.finishStream()
	a.setFlash("cancelled")
}
```
```go
// after:
func (a *App) stopStream() {
	a.flushPending()
	for i := range a.Turns {
		t := &a.Turns[len(a.Turns)-1-i]
		if t.Role == RoleAssistant && t.Streaming {
			t.Interrupted = true
			break
		}
	}
	a.finishStream()
	a.setFlash("cancelled")
}
```

And in `StreamDoneMsg`'s case (so the final tail always lands even without one more tick):

```go
// before:
case StreamDoneMsg:
	if a.Mode == ModeQuitting {
		return a, tea.Quit
	}
	a.finishStream()
```
```go
// after:
case StreamDoneMsg:
	if a.State == StateShutdown {
		return a, tea.Quit
	}
	a.flushPending()
	a.finishStream()
```

- [ ] **Step 5: Render the interrupted line**

In `tui/app/model.go`'s `buildChatContent`, right after the per-turn cost footnote block (the `if turn.Meta != ""` block, before the closing `case RoleAssistant:` brace), add:

```go
if turn.Interrupted {
	b.WriteString(gutter + ui.EventStyle.Render(ui.G.Event+" interrupted"))
	b.WriteByte('\n')
}
```

This needs one new style — add to `tui/ui/styles.go` next to `MetaStyle`:

```go
// EventStyle renders the "◦ …" receipt lines (spec §11/§15) — this task
// only uses it for "◦ interrupted"; P1 reuses it for the full runtime
// event formatter map.
EventStyle = lipgloss.NewStyle().Foreground(Meta)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd tui && go build ./... && go test ./... -v`
Expected: PASS. Then manually smoke: `go run . ` against a live gateway (or `TestPrintScreens`) and confirm streaming still renders (just batched) and Esc mid-stream shows the interrupted line.

- [ ] **Step 7: Commit**

```bash
git add tui/app/model.go tui/app/update.go tui/ui/styles.go tui/app/streaming_test.go
git commit -m "feat(tui): batch streaming renders to 30fps, add interrupted line"
```

---

### Task 6: Error cards for the top-4 §14 rows + rate-limit recovery loop

**Files:**
- Modify: `tui/app/update.go` (`inferErrorKind`, new `App.lastUserText`, `App.RateLimitUntil`, retry wiring)
- Modify: `tui/app/overlay_test.go` (extend, keep all 6 existing tests green)
- Modify: `tui/app/view.go` (footer shows the active error's hint + live countdown when `State == StateError`)

**Interfaces:**
- Produces: `inferErrorKind` now also returns `"no_model"`, `"offline"`, `"runtime_lost"`, `"rate_limited"`. `App.lastUserText string`, `App.RateLimitUntil time.Time`, `App.retryLastMessage() tea.Cmd`.
- Consumes: `App.State` (Task 1) — transitions to `StateError` on classified failure, `r` key retries.

- [ ] **Step 1: Write the failing test**

```go
// appended to tui/app/overlay_test.go

func TestInferErrorKindNoModel(t *testing.T) {
	for _, msg := range []string{"no model loaded", "model not found", "no_model_selected"} {
		kind, hint := inferErrorKind(msg)
		if kind != "no_model" {
			t.Fatalf("inferErrorKind(%q) = %q, want no_model", msg, kind)
		}
		if hint == "" {
			t.Fatal("no_model errors should carry a hint")
		}
	}
}

func TestInferErrorKindOffline(t *testing.T) {
	kind, hint := inferErrorKind("offline: no network reachable")
	if kind != "offline" {
		t.Fatalf("inferErrorKind = %q, want offline", kind)
	}
	if hint == "" {
		t.Fatal("offline errors should carry a hint")
	}
}

func TestInferErrorKindRuntimeLost(t *testing.T) {
	for _, msg := range []string{"runtime lost", "gateway unreachable", "gateway down"} {
		kind, _ := inferErrorKind(msg)
		if kind != "runtime_lost" {
			t.Fatalf("inferErrorKind(%q) = %q, want runtime_lost", msg, kind)
		}
	}
}

func TestInferErrorKindRateLimited(t *testing.T) {
	for _, msg := range []string{"429 too many requests", "rate limit exceeded"} {
		kind, hint := inferErrorKind(msg)
		if kind != "rate_limited" {
			t.Fatalf("inferErrorKind(%q) = %q, want rate_limited", msg, kind)
		}
		if hint == "" {
			t.Fatal("rate_limited errors should carry a hint")
		}
	}
}

func TestRateLimitEntersErrorStateWithDeadline(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.lastUserText = "hi"
	a.pushAssistantError("429 too many requests")
	if a.RateLimitUntil.IsZero() {
		t.Fatal("expected RateLimitUntil to be set on a rate_limited error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tui && go test ./app/... -run 'TestInferErrorKind|TestRateLimit' -v`
Expected: FAIL — new kinds not classified (fall through to `"unknown"`); `RateLimitUntil`/`lastUserText` undefined.

- [ ] **Step 3: Extend `inferErrorKind`**

```go
// before:
func inferErrorKind(msg string) (kind, hint string) {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "timed out") || strings.Contains(lower, "timeout") ||
		strings.Contains(lower, "deadline"):
		return "timeout", "Try: shorter prompt, or ^C to cancel"
	case strings.Contains(lower, "permission") || strings.Contains(lower, "denied") ||
		strings.Contains(lower, "not_allowed") || strings.Contains(lower, "not allowed") ||
		strings.Contains(lower, "eacces"):
		return "permission", "Check the sandbox allow-list for this path/host"
	case strings.Contains(lower, "connection") || strings.Contains(lower, "refused") ||
		strings.Contains(lower, "reset") || strings.Contains(lower, "unreachable") ||
		strings.Contains(lower, "econn"):
		return "network", "Check the sidecar / model server is running"
	case strings.Contains(lower, "not_available") || strings.Contains(lower, "unknown tool"):
		return "tool", "Tool isn't registered for this profile — try /model or check the connectors tab"
	default:
		return "unknown", ""
	}
}
```
```go
// after — the 4 spec §14 top-priority kinds are checked first (most
// specific substrings), existing kinds unchanged below them so all 6
// existing overlay_test.go cases stay green:
func inferErrorKind(msg string) (kind, hint string) {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "429") || strings.Contains(lower, "rate limit") ||
		strings.Contains(lower, "too many requests"):
		return "rate_limited", "cooling down 30s — or /model to switch"
	case strings.Contains(lower, "no model") || strings.Contains(lower, "model not found") ||
		strings.Contains(lower, "no_model"):
		return "no_model", "pick one with /model"
	case strings.Contains(lower, "runtime lost") || strings.Contains(lower, "gateway"):
		return "runtime_lost", "restarting runtime…"
	case strings.Contains(lower, "offline") || strings.Contains(lower, "no network"):
		return "offline", "local model still works — /model list"
	case strings.Contains(lower, "timed out") || strings.Contains(lower, "timeout") ||
		strings.Contains(lower, "deadline"):
		return "timeout", "Try: shorter prompt, or ^C to cancel"
	case strings.Contains(lower, "permission") || strings.Contains(lower, "denied") ||
		strings.Contains(lower, "not_allowed") || strings.Contains(lower, "not allowed") ||
		strings.Contains(lower, "eacces"):
		return "permission", "Check the sandbox allow-list for this path/host"
	case strings.Contains(lower, "connection") || strings.Contains(lower, "refused") ||
		strings.Contains(lower, "reset") || strings.Contains(lower, "unreachable") ||
		strings.Contains(lower, "econn"):
		return "network", "Check the sidecar / model server is running"
	case strings.Contains(lower, "not_available") || strings.Contains(lower, "unknown tool"):
		return "tool", "Tool isn't registered for this profile — try /model or check the connectors tab"
	default:
		return "unknown", ""
	}
}
```

(Note: `"gateway"` alone now also catches messages this repo doesn't currently emit that happen to mention "gateway" for unrelated reasons — acceptable given the host only ever sends the handful of stable strings noted in the existing doc comment above `inferErrorKind`; if that assumption ever breaks, tighten to `"gateway unreachable"`/`"gateway down"`/`"runtime lost"` explicitly.)

- [ ] **Step 4: Wire `State`, `RateLimitUntil`, and retry**

Add fields to `App` in `model.go`:

```go
// lastUserText is the most recently submitted user message — restored
// into the textarea (or auto-resent, for rate_limited) on recovery
// (spec §7 "Interruptions", §14 "auto-retry once at 0").
lastUserText string

// RateLimitUntil is non-zero while a rate_limited error's cooldown is
// counting down. Cleared on the auto-retry.
RateLimitUntil time.Time
retriedRateLimit bool
```

In `handleSubmit`, capture `lastUserText` for non-slash messages (right where the user turn is appended):

```go
// before:
a.Turns = append(a.Turns, Turn{Role: RoleUser, Text: raw})
a.beginAssistant()
```
```go
// after:
a.lastUserText = raw
a.Turns = append(a.Turns, Turn{Role: RoleUser, Text: raw})
a.beginAssistant()
```

In `pushAssistantError`, set `State`/`RateLimitUntil` alongside the existing `ErrorCard` append:

```go
// before:
func (a *App) pushAssistantError(msg string) {
	for i := range a.Turns {
		t := &a.Turns[len(a.Turns)-1-i]
		if t.Role != RoleAssistant {
			continue
		}
		kind, hint := inferErrorKind(msg)
		t.Errors = append(t.Errors, ErrorCard{
			Message: msg,
			Kind:    kind,
			Hint:    hint,
		})
		return
	}
}
```
```go
// after:
func (a *App) pushAssistantError(msg string) {
	kind, hint := inferErrorKind(msg)
	a.State = StateError
	if kind == "rate_limited" {
		a.RateLimitUntil = time.Now().Add(30 * time.Second)
		a.retriedRateLimit = false
	}
	for i := range a.Turns {
		t := &a.Turns[len(a.Turns)-1-i]
		if t.Role != RoleAssistant {
			continue
		}
		t.Errors = append(t.Errors, ErrorCard{
			Message: msg,
			Kind:    kind,
			Hint:    hint,
		})
		return
	}
}
```

Add the retry command and the auto-retry check, in `update.go`:

```go
// retryLastMessage re-submits lastUserText — used both by the "r" keybind
// (spec §14: "every error names its recovery in the same breath") and by
// the rate_limited auto-retry-once-at-0 (spec §14's rate-limit row).
func (a *App) retryLastMessage() tea.Cmd {
	if a.lastUserText == "" {
		return nil
	}
	a.State = StateReady
	a.RateLimitUntil = time.Time{}
	msg := a.lastUserText
	a.beginAssistant()
	a.State = StateStreaming
	a.FollowBottom = true
	a.rebuildViewport()
	return tea.Batch(a.startStream(msg), frameTick())
}
```

Add the `r`-to-retry keybind — insert a new case in `Update`'s `tea.KeyMsg` switch, guarded so it only fires in `StateError` (never steals a literal "r" keystroke while editing):

```go
case "r":
	if a.State == StateError {
		return a, a.retryLastMessage()
	}
	// fall through to the textarea below — "r" is a normal character
	// everywhere else.
```

(Go `switch` doesn't fall through by default — since the existing switch's default behavior for unmatched keys is to fall out of the `switch key {` block entirely into the `if a.Mode == ModeEditing { ... a.Input.Update(msg) ... }` code below, simply *not* returning from this case already achieves "fall through to the textarea": omit `return a, nil` when `a.State != StateError` so control reaches the post-switch textarea-update code exactly like every other unhandled key today.)

Auto-retry-at-zero: add to the existing `spinner.TickMsg` case (already fires continuously, perfect for a countdown check with no new timer):

```go
// before:
case spinner.TickMsg:
	var cmd tea.Cmd
	a.Loader, cmd = a.Loader.Update(msg)
	if !a.FlashUntil.IsZero() && time.Now().After(a.FlashUntil) {
		a.FlashText = ""
		a.FlashUntil = time.Time{}
	}
	if a.IsStreaming() {
		a.rebuildViewport()
	}
	return a, cmd
```
```go
// after:
case spinner.TickMsg:
	var cmd tea.Cmd
	a.Loader, cmd = a.Loader.Update(msg)
	if !a.FlashUntil.IsZero() && time.Now().After(a.FlashUntil) {
		a.FlashText = ""
		a.FlashUntil = time.Time{}
	}
	if !a.RateLimitUntil.IsZero() && !a.retriedRateLimit && time.Now().After(a.RateLimitUntil) {
		a.retriedRateLimit = true
		return a, tea.Batch(cmd, a.retryLastMessage())
	}
	if a.IsStreaming() {
		a.rebuildViewport()
	}
	return a, cmd
```

- [ ] **Step 5: Footer shows the active error's hint + countdown**

In `tui/app/view.go`'s `renderFooter`, add the error/countdown branch above the existing flash check (priority per §4: error > progress > flash > state text > hint):

```go
// before:
func (a *App) renderFooter() string {
	if a.FlashText != "" {
		return ui.FooterStyle.Render(ui.FlashStyle.Render(a.FlashText))
	}
	return ui.FooterStyle.Render("F1 for shortcuts · Ctrl+C to exit")
}
```
```go
// after:
func (a *App) renderFooter() string {
	if a.State == StateError {
		if !a.RateLimitUntil.IsZero() {
			remaining := int(time.Until(a.RateLimitUntil).Seconds())
			if remaining < 0 {
				remaining = 0
			}
			return ui.FooterStyle.Render(ui.ErrorTitle.Render("error · rate limited") +
				ui.MetaStyle.Render(fmt.Sprintf("  cooling down %ds — r to retry now", remaining)))
		}
		return ui.FooterStyle.Render(ui.ErrorTitle.Render("error") +
			ui.MetaStyle.Render("  r to retry"))
	}
	if a.FlashText != "" {
		return ui.FooterStyle.Render(ui.FlashStyle.Render(a.FlashText))
	}
	return ui.FooterStyle.Render(a.State.FooterHint())
}
```

(This also finally makes the footer's default hint state-driven per Task 1's `FooterHint()`, closing spec §22 acceptance #12 for the states this repo can actually reach today — see the "Filed discrepancies" note at the top of this plan for the wizard-only states.)

`retryLastMessage` above sets `a.State = StateReady` before immediately re-setting it to `StateStreaming` — leave both lines; the first ensures a stray render between the two statements (there isn't one, `Update` is synchronous) is never observed in `StateError`, and it makes the intent ("leaving Error, entering Streaming") readable without a comment.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd tui && go build ./... && go test ./... -v`
Expected: PASS — all 6 original `inferErrorKind` tests plus the 5 new ones, plus every other existing test untouched.

- [ ] **Step 7: Commit**

```bash
git add tui/app/update.go tui/app/model.go tui/app/view.go tui/app/overlay_test.go
git commit -m "feat(tui): error cards for no-model/offline/runtime-lost/rate-limit + retry loop"
```

---

### Task 7: Panic-safe terminal restore + acceptance-test guard rails

**Files:**
- Modify: `tui/main.go` (recover-and-restore wrapper)
- Create: `tui/app/acceptance_test.go`

**Interfaces:**
- Produces: no new exported symbols; `acceptance_test.go` is a pure test file exercising existing renderers.

- [ ] **Step 1: Write the failing tests**

```go
// tui/app/acceptance_test.go
package app

import (
	"regexp"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// TestHeaderIsSingleLine — spec §22 acceptance #1.
func TestHeaderIsSingleLine(t *testing.T) {
	for _, w := range []int{40, 60, 80, 120} {
		a := newTestApp()
		a.Width = w
		out := a.renderHeader()
		if lipgloss.Height(out) != 1 {
			t.Fatalf("width %d: header height = %d, want 1", w, lipgloss.Height(out))
		}
	}
}

// TestFooterIsSingleLineAndExclusive — spec §22 acceptance #2.
func TestFooterIsSingleLineAndExclusive(t *testing.T) {
	a := newTestApp()
	a.FlashText = "model switched"
	out := a.renderFooter()
	if lipgloss.Height(out) != 1 {
		t.Fatalf("footer height = %d, want 1", lipgloss.Height(out))
	}
	if strings.Contains(stripAnsi(out), "F1 for shortcuts") {
		t.Fatal("flash message and default hint both rendered — only one may win")
	}
}

// boxDrawing matches common box-drawing runes. ⎿ is spec-sanctioned and
// excluded. This only checks the steady-state frame (no overlay open) —
// see "Filed discrepancies" #2 in the plan for the overlay divider gap.
var boxDrawing = regexp.MustCompile(`[┌┐└┘├┤┬┴┼│─═║╔╗╚╝╠╣╦╩╬]`)

// TestSteadyStateFrameHasNoBoxDrawing — spec §22 acceptance #3 (scoped to
// the non-overlay frame; see plan discrepancy note #2).
func TestSteadyStateFrameHasNoBoxDrawing(t *testing.T) {
	a := newTestApp()
	out := stripAnsi(a.View())
	if boxDrawing.MatchString(out) {
		t.Fatalf("steady-state frame contains box-drawing characters:\n%s", out)
	}
}

// TestAsciiModeEmitsNoNonAsciiBytes — spec §22 acceptance #19, exercised
// against the real glyph table (not just the Ascii struct in ui/glyphs_test.go).
func TestAsciiModeEmitsNoNonAsciiBytes(t *testing.T) {
	t.Setenv("FERAL_ASCII", "1")
	// ui.G is resolved once at package init, before t.Setenv can take
	// effect — this test documents the current limitation rather than
	// re-resolving it, since ui.G is a package var by design (spec §25.3
	// doesn't call for a re-pick-on-demand API). Skip with a clear reason
	// so CI output explains the gap instead of silently passing green.
	t.Skip("ui.G is resolved at package init; process-level FERAL_ASCII=1 is exercised manually per the phase's exit criteria (spec §23), not by this in-process test")
}
```

- [ ] **Step 2: Run test to verify it fails (then passes for the ones that should)**

Run: `cd tui && go test ./app/... -run 'TestHeaderIsSingleLine|TestFooterIsSingleLineAndExclusive|TestSteadyStateFrameHasNoBoxDrawing|TestAsciiModeEmitsNoNonAsciiBytes' -v`

Expected before Task 2 lands: `TestSteadyStateFrameHasNoBoxDrawing` FAILs (the `─` separator from view.go:56 still present if Task 7 is somehow run before Task 2 — it shouldn't be, tasks are sequential). Run in the correct order (after Tasks 1–6): expected all PASS, `TestAsciiModeEmitsNoNonAsciiBytes` SKIP.

- [ ] **Step 3: Panic-safe terminal restore in `main.go`**

```go
// before:
func main() {
	settings, err := api.LoadSettings()
	...
	m := app.New(baseURL, token, status)
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	m.Prog = p

	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "feral: error: %v\n", err)
		os.Exit(1)
	}
}
```
```go
// after:
func main() {
	settings, err := api.LoadSettings()
	...
	m := app.New(baseURL, token, status)
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	m.Prog = p

	run(p)
}

// run isolates p.Run() behind a recover so an in-process panic (a bug in
// Update/View, not an OS-level SIGSEGV — Go cannot recover from an actual
// segfault) always restores the terminal before the process exits (spec
// §2 J9, §34.9). Bubble Tea's own Run() already restores raw-mode/alt-
// screen on a normal return or on tea.Quit; this only covers the panic
// path, which today would otherwise print a mid-panic stack trace over a
// still-alternate-screen, corrupted-cooked-mode terminal.
func run(p *tea.Program) {
	defer func() {
		if r := recover(); r != nil {
			p.ReleaseTerminal()
			fmt.Fprintf(os.Stderr, "feral: crashed: %v\n", r)
			os.Exit(1)
		}
	}()
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "feral: error: %v\n", err)
		os.Exit(1)
	}
}
```

(A real `kill -SEGV <pid>` from another shell is a Go-runtime-fatal signal outside any `recover()`'s reach — Go prints its own crash report and the OS reclaims the tty. That half of spec §22 acceptance #15/#2-J9 is a manual/platform-specific check on Unix, not automatable here, and the dev machine for this repo is Windows where `SIGSEGV` isn't a deliverable signal at all. This `recover()` covers the actually-recoverable case: a Go panic inside `Update`/`View` from a bug, which is the realistic failure mode this codebase can produce.)

- [ ] **Step 4: Run full suite**

Run: `cd tui && go build ./... && go vet ./... && go test ./... -v`
Expected: PASS (with the one documented `SKIP`).

- [ ] **Step 5: Commit**

```bash
git add tui/main.go tui/app/acceptance_test.go
git commit -m "feat(tui): panic-safe terminal restore + P0 acceptance guard-rail tests"
```

---

## Phase exit — before starting P1

- [ ] Run `cd tui && go build ./... && go vet ./... && go test ./... -v` — all green.
- [ ] Manually smoke against a live gateway (`feral gateway start` then `go run ./tui` or the built `feral chat`): send a message, interrupt it mid-stream (confirm `◦ interrupted`), trigger `/model` with a bad id or unplug network briefly to eyeball an error card, resize the terminal during a stream, toggle `NO_COLOR=1` and `FERAL_ASCII=1` and eyeball both.
- [ ] Re-read spec §23's P0 bullet list against this plan's tasks — Tasks 1–7 map to all 5 bullets plus the acceptance subset (1–8, 12–17, 18–19 scoped per the discrepancy notes above).
- [ ] Hand the "Filed discrepancies" section to whoever scopes P1/P2 — item 1 (tag→gutter migration) and item 2 (overlay dividers) are candidates to fold into P2's virtualization rewrite of `buildChatContent`; item 3 (full gateway-restart loop) needs P1's `/events` SSE consumer.
