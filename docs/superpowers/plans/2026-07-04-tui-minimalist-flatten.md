# TUI Minimalist Flatten (Claude-Code style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the `feral chat` Go/Bubble Tea TUI (`tui/`) down to a flat, borderless, Claude-Code-style look — no ASCII logo, no boxed panels, no per-tool emoji, no colored header bar — and fix three real interaction bugs that make it feel un-smooth (auto-scroll fights manual scrollback, mouse wheel does nothing, flash messages never expire).

**Architecture:** No new files, no new dependencies. `tui/ui/styles.go` loses its `Border()`/`Background()` declarations in favor of plain foreground-only styles; `tui/app/view.go` swaps every boxed/logo renderer for flat indented text; `tui/app/model.go` + `tui/app/update.go` get a `FollowBottom` flag and a mouse-wheel handler. Dead code (unused mascot renderer, its 400ms ticker, the per-tool emoji map) is deleted outright rather than kept around unused.

**Tech Stack:** Go, Bubble Tea, Lip Gloss, Glamour (unchanged) — this is a styling + state-tracking pass, not a rewrite.

---

## Task 1: Delete dead weight (mascot + tool-emoji map)

**Files:**
- Delete: `tui/ui/mascot.go`
- Delete: `tui/ui/tool_emoji_test.go`
- Delete: `tui/ui/tool_emoji.go` (after Task 3 removes its last call site — see note)
- Modify: `tui/app/view.go:85-89` (remove `renderMascot` + `bouncePattern`)
- Modify: `tui/app/model.go:139` (remove `MascotCycle int` field)
- Modify: `tui/app/update.go:15-19,41-43,331-333` (remove `mascotTick`, its `Init()` call, and the `MascotTickMsg` case)

`renderMascot()` is defined but never called from `View()` — confirmed via `grep -rn "renderMascot" tui/`. Its ticker fires every 400ms forever for nothing. `EmojiForTool` is still called from `view.go` (tool pills) at this point in the plan — don't delete `tool_emoji.go` yet, that happens in Task 3 once the flat tool-pill renderer stops calling it.

- [ ] **Step 1: Remove mascot files and call sites**

Delete `tui/ui/mascot.go` entirely.

In `tui/app/view.go`, remove:
```go
var bouncePattern = []int{0, 1, 2, 1, 0, 0}

func (a *App) renderMascot() string {
	return ui.RenderMascot(bouncePattern[a.MascotCycle])
}
```

In `tui/app/model.go`, remove the `MascotCycle int` field from `App` (line 139) and the `MascotTickMsg time.Time` type declaration (line 18).

In `tui/app/update.go`, remove:
```go
func mascotTick() tea.Cmd {
	return tea.Tick(400*time.Millisecond, func(t time.Time) tea.Msg {
		return MascotTickMsg(t)
	})
}
```
Remove `mascotTick()` from the `tea.Batch(...)` call in `Init()` (line 42).
Remove the `case MascotTickMsg:` block (lines 331-333).

- [ ] **Step 2: Build to confirm no dangling references**

Run: `cd tui && go build ./...`
Expected: builds clean (no "declared and not used" / "undefined" errors).

- [ ] **Step 3: Commit**

```bash
git add tui/ui/mascot.go tui/app/view.go tui/app/model.go tui/app/update.go
git commit -m "chore(tui): delete unused mascot renderer + its 400ms ticker"
```

---

## Task 2: Flatten `tui/ui/styles.go` — no borders, no backgrounds

**Files:**
- Modify: `tui/ui/styles.go`

Replace every `Border(...)`/`Background(...)` style with a plain foreground-only one. Keep the color palette (`Accent`, `AccentHi`, `AccentDim`, `Text`, `Meta`, `Ok`, `Warn`, `Fail`) — only the *shape* (boxes) goes, not the *color* language.

- [ ] **Step 1: Strip the header, input, and welcome styles**

Replace:
```go
var (
	HeaderStyle = lipgloss.NewStyle().
			Background(Bg).
			Padding(0, 1)
	...
)
```
with:
```go
var (
	HeaderStyle = lipgloss.NewStyle()
	...
)
```
(drop `Background(Bg)` and `Padding(0, 1)` — the header is now a single plain text row, no filled bar).

Delete the `Bg`, `Surface`, and `BorderCol` color vars if nothing else references them after this task (check with `grep -n "ui.Bg\|ui.Surface\|ui.BorderCol" tui/app/*.go` once Steps 2-4 land — the completion box and welcome rule are the two other users, both go away below).

Delete `WelcomeLogo`, `WelcomeRule`, `WelcomeDash` (the ASCII-logo and horizontal-rule styles — no longer used once Task 4 rewrites `renderWelcomeContent`). Keep `WelcomeTagline`, `WelcomeLabel`, `WelcomeValue`, `WelcomeSess`, `WelcomeSessMeta`, `WelcomeSection` — the plain-text welcome body still uses these.

- [ ] **Step 2: Replace tool-pill styles with the flat Claude-Code shape**

Replace the "Tool-call pills" block:
```go
	ToolRunning = lipgloss.NewStyle().Foreground(Accent)
	ToolDone    = lipgloss.NewStyle().Foreground(Meta)
	ToolError   = lipgloss.NewStyle().Foreground(Fail)
	ToolName    = lipgloss.NewStyle().Foreground(Text).Bold(true)
	ToolArg     = lipgloss.NewStyle().Foreground(Meta)
	ToolNote    = lipgloss.NewStyle().Foreground(Meta).Italic(true)
	ToolBullet  = lipgloss.NewStyle().Foreground(AccentDim).SetString("└─")
	ToolSpinner = lipgloss.NewStyle().Foreground(Accent).SetString("⠿")
```
with:
```go
	ToolRunning = lipgloss.NewStyle().Foreground(Accent)
	ToolDone    = lipgloss.NewStyle().Foreground(Meta)
	ToolError   = lipgloss.NewStyle().Foreground(Fail)
	ToolName    = lipgloss.NewStyle().Foreground(Text).Bold(true)
	ToolArg     = lipgloss.NewStyle().Foreground(Meta)
	ToolNote    = lipgloss.NewStyle().Foreground(Meta).Italic(true)
	// ToolMark is the leading status dot — Claude-Code-style "⏺ name(arg)"
	// instead of a bulleted card. ToolResult prefixes the indented result
	// line with "⎿" so it reads as a child of the call above it.
	ToolMark   = lipgloss.NewStyle().SetString("⏺")
	ToolResult = lipgloss.NewStyle().Foreground(Meta).SetString("⎿")
```
(`ToolSpinner` is unused already — confirm with `grep -rn "ToolSpinner" tui/` before deleting; if unused, drop it here too.)

- [ ] **Step 3: Replace error-card, tool-viewer, and completion box styles**

Replace:
```go
	ErrorBorder = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(Fail).Padding(0, 1)
	ErrorTitle  = lipgloss.NewStyle().Foreground(Fail).Bold(true)
```
with:
```go
	ErrorTitle  = lipgloss.NewStyle().Foreground(Fail).Bold(true)
```
(delete `ErrorBorder` — the flat renderer in Task 4 uses `ToolMark`/`ToolResult` styling instead of a box).

Replace:
```go
	ToolViewerBox = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(Accent).Padding(1, 2)
```
with:
```go
	ToolViewerBox = lipgloss.NewStyle().Padding(0, 2)
```
(keep the type name — call sites in `view.go` still call `.Width(boxW).Render(...)` on it — just drop the border/padding-1 so it reads as an indented plain block, not a box).

Replace:
```go
	CompletionBox = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder()).
			BorderForeground(BorderCol).
			Padding(0, 1)
```
with:
```go
	CompletionBox = lipgloss.NewStyle().Padding(0, 1)
```

- [ ] **Step 4: Replace the input style**

Replace:
```go
	InputStyle     = lipgloss.NewStyle().
			Padding(0, 1).
			Background(Surface).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(Accent)
```
with:
```go
	// InputPrompt is the leading glyph on the input row — Claude-Code style
	// "› " prompt instead of a bordered box. No Border/Background: the
	// horizontal rule already drawn above the input (see view.go's `sep`)
	// is the only visual separator.
	InputPrompt = lipgloss.NewStyle().Foreground(Accent).SetString("›")
	InputStyle  = lipgloss.NewStyle().Padding(0, 1)
```
(Task 4 changes `renderInput` to prefix `ui.InputPrompt` instead of relying on a box border.)

- [ ] **Step 5: Simplify the footer accents**

Replace:
```go
	FooterStyle    = lipgloss.NewStyle().Foreground(Meta).Padding(0, 1)
	FooterAccent   = lipgloss.NewStyle().Foreground(Accent)
	FooterHint     = lipgloss.NewStyle().Foreground(Meta)
```
with:
```go
	FooterStyle = lipgloss.NewStyle().Foreground(Meta).Padding(0, 1)
```
(delete `FooterAccent`/`FooterHint` — Task 4's flat footer is one uncolored dim line, no per-item accent).

- [ ] **Step 6: Build**

Run: `cd tui && go build ./...`
Expected: fails here — that's fine, it'll list every call site in `view.go` still referencing the deleted styles (`ui.WelcomeLogo`, `ui.ErrorBorder`, `ui.FooterAccent`, etc). Keep the list of errors; Task 4 fixes every one of them. Do not try to make this compile yet — commit the style file alone only after Task 4 lands, since a half-done rename leaves the package unbuildable. Skip the commit step for this task; fold it into Task 4's commit instead.

---

## Task 3: Delete `tool_emoji.go` and its test

**Files:**
- Delete: `tui/ui/tool_emoji.go`
- Delete: `tui/ui/tool_emoji_test.go`

Claude-Code's tool-call line has no per-tool emoji — just the colored `⏺` mark. Task 4's flat tool-pill renderer stops calling `ui.EmojiForTool`, so the map becomes dead code once that lands. Do this deletion in the same commit as Task 4 (the build won't pass in between otherwise).

- [ ] **Step 1: Delete both files** (fold into Task 4's commit — see below)

---

## Task 4: Rewrite `tui/app/view.go` renderers to the flat shape

**Files:**
- Modify: `tui/app/view.go`

This is the task that makes Task 2's style file compile again. Go renderer-by-renderer.

- [ ] **Step 1: Flatten the header**

Replace `renderHeader` (currently pads a `Background`-filled bar). New version — same content, just rendered on a plain (unfilled) row:
```go
func (a *App) renderHeader() string {
	dot := ui.StatusOffline.String()
	state := "no sidecar"
	if a.Status.Online {
		dot = ui.StatusOnline.String()
		state = "online"
	}
	m := orStr(a.Status.Model, "—")
	l := orStr(a.Status.LoRA, "none")
	backendLabel := a.Status.Backend
	if a.Status.ByokProvider != "" {
		backendLabel = a.Status.ByokProvider
	}
	brand := ui.BrandStyle.Render("feral")
	left := fmt.Sprintf("%s  %s %s  %s %s  %s %s",
		brand,
		ui.MetaStyle.Render("model"), m,
		ui.MetaStyle.Render("lora"), l,
		ui.MetaStyle.Render("backend"), backendLabel)
	right := fmt.Sprintf("%s %s", dot, state)
	pad := a.Width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if pad < 1 {
		pad = 1
	}
	return ui.HeaderStyle.Render(" " + left + strings.Repeat(" ", pad) + right)
}
```
(Only real change: dropped the `▸ chat` caret segment and the filled background — `HeaderStyle` is now a no-op style so this renders as plain text on the terminal's own background.)

- [ ] **Step 2: Flatten the welcome screen — delete the ASCII logo path entirely**

Delete `feralLogoFull`, `feralLogoMid`, `feralLogoSingle` and replace `renderWelcomeContent` with:
```go
// renderWelcomeContent draws the once-per-session welcome text — a plain,
// left-aligned block (brand line, status line, recent sessions, shortcut
// hint) with no border and no ASCII logo, matching Claude Code's flat
// welcome screen. Centered as a block so it doesn't hug the left edge on
// wide terminals; the block's own content never wraps or truncates itself
// beyond the plain truncate() calls already used for session titles.
func (a *App) renderWelcomeContent() string {
	w, h := a.ChatVP.Width, a.ChatVP.Height
	if w <= 0 || h <= 0 {
		return ""
	}

	var lines []string
	lines = append(lines, ui.WelcomeTagline.Render("✻ feral chat"), "")
	lines = append(lines, a.renderWelcomeStatus()...)
	lines = append(lines, "")

	if h >= 14 {
		lines = append(lines, ui.WelcomeSection.Render("recent"))
		lines = append(lines, a.renderWelcomeSessions()...)
		lines = append(lines, "")
	}
	lines = append(lines, a.renderWelcomeShortcuts()...)

	content := lipgloss.JoinVertical(lipgloss.Left, lines...)
	if lipgloss.Height(content) > h {
		return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, lines[0])
	}
	return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, content)
}
```
`renderWelcomeStatus` and `renderWelcomeSessions` are unchanged (they already render plain label/value rows, no box). `renderWelcomeShortcuts` is unchanged too — it already renders `ui.KbdStyle` inline chips with no outer border, so it stays as-is.

- [ ] **Step 3: Flatten the footer**

Replace `renderFooter`:
```go
func (a *App) renderFooter() string {
	if a.FlashText != "" {
		return ui.FooterStyle.Render(ui.FlashStyle.Render(a.FlashText))
	}
	return ui.FooterStyle.Render("F1 for shortcuts · Ctrl+C to exit")
}
```

- [ ] **Step 4: Flatten the input — drop the box, add the `›` prompt**

Replace `renderInput`:
```go
func (a *App) renderInput(h int) string {
	if a.IsStreaming() {
		placeholder := ui.InputPlaceholder.Render("…  (esc to cancel)")
		return ui.InputStyle.Width(a.Width).Height(h).Render(ui.InputPrompt.String() + " " + placeholder)
	}
	return ui.InputStyle.Width(a.Width).Height(h).Render(ui.InputPrompt.String() + " " + a.Input.View())
}
```

- [ ] **Step 5: Flatten tool pills — Claude-Code `⏺ name(arg)` / `⎿ result`**

Replace `renderToolPill`:
```go
// renderToolPill renders one tool call as two flat lines:
//   ⏺ tool_name(main arg)  ⏱ 0.4s ✓
//     ⎿ result preview / note / error
// No emoji, no bullet card — the leading ⏺ is colored by status
// (accent = running, meta = done, fail = error) so the eye reads state
// from color before reading the name, same idea Claude Code uses.
func (a *App) renderToolPill(t ToolCall, gutter string, width int) string {
	name := ui.ToolName.Render(t.Name)
	arg := ""
	if t.Main != "" {
		arg = ui.ToolArg.Render(fmt.Sprintf("(%s)", t.Main))
	} else {
		arg = ui.ToolArg.Render("()")
	}
	elapsed := formatElapsed(t.endedOrNow())
	statusGlyph, statusStyle := t.statusGlyph()
	mark := statusStyle.Render("⏺")
	tail := statusStyle.Render(fmt.Sprintf("⏱ %s %s", elapsed, statusGlyph))

	first := fmt.Sprintf("%s %s%s  %s", mark, name, arg, tail)
	out := []string{first}
	if t.Note != "" {
		out = append(out, "  "+ui.ToolResult.String()+" "+ui.ToolNote.Render(t.Note))
	}
	if t.Status == ToolError && t.ErrMsg != "" {
		out = append(out, "  "+ui.ToolResult.String()+" "+ui.ToolError.Render(t.ErrMsg))
	}
	if t.Preview != "" {
		preview := truncate(t.Preview, width-TagIndent-2)
		if preview != "" {
			out = append(out, "  "+ui.ToolResult.String()+" "+ui.MetaStyle.Render(preview))
		}
	}
	return strings.Join(out, "\n"+gutter)
}
```
Note the join changed from a bare `"\n"` to `"\n"+gutter` — previously the caller (`buildChatContent` in `model.go`) prefixed only the *first* line with `gutter` and let continuation lines rely on the pill's own internal indent; check `model.go`'s loop (`b.WriteString(gutter + pill)`) still only adds `gutter` once before the whole (possibly multi-line) string. Fix that call site too:
```go
for _, tc := range turn.Tools {
	pill := a.renderToolPill(tc, gutter, msgWidth)
	b.WriteString(gutter + pill)
	b.WriteByte('\n')
}
```
This already works correctly once `renderToolPill` embeds `gutter` before each continuation line internally (shown above) — don't double-prefix the first line. Adjust to:
```go
first := fmt.Sprintf("%s %s%s  %s", mark, name, arg, tail)
out := []string{first}
... (append continuation lines WITHOUT a leading gutter, as before)
return strings.Join(out, "\n"+gutter)
```
i.e. leave the continuation-line strings exactly as originally written (`"  "+ui.ToolResult...`) — the `"\n"+gutter` join adds the shared indent once per line break, same as the original `"\n"` did implicitly via the caller's single `gutter +` prefix on line 1 only. **This is the one subtle bit — verify visually in Step 8 below**, since getting the double-indent wrong is an easy off-by-one.

- [ ] **Step 6: Flatten error cards**

Replace `renderErrorCard`:
```go
// renderErrorCard draws a flat, unboxed error line — matches the tool-pill
// shape: "⏺ error · kind" then indented message/hint lines, colored by
// Kind (see inferErrorKind) so the eye still categorises the failure
// before reading text, just without a drawn border around it.
func (a *App) renderErrorCard(e ErrorCard, width int) string {
	if width < 20 {
		width = 20
	}
	mark := ui.ErrorTitle.Render("⏺ error")
	if e.Kind != "" && e.Kind != "unknown" {
		mark = mark + ui.ErrorTitle.Render("  ·  "+e.Kind)
	}
	body := ui.ErrorMsg.Render(truncateRunes(e.Message, width*3))
	lines := []string{mark, "  " + body}
	if e.Hint != "" {
		lines = append(lines, "  "+ui.ErrorHint.Render(e.Hint))
	}
	return strings.Join(lines, "\n")
}
```

- [ ] **Step 7: Flatten the four overlays (help, history, tool-viewer, model-picker) and the completion popup**

For each of `renderHelpOverlay`, `renderHistoryOverlay`, `renderToolViewerOverlay`, `renderModelPickerOverlay`: remove the `lipgloss.NewStyle().Border(lipgloss.RoundedBorder())...` wrapper around `content`/`body` and render the joined lines directly (still passed through `lipgloss.Place(...)` for screen-centering — that's positioning, not a box). Concretely, in `renderHelpOverlay`, replace:
```go
	content := strings.Join(lines, "\n")
	box := lipgloss.NewStyle().
		Width(boxW).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(ui.Accent).
		Padding(1, 2).
		Foreground(ui.Text).
		Render(content)
	box = ui.HelpTitle.Render(" help ") + "\n" + box
```
with:
```go
	content := strings.Join(lines, "\n")
	box := lipgloss.NewStyle().Width(boxW).Padding(0, 2).Foreground(ui.Text).Render(content)
	box = ui.HelpTitle.Render("help") + "\n" + box
```
Apply the same pattern (drop `Border`/`BorderForeground`, drop the leading space in the title, `Padding(1,2)` → `Padding(0,2)`) to `renderHistoryOverlay`. For `renderToolViewerOverlay` and `renderModelPickerOverlay`, `ui.ToolViewerBox` was already flattened to a border-less style in Task 2 Step 3 — those call sites (`ui.ToolViewerBox.Width(boxW).Render(...)`) need no further edit here, just confirm they no longer draw a border once Task 2 lands.

For `renderCompletions`, `ui.CompletionBox` was flattened the same way in Task 2 Step 3 — no call-site change needed there either.

- [ ] **Step 8: Build, then eyeball every screen**

Run: `cd tui && go build ./...`
Expected: clean build — every dangling reference from Task 2 Step 6 is now fixed.

Run: `cd tui && go test ./... -run TestPrintScreens -v`
Expected: dumps every named screen (`welcome`, `streaming`, `tool_viewer`, `error_card_turn`, …) to stdout. Read through `tool_viewer` and `error_card_turn` specifically — confirm the tool-pill continuation lines (Step 5's subtle indent) line up under the `⏺` mark, not double-indented or flush-left.

Run: `cd tui && go test ./...`
Expected: all existing tests pass unchanged (they assert on substrings like `"feral"`, `"streaming"`, `"tok"`, `"/model"` — none of which this task removes).

- [ ] **Step 9: Commit**

```bash
git add tui/ui/styles.go tui/ui/tool_emoji.go tui/ui/tool_emoji_test.go tui/app/view.go
git commit -m "feat(tui): flatten chat UI to Claude-Code-style borderless layout"
```
(Note: `git add` on deleted files stages the deletion — `tui/ui/tool_emoji.go` and its test are removed here per Task 3.)

---

## Task 5: Fix auto-scroll fighting manual scrollback

**Files:**
- Modify: `tui/app/model.go`
- Modify: `tui/app/update.go`

**The bug:** `rebuildViewport()` (`model.go:392-401`) unconditionally calls `a.ChatVP.GotoBottom()` whenever content changed and the viewport isn't already at the bottom. Since content changes on every streamed token, scrolling up mid-stream to read earlier text gets yanked back to the bottom on the very next token — scrollback is effectively unusable while the agent is talking.

- [ ] **Step 1: Add a `FollowBottom` flag to `App`**

In `tui/app/model.go`, add to the `App` struct (near `PrevContent`):
```go
	ChatVP      viewport.Model
	Input       textarea.Model
	Loader      spinner.Model
	PrevContent string
	// FollowBottom is true while the transcript should auto-scroll to the
	// newest content (the default, and what streaming needs). It flips to
	// false the moment the user scrolls up on purpose (PgUp / mouse wheel
	// up) and flips back once they've scrolled back down to the bottom —
	// mirrors how a normal terminal pager or chat client behaves, and
	// stops streaming tokens from yanking the view back down mid-read.
	FollowBottom bool
```

In `New()`, initialize it:
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
	}
```

Change `rebuildViewport`:
```go
func (a *App) rebuildViewport() {
	content := a.buildChatContent()
	if content != a.PrevContent {
		a.ChatVP.SetContent(content)
		a.PrevContent = content
		if a.FollowBottom {
			a.ChatVP.GotoBottom()
		}
	}
}
```

- [ ] **Step 2: Update `FollowBottom` when the user scrolls the viewport**

In `tui/app/update.go`, the `case "pgup", "pgdown":` block currently is:
```go
		case "pgup", "pgdown":
			var cmd tea.Cmd
			a.ChatVP, cmd = a.ChatVP.Update(msg)
			return a, cmd
```
Change to:
```go
		case "pgup", "pgdown":
			var cmd tea.Cmd
			a.ChatVP, cmd = a.ChatVP.Update(msg)
			a.FollowBottom = a.ChatVP.AtBottom()
			return a, cmd
```

- [ ] **Step 3: Re-enable following on new input**

`handleSubmit` (start of a fresh turn) and the `clear`/`new`/`reset` slash commands should always resume following — the user just acted, they want to see what happens next. Add `a.FollowBottom = true` in `handleSubmit` right before `a.rebuildViewport()`, and in the `"clear"`/`"new"` slash-command branches right before `a.setFlash(...)`.

- [ ] **Step 4: Build and test**

Run: `cd tui && go build ./... && go test ./...`
Expected: clean build, all tests pass (no test currently exercises `FollowBottom`, so nothing should break).

- [ ] **Step 5: Commit**

```bash
git add tui/app/model.go tui/app/update.go
git commit -m "fix(tui): stop auto-scroll from overriding manual scrollback during streaming"
```

---

## Task 6: Make the mouse wheel actually scroll the transcript

**Files:**
- Modify: `tui/app/update.go`

**The bug:** `main.go` enables `tea.WithMouseCellMotion()`, but `Update()`'s type switch has no `case tea.MouseMsg:` — every mouse event (including wheel) is silently dropped. Mouse wheel scrolling currently does nothing at all.

- [ ] **Step 1: Add a `tea.MouseMsg` case**

In `tui/app/update.go`, add a new case to the `switch msg := msg.(type)` block in `Update` (place it next to the `tea.KeyMsg` case, before the `spinner.TickMsg` case):
```go
	case tea.MouseMsg:
		if a.ShowHelp || a.ShowHistory || a.ToolViewer.Show || a.ModelPicker.Show {
			// Overlays don't scroll via mouse wheel yet — ignore rather
			// than let the wheel silently move the chat viewport behind
			// a modal the user is looking at.
			return a, nil
		}
		var cmd tea.Cmd
		a.ChatVP, cmd = a.ChatVP.Update(msg)
		a.FollowBottom = a.ChatVP.AtBottom()
		return a, cmd
```

- [ ] **Step 2: Build and manually verify**

Run: `cd tui && go build -o feral-tui.exe .`
Then launch it against a running gateway (`feral gateway start` if not already up) and scroll the mouse wheel over a transcript with a few turns in it — confirm the viewport moves and that streaming a new reply doesn't yank you back down (Task 5) unless you were already at the bottom.

- [ ] **Step 3: Commit**

```bash
git add tui/app/update.go
git commit -m "fix(tui): wire up mouse-wheel scrolling (was silently dropped)"
```

---

## Task 7: Fix flash messages that never expire

**Files:**
- Modify: `tui/app/update.go`

**The bug:** `setFlash()` sets `FlashUntil` but nothing ever checks it — once any flash fires (e.g. "switched to qwen2.5-7b" after `/model <id>`), `renderFooter` shows that stale text forever instead of the shortcut hint, since `FlashText` is only ever overwritten by the *next* flash, never cleared.

- [ ] **Step 1: Clear expired flashes on the spinner tick**

The spinner ticks continuously (bubbles' `spinner.Update` re-arms its own `tea.Tick` every ~100ms for as long as the program runs — confirmed by `Init()` calling `a.Loader.Tick` unconditionally and `case spinner.TickMsg` never stopping the chain). Piggyback on it instead of adding a new ticker. In `tui/app/update.go`, change:
```go
	case spinner.TickMsg:
		var cmd tea.Cmd
		a.Loader, cmd = a.Loader.Update(msg)
		if a.IsStreaming() {
			a.rebuildViewport()
		}
		return a, cmd
```
to:
```go
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

- [ ] **Step 2: Build and test**

Run: `cd tui && go build ./... && go test ./...`
Expected: clean build, all tests pass.

Manual check: run the TUI, trigger a flash (e.g. `/status`), confirm the footer reverts to `F1 for shortcuts · Ctrl+C to exit` on its own after ~5s without pressing another key.

- [ ] **Step 3: Commit**

```bash
git add tui/app/update.go
git commit -m "fix(tui): expire flash messages instead of leaving them stuck in the footer"
```

---

## Self-Review Notes

- **Spec coverage:** "minimalist like Claude Code, keep functionality/commands" → Tasks 1-4 (visual flatten, zero commands removed — `/help`, `/clear`, `/model`, `/tools`, `/status`, etc. all untouched, only their *rendering* changes). "UX overall isn't smooth" → Tasks 5-7 (scroll-lock fight, dead mouse wheel, stuck flash text) are the three concrete, verifiable interaction bugs found while reading `update.go`/`model.go`; no other smoothness issues were found (resize math in `Update`'s `tea.WindowSizeMsg` case is dead weight but harmless — `View()` recomputes layout from scratch every frame regardless, so it wasn't included as a "bug").
- **Ordering:** Tasks 1-4 must land together in that order (Task 2 intentionally leaves the package unbuildable until Task 4 lands — noted inline). Tasks 5-7 are independent of each other and of 1-4; they can be done in any order, or in parallel by different engineers, since they touch disjoint line ranges in `update.go`/`model.go` (verify no merge conflicts if split across people: Task 5 touches `model.go` struct+`rebuildViewport`+`update.go`'s pgup case; Task 6 adds a new case; Task 7 touches the spinner-tick case — three non-overlapping edits to the same file).
- **No placeholders:** every step above shows literal Go, not a description of Go.
