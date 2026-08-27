package app

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"cinderpaw-tui/ui"

	"github.com/charmbracelet/lipgloss"
)

func (a *App) View() string {
	if a.Width == 0 {
		return "Loading…"
	}
	// Freeze frame on too-small terminals (§17).
	if a.Width < 40 || a.Height < 10 {
		return ui.MetaStyle.Render("terminal too small (min 40×10)")
	}

	headerH := 1
	footerH := 1
	sepH := 1
	maxInH := 6
	if a.Height/4 < maxInH {
		maxInH = a.Height / 4
	}
	inH := clamp(1, a.Input.Height()+2, maxInH)

	// Guided mode: same layout as the wizard — header, guided content,
	// guided footer, no input.
	if a.Guided.Show {
		header := a.renderHeader()
		chat := a.renderGuided()
		footer := ui.FooterStyle.Render(a.Guided.footerHint())
		return lipgloss.JoinVertical(lipgloss.Top, header, chat, "", footer)
	}

	// Wizard mode: input hidden, wizard footer, wizard content in chat area.
	if a.Wizard.Show {
		chatH := a.Height - headerH - footerH - 1
		if chatH < 10 {
			chatH = 10
		}
		// Write only on change: View() must be idempotent. Unconditional
		// stores here made every repaint mutate model state, which fed
		// back into the next frame's layout decisions.
		vpW := a.Width - 2
		if a.ChatVP.Height != chatH || a.ChatVP.Width != vpW {
			a.ChatVP.Height = chatH
			a.ChatVP.Width = vpW
			a.needsRebuild = true
		}
		if a.needsRebuild {
			a.rebuildViewport()
		}

		header := a.renderHeader()
		chat := a.renderWizard()
		input := ""
		footer := renderWizardFooter(&a.Wizard)
		main := lipgloss.JoinVertical(lipgloss.Top, header, chat, input, footer)
		return main
	}

	// Auxiliary strips above the input — the streaming status line and the
	// autocomplete popup. Each takes from the chat height so the layout
	// stays exact even when both are visible.
	auxH := 0
	if a.IsStreaming() || a.State == StateThinking {
		auxH += 1
	}
	if a.Completion.Show && len(a.Completion.List) > 0 {
		items := len(a.Completion.List)
		if items > 8 {
			items = 8
		}
		auxH += items + 2
	}

	chatH := a.Height - headerH - inH - footerH - sepH - auxH
	if chatH < 4 {
		chatH = 4
	}

	// Set dimensions only when they actually changed — View() must be
	// idempotent (same reasoning as the wizard branch above).
	vpW := a.Width - 2
	widthChanged := a.ChatVP.Width != vpW
	if a.ChatVP.Height != chatH || widthChanged {
		a.ChatVP.Height = chatH
		a.ChatVP.Width = vpW
	}

	// Detect auxH changes (streaming start/stop, completion popup) that
	// affect viewport height — force a rebuild when the layout shifts.
	// Width changes need the same treatment; prevChatH only covers height.
	if chatH != a.prevChatH || widthChanged {
		a.needsRebuild = true
	}
	a.prevChatH = chatH

	if a.needsRebuild {
		a.rebuildViewport()
	}

	header := a.renderHeader()
	chat := a.ChatVP.View()
	streamLine := a.renderStreamingStatus()
	completions := a.renderCompletions()
	input := a.renderInput(inH)
	footer := a.renderFooter()

	// JoinVertical does NOT drop empty strings — each "" contributes one
	// blank line. Inactive aux strips must be skipped explicitly, or the
	// frame ends up taller than the terminal, the terminal scrolls on every
	// repaint, and the diff renderer desyncs — the "blank screen, only the
	// input row visible" bug (2026-07-11). The one literal "" kept below is
	// the budgeted blank separator between chat and input (sepH in chatH).
	segs := make([]string, 0, 7)
	segs = append(segs, header, chat, "")
	if streamLine != "" {
		segs = append(segs, streamLine)
	}
	if completions != "" {
		segs = append(segs, completions)
	}
	segs = append(segs, input, footer)
	main := lipgloss.JoinVertical(lipgloss.Top, segs...)
	if a.ShowHelp {
		main = a.renderHelpOverlay(main)
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
	lines = append(lines, ui.WelcomeTagline.Render(ui.G.Spark+" cinderpaw chat"))
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
	elapsed := formatElapsed(a.Now.Sub(a.StartedAt))
	rows := [][2]string{
		{"model", m},
		{"lora", l},
		{"backend", backend},
		{"session", fmt.Sprintf("%s %s · ⏱ %s", dot, state, elapsed)},
	}
	out := make([]string, 0, len(rows)+1)
	for _, r := range rows {
		out = append(out, fmt.Sprintf("%s %s",
			ui.WelcomeLabel.Render(r[0]),
			ui.WelcomeValue.Render(r[1]),
		))
	}

	// Sprint 1.8 — Memory Resume last-task row. Sits below the status block,
	// renders "↻ <title> · <workspace> · <relative>" or is suppressed when
	// (a) no task, (b) stale (>30 days), (c) a transient fetch error. The
	// same staleness rule the React WelcomeBack banner uses.
	if resumeLine := a.renderWelcomeResume(); resumeLine != "" {
		out = append(out, resumeLine)
	}
	return out
}

// Sprint 1.8 — Memory Resume last-task row. Sits below the status block,
// renders "↻ <title> · <workspace> · <relative>" or is suppressed when
// (a) no task, (b) stale (>30 days), (c) a transient fetch error. The
// same staleness rule the React WelcomeBack banner uses.
func (a *App) renderWelcomeResume() string {
	if a.LastTaskView == nil || a.LastTask == nil {
		return ""
	}
	task := a.LastTask
	if task.Title == "" {
		return ""
	}
	ref := a.LastTaskView.LastActiveAt
	if ref <= 0 {
		ref = task.TS
	}
	if ref <= 0 || a.Now.Sub(time.UnixMilli(ref)) > 30*24*time.Hour {
		return ""
	}
	rel := formatRelativeMs(ref, a.Now)
	ws := a.LastTaskView.WorkspaceName
	line := fmt.Sprintf("welcome back · %s", task.Title)
	if ws != "" {
		line = fmt.Sprintf("%s · in %s", line, ws)
	}
	line = fmt.Sprintf("%s · %s", line, rel)
	return fmt.Sprintf("%s %s",
		ui.WelcomeLabel.Render("resume"),
		ui.WelcomeValue.Render(line),
	)
}

// formatRelativeMs is the unix-ms variant of formatRelative — same labels
// ("5m ago", "yesterday"), different input. Used by renderWelcomeResume.
func formatRelativeMs(ms int64, now time.Time) string {
	if ms <= 0 {
		return "—"
	}
	return formatRelative(time.UnixMilli(ms).UTC().Format(time.RFC3339Nano), now)
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
			ui.WelcomeSessMeta.Render("· "+formatRelative(s.UpdatedAt, a.Now)),
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
		row("^R", "thinking") + "  " + row("^C ×2", "exit"),
	}
}

// formatRelative turns an ISO-8601 timestamp into a coarse "5m / 2h /
// yesterday" label. Falls back to the raw string on parse error.
// `now` is injected by the caller (spec §34.4: View never calls time.Now).
func formatRelative(iso string, now time.Time) string {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		t, err = time.Parse(time.RFC3339, iso)
		if err != nil {
			return iso
		}
	}
	d := now.Sub(t)
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
	dot := ui.StatusOffline.Render(ui.G.Off)
	state := "starting"
	if a.State == StateBoot {
		// Boot flash — show "○ starting" (§2 J2.1).
	} else if a.Status.Online {
		dot = ui.StatusOnline.Render(ui.G.On)
		state = "online"
	} else if a.State == StateRecovery {
		state = fmt.Sprintf("reconnecting… (attempt %d)", a.RecoverAttempts)
	} else {
		state = "no sidecar"
	}
	brand := ui.BrandStyle.Render("feral")
	right := fmt.Sprintf("%s %s", dot, state)

	// Build left segments right-to-left, dropping the rightmost segment
	// when it doesn't fit (spec §29 segment-drop loop).
	type segment struct {
		label string // e.g. "model", "lora", "backend"
		value string
	}
	var segs []segment
	if a.Width >= 60 {
		segs = append(segs, segment{"model", orStr(a.Status.Model, "—")})
	}
	if a.Width >= 80 {
		segs = append(segs, segment{"lora", orStr(a.Status.LoRA, "none")})
		backendLabel := a.Status.Backend
		if a.Status.ByokProvider != "" {
			backendLabel = a.Status.ByokProvider
		}
		segs = append(segs, segment{"backend", backendLabel})
	}

	// Assemble segments into a single string, measuring as we go.
	left := brand
	for i, s := range segs {
		part := fmt.Sprintf("%s %s", ui.MetaStyle.Render(s.label), ui.HeaderValue.Render(s.value))
		if i == 0 {
			left = brand + "  " + part
		} else {
			left += "  " + part
		}
		// Check if it fits: brand + all so far + right + padding.
		needed := lipgloss.Width(left) + lipgloss.Width(right) + 2
		if needed > a.Width {
			// Drop this segment and everything after it.
			if i == 0 {
				left = brand
			} else {
				// Rebuild without this and later segments.
				left = brand
				for j := 0; j < i; j++ {
					part := fmt.Sprintf("%s %s",
						ui.MetaStyle.Render(segs[j].label),
						ui.HeaderValue.Render(segs[j].value))
					left += "  " + part
				}
			}
			break
		}
	}
	// If brand alone is too wide, just show the right side.
	if lipgloss.Width(brand)+lipgloss.Width(right)+2 > a.Width {
		return ui.HeaderStyle.Render(right)
	}

	pad := a.Width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if pad < 1 {
		pad = 1
	}
	return ui.HeaderStyle.Render(" " + left + strings.Repeat(" ", pad) + right)
}

func (a *App) renderInput(h int) string {
	// P2.3: keep the textarea focused and editable during streaming.
	// The streaming-status strip above carries tokens / tps / cancel
	// hint; the input itself stays interactive so the user can type
	// ahead. Enter during StateStreaming queues the text into
	// App.PendingSubmit (auto-submitted on the next clean StreamDoneMsg).
	return ui.InputStyle.Width(a.Width).Height(h).Render(ui.InputPrompt.Render(ui.G.Prompt) + " " + a.Input.View())
}

func (a *App) renderFooter() string {
	// Narrow terminal: shorten hints (§17 40–59 cols).
	short := a.Width < 60 && !a.IsStreaming() && a.State != StateError && a.State != StateWaiting

	if a.State == StateError {
		return ui.FooterStyle.Render(a.renderErrorFooter())
	}
	if a.FlashText != "" {
		return ui.FooterStyle.Render(ui.FlashStyle.Render(a.FlashText))
	}

	// State-specific dynamic rendering (§3). The bare text lives in
	// FooterHint() but live data (model name, tool name, attempt count,
	// progress bytes, dimmer) is added here.
	var hint string
	switch a.State {
	case StateLoadingModel:
		name := orStr(a.Status.Model, "model")
		hint = fmt.Sprintf("loading %s…", name)
	case StateToolRunning:
		if name := a.runningToolName(); name != "" {
			hint = fmt.Sprintf("running %s…", name)
		} else {
			hint = "running…"
		}
	case StateDownloadingModel:
		hint = a.renderDownloadProgress()
	case StateRecovery:
		hint = fmt.Sprintf("reconnecting… (attempt %d)", a.RecoverAttempts)
	case StateIdle:
		hint = ui.MetaStyle.Render("F1 for shortcuts · Ctrl+C to exit")
	default:
		hint = a.State.FooterHint()
	}
	if short {
		hint = shortHint(stripAnsiLocal(hint))
	}
	return ui.FooterStyle.Render(hint)
}

// renderErrorFooter renders the StateError footer line — kind + hint per
// spec §14. The kind and hint come from the trailing assistant turn's
// ErrorCard (filled by pushAssistantError → inferErrorKind).
func (a *App) renderErrorFooter() string {
	kind, hint := "error", "r to retry"
	if !a.RateLimitUntil.IsZero() {
		remaining := int(a.RateLimitUntil.Sub(a.Now).Seconds())
		if remaining < 0 {
			remaining = 0
		}
		kind = "error · rate limited"
		hint = fmt.Sprintf("cooling down %ds — r to retry now", remaining)
	} else if t := a.lastAssistantTurn(); t != nil {
		for i := len(t.Errors) - 1; i >= 0; i-- {
			e := t.Errors[i]
			if e.Kind != "" && e.Kind != "unknown" {
				kind = "error · " + humanKind(e.Kind)
				if e.Hint != "" {
					hint = e.Hint
				}
				break
			}
		}
	}
	return ui.ErrorTitle.Render(kind) + ui.MetaStyle.Render("  "+hint)
}

// humanKind maps inferErrorKind machine tokens to human footer labels
// per spec §14's table ("no model", "offline", "provider down", etc.).
func humanKind(k string) string {
	switch k {
	case "no_model":
		return "no model"
	case "runtime_lost":
		// Terminal surfaces say "gateway" — the same noun as the CLI's
		// `feral gateway` command — so a user can transfer the word straight
		// into the fix (audit 2026-07-10 Part 5, gateway had 4 names).
		return "gateway lost"
	case "rate_limited":
		return "rate limited"
	case "provider_down":
		return "provider down"
	default:
		return k
	}
}

// renderDownloadProgress renders the §3 DownloadingModel footer line:
// "↓ name 38% · 1.6/4.1 GB · 12 MB/s". Returns empty string when no
// active download is reported.
func (a *App) renderDownloadProgress() string {
	if a.DownloadBytesTot <= 0 {
		return ""
	}
	pct := float64(a.DownloadBytesDone) / float64(a.DownloadBytesTot) * 100
	if pct > 100 {
		pct = 100
	}
	done := float64(a.DownloadBytesDone) / (1024 * 1024 * 1024)
	tot := float64(a.DownloadBytesTot) / (1024 * 1024 * 1024)
	mbps := a.DownloadMBps
	return fmt.Sprintf("%s %s  %.0f%% \u00b7 %.1f/%.1f GB \u00b7 %.0f MB/s",
		ui.G.Down, orStr(a.Status.Model, "model"),
		pct, done, tot, mbps)
}

// shortHint returns a compressed version of the footer hint for narrow
// terminals (§17 <60 cols). Key names only, no descriptions.
func shortHint(hint string) string {
	switch hint {
	case "F1 for shortcuts · Ctrl+C to exit":
		return "F1 · ^C"
	default:
		return hint
	}
}

func (a *App) renderHelpOverlay(under string) string {
	boxW := a.Width - 8
	if boxW < 50 {
		boxW = a.Width - 4
	}
	if boxW > 100 {
		boxW = 100
	}
	// Commands + keys both render from single sources of truth: the command
	// Registry (P0.8) and Keys.HelpEntries(). No hand-maintained lists.
	lines := []string{""}
	for _, c := range nonHiddenCommands() {
		lines = append(lines, helpCommandLine(c))
	}
	lines = append(lines, "")
	for _, b := range Keys.HelpEntries() {
		h := b.Help()
		lines = append(lines, helpLine(h.Key, h.Desc))
	}
	lines = append(lines,
		"",
		ui.HelpMeta.Render("  esc close"),
	)
	content := strings.Join(lines, "\n")
	box := lipgloss.NewStyle().Width(boxW).Padding(0, 2).Foreground(ui.Text).Render(content)
	box = ui.HelpTitle.Render("help") + "\n" + box
	overlay := lipgloss.Place(a.Width, a.Height,
		lipgloss.Center, lipgloss.Center, box,
		lipgloss.WithWhitespaceChars(" "))
	return composeOverlay(under, overlay, a.Width, a.Height)
}

// composeOverlay places a centered overlay box on top of an existing
// frame string (`under`), per spec §4: "Backdrop is the dimmed
// transcript (no fill)". Cells inside the overlay's bounding box come
// from the overlay; cells outside come from the underlying frame. Both
// inputs are expected to be exactly `width × height` in dimensions;
// anything else gets padded with spaces.
func composeOverlay(under, overlay string, width, height int) string {
	if under == "" {
		return overlay
	}
	underLines := strings.Split(under, "\n")
	overlayLines := strings.Split(overlay, "\n")

	// Compute the overlay's vertical range. lipgloss.Place centers it,
	// so the top row is (height - boxH) / 2 where boxH = len(overlayLines).
	boxH := len(overlayLines)
	boxW := 0
	for _, l := range overlayLines {
		if w := lipgloss.Width(l); w > boxW {
			boxW = w
		}
	}
	boxTop := (height - boxH) / 2
	boxLeft := (width - boxW) / 2
	_ = boxLeft

	// Pad both to width × height.
	for len(underLines) < height {
		underLines = append(underLines, strings.Repeat(" ", width))
	}
	if len(underLines) > height {
		underLines = underLines[:height]
	}
	for len(overlayLines) < height {
		overlayLines = append(overlayLines, "")
	}
	if len(overlayLines) > height {
		overlayLines = overlayLines[:height]
	}

	var b strings.Builder
	for r := 0; r < height; r++ {
		var row string
		if r >= boxTop && r < boxTop+boxH {
			ol := overlayLines[r]
			pad := width - lipgloss.Width(ol)
			if pad < 0 {
				pad = 0
			}
			row = ol + strings.Repeat(" ", pad)
		} else {
			row = underLines[r]
		}
		if r > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(row)
	}
	return b.String()
}

// renderWizResume renders the F2 partial-progress resume screen
// (spec §PARTIAL PROGRESS PERSISTENCE). Shown when a previous run
// exited mid-onboarding: progress file exists, wizard-done does not.
// The user can Resume from the saved step or Start Over.
func renderWizResume(w *WizardState, width int) string {
	type opt struct {
		name string
		desc string
		idx  int
	}
	opts := []opt{
		{"Resume", "Pick up where you left off.", 0},
		{"Start over", "Clear progress and re-run the wizard from the top.", 1},
	}
	var b strings.Builder
	b.WriteString(wizLine("  You exited before finishing setup. Last completed:"))
	b.WriteByte('\n')
	b.WriteString(wizLine("    " + resumeStepLabel(w.ResumeStep)))
	b.WriteByte('\n')
	b.WriteByte('\n')
	for _, o := range opts {
		sel := "  "
		nameStyle := ui.MetaStyle
		descStyle := ui.MetaStyle
		if w.ResumeIdx == o.idx {
			sel = ui.G.ThinkClosed + " "
			nameStyle = ui.AccentStyle
			descStyle = ui.AccentStyle
		}
		b.WriteString(fmt.Sprintf("  %s %s", sel, nameStyle.Render(o.name)))
		b.WriteByte('\n')
		b.WriteString(fmt.Sprintf("    %s", descStyle.Render(o.desc)))
		b.WriteByte('\n')
		b.WriteByte('\n')
	}
	return b.String()
}

// resumeStepLabel maps a WizardStep to a short human label for the
// resume screen. Kept in view.go next to the renderer for clarity.
func resumeStepLabel(s WizardStep) string {
	switch s {
	case WizWelcome:
		return "welcome"
	case WizSecurity:
		return "security disclaimer"
	case WizSetupMode:
		return "setup mode"
	case WizConfigHandling:
		return "config handling"
	case WizHardware:
		return "hardware probe"
	case WizModelChoice:
		return "runtime choice"
	case WizLocalDownload:
		return "model download"
	case WizCloudProvider:
		return "cloud provider"
	case WizCloudModel:
		return "cloud model"
	case WizCloudKeyMode:
		return "key storage"
	case WizCloudKey:
		return "API key"
	case WizConnectors:
		return "connectors"
	case WizConnectorPrompt:
		return "connector prompt"
	case WizTestIt:
		return "health check"
	case WizFinish:
		return "finish"
	default:
		return "unknown"
	}
}

// renderToolViewerOverlay draws the full-screen tool-result browser.
// Layout:
//
//	tools  · 3 calls
//	───────────────────────────────────────────────────────────
//	▸ ● read_file (project_local_models_gpu.md)  ⏱ 0.1s ✓
//	  ● scan_workspace                           ⏱ 1.2s ✓
//	  ● tool_health                              ⏱ 0.4s ✓
//	───────────────────────────────────────────────────────────
//	▸ result ────────────────────────────────────────────────
//	# project_local_models_gpu.md
//	On-disk models:
//	- bge-small-en-v1.5 (default embed)
//	...
//	───────────────────────────────────────────────────────────
//	↑↓ navigate · enter expand · esc close
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
	headerLine := fmt.Sprintf(" tools  ·  %d call%s", len(a.ToolViewer.Rows), plural(len(a.ToolViewer.Rows)))
	// P2.4: when the row count exceeds the visible cap (12), surface the
	// current 1-based position so the user can see how deep they are
	// without expanding the preview.
	if len(a.ToolViewer.Rows) > 12 {
		headerLine += fmt.Sprintf("  ·  %d/%d", a.ToolViewer.Idx+1, len(a.ToolViewer.Rows))
	}
	header := ui.ToolViewerTitle.Render(headerLine)

	if len(a.ToolViewer.Rows) == 0 {
		rows := []string{
			"",
			ui.ToolViewerMeta.Render("  no tool calls yet — type a message that triggers one"),
		}
		content := strings.Join(rows, "\n")
		box := ui.ToolViewerBox.Width(boxW).Render(content)
		box = ui.ToolViewerTitle.Render(" tools ") + "\n" + header + "\n" + box
		overlay := lipgloss.Place(a.Width, a.Height,
			lipgloss.Center, lipgloss.Center, box,
			lipgloss.WithWhitespaceChars(" "))
		return composeOverlay(under, overlay, a.Width, a.Height)
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
		line := formatToolViewerRow(row, a.Now)
		if absoluteIdx == a.ToolViewer.Idx {
			line = ui.ToolViewerSel.Render(ui.G.ThinkClosed + " " + stripAnsiLocal(line))
		} else {
			line = "  " + ui.ToolViewerRow.Render(stripAnsiLocal(line))
		}
		rowLines = append(rowLines, line)
	}

	body := strings.Join(rowLines, "\n")
	if a.ToolViewer.Expanded && a.ToolViewer.Idx < len(a.ToolViewer.Rows) {
		preview := formatToolViewerPreview(a.ToolViewer.Rows[a.ToolViewer.Idx], boxW-8, &a.ToolViewer.PreviewOffset)
		body += "\n\n" + preview
	}
	hint := ui.ToolViewerMeta.Render(fmt.Sprintf("  %s%s navigate · enter expand · esc close", ui.G.Up, ui.G.Down))
	if a.ToolViewer.Expanded {
		hint = ui.ToolViewerMeta.Render(fmt.Sprintf("  %s%s navigate · %s%s page preview · enter collapse · esc close",
			ui.G.Up, ui.G.Down, ui.G.Up, ui.G.Down))
	}
	body += "\n" + hint

	box := ui.ToolViewerBox.Width(boxW).Render(body)
	box = ui.ToolViewerTitle.Render(" tools ") + "\n" + header + "\n" + box
	overlay := lipgloss.Place(a.Width, a.Height,
		lipgloss.Center, lipgloss.Center, box,
		lipgloss.WithWhitespaceChars(" "))
	return composeOverlay(under, overlay, a.Width, a.Height)
}

// renderModelPickerOverlay draws the full-screen model picker. Layout:
//
//	models  ·  2 available
//	─────────────────────────────────────────────────────────
//	▸ cloud nvidia:stepfun-ai/step-3.7-flash   cloud · nvidia
//	  local Qwen_Qwen3-4B-Q5_K_M.gguf          local · llama.cpp
//	─────────────────────────────────────────────────────────
//	↑↓ navigate · enter switch · esc close
//
// The kind column (cloud / local) replaces an icon, the active model is
// marked with a leading "▸".
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
		overlay := lipgloss.Place(a.Width, a.Height,
			lipgloss.Center, lipgloss.Center, box,
			lipgloss.WithWhitespaceChars(" "))
		return composeOverlay(under, overlay, a.Width, a.Height)
	}

	if a.ModelPicker.LoadErr != "" && len(a.ModelPicker.Rows) == 0 {
		content := "\n" + ui.ToolViewerMeta.Render("  "+a.ModelPicker.LoadErr)
		box := ui.ToolViewerBox.Width(boxW).Render(content)
		box = ui.ToolViewerTitle.Render(" models ") + "\n" + box
		overlay := lipgloss.Place(a.Width, a.Height,
			lipgloss.Center, lipgloss.Center, box,
			lipgloss.WithWhitespaceChars(" "))
		return composeOverlay(under, overlay, a.Width, a.Height)
	}

	headerLine := fmt.Sprintf(" models  ·  %d available", len(a.ModelPicker.Rows))
	// P2.4: when more rows than fit in the visible cap, show the
	// current position so the user knows how deep they are.
	if len(a.ModelPicker.Rows) > 14 {
		headerLine += fmt.Sprintf("  ·  %d/%d", a.ModelPicker.Idx+1, len(a.ModelPicker.Rows))
	}
	header := ui.ToolViewerTitle.Render(headerLine)

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
		kind := "local"
		if row.Kind == "cloud" {
			kind = "cloud"
			if row.Provider != "" {
				kind = "cloud · " + row.Provider
			}
		}
		marker := " "
		if row.Active {
			marker = ui.G.On
		}
		line := fmt.Sprintf("%s %s   %s",
			marker, row.ID, ui.ToolViewerMeta.Render(kind))
		if absIdx == a.ModelPicker.Idx {
			line = ui.ToolViewerSel.Render(ui.G.ThinkClosed + " " + stripAnsiLocal(line))
		} else {
			line = "  " + ui.ToolViewerRow.Render(stripAnsiLocal(line))
		}
		rowLines = append(rowLines, line)
	}
	body := strings.Join(rowLines, "\n")
	hint := ui.ToolViewerMeta.Render(fmt.Sprintf("  %s%s navigate · enter switch · tab cycle · esc close", ui.G.Up, ui.G.Down))
	body += "\n" + hint

	box := ui.ToolViewerBox.Width(boxW).Render(body)
	box = ui.ToolViewerTitle.Render(" models ") + "\n" + header + "\n" + box
	overlay := lipgloss.Place(a.Width, a.Height,
		lipgloss.Center, lipgloss.Center, box,
		lipgloss.WithWhitespaceChars(" "))
	return composeOverlay(under, overlay, a.Width, a.Height)
}

// formatToolViewerRow renders one row of the tool list in the visual
// style shared with the inline pill, so the eye recognises a tool the
// user has seen on the transcript.
func formatToolViewerRow(row ToolViewerRow, now time.Time) string {
	name := ui.ToolViewerRow.Render(row.Call.Name)
	arg := ""
	if row.Call.Main != "" {
		arg = ui.ToolViewerMeta.Render(fmt.Sprintf(" (%s)", truncateRunes(row.Call.Main, 40)))
	}
	elapsed := ui.G.Running
	switch row.Call.Status {
	case ToolDone:
		elapsed = ui.ToolViewerMeta.Render(fmt.Sprintf("⏱ %s %s", formatElapsed(row.Call.EndedAt.Sub(row.Call.StartedAt)), ui.G.OK))
	case ToolError:
		elapsed = ui.ToolViewerMeta.Render(fmt.Sprintf("⏱ %s %s", formatElapsed(row.Call.EndedAt.Sub(row.Call.StartedAt)), ui.G.Err))
	default:
		// Running — show elapsed-so-far.
		elapsed = ui.ToolViewerMeta.Render(fmt.Sprintf("⏱ %s %s", formatElapsed(now.Sub(row.Call.StartedAt)), ui.G.Running))
	}
	return fmt.Sprintf("%s %s%s   %s", ui.ToolMark.Render(ui.G.ToolMark), name, arg, elapsed)
}

// formatToolViewerPreview renders the expanded preview panel for the
// highlighted row. Caps at 16 lines so the overlay stays scannable;
// `tool_call: …` results that don't fit get a "(N more chars)" hint so
// formatToolViewerPreview renders the expanded preview panel for the
// highlighted tool call. The preview is line-truncated to maxLines; if
// the result has more lines than fit, *offset is consulted (P2.4) so
// PgUp/PgDn can page through the preview window.
//
// The pointer-to-int signature lets the caller keep the offset across
// redraws (every key event rebuilds the overlay) without threading a
// new struct field through the renderer signature.
func formatToolViewerPreview(row ToolViewerRow, width int, offset *int) string {
	tc := row.Call
	if tc.Preview == "" {
		return ui.ToolViewerMeta.Render("  (no result preview available — tool is still running or didn't return data)")
	}
	preview := tc.Preview
	allLines := strings.Split(preview, "\n")
	const maxLines = 16
	total := len(allLines)

	// P2.4: clamp *offset to [0, max(0, total-maxLines)]. When the
	// preview is shorter than the cap, force offset back to 0 so a
	// stale value from a previous, taller result doesn't leave the
	// window blank.
	if total <= maxLines {
		if offset != nil {
			*offset = 0
		}
	} else {
		maxOff := total - maxLines
		if offset != nil {
			if *offset < 0 {
				*offset = 0
			}
			if *offset > maxOff {
				*offset = maxOff
			}
		}
	}

	start := 0
	if offset != nil {
		start = *offset
	}
	end := start + maxLines
	if end > total {
		end = total
	}
	lines := allLines[start:end]
	truncated := end < total

	diff := looksLikeDiff(preview)
	out := make([]string, 0, len(lines)+3)
	out = append(out, ui.ToolViewerMeta.Render(" "+ui.G.ThinkClosed+" result --"))
	if total > maxLines {
		out = append(out, ui.ToolViewerMeta.Render(fmt.Sprintf("   %s lines %d-%d of %d (%s%s page)",
			ui.G.Up, start+1, end, total, ui.G.Up, ui.G.Down)))
	}
	for _, line := range lines {
		clipped := truncateRunes(line, width)
		if diff {
			out = append(out, "   "+renderDiffLine(clipped))
			continue
		}
		out = append(out, "   "+ui.ToolViewerPreview.Render(clipped))
	}
	if truncated {
		out = append(out, ui.ToolViewerMeta.Render("   … truncated · /tools"))
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
//	▸ /help              show this overlay
//
// where `▸` marks the highlighted row and the right column shows the
// command's one-line description. The bottom strip carries a hint so the
// user knows Tab cycles and Enter accepts.
func (a *App) renderCompletions() string {
	if !a.Completion.Show || len(a.Completion.List) == 0 {
		return ""
	}
	// Cap the visible list so a tall registry + narrow terminal still
	// leaves room for the chat viewport. 8 items per spec §28.11.
	shown := a.Completion.List
	if len(shown) > 8 {
		shown = shown[:8]
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
			name = ui.CompletionSel.Render(ui.G.ThinkClosed+" "+c.Text) + "  " + ui.CompletionDesc.Render(c.Desc)
		} else {
			name = "  " + ui.CompletionItem.Render(c.Text) + "  " + ui.CompletionDesc.Render(c.Desc)
		}
		rows = append(rows, name)
	}
	hint := ui.CompletionHint.Render(fmt.Sprintf("  tab/%s%s cycle · enter accept · esc dismiss", ui.G.Up, ui.G.Down))
	rows = append(rows, hint)

	boxW := a.Width - 2
	if a.Width >= 80 {
		boxW = 60
		if boxW > a.Width-2 {
			boxW = a.Width - 2
		}
	}
	box := ui.CompletionBox.Width(boxW).Render(strings.Join(rows, "\n"))
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
	if !a.IsStreaming() && a.State != StateThinking {
		return ""
	}
	// Thinking phase (reasoning before first content token) — show latency
	// hiding line per spec §9 (100ms+, 3s+, 15s+ ladders).
	if a.State == StateThinking {
		elapsed := a.Now.Sub(a.StreamStartedAt)
		status := ui.StreamStatus.Render(fmt.Sprintf("%s thinking %s", ui.G.Stream, a.Loader.View()))
		if elapsed > 100*time.Millisecond {
			status += "  " + ui.StreamDim.Render(fmt.Sprintf("%s %s", ui.G.Timer, formatElapsed(elapsed)))
		}
		if elapsed > 15*time.Second {
			status += "  " + ui.StreamStalled.Render(fmt.Sprintf("%s still working (esc to interrupt)", ui.G.Stalled))
		}
		status += "  " + ui.StreamHint.Render("esc to interrupt")
		return status
	}

	elapsed := formatElapsed(a.Now.Sub(a.StreamStartedAt))
	tokens := a.StreamCompletionTokens
	if tokens <= 0 {
		// No `usage` event yet — show what we know (elapsed + spinner). Past
		// 8s with zero tokens the model is almost certainly still prefilling
		// the prompt (long context + CPU inference can take tens of seconds
		// before the first token), not hung — say so explicitly, otherwise a
		// bare spinner + growing timer is indistinguishable from a freeze.
		status := ui.StreamStatus.Render(fmt.Sprintf("%s streaming %s", ui.G.Stream, a.Loader.View())) +
			"  " + ui.StreamDim.Render(fmt.Sprintf("%s %s", ui.G.Timer, elapsed))
		if a.Now.Sub(a.StreamStartedAt) > 8*time.Second {
			status += "  " + ui.StreamStalled.Render(fmt.Sprintf("%s prefilling prompt — first token can take a while on CPU", ui.G.Stalled))
		}
		status += "  " + ui.StreamHint.Render("esc to cancel")
		return status
	}
	tps := 0.0
	if d := a.Now.Sub(a.StreamStartedAt).Seconds(); d > 0 {
		tps = float64(tokens) / d
	}
	status := ui.StreamStatus.Render(fmt.Sprintf("%s streaming %s", ui.G.Stream, a.Loader.View())) +
		"  " + ui.StreamNumber.Render(fmt.Sprintf("%d tok", tokens)) +
		"  " + ui.StreamDim.Render(fmt.Sprintf("%.1f t/s", tps)) +
		"  " + ui.StreamDim.Render(fmt.Sprintf("%s %s", ui.G.Timer, elapsed))

	// Stall hint — if the model hasn't emitted a token for >3s, surface it
	// in the warning color so the user knows the agent is still working
	// but the rate has dropped (e.g. tool call in flight, GPU stall).
	if !a.LastTokenAt.IsZero() && a.Now.Sub(a.LastTokenAt) > 3*time.Second {
		status += "  " + ui.StreamStalled.Render(fmt.Sprintf("%s thinking…", ui.G.Stalled))
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
func collapsedToolSummary(turn *Turn, gutter string, now time.Time) string {
	if turn.Streaming || len(turn.Tools) < collapseToolThreshold {
		return ""
	}
	var total time.Duration
	for _, tc := range turn.Tools {
		if tc.Status != ToolDone {
			return ""
		}
		total += tc.endedOrNow(now)
	}
	line := fmt.Sprintf("%s %s  %s",
		ui.ToolDone.Render(ui.ToolMark.Render(ui.G.ToolMark)),
		fmt.Sprintf("ran %d tool calls", len(turn.Tools)),
		ui.MetaStyle.Render(fmt.Sprintf("⏱ %s total · /tools for details", formatElapsed(total))))
	return gutter + line
}

// renderToolPill renders one tool call as flat lines:
//
//	⏺ tool_name(main arg)  ⏱ 0.4s ✓
//	  ⎿ result preview / note / error
//	  ⎿ … (+N more chars · /tools)
//
// No emoji, no bullet card — the leading ⏺ is colored by status
// (accent = running, meta = done, fail = error) so the eye reads state
// from color before reading the name, same idea Claude Code uses.
//
// Budget: 1 call line + at most 3 ⎿ lines (§8 result budget). If the
// result would exceed 3 lines, the last ⎿ becomes an overflow hint.
const toolResultBudget = 3

// renderToolPill renders one tool call. When `compactTail` is true (narrow
// terminal, 60–79 cols), the ⏱ elapsed + status glyph moves to the last
// ⎿ line instead of sharing the call line (spec §17).
func (a *App) renderToolPill(t ToolCall, gutter string, width int) string {
	return a.renderToolPillCompact(t, gutter, width, a.narrowToolLayout())
}

func (a *App) renderToolPillCompact(t ToolCall, gutter string, width int, compactTail bool) string {
	// Declined tools render a single line.
	if t.Status == ToolDeclined {
		mark := ui.MetaStyle.Render(ui.G.ToolMark)
		name := ui.ToolName.Render(t.Name)
		arg := ""
		if t.Main != "" {
			arg = ui.ToolArg.Render(fmt.Sprintf("(%s)", t.Main))
		}
		first := fmt.Sprintf("%s %s%s", mark, name, arg)
		second := "  " + ui.ToolResult.Render(ui.G.Result) + " " + ui.MetaStyle.Render("declined")
		return strings.Join([]string{first, second}, "\n"+gutter)
	}

	name := ui.ToolName.Render(t.Name)
	arg := ""
	if t.Main != "" {
		arg = ui.ToolArg.Render(fmt.Sprintf("(%s)", t.Main))
	} else {
		arg = ui.ToolArg.Render("()")
	}
	elapsed := formatElapsed(t.endedOrNow(a.Now))
	statusGlyph, statusStyle := t.statusGlyph()
	mark := statusStyle.Render(ui.ToolMark.Render(ui.G.ToolMark))
	tail := statusStyle.Render(fmt.Sprintf("⏱ %s %s", elapsed, statusGlyph))

	var out []string
	if compactTail {
		// Narrow layout: tail moves to the first ⎿ line (§17).
		out = []string{fmt.Sprintf("%s %s%s", mark, name, arg)}
	} else {
		out = []string{fmt.Sprintf("%s %s%s  %s", mark, name, arg, tail)}
	}

	// Collect result lines — enforce the 3 ⎿ line budget (§8).
	resultLines := make([]string, 0, toolResultBudget)
	if t.Note != "" {
		line := "  " + ui.ToolResult.Render(ui.G.Result) + " " + ui.ToolNote.Render(t.Note)
		if compactTail && len(resultLines) == 0 {
			line += "  " + tail
		}
		resultLines = append(resultLines, line)
	}
	if t.Status == ToolError && t.ErrMsg != "" {
		line := "  " + ui.ToolResult.Render(ui.G.Result) + " " + ui.ToolError.Render(t.ErrMsg)
		if compactTail && len(resultLines) == 0 {
			line += "  " + tail
		}
		resultLines = append(resultLines, line)
	}
	if t.Preview != "" {
		// Count lines already allocated.
		allocated := 0
		for _, rl := range resultLines {
			allocated += 1 + strings.Count(rl, "\n")
		}
		remaining := toolResultBudget - allocated
		if remaining <= 0 {
			// No budget left — show overflow on the last line.
			overflow := fmt.Sprintf("%s %s (+%d more · /tools)", ui.G.Result, ui.G.Ellipsis, len(t.Preview))
			if compactTail {
				overflow += "  " + tail
			}
			resultLines[len(resultLines)-1] = "  " + ui.ToolResult.Render(overflow)
		} else {
			// Preview width: vp.Width - ResultIndent - 2 (⎿ glyph + space) per §30.4
			preview := truncate(t.Preview, width-TagIndent-2)
			if preview != "" {
				renderLines := strings.Split(preview, "\n")
				if len(renderLines) > remaining {
					// Cap at remaining lines, last one is overflow.
					renderLines = renderLines[:remaining]
					renderLines[remaining-1] = fmt.Sprintf("%s (+%d more · /tools)", ui.G.Ellipsis, len(t.Preview))
				}
				for i, pl := range renderLines {
					line := "  " + ui.ToolResult.Render(ui.G.Result) + " " + ui.MetaStyle.Render(pl)
					if compactTail && i == 0 && len(resultLines) == 0 {
						line += "  " + tail
					}
					resultLines = append(resultLines, line)
				}
			}
		}
	}

	// If compact tail never got attached (no result lines at all), append
	// the tail on a standalone ⎿ line so it's not lost.
	if compactTail && len(resultLines) == 0 {
		resultLines = append(resultLines, "  "+ui.ToolResult.Render(ui.G.Result)+" "+ui.MetaStyle.Render(tail))
	}

	out = append(out, resultLines...)
	return strings.Join(out, "\n"+gutter)
}

// TagIndent is the 2-space content indent for all transcript lines (§5).
const TagIndent = ui.ContentIndent

// endedOrNow returns EndedAt for completed tools, `now` for running ones —
// so the elapsed counter animates without the caller having to pre-rewind.
// `now` is injected by the caller (spec §34.4: View never calls time.Now).
func (t ToolCall) endedOrNow(now time.Time) time.Duration {
	end := t.EndedAt
	if end.IsZero() {
		end = now
	}
	return end.Sub(t.StartedAt)
}

// statusGlyph returns the right tail-glyph + colour for a tool call's
// status. The glyph comes from the spec's glyph table (§25.3) so ASCII
// mode substitutes it correctly; the colour carries the same state
// redundantly (spec §18's NO_COLOR rule: state must survive colour-off).
func (t ToolCall) statusGlyph() (string, lipgloss.Style) {
	switch t.Status {
	case ToolRunning:
		return ui.G.Running, ui.ToolRunning
	case ToolError:
		return ui.G.Err, ui.ToolError
	case ToolDeclined:
		return ui.G.Off, ui.MetaStyle
	default:
		return ui.G.OK, ui.ToolDone
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

// ── Wizard renderers (§13) ─────────────────────────────────────────

// renderWizard renders the current Setup Wizard step in the transcript zone.
// Every step routes through ui.RenderWizardFrame so the chrome — header
// strip (product mark + step indicator), rounded border, footer — stays
// consistent across the wizard. Per-step renderers only return the body
// content; the frame owns the title and the surrounding whitespace.
func (a *App) renderWizard() string {
	w := &a.Wizard
	width := a.ChatVP.Width
	if width < 40 {
		width = 40
	}

	body, fullFrame := wizardStepBody(w, width)
	if body == "" && !fullFrame {
		return ""
	}

	// P0.1 / P1: the counter shows the user-visible screen number (1..4),
	// not the enum index. Conditional steps (Resume) map to 0 → the frame
	// drops the counter and shows a static title.
	idx := visibleScreen(w.Step)
	total := visibleScreenTotal
	if idx == 0 {
		total = 0
	}
	return ui.RenderWizardFrame(width, ui.WizardFrame{
		Title:     wizardStepLabel(w.Step),
		StepIdx:   idx,
		StepTotal: total,
		Body:      body,
	})
}

// wizardStepBody dispatches to the per-step renderer. The boolean
// return tells the caller whether the step is "full-frame" (it owns
// its own header/footer — currently just WizFinish) or "framed"
// (everything else, which the wizard frame wraps). Per-step renderers
// no longer prepend their own `wizTitle()` since the frame supplies
// the title in the header strip.
func wizardStepBody(w *WizardState, width int) (body string, fullFrame bool) {
	switch w.Step {
	case WizWelcome:
		return renderWizWelcome(w, width), false
	case WizResume:
		return renderWizResume(w, width), false
	case WizHardware:
		return renderWizEngine(w, width), false
	case WizLocalDownload:
		return renderWizDownload(w, width), false
	case WizCloudProvider:
		return renderWizCloudProvider(w, width), false
	case WizCloudKey:
		return renderWizCloudKey(w, width), false
	case WizTestIt:
		return renderWizTestIt(w, width), false
	case WizFinish:
		return renderWizFinish(w, width), true
	default:
		return "", false
	}
}

// wizTitle was the per-step title rendered above each body. Now that
// ui.RenderWizardFrame owns the title, the per-step renderers drop
// their wizTitle call. Kept here as a thin alias so any leftover call
// site compiles and behaves the same — once the per-step renderers
// finish their migration, this is removable.
func wizTitle(s string) string {
	return ui.WizardTitle.Render(s)
}

func wizLine(s string) string {
	return ui.MetaStyle.Render(s)
}

func wizSep(int) string { return "" }

// renderWizWelcome renders the F1 welcome screen: bear logo + version +
// random tagline + Enter-to-continue prompt. The bear mascot is the only
// place in the TUI where the bear appears (per the OpenClaw-style UI rule
// "only use the bear in branding").
func renderWizWelcome(w *WizardState, width int) string {
	var b strings.Builder
	b.WriteString(ui.AccentStyle.Render(ui.CinderpawLogo))
	b.WriteByte('\n')
	b.WriteString(ui.WarnStyle.Render(ui.BearLogo))
	b.WriteByte('\n')
	if w.Tagline == "" {
		w.Tagline = ui.RandomTagline()
	}
	b.WriteString(wizLine("  " + w.Tagline))
	b.WriteByte('\n')
	if pre := renderPreflightNotes(w.PreflightNotes); pre != "" {
		b.WriteByte('\n')
		b.WriteString(ui.AccentStyle.Render("  " + ui.G.Spark + " " + pre))
		b.WriteByte('\n')
	}
	b.WriteByte('\n')

	// P1: mode-select list.
	type welcomeOpt struct{ name, desc string }
	opts := []welcomeOpt{
		{"Quick start", "recommended - ~2 min"},
		{"Custom setup", "pick provider, model, storage"},
	}
	if w.HasExistingConfig {
		opts = append(opts, welcomeOpt{"Use existing config", existingConfigSummary()})
	}
	for i, o := range opts {
		sel := "  "
		nameStyle := ui.MetaStyle
		if w.SetupModeIdx == i {
			sel = ui.G.ThinkClosed + " "
			nameStyle = ui.AccentStyle
		}
		b.WriteString(fmt.Sprintf("  %s %s", sel, nameStyle.Render(o.name)))
		b.WriteByte('\n')
		b.WriteString("     " + ui.MetaStyle.Render(o.desc))
		b.WriteByte('\n')
	}
	if w.HasExistingConfig {
		b.WriteByte('\n')
		if w.ResetPending {
			b.WriteString(ui.WarnStyle.Render("  reset ~/.feral and start fresh?  y/N"))
		} else {
			b.WriteString(wizLine("  " + ui.AccentStyle.Render("r") + " reset - wipe ~/.feral and start fresh"))
		}
		b.WriteByte('\n')
	}
	b.WriteByte('\n')
	// Security note as body copy (not a step).
	b.WriteString(wizLine("  Cinderpaw can run tools and connect to services you enable. You approve"))
	b.WriteByte('\n')
	b.WriteString(wizLine("  each connector. Nothing leaves this machine unless you add a cloud key."))
	b.WriteByte('\n')
	return b.String()
}

// modelDisplayName turns a model repo id into a short, human label for the
// Engine/download rows (e.g. "bartowski/Qwen_Qwen3.5-9B-GGUF" → "Qwen3.5 9B").
func modelDisplayName(id string) string {
	if id == "" {
		return "local model"
	}
	name := id
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.TrimSuffix(name, "-GGUF")
	name = strings.TrimSuffix(name, ".gguf")
	name = strings.ReplaceAll(name, "_", " ")
	name = strings.ReplaceAll(name, "-", " ")
	if i := strings.Index(name, "Qwen "); i >= 0 {
		name = name[i:] // drop a duplicated vendor prefix like "Qwen Qwen3.5"
	}
	return strings.TrimSpace(name)
}

// renderWizEngine renders P1 screen 2: the hardware probe result as one
// line, then a Local/Cloud select list pre-highlighted from the probe. The
// model name + size on the Local row ARE the download consent (fixes C4).
func renderWizEngine(w *WizardState, width int) string {
	var b strings.Builder
	if w.HardwareProbeErr != nil {
		b.WriteString(ui.WarnStyle.Render("  " + ui.G.Err + " " + w.HardwareProbeErr.Error()))
		b.WriteByte('\n')
		b.WriteByte('\n')
		b.WriteString(ui.AccentStyle.Render("  press Enter or r to retry"))
		b.WriteByte('\n')
		return b.String()
	}
	probing := w.Hardware.RamGB == 0 && !w.Hardware.GpuOK
	if probing {
		b.WriteString(wizLine("  " + w.SpinnerView + " detecting hardware" + ui.G.Ellipsis))
		b.WriteByte('\n')
		return b.String()
	}
	if w.Hardware.GpuOK {
		line := fmt.Sprintf("  %s %s · %d GB vram · %d GB ram", ui.G.OK, w.Hardware.GpuName, w.Hardware.GpuVram, w.Hardware.RamGB)
		b.WriteString(ui.OkStyle.Render(line))
	} else {
		b.WriteString(wizLine("  " + ui.G.Off + " no GPU detected — using CPU (slower, still private)"))
	}
	b.WriteByte('\n')
	b.WriteByte('\n')

	type rt struct {
		name, desc string
		opt        WizardChoice
	}
	localDesc := fmt.Sprintf("%s · %s · private, runs on your GPU", modelDisplayName(w.ModelID), w.ModelSize)
	rows := []rt{
		{"Local", localDesc, WizChoiceLocal},
		{"Cloud", "bring your API key · faster, prompts leave this machine", WizChoiceCloud},
	}
	keys := []string{"1", "2"}
	for i, r := range rows {
		sel := "  "
		nameStyle := ui.MetaStyle
		if w.Choice == r.opt {
			sel = ui.G.ThinkClosed + " "
			nameStyle = ui.AccentStyle
		}
		b.WriteString(fmt.Sprintf("  %s %s%s", ui.WizardKey.Render(keys[i]+"."), sel, nameStyle.Render(r.name)))
		b.WriteByte('\n')
		b.WriteString("     " + ui.MetaStyle.Render(r.desc))
		b.WriteByte('\n')
		b.WriteByte('\n')
	}
	b.WriteString(wizLine("1 2  choose    " + ui.AccentStyle.Render("Enter") + "  confirm"))
	b.WriteByte('\n')
	return b.String()
}

// renderWizDownload renders P1 screen 3a: the model download progress. The
// health checks that auto-run on completion render on WizTestIt (same
// visible screen 3). On failure, retry (r) / continue anyway (s) hints show.
func renderWizDownload(w *WizardState, width int) string {
	var b strings.Builder
	b.WriteString("  " + ui.AccentStyle.Render(ui.G.Cursor) + " " +
		ui.WizardBody.Render(modelDisplayName(w.ModelID)) + ui.MetaStyle.Render(" · "+w.ModelSize))
	b.WriteByte('\n')
	b.WriteByte('\n')

	if w.DownloadErr != nil {
		b.WriteString(ui.WarnStyle.Render("  " + ui.G.Err + " " + w.DownloadErr.Error()))
		b.WriteByte('\n')
		b.WriteByte('\n')
		hint := "  r retry"
		if w.custom() {
			hint += " · m change model"
		}
		hint += " · s continue anyway"
		b.WriteString(wizLine(hint))
		b.WriteByte('\n')
		return b.String()
	}

	if w.Progress > 0 {
		pct := int(w.Progress * 100)
		barWidth := width - 10
		if barWidth < 10 {
			barWidth = 30
		}
		filled := int(float64(barWidth) * w.Progress)
		if filled > barWidth {
			filled = barWidth
		}
		bar := strings.Repeat("█", filled) + strings.Repeat("░", barWidth-filled)
		b.WriteString(ui.AccentStyle.Render(fmt.Sprintf("  %s  %d%%", bar, pct)))
		b.WriteByte('\n')
		b.WriteByte('\n')
		if !w.DownloadStartedAt.IsZero() {
			elapsed := time.Since(w.DownloadStartedAt)
			b.WriteString(wizLine(fmt.Sprintf("  elapsed: %s", elapsed.Round(time.Second))))
			b.WriteByte('\n')
		}
	} else if w.ProgressMsg != "" {
		b.WriteString(wizLine("  " + w.ProgressMsg))
		b.WriteByte('\n')
	} else {
		b.WriteString(wizLine("  preparing download" + ui.G.Ellipsis))
		b.WriteByte('\n')
	}
	return b.String()
}

func renderWizCloudProvider(w *WizardState, width int) string {
	var b strings.Builder
	b.WriteString(wizSep(width))
	b.WriteByte('\n')
	b.WriteByte('\n')
	// F2 / spec §SEARCHABLE LISTS: search input + filtered list.
	// The cursor (`_`) marks the end of the query.
	cursor := ui.G.Cursor
	if w.SearchQuery == "" {
		b.WriteString(wizLine("  search: " + ui.AccentStyle.Render(cursor)))
	} else {
		b.WriteString(wizLine("  search: " + ui.AccentStyle.Render(w.SearchQuery+cursor)))
	}
	b.WriteByte('\n')
	b.WriteByte('\n')
	filtered := FilteredProviders(w.SearchQuery)
	if len(filtered) == 0 {
		b.WriteString(wizLine("  no providers match"))
		b.WriteByte('\n')
	} else {
		for i, p := range filtered {
			sel := "  "
			nameStyle := ui.MetaStyle
			if w.ProviderIdx == i {
				sel = ui.G.ThinkClosed + " "
				nameStyle = ui.AccentStyle
			}
			b.WriteString(fmt.Sprintf("  %s %s", sel, nameStyle.Render(p.Name)))
			b.WriteByte('\n')
		}
	}
	b.WriteByte('\n')
	if w.SearchQuery != "" {
		b.WriteString(wizLine("  type to filter  ·  " + ui.AccentStyle.Render("Enter") + "  select  ·  esc clear"))
	} else {
		b.WriteString(wizLine("  type to filter  ·  " + ui.AccentStyle.Render("Enter") + "  select  ·  esc back"))
	}
	return b.String()
}

// renderWizCloudKey renders P1 screen 3b (the cloud form): the chosen
// provider collapsed to one line, a masked key field, the model line
// (editable in Custom mode), a validation status line, and the env-var tip.
func renderWizCloudKey(w *WizardState, width int) string {
	var b strings.Builder
	providerName := w.Provider
	for _, p := range CloudProviders {
		if p.ID == w.Provider {
			providerName = p.Name
			break
		}
	}
	// Provider collapsed to a line (press p to change while the field is empty).
	b.WriteString(wizLine("  provider: ") + ui.WizardBody.Render(providerName) + wizLine("  \u00b7  press p to change"))
	b.WriteByte('\n')
	b.WriteByte('\n')

	// Masked key field. EchoPassword-style: last-4 shown after validation.
	masked := strings.Repeat("\u2022", 16)
	if w.APIKey != "" {
		masked = strings.Repeat("\u2022", len(w.APIKey))
		if w.KeyValid && len(w.APIKey) > 4 {
			masked = strings.Repeat("\u2022", len(w.APIKey)-4) + w.APIKey[len(w.APIKey)-4:]
		}
	}
	keyLabel := "  key: "
	b.WriteString(wizLine(keyLabel) + ui.AccentStyle.Render(masked))
	if !w.ModelEditing {
		b.WriteString(ui.AccentStyle.Render(ui.G.Cursor))
	}
	b.WriteByte('\n')

	// Model line (editable inline in Custom mode).
	if w.ModelEditing {
		b.WriteString(wizLine("  model: ") + ui.AccentStyle.Render(w.ModelID+ui.G.Cursor))
	} else if w.custom() {
		b.WriteString(wizLine("  model: ") + ui.WizardBody.Render(w.ModelID) + wizLine("  \u00b7  press m to edit"))
	} else {
		b.WriteString(wizLine("  model: " + w.ModelID))
	}
	b.WriteByte('\n')
	b.WriteByte('\n')

	if w.KeyValid {
		b.WriteString(ui.OkStyle.Render("  " + ui.G.OK + " connected"))
	} else if a := w.KeyValidMsg; a != "" && w.APIKey != "" {
		b.WriteString(ui.WarnStyle.Render("  " + ui.G.Err + " " + a))
	} else if w.APIKey != "" {
		b.WriteString(wizLine("  validating" + ui.G.Ellipsis))
	} else {
		b.WriteString(wizLine("  " + ui.AccentStyle.Render("Enter") + "  validate"))
	}
	b.WriteByte('\n')
	b.WriteByte('\n')
	b.WriteString(wizLine("  tip: or set FERAL_BYOK_KEY in your environment"))
	b.WriteByte('\n')
	return b.String()
}

func renderWizTestIt(w *WizardState, width int) string {
	var b strings.Builder
	running := w.TestItRunning || anyCheckRunning(w.HealthChecks)
	if running {
		// Show all four granular checks with live status.
		for i := 0; i < 4; i++ {
			hc := w.HealthChecks[i]
			name := hc.Kind.String()
			switch hc.Status {
			case CheckPending:
				b.WriteString(wizLine(fmt.Sprintf("  %s %s", ui.G.Off, name)))
			case CheckRunning:
				spinner := w.SpinnerView
				if spinner == "" {
					spinner = string(ui.G.Stream)
				}
				b.WriteString(wizLine(fmt.Sprintf("  %s %s", spinner, name)))
			case CheckPassed:
				b.WriteString(ui.OkStyle.Render(fmt.Sprintf("  %s %s", ui.G.OK, name)))
			case CheckFailed:
				b.WriteString(ui.ErrorTitle.Render(fmt.Sprintf("  %s %s", ui.G.Err, name)))
			}
			b.WriteByte('\n')
			if hc.Message != "" && hc.Status != CheckPending {
				b.WriteString(wizLine("    " + hc.Message))
				b.WriteByte('\n')
			}
		}
		b.WriteByte('\n')
		if w.TestItRunning {
			spinner := w.SpinnerView
			if spinner == "" {
				spinner = string(ui.G.Stream)
			}
			b.WriteString(wizLine(fmt.Sprintf("  %s running health checks%s", spinner, ui.G.Ellipsis)))
		}
	} else if w.TestItSucceeded {
		b.WriteString(ui.OkStyle.Render("  " + ui.G.OK + " all checks passed"))
		b.WriteByte('\n')
		b.WriteByte('\n')
		// Show timing metrics as a compact benchmark block.
		if w.HealthCheckLatency > 0 || w.StreamLatency > 0 {
			b.WriteString(wizLine("  Connection"))
			b.WriteByte('\n')
			if w.HealthCheckLatency > 0 {
				b.WriteString(wizLine(fmt.Sprintf("    Latency:   %s", formatElapsed(w.HealthCheckLatency))))
				b.WriteByte('\n')
			}
			if w.StreamLatency > 0 {
				b.WriteString(wizLine(fmt.Sprintf("    Streaming: %s", formatElapsed(w.StreamLatency))))
				b.WriteByte('\n')
			}
			if w.Provider != "" {
				providerName := w.Provider
				for _, p := range CloudProviders {
					if p.ID == w.Provider {
						providerName = p.Name
						break
					}
				}
				b.WriteString(wizLine(fmt.Sprintf("    Provider:  %s", providerName)))
				b.WriteByte('\n')
			}
			status := ui.OkStyle.Render(ui.G.OK + " Healthy")
			b.WriteString(wizLine(fmt.Sprintf("    Status:    %s", stripAnsiLocal(status))))
			b.WriteByte('\n')
			b.WriteByte('\n')
		}
		if w.TestItResponse != "" {
			b.WriteString(ui.WizardBody.Render(w.TestItResponse))
			b.WriteByte('\n')
			b.WriteByte('\n')
		}
		b.WriteString(ui.AccentStyle.Render("  press Enter to continue"))
	} else {
		// F2 / spec §HEALTH CHECK FAILURE HANDLING: show which check
		// failed + the raw error, then offer explicit Retry / Change
		// / Skip. Never leave the user stuck on a spinner.
		// F3: show the per-check status instead of a single failure line.
		b.WriteString(ui.ErrorTitle.Render(ui.G.Err + " health check failed"))
		b.WriteByte('\n')
		b.WriteByte('\n')
		for i := 0; i < 4; i++ {
			hc := w.HealthChecks[i]
			name := hc.Kind.String()
			switch hc.Status {
			case CheckPassed:
				b.WriteString(ui.OkStyle.Render(fmt.Sprintf("  %s %s", ui.G.OK, name)))
			case CheckFailed:
				b.WriteString(ui.ErrorTitle.Render(fmt.Sprintf("  %s %s", ui.G.Err, name)))
				if hc.Message != "" {
					b.WriteString(wizLine("    " + hc.Message))
				}
			default:
				b.WriteString(wizLine(fmt.Sprintf("  %s %s — skipped", ui.G.Off, name)))
			}
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
		if w.TestItError != "" && !strings.Contains(w.TestItError, "gateway unreachable") {
			b.WriteString(wizLine("  error:"))
			b.WriteByte('\n')
			b.WriteString(ui.MetaStyle.Render("    " + w.TestItError))
			b.WriteByte('\n')
			b.WriteByte('\n')
		}
		if w.TestItAttempts > 1 {
			b.WriteString(wizLine("  retried " + strconv.Itoa(w.TestItAttempts-1) + " time(s) automatically"))
			b.WriteByte('\n')
			b.WriteByte('\n')
		}
		b.WriteString(wizLine("  next:"))
		b.WriteByte('\n')
		b.WriteString(wizLine("    " + ui.AccentStyle.Render("r") + "  retry"))
		b.WriteByte('\n')
		// P0.10: only offer "change provider" on the cloud path, and "change
		// model" only when the cloud key screen is in the path AND we're in
		// Custom mode (inline model edit). The local path offers neither.
		if pathHasStep(w, WizCloudProvider) {
			b.WriteString(wizLine("    " + ui.AccentStyle.Render("p") + "  change provider"))
			b.WriteByte('\n')
		}
		if pathHasStep(w, WizCloudKey) && w.custom() {
			b.WriteString(wizLine("    " + ui.AccentStyle.Render("m") + "  change model"))
			b.WriteByte('\n')
		}
		b.WriteString(wizLine("    " + ui.AccentStyle.Render("s") + "  continue anyway"))
		b.WriteByte('\n')
	}
	return b.String()
}

// renderWizFinish renders P1 screen 4: Ready. One consolidated receipt
// (provider/model + benchmark, rendered once), a ⚠ warning when the health
// check was skipped, a try-this suggestion (pre-filled on Enter), and the
// two slash-command pointers. No `feral chat/doctor/desktop` list — the
// user is already inside the TUI.
func renderWizFinish(w *WizardState, width int) string {
	var b strings.Builder
	b.WriteString(ui.AccentStyle.Render("  " + ui.BearCompact))
	b.WriteByte('\n')
	b.WriteByte('\n')

	// Receipt: provider/model line.
	if w.Choice == WizChoiceCloud && w.Provider != "" {
		providerName := w.Provider
		for _, p := range CloudProviders {
			if p.ID == w.Provider {
				providerName = p.Name
				break
			}
		}
		b.WriteString(ui.OkStyle.Render(fmt.Sprintf("  %s %s · %s", ui.G.OK, providerName, w.ModelID)))
	} else if w.Choice == WizChoiceLocal {
		b.WriteString(ui.OkStyle.Render(fmt.Sprintf("  %s local · %s", ui.G.OK, modelDisplayName(w.ModelID))))
	} else {
		b.WriteString(wizLine(fmt.Sprintf("  %s no provider configured", ui.G.Off)))
	}
	b.WriteByte('\n')

	if w.TestItSkipped {
		b.WriteString(ui.WarnStyle.Render("  " + ui.G.Err + " health check skipped — run /doctor after setup"))
		b.WriteByte('\n')
	} else if w.HealthCheckLatency > 0 || w.StreamLatency > 0 {
		// Benchmark block — rendered ONCE, here.
		b.WriteString(ui.MetaStyle.Render(fmt.Sprintf("  latency %s · streaming %s · healthy",
			formatElapsed(w.HealthCheckLatency), formatElapsed(w.StreamLatency))))
		b.WriteByte('\n')
	}
	b.WriteByte('\n')

	// Try-this suggestion (pre-filled into the input on Enter — see finishWizard).
	b.WriteString(wizLine("  try: ") + ui.WizardBody.Render("\"summarize the files in this folder\""))
	b.WriteByte('\n')
	b.WriteByte('\n')
	b.WriteString(wizLine("  " + ui.AccentStyle.Render("/help") + " commands  ·  " + ui.AccentStyle.Render("/setup") + " re-run setup"))
	b.WriteByte('\n')
	b.WriteByte('\n')
	b.WriteString(ui.AccentStyle.Render("  Have fun. Press Enter to begin."))
	b.WriteByte('\n')
	return b.String()
}

// renderWizardFooter renders the footer hint for the current wizard step.
func renderWizardFooter(w *WizardState) string {
	hint := w.footerHint()
	if hint == "" {
		return ""
	}
	return ui.FooterStyle.Render(hint)
}
