package app

// The GUIDED first-run flow (OpenClaw parity, 2026-07-10 spec Part 5) —
// the TUI face of the same server-side ladder `cinderpaw setup` and the desktop
// "Found on your machine" section consume (/runtime/setup/detect|verify|ack).
// Shape: security ack (one-time) → detect → auto-test the ladder with a
// REAL completion → manual stage on failure → summary → chat. The classic
// step-by-step wizard stays reachable (`/setup classic`, `--wizard`, or the
// manual-stage option) and is untouched.

import (
	"fmt"
	"os"
	"strings"
	"time"

	"cinderpaw-tui/api"
	"cinderpaw-tui/ui"

	tea "github.com/charmbracelet/bubbletea"
)

// GuidedStep identifies which guided screen is active.
type GuidedStep int

const (
	GuidedDetect      GuidedStep = iota // spinner while /runtime/setup/detect runs
	GuidedSecurity                      // one-time ack (y/n; n exits)
	GuidedTesting                       // auto-test ladder in flight
	GuidedManual                        // failure → choice menu (never a dead end)
	GuidedKeyProvider                   // manual key: pick a provider
	GuidedKeyInput                      // manual key: paste it
	GuidedDownloading                   // hardware-tier one-click download
	GuidedDone                          // summary + next steps → chat
)

// GuidedState is all mutable state for the guided flow.
type GuidedState struct {
	Show bool
	Step GuidedStep

	NeedsAck   bool
	Candidates []api.SetupCandidate
	DetectErr  string

	// TestIdx walks Candidates during the auto-test phase. TestLog is the
	// running commentary ("Testing X — real completion, not a ping…", ✓/✗
	// lines) rendered on the testing/manual/done screens.
	TestIdx int
	TestLog []string

	MenuIdx     int
	ProviderIdx int
	KeyBuf      string
	KeyProvider CloudProvider

	DownloadID       string
	DownloadProgress float64
	DownloadErr      string
	// pendingVerify holds the candidate a download will verify on completion.
	pendingDownload *api.SetupCandidate

	VerifiedLabel string
	VerifiedMsg   string
	Skipped       bool
}

// Messages ------------------------------------------------------------------

// GuidedDetectMsg is the /runtime/setup/detect response.
type GuidedDetectMsg struct {
	Res *api.SetupDetectResult
	Err error
}

// GuidedVerifyMsg is one candidate's real-completion outcome. Idx is the
// ladder position (-1 for manual retries / pasted keys / downloads).
type GuidedVerifyMsg struct {
	Idx       int
	Candidate api.SetupCandidate
	OK        bool
	Msg       string
	Err       error
}

// GuidedDownloadMsg is one 500ms poll of the model download.
type GuidedDownloadMsg struct {
	Download *api.ModelDownload
	Err      error
}

// Flow ----------------------------------------------------------------------

// startGuided opens the guided flow and kicks the detect fetch.
func (a *App) startGuided() tea.Cmd {
	a.Guided = GuidedState{Show: true, Step: GuidedDetect}
	base, token := a.BaseURL, a.Token
	return func() tea.Msg {
		res, err := api.SetupDetect(base, token)
		return GuidedDetectMsg{Res: res, Err: err}
	}
}

// guidedVerifyCmd tests one candidate (and persists it server-side on
// success). Cloud routes are additionally activated on the live sidecar —
// best-effort, mirroring `cinderpaw setup` (a cold sidecar picks the persisted
// route up on next start).
func (a *App) guidedVerifyCmd(idx int, c api.SetupCandidate, apiKey string) tea.Cmd {
	base, token := a.BaseURL, a.Token
	return func() tea.Msg {
		ok, msg, err := api.SetupVerify(base, token, c.Raw, apiKey)
		if ok && c.Kind != "local_gguf" && c.ProviderID != "" && c.Model != "" {
			_, _ = api.SetModel(base, token, c.ProviderID+":"+c.Model)
		}
		return GuidedVerifyMsg{Idx: idx, Candidate: c, OK: ok, Msg: msg, Err: err}
	}
}

// guidedAutoTest advances the ladder: tests the next auto-testable candidate
// (hardware downloads need explicit consent, so they are offered in the
// manual stage instead), or drops to the manual stage when the ladder is
// exhausted.
func (a *App) guidedAutoTest() tea.Cmd {
	g := &a.Guided
	for g.TestIdx < len(g.Candidates) {
		c := g.Candidates[g.TestIdx]
		if c.Kind == "hardware_download" {
			g.TestIdx++
			continue
		}
		g.Step = GuidedTesting
		g.TestLog = append(g.TestLog, fmt.Sprintf("Testing %s — real completion, not a ping…", c.Label))
		return a.guidedVerifyCmd(g.TestIdx, c, "")
	}
	g.Step = GuidedManual
	g.MenuIdx = 0
	return nil
}

// guidedDownloadCmd kicks the one-click model download for a
// hardware_download candidate.
func (a *App) guidedDownloadCmd(c api.SetupCandidate) tea.Cmd {
	g := &a.Guided
	g.Step = GuidedDownloading
	g.DownloadProgress = 0
	g.DownloadErr = ""
	g.pendingDownload = &c
	base, token := a.BaseURL, a.Token
	return func() tea.Msg {
		id, err := api.InstallModel(base, token, c.DownloadRepo, c.DownloadFile)
		if err != nil {
			return GuidedDownloadMsg{Err: err}
		}
		d, err := api.DownloadModel(base, token, id)
		return GuidedDownloadMsg{Download: d, Err: err}
	}
}

// guidedDownloadPoll returns the next 500ms poll cmd for an in-flight download.
func (a *App) guidedDownloadPoll(id string) tea.Cmd {
	base, token := a.BaseURL, a.Token
	return func() tea.Msg {
		time.Sleep(500 * time.Millisecond)
		d, err := api.DownloadModel(base, token, id)
		return GuidedDownloadMsg{Download: d, Err: err}
	}
}

// handleGuidedMsg processes guided-flow messages. Returns (handled, cmd).
func (a *App) handleGuidedMsg(msg tea.Msg) (bool, tea.Cmd) {
	if !a.Guided.Show {
		return false, nil
	}
	g := &a.Guided
	switch m := msg.(type) {
	case GuidedDetectMsg:
		if m.Err != nil {
			g.DetectErr = m.Err.Error()
			g.Step = GuidedManual
			a.needsRebuild = true
			return true, nil
		}
		g.Candidates = m.Res.Candidates
		g.NeedsAck = !m.Res.Acked
		if g.NeedsAck {
			g.Step = GuidedSecurity
			a.needsRebuild = true
			return true, nil
		}
		a.needsRebuild = true
		return true, a.guidedAutoTest()

	case GuidedVerifyMsg:
		a.needsRebuild = true
		if m.OK {
			g.TestLog = append(g.TestLog, fmt.Sprintf(ui.G.OK+" %s", m.Msg))
			g.VerifiedLabel = m.Candidate.Label
			g.VerifiedMsg = m.Msg
			g.Step = GuidedDone
			return true, nil
		}
		reason := m.Msg
		if m.Err != nil {
			reason = m.Err.Error()
		}
		g.TestLog = append(g.TestLog, fmt.Sprintf(ui.G.Err+" %s", reason))
		if m.Idx >= 0 && m.Candidate.Kind == "existing_config" {
			// OpenClaw invariant: never silently replace a configured model
			// that fails the probe — stop the ladder, let the user decide.
			g.TestLog = append(g.TestLog,
				"Your already-configured model failed the test. Cinderpaw will not replace it automatically.")
			g.Step = GuidedManual
			g.MenuIdx = 0
			return true, nil
		}
		if m.Idx >= 0 {
			g.TestIdx = m.Idx + 1
			return true, a.guidedAutoTest()
		}
		// Manual retry / key / download failure → back to the menu.
		g.Step = GuidedManual
		return true, nil

	case GuidedDownloadMsg:
		a.needsRebuild = true
		if m.Err != nil {
			g.DownloadErr = m.Err.Error()
			g.TestLog = append(g.TestLog, fmt.Sprintf(ui.G.Err+" download failed: %s", g.DownloadErr))
			g.Step = GuidedManual
			return true, nil
		}
		d := m.Download
		g.DownloadID = d.ID
		g.DownloadProgress = d.Progress
		switch d.Status {
		case "complete":
			c := *g.pendingDownload
			// Synthetic local candidate for the file we just fetched — the
			// same shape `cinderpaw setup` builds after its download rung.
			raw := fmt.Sprintf(
				`{"kind":"local_gguf","id":"local:%s","label":%q,"detail":"just downloaded","model":%q}`,
				c.DownloadFile, c.DownloadLabel, c.DownloadFile)
			local := api.SetupCandidate{
				Kind: "local_gguf", Label: c.DownloadLabel, Model: c.DownloadFile,
				Raw: []byte(raw),
			}
			g.TestLog = append(g.TestLog, fmt.Sprintf("Testing %s — real completion, not a ping…", local.Label))
			g.Step = GuidedTesting
			return true, a.guidedVerifyCmd(-1, local, "")
		case "failed", "cancelled":
			g.DownloadErr = d.Error
			if g.DownloadErr == "" {
				g.DownloadErr = d.Status
			}
			g.TestLog = append(g.TestLog, fmt.Sprintf(ui.G.Err+" download %s", g.DownloadErr))
			g.Step = GuidedManual
			return true, nil
		default:
			return true, a.guidedDownloadPoll(d.ID)
		}
	}
	return false, nil
}

// Manual-stage menu -----------------------------------------------------------

type guidedMenuEntry struct {
	label  string
	action func(a *App) tea.Cmd
}

// guidedMenu builds the manual-stage options: retry/download every detected
// candidate, paste a key, classic wizard, skip. Failure → choice, never a
// dead end.
func (a *App) guidedMenu() []guidedMenuEntry {
	var out []guidedMenuEntry
	for _, c := range a.Guided.Candidates {
		c := c
		if c.Kind == "hardware_download" {
			out = append(out, guidedMenuEntry{
				label:  fmt.Sprintf("Download %s (%s)", c.Label, c.DownloadSize),
				action: func(a *App) tea.Cmd { return a.guidedDownloadCmd(c) },
			})
		} else {
			out = append(out, guidedMenuEntry{
				label: fmt.Sprintf("Retry %s", c.Label),
				action: func(a *App) tea.Cmd {
					a.Guided.Step = GuidedTesting
					a.Guided.TestLog = append(a.Guided.TestLog,
						fmt.Sprintf("Testing %s — real completion, not a ping…", c.Label))
					return a.guidedVerifyCmd(-1, c, "")
				},
			})
		}
	}
	out = append(out,
		guidedMenuEntry{label: "Enter an API key", action: func(a *App) tea.Cmd {
			a.Guided.Step = GuidedKeyProvider
			a.Guided.ProviderIdx = 0
			return nil
		}},
		guidedMenuEntry{label: "Use the classic step-by-step wizard", action: func(a *App) tea.Cmd {
			a.Guided.Show = false
			a.startWizard()
			return nil
		}},
		guidedMenuEntry{label: "Skip AI setup for now", action: func(a *App) tea.Cmd {
			a.Guided.Skipped = true
			a.Guided.Step = GuidedDone
			return nil
		}},
	)
	return out
}

// Keys ------------------------------------------------------------------------

// guidedHandleKey consumes all keys while the guided flow is showing.
func (a *App) guidedHandleKey(msg tea.KeyMsg) tea.Cmd {
	g := &a.Guided
	key := msg.String()
	if key == "ctrl+c" {
		a.State = StateShutdown
		return tea.Quit
	}
	switch g.Step {
	case GuidedSecurity:
		switch strings.ToLower(key) {
		case "y", "enter":
			base, token := a.BaseURL, a.Token
			go func() { _ = api.SetupAck(base, token) }()
			return a.guidedAutoTest()
		case "n", "esc":
			// Decline = exit, nothing written (OpenClaw parity).
			a.State = StateShutdown
			return tea.Quit
		}
	case GuidedManual:
		menu := a.guidedMenu()
		switch key {
		case "up", "k":
			if g.MenuIdx > 0 {
				g.MenuIdx--
			}
		case "down", "j":
			if g.MenuIdx < len(menu)-1 {
				g.MenuIdx++
			}
		case "enter":
			if g.MenuIdx < len(menu) {
				return menu[g.MenuIdx].action(a)
			}
		}
	case GuidedKeyProvider:
		switch key {
		case "up", "k":
			if g.ProviderIdx > 0 {
				g.ProviderIdx--
			}
		case "down", "j":
			if g.ProviderIdx < len(CloudProviders)-1 {
				g.ProviderIdx++
			}
		case "enter":
			g.KeyProvider = CloudProviders[g.ProviderIdx]
			g.KeyBuf = ""
			g.Step = GuidedKeyInput
		case "esc":
			g.Step = GuidedManual
		}
	case GuidedKeyInput:
		switch key {
		case "enter":
			if strings.TrimSpace(g.KeyBuf) == "" {
				return nil
			}
			p := g.KeyProvider
			raw := fmt.Sprintf(
				`{"kind":"env_key","id":"manual:%s","label":%q,"detail":"manual key","provider_id":%q,"model":%q,"base_url":%q}`,
				p.ID, p.Name+" ("+p.DefaultModel+")", p.ID, p.DefaultModel, p.BaseURL)
			c := api.SetupCandidate{
				Kind: "env_key", Label: p.Name + " (" + p.DefaultModel + ")",
				ProviderID: p.ID, Model: p.DefaultModel, Raw: []byte(raw),
			}
			g.Step = GuidedTesting
			g.TestLog = append(g.TestLog, fmt.Sprintf("Testing %s — real completion, not a ping…", c.Label))
			return a.guidedVerifyCmd(-1, c, strings.TrimSpace(g.KeyBuf))
		case "esc":
			g.Step = GuidedKeyProvider
		case "backspace":
			if len(g.KeyBuf) > 0 {
				g.KeyBuf = g.KeyBuf[:len(g.KeyBuf)-1]
			}
		default:
			if msg.Type == tea.KeyRunes {
				g.KeyBuf += string(msg.Runes)
			}
		}
	case GuidedDone:
		if key == "enter" {
			a.finishGuided()
		}
	}
	return nil
}

// Rendering ---------------------------------------------------------------

// renderGuided renders the current guided screen inside the shared wizard
// frame (same chrome, no step counter — the guided flow is one fluid pass,
// not numbered screens).
func (a *App) renderGuided() string {
	g := &a.Guided
	width := a.ChatVP.Width
	if width < 40 {
		width = 40
	}
	var b strings.Builder
	line := func(s string) { b.WriteString(s + "\n") }

	switch g.Step {
	case GuidedDetect:
		line(ui.MetaStyle.Render("Looking for AI you can already use…"))
	case GuidedSecurity:
		line(ui.MetaStyle.Render("Cinderpaw is personal-by-default: it runs with your permissions, and a bad"))
		line(ui.MetaStyle.Render("prompt can trick it into doing unsafe things. Shared or multi-user setups"))
		line(ui.MetaStyle.Render("need locking down (allowlists, sandboxing, least-privilege)."))
		line("")
		line(ui.AccentStyle.Render("I understand — continue?"))
	case GuidedTesting, GuidedManual, GuidedDone:
		if g.DetectErr != "" {
			line(ui.ErrorTitle.Render(ui.G.Err+" detection failed: ") + ui.MetaStyle.Render(g.DetectErr))
			line("")
		}
		if len(g.Candidates) == 0 && g.DetectErr == "" {
			line(ui.MetaStyle.Render("No existing AI access was detected on this machine."))
			line("")
		}
		for _, c := range g.Candidates {
			rec := ""
			if c.Recommended {
				rec = ui.AccentStyle.Render(" — recommended")
			}
			line("• " + c.Label + " " + ui.MetaStyle.Render(c.Detail) + rec)
		}
		if len(g.Candidates) > 0 {
			line("")
		}
		for _, l := range g.TestLog {
			switch {
			case strings.HasPrefix(l, ui.G.OK):
				line(ui.OkMark.Render(l))
			case strings.HasPrefix(l, ui.G.Err):
				line(ui.ErrorTitle.Render(l))
			default:
				line(ui.MetaStyle.Render(l))
			}
		}
		if g.Step == GuidedManual {
			line("")
			line(ui.AccentStyle.Render("How do you want to connect?"))
			for i, e := range a.guidedMenu() {
				cursor := "  "
				label := ui.MetaStyle.Render(e.label)
				if i == g.MenuIdx {
					cursor = ui.AccentStyle.Render("› ")
					label = e.label
				}
				line(cursor + label)
			}
		}
		if g.Step == GuidedDone {
			line("")
			if g.Skipped {
				line(ui.MetaStyle.Render("To add AI later: set OPENAI_API_KEY or ANTHROPIC_API_KEY, download a"))
				line(ui.MetaStyle.Render("local model in the desktop app, or run `cinderpaw setup`."))
			} else {
				line(ui.OkMark.Render(ui.G.OK+" "+g.VerifiedLabel+" is ready") +
					ui.MetaStyle.Render(" — AI check: "+g.VerifiedMsg))
			}
			line("")
			line(ui.AccentStyle.Render("Next steps"))
			line(ui.MetaStyle.Render("Add a connector:  /connectors add   (or `cinderpaw connectors set discord`)"))
			line(ui.MetaStyle.Render("Desktop app:      launch Cinderpaw from the Start Menu"))
			line(ui.MetaStyle.Render("Health check:     /doctor"))
		}
	case GuidedKeyProvider:
		line(ui.AccentStyle.Render("Which provider?"))
		for i, p := range CloudProviders {
			cursor := "  "
			label := ui.MetaStyle.Render(p.Name)
			if i == g.ProviderIdx {
				cursor = ui.AccentStyle.Render("› ")
				label = p.Name
			}
			line(cursor + label)
		}
	case GuidedKeyInput:
		line(ui.MetaStyle.Render("Paste your " + g.KeyProvider.Name + " API key:"))
		line("")
		line(ui.AccentStyle.Render("› ") + strings.Repeat("•", len(g.KeyBuf)))
	case GuidedDownloading:
		label := ""
		if g.pendingDownload != nil {
			label = g.pendingDownload.Label
		}
		line(ui.MetaStyle.Render(fmt.Sprintf("Downloading %s… %3.0f%%", label, g.DownloadProgress*100)))
	}

	return ui.RenderWizardFrame(width, ui.WizardFrame{
		Title: "Connect your AI",
		Body:  b.String(),
	})
}

// guidedFooterHint is the footer text for the current guided screen.
func (g *GuidedState) footerHint() string {
	switch g.Step {
	case GuidedDetect:
		return "detecting…"
	case GuidedSecurity:
		return "y accept  ·  n decline (exits)"
	case GuidedTesting:
		return "testing — real completion, not a ping…"
	case GuidedManual:
		return ui.G.Up + ui.G.Down + " navigate  ·  enter select"
	case GuidedKeyProvider:
		return ui.G.Up + ui.G.Down + " navigate  ·  enter select  ·  esc back"
	case GuidedKeyInput:
		return "paste your api key and press enter  ·  esc back"
	case GuidedDownloading:
		return "downloading…"
	case GuidedDone:
		return "enter to start chatting  ·  classic wizard: /setup classic"
	default:
		return ""
	}
}

// finishGuided closes the flow into chat. The wizard-done marker is written
// on BOTH success and skip — skip's resume note tells the user how to
// re-run setup, and nagging every launch is worse than trusting them.
func (a *App) finishGuided() {
	a.Guided.Show = false
	a.State = StateReady
	if marker, err := wizardDonePath(); err == nil {
		os.WriteFile(marker, []byte("done\n"), 0644)
	}
	clearWizardProgress()
	a.connectorTipArmed = true
	a.needsRebuild = true
	a.rebuildViewport()
}
