package app

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"feral-tui/ui"

	"github.com/charmbracelet/lipgloss"
)

func (a *App) View() string {
	if a.Width == 0 {
		return "Loading…"
	}

	headerH := 1
	footerH := 1
	sepH := 1
	inH := clamp(3, a.Input.Height()+2, a.Height/5)

	// Auxiliary strips above the input — the streaming status line and the
	// autocomplete popup. Each takes from the chat height so the layout
	// stays exact even when both are visible.
	auxH := 0
	if a.IsStreaming() {
		auxH += 1
	}
	if a.Completion.Show && len(a.Completion.List) > 0 {
		// +2 for the border + 1 row per item, capped so a short terminal
		// still has a usable chat viewport.
		items := len(a.Completion.List)
		if items > 6 {
			items = 6
		}
		auxH += items + 2
	}

	chatH := a.Height - headerH - inH - footerH - sepH - auxH
	if chatH < 4 {
		chatH = 4
	}

	a.ChatVP.Height = chatH
	a.ChatVP.Width = a.Width - 2
	a.rebuildViewport()

	header := a.renderHeader()
	chat := a.ChatVP.View()
	streamLine := a.renderStreamingStatus()
	completions := a.renderCompletions()
	input := a.renderInput(inH)
	footer := a.renderFooter()
	sep := ""

	// Order matters — JoinVertical drops empty strings, so the layout
	// gracefully shrinks when none of the aux strips are active.
	main := lipgloss.JoinVertical(
		lipgloss.Top,
		header,
		chat,
		sep,
		streamLine,
		completions,
		input,
		footer,
	)
	if a.ShowHelp {
		main = a.renderHelpOverlay(main)
	}
	if a.ShowHistory {
		main = a.renderHistoryOverlay(main)
	}
	if a.ToolViewer.Show {
		main = a.renderToolViewerOverlay(main)
	}
	if a.ModelPicker.Show {
		main = a.renderModelPickerOverlay(main)
	}
	return main
}

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
	lines = append(lines, ui.WelcomeTagline.Render(ui.G.Spark+" feral chat"))
	if a.Cwd != "" {
		lines = append(lines, ui.WelcomeValue.Render(a.Cwd))
	}
	lines = append(lines, "")
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

// renderWelcomeStatus builds the right-aligned-label / left-aligned-value
// rows that show what model is loaded and how healthy the runtime is.
func (a *App) renderWelcomeStatus() []string {
	m := orStr(a.Status.Model, "—")
	l := orStr(a.Status.LoRA, "none")
	// Prefer the human-friendly BYOK provider id when set — "nvidia" is
	// more useful than "openai_compatible" on a glance, but the raw
	// backend stays available so the user can still tell which protocol
	// the sidecar is using underneath.
	backend := a.Status.Backend
	if a.Status.ByokProvider != "" {
		backend = a.Status.ByokProvider
	}
	dot := ui.StatusOffline.Render(ui.G.On)
	state := "offline"
	if a.Status.Online {
		dot = ui.StatusOnline.Render(ui.G.On)
		state = "online"
	}
	elapsed := formatElapsed(time.Since(a.StartedAt))
	rows := [][2]string{
		{"model", m},
		{"lora", l},
		{"backend", backend},
		{"session", fmt.Sprintf("%s %s · ⏱ %s", dot, state, elapsed)},
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, fmt.Sprintf("%s %s",
			ui.WelcomeLabel.Render(r[0]),
			ui.WelcomeValue.Render(r[1]),
		))
	}
	return out
}

// renderWelcomeSessions renders the "recent" rows, falling back to a single
// dimmed placeholder when the fetch failed or returned nothing.
func (a *App) renderWelcomeSessions() []string {
	if a.SessionsErr != nil {
		return []string{ui.WelcomeSessMeta.Render("  (could not load recent sessions)")}
	}
	if len(a.Sessions) == 0 {
		return []string{ui.WelcomeSessMeta.Render("  (no previous sessions)")}
	}
	out := make([]string, 0, len(a.Sessions))
	for i, s := range a.Sessions {
		out = append(out, fmt.Sprintf("  %s %s   %s", ui.G.ThinkClosed,
			ui.WelcomeSess.Render(truncate(s.Title, 38)),
			ui.WelcomeSessMeta.Render("· "+formatRelative(s.UpdatedAt)),
		))
		_ = i
	}
	return out
}

// renderWelcomeShortcuts is the bottom keymap hint row — kept identical to
// the in-chat footer so muscle memory carries across.
func (a *App) renderWelcomeShortcuts() []string {
	row := func(k, d string) string {
		return fmt.Sprintf("  %s  %s", ui.KbdStyle.Render(k), ui.WelcomeSessMeta.Render(d))
	}
	return []string{
		row("↵", "send") + "  " + row("⇧↵", "newline") + "  " + row("/help", "commands"),
		row("^T", "thinking") + "  " + row("^H", "history") + "  " + row("^C", "exit"),
	}
}

// formatRelative turns an ISO-8601 timestamp into a coarse "5m / 2h /
// yesterday" label. Falls back to the raw string on parse error.
func formatRelative(iso string) string {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		t, err = time.Parse(time.RFC3339, iso)
		if err != nil {
			return iso
		}
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 48*time.Hour:
		return "yesterday"
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// formatElapsed renders a duration as `m:ss` (under an hour) or `h:mm:ss`.
func formatElapsed(d time.Duration) string {
	d = d.Truncate(time.Second)
	if d < time.Hour {
		return fmt.Sprintf("%d:%02d", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%d:%02d:%02d",
		int(d.Hours()), int(d.Minutes())%60, int(d.Seconds())%60)
}

// truncate is a rune-safe string cap with an ellipsis suffix when over.
func truncate(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max == 1 {
		return string(runes[:1])
	}
	return string(runes[:max-1]) + "…"
}

func (a *App) renderHeader() string {
	dot := ui.StatusOffline.Render(ui.G.On)
	state := "no sidecar"
	if a.Status.Online {
		dot = ui.StatusOnline.Render(ui.G.On)
		state = "online"
	}
	m := orStr(a.Status.Model, "—")
	l := orStr(a.Status.LoRA, "none")
	// Show the BYOK provider (nvidia / minimax / …) when one is active,
	// otherwise fall back to the generic backend label. Either way the
	// header stays one short phrase so it fits narrow terminals.
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

func (a *App) renderInput(h int) string {
	if a.IsStreaming() {
		// The streaming-status strip above the input already carries
		// tokens / tps / elapsed / cancel hint — duplicating a spinner
		// here just adds visual noise. Render an empty placeholder so
		// the layout height stays stable and the user's eye doesn't
		// jump around between the two strips.
		placeholder := ui.InputPlaceholder.Render("…  (esc to cancel)")
		return ui.InputStyle.Width(a.Width).Height(h).Render(ui.InputPrompt.Render(ui.G.Prompt) + " " + placeholder)
	}
	return ui.InputStyle.Width(a.Width).Height(h).Render(ui.InputPrompt.Render(ui.G.Prompt) + " " + a.Input.View())
}

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

func (a *App) renderHelpOverlay(under string) string {
	boxW := 56
	if a.Width < boxW+4 {
		boxW = a.Width - 4
	}
	lines := []string{
		"",
		helpLine("/help", "show this overlay"),
		helpLine("/tools", "browse tool calls + their results"),
		helpLine("/clear", "clear the history"),
		helpLine("/model", "show active model / lora / backend"),
		helpLine("/model list", "list installed models"),
		helpLine("/model <id>", "switch the loaded model"),
		helpLine("/exit", "quit the TUI"),
		"",
		helpLine("Enter", "send message / accept completion"),
		helpLine("Tab", "cycle slash-command completion"),
		helpLine("Shift+Enter", "insert newline"),
		helpLine("PgUp / PgDn", "scroll the history"),
		helpLine("Ctrl+T", "toggle the thinking pane"),
		helpLine("Ctrl+H", "toggle session history"),
		helpLine("F1", "toggle this help overlay"),
		helpLine("Esc", "close overlay / exit TUI"),
		helpLine("Ctrl+C", "exit TUI"),
		"",
		ui.HelpMeta.Render("  press Esc to close"),
	}
	content := strings.Join(lines, "\n")
	box := lipgloss.NewStyle().Width(boxW).Padding(0, 2).Foreground(ui.Text).Render(content)
	box = ui.HelpTitle.Render("help") + "\n" + box
	return lipgloss.Place(a.Width, a.Height,
		lipgloss.Center, lipgloss.Center, box,
		lipgloss.WithWhitespaceChars(" "))
}

func (a *App) renderHistoryOverlay(under string) string {
	boxW := 44
	if a.Width < boxW+4 {
		boxW = a.Width - 4
	}
	var lines []string
	lines = append(lines, "")
	if len(a.Turns) == 0 {
		lines = append(lines, ui.HelpMeta.Render("  no messages yet"))
	} else {
		n := 0
		for _, t := range a.Turns {
			if t.Role == RoleUser {
				n++
				preview := t.Text
				if len(preview) > 38 {
					preview = preview[:35] + "…"
				}
				lines = append(lines, fmt.Sprintf("  %d. %s", n, ui.HelpDesc.Render(preview)))
			}
		}
	}
	lines = append(lines, "")
	lines = append(lines, ui.HelpMeta.Render("  press Tab/Esc to close"))
	content := strings.Join(lines, "\n")
	box := lipgloss.NewStyle().Width(boxW).Padding(0, 2).Foreground(ui.Text).Render(content)
	box = ui.HelpTitle.Render("history") + "\n" + box
	return lipgloss.Place(a.Width, a.Height,
		lipgloss.Center, lipgloss.Center, box,
		lipgloss.WithWhitespaceChars(" "))
}

// renderToolViewerOverlay draws the full-screen tool-result browser.
// Layout:
//
//   tools  · 3 calls
//   ───────────────────────────────────────────────────────────
//   ▸ ● 📄 read_file (project_local_models_gpu.md)  ⏱ 0.1s ✓
//     ● 🛡️ scan_workspace                         ⏱ 1.2s ✓
//     ● 🔧 tool_health                            ⏱ 0.4s ✓
//   ───────────────────────────────────────────────────────────
//   ▸ result ────────────────────────────────────────────────
//   # project_local_models_gpu.md
//   On-disk models:
//   - bge-small-en-v1.5 (default embed)
//   ...
//   ───────────────────────────────────────────────────────────
//   ↑↓ navigate · enter expand · esc close
//
// The expanded preview panel appears under the list only when
// `ToolViewer.Expanded` is true; otherwise the box closes after the
// nav hint so the overlay stays one-screen-tall for 3-call turns.
func (a *App) renderToolViewerOverlay(under string) string {
	boxW := a.Width - 8
	if boxW < 50 {
		boxW = a.Width - 4
	}
	if boxW > 100 {
		boxW = 100
	}
	headerLine := fmt.Sprintf(" tools  ·  %d call%s",
		len(a.ToolViewer.Rows), plural(len(a.ToolViewer.Rows)))
	header := ui.ToolViewerTitle.Render(headerLine) +
		ui.ToolViewerMeta.Render("  "+strings.Repeat("─", boxW-lipgloss.Width(headerLine)-4))

	if len(a.ToolViewer.Rows) == 0 {
		rows := []string{
			"",
			ui.ToolViewerMeta.Render("  no tool calls yet — type a message that triggers one"),
		}
		content := strings.Join(rows, "\n")
		box := ui.ToolViewerBox.Width(boxW).Render(content)
		box = ui.ToolViewerTitle.Render(" tools ") + "\n" + header + "\n" + box
		return lipgloss.Place(a.Width, a.Height,
			lipgloss.Center, lipgloss.Center, box,
			lipgloss.WithWhitespaceChars(" "))
	}

	// Cap visible rows so a chat with 200 tool calls doesn't make the
	// overlay overflow the terminal — scrolling within the overlay is a
	// future enhancement. 12 rows + 2 for borders + preview footer fits
	// any terminal ≥ 24 rows tall.
	maxRows := 12
	end := a.ToolViewer.Idx + maxRows/2
	start := end - maxRows
	if start < 0 {
		start = 0
	}
	end = start + maxRows
	if end > len(a.ToolViewer.Rows) {
		end = len(a.ToolViewer.Rows)
	}
	visible := a.ToolViewer.Rows[start:end]

	rowLines := make([]string, 0, maxRows+2)
	for i, row := range visible {
		absoluteIdx := start + i
		line := formatToolViewerRow(row)
		if absoluteIdx == a.ToolViewer.Idx {
			line = ui.ToolViewerSel.Render("▸ " + stripAnsiLocal(line))
		} else {
			line = "  " + ui.ToolViewerRow.Render(stripAnsiLocal(line))
		}
		rowLines = append(rowLines, line)
	}

	body := strings.Join(rowLines, "\n")
	if a.ToolViewer.Expanded && a.ToolViewer.Idx < len(a.ToolViewer.Rows) {
		preview := formatToolViewerPreview(a.ToolViewer.Rows[a.ToolViewer.Idx], boxW-8)
		body += "\n" + strings.Repeat("─", boxW-4) + "\n" + preview
	}

	body += "\n" + strings.Repeat("─", boxW-4)
	hint := ui.ToolViewerMeta.Render("  ↑↓ navigate · enter expand · esc close")
	body += "\n" + hint

	box := ui.ToolViewerBox.Width(boxW).Render(body)
	box = ui.ToolViewerTitle.Render(" tools ") + "\n" + header + "\n" + box
	return lipgloss.Place(a.Width, a.Height,
		lipgloss.Center, lipgloss.Center, box,
		lipgloss.WithWhitespaceChars(" "))
}

// renderModelPickerOverlay draws the full-screen model picker. Layout:
//
//   models  ·  2 available
//   ─────────────────────────────────────────────────────────
//   ▸ ☁ nvidia:stepfun-ai/step-3.7-flash        cloud · nvidia
//     💻 Qwen_Qwen3-4B-Q5_K_M.gguf               local · llama.cpp
//   ─────────────────────────────────────────────────────────
//   ↑↓ navigate · enter switch · esc close
//
// Cloud entries show a ☁ icon and the provider id; local entries show
// 💻 and "llama.cpp". The active model is marked with a leading `●`.
func (a *App) renderModelPickerOverlay(under string) string {
	boxW := a.Width - 8
	if boxW < 50 {
		boxW = a.Width - 4
	}
	if boxW > 100 {
		boxW = 100
	}

	if a.ModelPicker.Loading {
		content := "\n" + ui.ToolViewerMeta.Render("  loading models…")
		box := ui.ToolViewerBox.Width(boxW).Render(content)
		box = ui.ToolViewerTitle.Render(" models ") + "\n" + box
		return lipgloss.Place(a.Width, a.Height,
			lipgloss.Center, lipgloss.Center, box,
			lipgloss.WithWhitespaceChars(" "))
	}

	if a.ModelPicker.LoadErr != "" && len(a.ModelPicker.Rows) == 0 {
		content := "\n" + ui.ToolViewerMeta.Render("  "+a.ModelPicker.LoadErr)
		box := ui.ToolViewerBox.Width(boxW).Render(content)
		box = ui.ToolViewerTitle.Render(" models ") + "\n" + box
		return lipgloss.Place(a.Width, a.Height,
			lipgloss.Center, lipgloss.Center, box,
			lipgloss.WithWhitespaceChars(" "))
	}

	headerLine := fmt.Sprintf(" models  ·  %d available", len(a.ModelPicker.Rows))
	header := ui.ToolViewerTitle.Render(headerLine) +
		ui.ToolViewerMeta.Render("  "+strings.Repeat("─", boxW-lipgloss.Width(headerLine)-4))

	maxRows := 14
	start := 0
	end := len(a.ModelPicker.Rows)
	if end-start > maxRows {
		start = a.ModelPicker.Idx - maxRows/2
		if start < 0 {
			start = 0
		}
		end = start + maxRows
		if end > len(a.ModelPicker.Rows) {
			end = len(a.ModelPicker.Rows)
			start = end - maxRows
			if start < 0 {
				start = 0
			}
		}
	}
	visible := a.ModelPicker.Rows[start:end]

	rowLines := make([]string, 0, maxRows+2)
	for i, row := range visible {
		absIdx := start + i
		icon := "💻"
		kind := "local"
		if row.Kind == "cloud" {
			icon = "☁"
			kind = "cloud"
			if row.Provider != "" {
				kind = "cloud · " + row.Provider
			}
		}
		marker := " "
		if row.Active {
			marker = "●"
		}
		line := fmt.Sprintf("%s %s %s   %s",
			marker, icon, row.ID, ui.ToolViewerMeta.Render(kind))
		if absIdx == a.ModelPicker.Idx {
			line = ui.ToolViewerSel.Render("▸ " + stripAnsiLocal(line))
		} else {
			line = "  " + ui.ToolViewerRow.Render(stripAnsiLocal(line))
		}
		rowLines = append(rowLines, line)
	}
	body := strings.Join(rowLines, "\n")
	body += "\n" + strings.Repeat("─", boxW-4)
	hint := ui.ToolViewerMeta.Render("  ↑↓ navigate · enter switch · tab cycle · esc close")
	body += "\n" + hint

	box := ui.ToolViewerBox.Width(boxW).Render(body)
	box = ui.ToolViewerTitle.Render(" models ") + "\n" + header + "\n" + box
	return lipgloss.Place(a.Width, a.Height,
		lipgloss.Center, lipgloss.Center, box,
		lipgloss.WithWhitespaceChars(" "))
}

// formatToolViewerRow renders one row of the tool list in the visual
// style shared with the inline pill, so the eye recognises a tool the
// user has seen on the transcript.
func formatToolViewerRow(row ToolViewerRow) string {
	name := ui.ToolViewerRow.Render(row.Call.Name)
	arg := ""
	if row.Call.Main != "" {
		arg = ui.ToolViewerMeta.Render(fmt.Sprintf(" (%s)", truncateRunes(row.Call.Main, 40)))
	}
	elapsed := "⠿"
	switch row.Call.Status {
	case ToolDone:
		elapsed = ui.ToolViewerMeta.Render(fmt.Sprintf("⏱ %s ✓", formatElapsed(row.Call.EndedAt.Sub(row.Call.StartedAt))))
	case ToolError:
		elapsed = ui.ToolViewerMeta.Render(fmt.Sprintf("⏱ %s !", formatElapsed(row.Call.EndedAt.Sub(row.Call.StartedAt))))
	default:
		// Running — show elapsed-so-far.
		elapsed = ui.ToolViewerMeta.Render(fmt.Sprintf("⏱ %s ⠿", formatElapsed(time.Since(row.Call.StartedAt))))
	}
	return fmt.Sprintf("%s %s%s   %s", ui.ToolMark.Render(ui.G.ToolMark), name, arg, elapsed)
}

// formatToolViewerPreview renders the expanded preview panel for the
// highlighted row. Caps at 16 lines so the overlay stays scannable;
// `tool_call: …` results that don't fit get a "(N more chars)" hint so
// the user knows there's more to inspect via the underlying log file.
func formatToolViewerPreview(row ToolViewerRow, width int) string {
	tc := row.Call
	if tc.Preview == "" {
		return ui.ToolViewerMeta.Render("  (no result preview available — tool is still running or didn't return data)")
	}
	preview := tc.Preview
	lines := strings.Split(preview, "\n")
	const maxLines = 16
	truncated := false
	if len(lines) > maxLines {
		lines = lines[:maxLines]
		truncated = true
	}
	diff := looksLikeDiff(preview)
	out := make([]string, 0, len(lines)+2)
	out = append(out, ui.ToolViewerMeta.Render(" "+ui.G.ThinkClosed+" result --"))
	for _, line := range lines {
		clipped := truncateRunes(line, width)
		if diff {
			out = append(out, "   "+renderDiffLine(clipped))
			continue
		}
		out = append(out, "   "+ui.ToolViewerPreview.Render(clipped))
	}
	if truncated {
		out = append(out, ui.ToolViewerMeta.Render(
			fmt.Sprintf("   … (%d more chars)", len(tc.Preview)-len(strings.Join(lines, "\n")))))
	}
	if tc.ErrMsg != "" {
		out = append(out, ui.ToolViewerMeta.Render("   error: ")+ui.ToolViewerRow.Render(tc.ErrMsg))
	}
	return strings.Join(out, "\n")
}

// looksLikeDiff reports whether text is unified-diff shaped (git_diff tool
// output, or any tool result that happens to embed one) — enough of the
// standard markers that plain prose won't false-positive.
func looksLikeDiff(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "),
			strings.HasPrefix(line, "@@ "),
			strings.HasPrefix(line, "--- a/"),
			strings.HasPrefix(line, "+++ b/"):
			return true
		}
	}
	return false
}

// renderDiffLine colors one line of a unified diff — added lines green,
// removed lines red, hunk headers and file markers dim/accent, everything
// else (context lines) in the plain preview style.
func renderDiffLine(line string) string {
	switch {
	case strings.HasPrefix(line, "+++ "), strings.HasPrefix(line, "--- "), strings.HasPrefix(line, "diff --git "):
		return ui.DiffFile.Render(line)
	case strings.HasPrefix(line, "@@"):
		return ui.DiffHunk.Render(line)
	case strings.HasPrefix(line, "+"):
		return ui.DiffAdd.Render(line)
	case strings.HasPrefix(line, "-"):
		return ui.DiffDel.Render(line)
	default:
		return ui.ToolViewerPreview.Render(line)
	}
}

// plural returns "s" when n != 1, else "" — keeps the overlay header
// grammatical without dragging in a third-party inflector.
func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// stripAnsiLocal is a tiny CSI-only stripper for the overlay — same
// approach as the test helper, kept local so the viewer file stays
// self-contained. Drops `\x1b[…m` runs.
func stripAnsiLocal(s string) string {
	var b strings.Builder
	i := 0
	for i < len(s) {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) {
				c := s[j]
				j++
				if (c >= 0x40 && c <= 0x7e) || c == 'm' {
					break
				}
			}
			i = j
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

func helpLine(key, desc string) string {
	return fmt.Sprintf("  %s  %s", ui.HelpKey.Render(key), ui.HelpDesc.Render(desc))
}

// renderErrorCard draws a flat, unboxed error line — matches the tool-pill
// shape: "⏺ error · kind" then indented message/hint lines, colored by
// Kind (see inferErrorKind) so the eye still categorises the failure
// before reading text, just without a drawn border around it.
func (a *App) renderErrorCard(e ErrorCard, width int) string {
	if width < 20 {
		width = 20
	}
	mark := ui.ErrorTitle.Render(ui.G.ToolMark + " error")
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

// renderCompletions renders the slash-command autocomplete popup as a
// dim-bordered box anchored to the width of the input area. Empty string
// when the popup is hidden — JoinVertical drops it cleanly.
//
// Layout per row:
//
//   ▸ /help              show this overlay
//
// where `▸` marks the highlighted row and the right column shows the
// command's one-line description. The bottom strip carries a hint so the
// user knows Tab cycles and Enter accepts.
func (a *App) renderCompletions() string {
	if !a.Completion.Show || len(a.Completion.List) == 0 {
		return ""
	}
	// Cap the visible list so a tall registry + narrow terminal still
	// leaves room for the chat viewport. 6 items is enough to fit every
	// currently-known command without scrolling.
	shown := a.Completion.List
	if len(shown) > 6 {
		shown = shown[:6]
	}
	// Fixed description column width so the box edges line up.
	descW := 0
	for _, c := range shown {
		if w := lipgloss.Width(c.Desc); w > descW {
			descW = w
		}
	}
	rows := make([]string, 0, len(shown)+1)
	for i, c := range shown {
		var name string
		if i == a.Completion.Idx {
			name = ui.CompletionSel.Render("▸ "+c.Text) + "  " + ui.CompletionDesc.Render(c.Desc)
		} else {
			name = "  " + ui.CompletionItem.Render(c.Text) + "  " + ui.CompletionDesc.Render(c.Desc)
		}
		rows = append(rows, name)
	}
	hint := ui.CompletionHint.Render("  tab/↑↓ cycle · enter accept · esc dismiss")
	rows = append(rows, hint)

	box := ui.CompletionBox.Width(a.Width - 2).Render(strings.Join(rows, "\n"))
	return box
}

// renderStreamingStatus is the 1-line status strip that replaces the
// spinner-only "streaming…" indicator while a turn is in flight. Shows
// elapsed wall time, total tokens emitted so far, and a live tokens-per-
// second number so the user can tell at a glance whether the model is
// making progress.
//
// Hidden when idle (returns "" so JoinVertical drops it).
func (a *App) renderStreamingStatus() string {
	if !a.IsStreaming() {
		return ""
	}
	elapsed := formatElapsed(time.Since(a.StreamStartedAt))
	tokens := a.StreamCompletionTokens
	if tokens <= 0 {
		// No `usage` event yet — show what we know (elapsed + spinner). Past
		// 8s with zero tokens the model is almost certainly still prefilling
		// the prompt (long context + CPU inference can take tens of seconds
		// before the first token), not hung — say so explicitly, otherwise a
		// bare spinner + growing timer is indistinguishable from a freeze.
		status := ui.StreamStatus.Render(fmt.Sprintf("▌ streaming %s", a.Loader.View())) +
			"  " + ui.StreamDim.Render(fmt.Sprintf("⏱ %s", elapsed))
		if time.Since(a.StreamStartedAt) > 8*time.Second {
			status += "  " + ui.StreamStalled.Render("⏳ prefilling prompt — first token can take a while on CPU")
		}
		status += "  " + ui.StreamHint.Render("esc to cancel")
		return status
	}
	tps := 0.0
	if d := time.Since(a.StreamStartedAt).Seconds(); d > 0 {
		tps = float64(tokens) / d
	}
	status := ui.StreamStatus.Render(fmt.Sprintf("▌ streaming %s", a.Loader.View())) +
		"  " + ui.StreamNumber.Render(fmt.Sprintf("%d tok", tokens)) +
		"  " + ui.StreamDim.Render(fmt.Sprintf("%.1f t/s", tps)) +
		"  " + ui.StreamDim.Render(fmt.Sprintf("⏱ %s", elapsed))

	// Stall hint — if the model hasn't emitted a token for >3s, surface it
	// in the warning color so the user knows the agent is still working
	// but the rate has dropped (e.g. tool call in flight, GPU stall).
	if !a.LastTokenAt.IsZero() && time.Since(a.LastTokenAt) > 3*time.Second {
		status += "  " + ui.StreamStalled.Render("⏳ thinking…")
	}

	// Right-aligned cancel hint so the eye knows the affordance is at the
	// end of the same line, not somewhere else.
	status += "  " + ui.StreamHint.Render("esc to cancel")
	return status
}

// collapseToolThreshold is the tool-call count past which a finished, all-
// successful turn collapses its pills into one summary line.
const collapseToolThreshold = 4

// collapsedToolSummary returns the one-line "ran N tool calls" summary for
// turn, or "" if the turn should render every pill individually (still
// streaming, too few calls, or at least one error/running call — those
// need to stay visible on their own).
func collapsedToolSummary(turn *Turn, gutter string) string {
	if turn.Streaming || len(turn.Tools) < collapseToolThreshold {
		return ""
	}
	var total time.Duration
	for _, tc := range turn.Tools {
		if tc.Status != ToolDone {
			return ""
		}
		total += tc.endedOrNow()
	}
	line := fmt.Sprintf("%s %s  %s",
		ui.ToolDone.Render(ui.ToolMark.Render(ui.G.ToolMark)),
		fmt.Sprintf("ran %d tool calls", len(turn.Tools)),
		ui.MetaStyle.Render(fmt.Sprintf("⏱ %s total · /tools for details", formatElapsed(total))))
	return gutter + line
}

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
	if t.Preview != "" {
		preview := truncate(t.Preview, width-TagIndent-2)
		if preview != "" {
			out = append(out, "  "+ui.ToolResult.Render(ui.G.Result)+" "+ui.MetaStyle.Render(preview))
		}
	}
	return strings.Join(out, "\n"+gutter)
}

// TagIndent is the indent at which tool pills sit inside an assistant
// turn — one space past the tag column, matching the gutter used by every
// continuation line in the transcript.
const TagIndent = ui.TagWidth + 1

// endedOrNow returns EndedAt for completed tools, time.Now() for running
// ones — so the elapsed counter animates without the caller having to
// pre-rewind.
func (t ToolCall) endedOrNow() time.Duration {
	end := t.EndedAt
	if end.IsZero() {
		end = time.Now()
	}
	return end.Sub(t.StartedAt)
}

// statusGlyph returns the right tail-glyph + colour for a tool call's
// status. `⠿` while running (a moving-spinner feel without a separate
// spinner widget), `✓` on success, `!` on error.
func (t ToolCall) statusGlyph() (string, lipgloss.Style) {
	switch t.Status {
	case ToolRunning:
		return "⠿", ui.ToolRunning
	case ToolError:
		return "!", ui.ToolError
	default:
		return "✓", ui.ToolDone
	}
}

// clampLen returns a byte index safe to slice s[:idx] at, truncated to at
// most `max` runes. ponytail: rune-count width, not display width — wide
// (double-column) runes aren't accounted for; upgrade to lipgloss.Width
// per-rune if CJK/emoji truncation misalignment ever matters here.
func clampLen(s string, max int) int {
	if max <= 0 {
		return 0
	}
	runes := []rune(s)
	if len(runes) <= max {
		return len(s)
	}
	return len(string(runes[:max]))
}

func reflow(text string, width int) []string {
	if width <= 0 {
		return []string{text}
	}
	var out []string
	for _, para := range strings.Split(text, "\n") {
		if para == "" {
			out = append(out, "")
			continue
		}
		line := ""
		lw := 0
		for _, tok := range splitTokens(para) {
			tw := utf8.RuneCountInString(tok)
			if lw+tw <= width {
				line += tok
				lw += tw
			} else if lw == 0 {
				r := []rune(tok)
				for len(r) > 0 {
					n := width
					if n > len(r) {
						n = len(r)
					}
					out = append(out, string(r[:n]))
					r = r[n:]
				}
				lw = 0
			} else {
				out = append(out, strings.TrimRight(line, " "))
				line = ""
				lw = 0
				if tok == " " {
					continue
				}
				line += tok
				lw = tw
			}
		}
		out = append(out, strings.TrimRight(line, " "))
	}
	if len(out) == 0 {
		out = append(out, "")
	}
	return out
}

func splitTokens(s string) []string {
	var tokens []string
	runes := []rune(s)
	i := 0
	for i < len(runes) {
		if runes[i] == ' ' {
			tokens = append(tokens, " ")
			i++
			continue
		}
		start := i
		for i < len(runes) && runes[i] != ' ' {
			i++
		}
		tokens = append(tokens, string(runes[start:i]))
	}
	return tokens
}
