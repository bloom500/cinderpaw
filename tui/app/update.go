package app

import (
	"encoding/json"
	"errors"
	"cinderpaw-tui/api"
	"cinderpaw-tui/ui"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
)

// statusPollTick fires every 5s to refresh the header's online/model/lora/
// backend values from the gateway (spec §29).
func statusPollTick() tea.Cmd {
	return tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
		return StatusPollTickMsg{}
	})
}

// fetchStatusCmd hits /runtime/status for the status poll.
func (a *App) fetchStatusCmd() tea.Cmd {
	return func() tea.Msg {
		status, err := api.FetchStatus(a.BaseURL, a.Token)
		return StatusPollResult{Status: status, Err: err}
	}
}

// toolTick fires every 250ms while any tool is running, so the elapsed-time
// column updates live and we don't need a separate per-tool ticker.
// ≤4×/s per spec §31.5.
func toolTick() tea.Cmd {
	return tea.Tick(250*time.Millisecond, func(t time.Time) tea.Msg {
		return TickMsg(t)
	})
}

// fetchSessionsCmd hits /runtime/sessions for the welcome screen. Cached
// results are valid for 30s so window resize doesn't refetch.
func (a *App) fetchSessionsCmd() tea.Cmd {
	// Snapshot the model HERE, on the update loop. The returned closure runs on
	// its own goroutine, and reading a.Sessions / a.SessionsAt from there races
	// with the Update handler writing them — bubbletea's rule is that a Cmd
	// never touches the model, and `go test -race` flags this one on sight.
	cached, cachedAt, cachedErr := a.Sessions, a.SessionsAt, a.SessionsErr
	baseURL, token := a.BaseURL, a.Token
	return func() tea.Msg {
		if !cachedAt.IsZero() && time.Since(cachedAt) < 30*time.Second && cachedErr == nil {
			return SessionsMsg{Sessions: cached, Err: nil}
		}
		sessions, err := api.FetchSessions(baseURL, token, 3)
		return SessionsMsg{Sessions: sessions, Err: err}
	}
}

// Sprint 1.8 — Memory Resume fetch. Hits `/runtime/resume` (the gateway
// route added in Sprint 1.6). 30s cache so the welcome screen doesn't
// refetch on every Tab / resize. Errors collapse to "no prior task" so a
// transient gateway hiccup never blocks the welcome render.
func (a *App) fetchResumeCmd() tea.Cmd {
	// Same snapshot-before-goroutine rule as fetchSessionsCmd above.
	cachedView, cachedAt, cachedErr := a.LastTaskView, a.LastTaskAt, a.LastTaskErr
	baseURL, token := a.BaseURL, a.Token
	return func() tea.Msg {
		if !cachedAt.IsZero() && time.Since(cachedAt) < 30*time.Second && cachedErr == nil {
			return LastTaskMsg{View: cachedView, Err: nil}
		}
		view, err := api.FetchResume(baseURL, token)
		return LastTaskMsg{View: view, Err: err}
	}
}

func (a *App) Init() tea.Cmd {
	return tea.Sequence(
		// Boot flash — header shows "○ starting" for ~100 ms (§2 J2.1).
		tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg {
			return BootComplete{}
		}),
		tea.Batch(textarea.Blink, a.Loader.Tick, toolTick(), a.fetchSessionsCmd(), a.fetchResumeCmd(), a.startEventsCmd(), statusPollTick()),
	)
}

func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	a.Now = time.Now()
	// Guided first-run flow messages (detect/verify/download) — handled
	// before the main switch so they can't leak into chat handling.
	if handled, cmd := a.handleGuidedMsg(msg); handled {
		return a, cmd
	}
	switch msg := msg.(type) {
	case BootComplete:
		a.State = StateReady
		a.rebuildViewport()

		// Check for wizard-done marker (§2 J2.3) — if missing, this is a
		// first launch. The GUIDED flow is the default (OpenClaw parity);
		// `--wizard` (the `feral setup --classic` path) forces the classic
		// step-by-step wizard.
		marker, err := wizardDonePath()
		if err == nil {
			if _, statErr := os.Stat(marker); os.IsNotExist(statErr) {
				if a.ForceClassicWizard {
					a.startWizard()
					return a, nil
				}
				return a, a.startGuided()
			}
		} else {
			if a.ForceClassicWizard {
				a.startWizard()
				return a, nil
			}
			return a, a.startGuided()
		}
		return a, nil

	case tea.WindowSizeMsg:
		a.Width = msg.Width
		a.Height = msg.Height
		headerH := 1
		footerH := 1
		sepH := 1
		maxInH := 6
		if a.Height/4 < maxInH {
			maxInH = a.Height / 4
		}
		tiH := clamp(1, 8, maxInH-2)
		inH := tiH + 2
		chatH := a.Height - headerH - inH - footerH - sepH
		if chatH < 4 {
			chatH = 4
		}
		a.Input.SetWidth(msg.Width - 3)
		a.Input.SetHeight(tiH)
		a.ChatVP.Width = msg.Width - 2
		a.ChatVP.Height = chatH
		a.rebuildViewport()
		return a, nil

	case tea.KeyMsg:
		if a.State == StateShutdown {
			return a, tea.Quit
		}
		// Guided mode: the guided first-run flow consumes all keys when active.
		if a.Guided.Show {
			return a, a.guidedHandleKey(msg)
		}
		// Wizard mode: wizard consumes all keys when active.
		if a.Wizard.Show {
			cmd := a.wizardHandleKey(msg)
			a.rebuildViewport()
			return a, cmd
		}
		// ── Key dispatch via key.Binding (spec §16/§24.3) ──────────────
		// Vim-style k/j overlay nav: only intercepted while an overlay is
		// showing (the && overlayNav guards below); otherwise no case
		// matches and the key falls through to the textarea update.
		raw := msg.String()
		overlayNav := a.ToolViewer.Show || a.ModelPicker.Show
		switch {
		case key.Matches(msg, Keys.Quit):
			a.handleCtrlC()
			if a.State == StateShutdown {
				return a, tea.Quit
			}
			return a, nil

		case key.Matches(msg, Keys.QuitEmpty):
			if a.Input.Value() == "" {
				a.State = StateShutdown
				return a, tea.Quit
			}
			return a, nil

		case key.Matches(msg, Keys.Interrupt):
			if a.State == StateStreaming || a.State == StateToolRunning || a.State == StateThinking {
				a.stopStream()
				// P2.3: Esc interrupts the stream but does NOT clear
				// the composed text — the user may still want what
				// they typed (or have queued a pendingSubmit).
				return a, nil
			}
			if a.ShowHelp {
				a.ShowHelp = false
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

		case key.Matches(msg, Keys.Send):
			if a.ShowHelp {
				a.ShowHelp = false
				return a, nil
			}
			if a.ModelPicker.Show && !a.ModelPicker.Loading && len(a.ModelPicker.Rows) > 0 {
				picked := a.ModelPicker.Rows[a.ModelPicker.Idx]
				a.ModelPicker.Show = false
				cmd := a.switchModelCmd(picked.ID)
				return a, cmd
			}
			if a.ToolViewer.Show {
				if len(a.ToolViewer.Rows) > 0 {
					a.ToolViewer.Expanded = !a.ToolViewer.Expanded
				}
				return a, nil
			}
			// A pending ask_user question owns the input: Enter answers
			// it instead of queueing chat text — the agent is BLOCKED on
			// this answer, so queueing would deadlock the turn until the
			// question timed out.
			if a.PendingAsk != nil {
				text := strings.TrimSpace(a.Input.Value())
				if text == "" {
					return a, nil
				}
				req := a.PendingAsk
				a.PendingAsk = nil
				a.Input.Reset()
				a.Turns = append(a.Turns, Turn{Role: RoleUser, Text: text, turnVer: 1})
				a.needsRebuild = true
				a.rebuildViewport()
				return a, a.answerAskCmd(req, text)
			}
			if a.State == StateStreaming {
				// P2.3: type-ahead during streaming. Capture the
				// composed text into PendingSubmit and clear the
				// textarea; the next clean StreamDoneMsg auto-submits
				// it. Empty input → ignore.
				text := strings.TrimSpace(a.Input.Value())
				if text != "" {
					a.PendingSubmit = text
					a.Input.Reset()
					a.rebuildViewport()
				}
				return a, nil
			}
			if a.Completion.Show && len(a.Completion.List) > 0 {
				a.acceptCompletion()
				a.rebuildViewport()
				return a, nil
			}
			cmd := a.handleSubmit()
			return a, cmd

		case key.Matches(msg, Keys.Tab):
			if a.ModelPicker.Show && !a.ModelPicker.Loading && len(a.ModelPicker.Rows) > 0 {
				a.ModelPicker.Idx = (a.ModelPicker.Idx + 1) % len(a.ModelPicker.Rows)
				return a, nil
			}
			if a.Completion.Show && len(a.Completion.List) > 0 {
				a.Completion.Idx = (a.Completion.Idx + 1) % len(a.Completion.List)
				return a, nil
			}

		case key.Matches(msg, Keys.Help):
			a.ShowHelp = !a.ShowHelp
			return a, nil

		case msg.String() == "?" && a.Input.Value() == "" &&
			!a.ToolViewer.Show && !a.ModelPicker.Show && !a.Completion.Show:
			// P2.2: `?` is a help-overlay alias when the input is empty.
			// With text in the input, `?` types as a literal character.
			a.ShowHelp = !a.ShowHelp
			return a, nil

		case key.Matches(msg, Keys.ScrollUp), key.Matches(msg, Keys.ScrollDown):
			// P2.4: when the tool viewer's preview is expanded,
			// PgUp/PgDn pages through the preview window instead of
			// the chat viewport behind it.
			if a.ToolViewer.Show && a.ToolViewer.Expanded {
				const pageLines = 16
				preview := ""
				if a.ToolViewer.Idx < len(a.ToolViewer.Rows) {
					preview = a.ToolViewer.Rows[a.ToolViewer.Idx].Call.Preview
				}
				if preview != "" {
					total := strings.Count(preview, "\n") + 1
					maxOff := total - pageLines
					if maxOff < 0 {
						maxOff = 0
					}
					if key.Matches(msg, Keys.ScrollUp) {
						a.ToolViewer.PreviewOffset -= pageLines
						if a.ToolViewer.PreviewOffset < 0 {
							a.ToolViewer.PreviewOffset = 0
						}
					} else {
						a.ToolViewer.PreviewOffset += pageLines
						if a.ToolViewer.PreviewOffset > maxOff {
							a.ToolViewer.PreviewOffset = maxOff
						}
					}
					return a, nil
				}
			}
			var cmd tea.Cmd
			a.ChatVP, cmd = a.ChatVP.Update(msg)
			a.FollowBottom = a.ChatVP.AtBottom()
			return a, cmd

		case key.Matches(msg, Keys.Up):
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

		case key.Matches(msg, Keys.Down):
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

		// Vim-style k/j nav for overlays only — without an overlay these
		// guards fail and k/j type into the textarea like any letter.
		case raw == "k" && overlayNav:
			if a.ToolViewer.Show && len(a.ToolViewer.Rows) > 0 && a.ToolViewer.Idx > 0 {
				a.ToolViewer.Idx--
				return a, nil
			}
			if !a.ModelPicker.Show || a.ModelPicker.Loading || len(a.ModelPicker.Rows) == 0 {
				return a, nil
			}
			if a.ModelPicker.Idx > 0 {
				a.ModelPicker.Idx--
			}
			return a, nil
		case raw == "j" && overlayNav:
			if a.ToolViewer.Show && len(a.ToolViewer.Rows) > 0 && a.ToolViewer.Idx < len(a.ToolViewer.Rows)-1 {
				a.ToolViewer.Idx++
				return a, nil
			}
			if !a.ModelPicker.Show || a.ModelPicker.Loading || len(a.ModelPicker.Rows) == 0 {
				return a, nil
			}
			if a.ModelPicker.Idx < len(a.ModelPicker.Rows)-1 {
				a.ModelPicker.Idx++
			}
			return a, nil

		case key.Matches(msg, Keys.Thinking):
			a.toggleThinking()
			a.rebuildViewport()
			return a, nil

		case key.Matches(msg, Keys.Confirm):
			if a.State == StateWaiting && a.ApprovalToolID != "" {
				a.State = a.PriorState
				a.ApprovalToolID = ""
				a.rebuildViewport()
				return a, nil
			}

		case key.Matches(msg, Keys.Decline):
			if a.State == StateWaiting && a.ApprovalToolID != "" {
				a.State = StateReady
				for i := len(a.Turns) - 1; i >= 0; i-- {
					t := &a.Turns[i]
					if t.Role != RoleAssistant {
						continue
					}
					for j := range t.Tools {
						if t.Tools[j].ID == a.ApprovalToolID {
							t.Tools[j].Status = ToolDeclined
							break
						}
					}
					break
				}
				a.ApprovalToolID = ""
				a.PriorState = StateReady
				a.setFlash("declined")
				a.rebuildViewport()
				return a, nil
			}

		case key.Matches(msg, Keys.Retry):
			if a.State == StateError {
				return a, a.retryLastMessage()
			}
		}

		if a.State != StateShutdown {
			var cmd tea.Cmd
			a.Input, cmd = a.Input.Update(msg)
			// Every keystroke can change the slash-command prefix.
			// Recompute the popup so it stays in sync without the user
			// having to "open" it explicitly.
			a.recomputeCompletion()
			return a, cmd
		}
		return a, nil

	case tea.MouseMsg:
		if a.ShowHelp || a.ToolViewer.Show || a.ModelPicker.Show {
			// Overlays don't scroll via mouse wheel yet — ignore rather
			// than let the wheel silently move the chat viewport behind
			// a modal the user is looking at.
			return a, nil
		}
		var cmd tea.Cmd
		a.ChatVP, cmd = a.ChatVP.Update(msg)
		a.FollowBottom = a.ChatVP.AtBottom()
		return a, cmd

	case spinner.TickMsg:
		var cmd tea.Cmd
		a.Loader, cmd = a.Loader.Update(msg)
		if a.Wizard.Show {
			a.Wizard.SpinnerView = a.Loader.View()
		}
		if !a.FlashUntil.IsZero() && time.Now().After(a.FlashUntil) {
			a.FlashText = ""
			a.FlashUntil = time.Time{}
		}
		if !a.RateLimitUntil.IsZero() && !a.retriedRateLimit && time.Now().After(a.RateLimitUntil) {
			a.retriedRateLimit = true
			return a, tea.Batch(cmd, a.retryLastMessage())
		}
		// Stop re-issuing spinner ticks when idle (spec §31.7: zero animation).
		if a.State == StateIdle || a.State == StateShutdown {
			return a, nil
		}
		return a, cmd

	case TickMsg:
		// Drives the live elapsed-time column on running tool pills.
		// Only re-issues the tick when something is actually changing.
		if a.toolsRunning() {
			return a, toolTick()
		}
		return a, nil

	case StreamChunkMsg:
		a.handleStreamChunk(msg.Chunk)
		return a, nil

	case FrameTickMsg:
		if a.State != StateStreaming {
			return a, nil
		}
		a.flushPending()
		a.rebuildViewport()
		return a, frameTick()

	case ModelListMsg:
		if msg.Err != nil {
			if a.ModelPicker.Show {
				a.ModelPicker.Loading = false
				a.ModelPicker.LoadErr = msg.Err.Error()
			} else {
				a.setFlash(fmt.Sprintf("model list failed: %v", msg.Err))
			}
			return a, nil
		}
		if len(msg.IDs) == 0 {
			a.ModelPicker.Loading = false
			a.ModelPicker.LoadErr = "no models installed — see the Local Models tab"
			a.setFlash(a.ModelPicker.LoadErr)
			return a, nil
		}
		// Build rows for the picker overlay: local entries have no
		// `provider:` prefix, cloud entries carry `provider:model`.
		// Each row records whether it's the currently loaded model.
		rows := make([]ModelEntry, 0, len(msg.IDs))
		for _, id := range msg.IDs {
			entry := ModelEntry{ID: id, Active: id == msg.Active}
			if pid, _, ok := strings.Cut(id, ":"); ok {
				entry.Kind = "cloud"
				entry.Provider = pid
			} else {
				entry.Kind = "local"
			}
			rows = append(rows, entry)
		}
		a.ModelPicker.Rows = rows
		a.ModelPicker.Loading = false
		// Also flash a one-liner when the picker isn't open so `/model
		// list` from a keybinding still gives the user feedback.
		if !a.ModelPicker.Show {
			labels := make([]string, len(rows))
			for i, r := range rows {
				if r.Active {
					labels[i] = "*" + r.ID
				} else {
					labels[i] = r.ID
				}
			}
			a.setFlash("models: " + strings.Join(labels, "  ") + "   (/model <id> to switch)")
		}
		return a, nil

	case ModelSwitchMsg:
		if msg.Err != nil {
			a.setFlash(fmt.Sprintf("model switch failed: %v", msg.Err))
			return a, nil
		}
		a.Status.Model = msg.Active
		a.setFlash("switched to " + msg.Active)
		return a, nil

	case SessionsMsg:
		a.Sessions = msg.Sessions
		a.SessionsErr = msg.Err
		a.SessionsAt = time.Now()
		a.rebuildViewport()
		return a, nil

	case LastTaskMsg:
		a.LastTaskView = msg.View
		a.LastTaskErr = msg.Err
		a.LastTaskAt = time.Now()
		if msg.View != nil {
			a.LastTask = msg.View.Task
		}
		a.rebuildViewport()
		return a, nil

	case HardwareProbeMsg:
		a.State = StateReady
		if msg.Err != nil || msg.Info == nil {
			// Don't advance; show a Retry CTA in the renderer. The user
			// can press R (or Enter) to re-trigger startWizardHardwareProbe.
			a.Wizard.HardwareProbeErr = msg.Err
			a.rebuildViewport()
			return a, nil
		}
		a.Wizard.HardwareProbeErr = nil
		a.Wizard.Hardware = WizardHardware{
			GpuName: msg.Info.GpuName,
			GpuVram: int(msg.Info.VramTotalMB / 1024),
			RamGB:   int(msg.Info.RamTotalMB / 1024),
			DiskGB:  0, // sysinfo_mod doesn't ship disk_free yet
			GpuOK:   msg.Info.GpuName != "" && msg.Info.VramTotalMB > 0,
		}
		// P1: the probe result stays on the Engine screen (WizHardware). We
		// do NOT auto-advance — the user picks Local/Cloud here. Pre-select
		// the runtime from the probe: GPU → Local, else Cloud.
		if a.Wizard.Hardware.GpuOK {
			a.Wizard.Choice = WizChoiceLocal
		} else {
			a.Wizard.Choice = WizChoiceCloud
		}
		a.rebuildViewport()
		return a, nil

	case ProvidersTestMsg:
		// Sprint 2 / audit C-2. On success we move to the next step; on
		// failure the renderer shows the real provider message verbatim.
		a.State = StateReady
		if msg.Success {
			a.Wizard.KeyValid = true
			a.Wizard.KeyValidMsg = msg.Msg
			a.Wizard.lastCompleted = WizCloudKey
			saveWizardProgress(WizCloudKey, a.Wizard.SetupMode, a.Wizard.Choice)
			// ONB-004: persist the validated key to ~/.feral/byok.json
			// and activate the provider by switching the runtime model.
			// The API key itself is not written to byok.json (the Rust
			// backend reads keys from the OS keychain); we only persist
			// the non-secret metadata so the provider is remembered
			// across launches.
			if err := a.saveCloudProvider(); err != nil {
				a.Wizard.KeyValidMsg = "saved config failed: " + err.Error()
			}
			// P1 screen 3b: auto-run the 4 health checks on the same screen
			// (WizTestIt maps to visible screen 3), no Enter in between.
			a.Wizard.pushStepHistory()
			a.Wizard.Step = nextPathStep(&a.Wizard)
			a.Wizard.TestItRunning = true
			for i := range a.Wizard.HealthChecks {
				a.Wizard.HealthChecks[i] = HealthCheck{Kind: HealthCheckKind(i), Status: CheckPending}
			}
			a.rebuildViewport()
			return a, a.startWizardHealthCheck()
		} else {
			a.Wizard.KeyValid = false
			a.Wizard.KeyValidMsg = msg.Msg
		}
		a.rebuildViewport()
		return a, nil

	case DownloadStartedMsg:
		// Sprint 2 / audit C-5 — store the download id and start the
		// first progress poll. The renderer shows the spinner; the
		// pollDownload cmd fires every 500ms until completion.
		a.Wizard.DownloadID = msg.ID
		a.Wizard.Progress = 0
		a.Wizard.ProgressMsg = "starting…"
		// ONB-014: stamp the start time so we can compute real speed/ETA.
		a.Wizard.DownloadStartedAt = time.Now()
		a.rebuildViewport()
		return a, a.pollDownload()

	case DownloadModelMsg:
		// Sprint 2 / audit C-5. On success: update progress + maybe advance.
		// On failure: keep the wizard on this step and surface a Retry CTA.
		// ONB-007: classify terminal vs transient errors — terminal errors
		// (404, hard gateway failures) stop the poll; transient errors retry.
		if msg.Err != nil || msg.Download == nil {
			a.Wizard.DownloadErr = msg.Err
			a.rebuildViewport()
			// A forgotten download (gateway restarted) is terminal — stop polling
			// and let the wizard show its Retry CTA. Everything else (network
			// blips, transient 5xx) is worth another poll.
			if errors.Is(msg.Err, api.ErrDownloadGone) {
				return a, nil
			}
			return a, a.pollDownload()
		}
		a.Wizard.DownloadErr = nil
		a.Wizard.Progress = msg.Download.Progress
		a.Wizard.ProgressMsg = fmt.Sprintf("%.0f%%", msg.Download.Progress*100)
		switch msg.Download.Status {
		case "complete":
			a.Wizard.Progress = 1.0
			a.Wizard.ProgressMsg = "ready"
			a.Wizard.lastCompleted = WizLocalDownload
			saveWizardProgress(WizLocalDownload, a.Wizard.SetupMode, a.Wizard.Choice)
			a.Wizard.pushStepHistory()
			a.Wizard.Step = nextPathStep(&a.Wizard)
			a.Wizard.TestItRunning = true
			for i := range a.Wizard.HealthChecks {
				a.Wizard.HealthChecks[i] = HealthCheck{Kind: HealthCheckKind(i), Status: CheckPending}
			}
			a.rebuildViewport()
			return a, a.startWizardHealthCheck()
		case "failed":
			a.Wizard.DownloadErr = fmt.Errorf("%s", msg.Download.Error)
			a.rebuildViewport()
			return a, nil
		case "cancelled":
			a.Wizard.DownloadErr = fmt.Errorf("download cancelled")
			a.rebuildViewport()
			return a, nil
		default:
			// Still downloading — keep polling.
			a.rebuildViewport()
			return a, a.pollDownload()
		}

	case WizardHealthProgress:
		a.Wizard.HealthChecks = msg.Checks
		a.rebuildViewport()
		return a, nil

	case WizardCatalogsLoadedMsg:
		// Phase 1 (2026-07-07) — populate the catalog cache. Renderers
		// read `WizardState.ProviderCatalog()` / `ConnectorCatalog()`
		// which fall back to the bundled slices when the cache is
		// empty. The Offline / Drift flags are surfaced via small
		// banners in the wizard's status row (Decision C — bundled
		// fallback with a clearly surfaced warning, never a silent
		// drop).
		a.Wizard.providerCatalog = msg.Providers
		a.Wizard.connectorCatalog = msg.Connectors
		a.Wizard.catalogVersion = msg.Version
		a.Wizard.catalogOffline = msg.Offline
		// Drift is sticky during the wizard session — the banner stays
		// up but only fires the visible flash once so the user isn't
		// spammed every redraw.
		if msg.Drift && !a.Wizard.catalogDriftWarned {
			a.Wizard.catalogDriftWarned = true
			a.setFlash("Catalog version mismatch — using bundled fallback.")
		}
		a.rebuildViewport()
		return a, nil

	case WizardTestItResult:
		a.Wizard.TestItRunning = false
		if msg.Err != nil {
			// Mark any remaining pending/running checks as failed.
			for i := range a.Wizard.HealthChecks {
				if a.Wizard.HealthChecks[i].Status == CheckPending || a.Wizard.HealthChecks[i].Status == CheckRunning {
					a.Wizard.HealthChecks[i].Status = CheckFailed
					a.Wizard.HealthChecks[i].Message = msg.Err.Error()
				}
			}
			a.Wizard.TestItSucceeded = false
			a.Wizard.TestItError = msg.Err.Error()
			a.Wizard.TestItResponse = msg.Response
			a.Wizard.TestItAttempts++
			// F2 / spec §HEALTH CHECK FAILURE HANDLING: auto-retry
			// at most once. After that, surface the failure to the
			// user with explicit Retry / Change / Skip. Prevents the
			// silent infinite-loop anti-pattern.
			if a.Wizard.TestItAttempts == 1 {
				a.Wizard.TestItRunning = true
				for i := range a.Wizard.HealthChecks {
					a.Wizard.HealthChecks[i] = HealthCheck{Kind: HealthCheckKind(i), Status: CheckPending}
				}
				a.rebuildViewport()
				return a, a.startWizardHealthCheck()
			}
			a.rebuildViewport()
			return a, nil
		}
		a.Wizard.TestItSucceeded = true
		a.Wizard.TestItRunning = false
		a.Wizard.TestItError = ""
		a.Wizard.TestItResponse = msg.Response
		a.Wizard.TestItAttempts = 0
		a.Wizard.HealthCheckLatency = msg.HealthLatency
		a.Wizard.StreamLatency = msg.StreamLatency
		a.Wizard.StreamVerified = msg.StreamVerified
		a.Wizard.lastCompleted = WizTestIt
		saveWizardProgress(WizTestIt, a.Wizard.SetupMode, a.Wizard.Choice)
		// P1: checks pass → auto-advance to the Ready screen (screen 4).
		// The benchmark block is rendered once there. Only WizTestIt is in
		// the path just before WizFinish, so nextPathStep lands on Ready.
		if a.Wizard.Step == WizTestIt {
			a.Wizard.pushStepHistory()
			a.Wizard.Step = nextPathStep(&a.Wizard)
		}
		a.rebuildViewport()
		return a, nil

	case StreamDoneMsg:
		if a.State == StateShutdown {
			return a, tea.Quit
		}
		a.flushPending()
		a.finishStream()
		if msg.Err != nil {
			a.setFlash(fmt.Sprintf("stream error: %v", msg.Err))
			// Type-ahead queued during a stream that errored: put the text
			// back in the input instead of dropping it silently.
			if a.PendingSubmit != "" {
				a.Input.SetValue(a.PendingSubmit)
				a.PendingSubmit = ""
			}
		} else if a.connectorTipArmed {
			// P1.1: first clean reply after setup → one connector-discovery tip.
			a.connectorTipArmed = false
			a.RuntimeEvents = append(a.RuntimeEvents, api.RuntimeEvent{
				Kind:    "tip",
				Message: "tip: connect Discord or Telegram with /connectors",
			})
		}
		// P2.3: clean stream completion → auto-submit queued text
		// (user typed ahead during streaming and hit Enter).
		var pendingCmd tea.Cmd
		if msg.Err == nil && a.PendingSubmit != "" {
			queued := a.PendingSubmit
			a.PendingSubmit = ""
			a.Input.SetValue(queued)
			pendingCmd = a.handleSubmit()
		}
		a.rebuildViewport()
		if pendingCmd != nil {
			return a, pendingCmd
		}
		return a, nil

	case FlashMsg:
		a.setFlash(msg.Text)
		return a, nil

	case TranscriptLinesMsg:
		a.appendTranscriptLines(msg.Lines)
		return a, nil

	case RuntimeEventMsg:
		// Brain Stack model switch: update header live (spec §10).
		if msg.Event.Kind == "model_set" {
			if msg.Event.Model != "" {
				a.Status.Model = msg.Event.Model
			}
			if msg.Event.Provider != "" {
				a.Status.Provider = msg.Event.Provider
			}
		}
		if a.State == StateStreaming {
			a.PendingEvents = append(a.PendingEvents, msg.Event)
		} else {
			a.RuntimeEvents = append(a.RuntimeEvents, msg.Event)
			a.coalesceRuntimeEvents()
			a.rebuildViewport()
		}
		return a, nil

	case StatusPollTickMsg:
		if a.State == StateShutdown || a.State == StateBoot {
			return a, nil
		}
		return a, a.fetchStatusCmd()

	case StatusPollResult:
		wasOnline := a.Status.Online
		if msg.Err == nil && msg.Status != nil {
			a.Status = msg.Status
			a.rebuildViewport()
		}
		if msg.Err != nil || msg.Status == nil || !msg.Status.Online {
			// Backend went dark — enter recovery (Sprint 3 / ONB-009).
			// The TUI can't restart the gateway (it's a separate process);
			// it polls every 5s and auto-reconnects when the runtime
			// comes back. The message below is honest about that.
			if wasOnline || a.State == StateReady || a.State == StateIdle {
				a.State = StateRecovery
				a.RecoverAttempts++
				if a.RecoverAttempts == 1 {
					a.setFlash("Backend disconnected. Waiting for runtime…")
				}
			}
			return a, statusPollTick()
		}
		// Came back online during recovery.
		if a.State == StateRecovery {
			a.setFlash(ui.G.OK + " Reconnected")
			a.State = StateReady
			a.RecoverAttempts = 0
		}
		return a, statusPollTick()

	}

	return a, nil
}

func (a *App) handleSubmit() tea.Cmd {
	raw := strings.TrimSpace(a.Input.Value())
	if raw == "" {
		return nil
	}
	if strings.HasPrefix(raw, "/") {
		// Hide the popup the instant we commit a slash command — keeps the
		// flash banner + overlay from racing the popup.
		a.Completion.Show = false
		a.Completion.List = nil
		a.Completion.Idx = 0
		a.pushHistory(raw)
		// Clear the composed command — same as the plain-message path;
		// leaving it in the input forced a manual delete after every /cmd.
		a.Input.Reset()
		return a.handleSlash(raw[1:])
	}
	a.pushHistory(raw)
	a.Input.Reset()
	a.Completion.Show = false
	a.Completion.List = nil
	a.Completion.Idx = 0
	a.lastUserText = raw
	a.Turns = append(a.Turns, Turn{Role: RoleUser, Text: raw, turnVer: 1})
	a.beginAssistant()
	a.State = StateStreaming
	a.FollowBottom = true
	a.rebuildViewport()
	return tea.Batch(a.startStream(raw), immediateFrameTick())
}

func (a *App) handleSlash(body string) tea.Cmd {
	parts := strings.Fields(body)
	if len(parts) == 0 {
		return nil
	}
	cmd := parts[0]
	if c, ok := lookupCommand(cmd); ok {
		return c.Run(a, parts[1:])
	}
	a.setFlash(fmt.Sprintf("unknown command: /%s  (try /help)", cmd))
	return nil
}

func orStr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func (a *App) beginAssistant() {
	a.Turns = append(a.Turns, Turn{
		Role:      RoleAssistant,
		Streaming: true,
		turnVer:   1, // non-zero so fresh turn doesn't match empty cache
	})
	// New turn added → content changed.
	a.needsRebuild = true
	// Reset streaming stats so the footer starts fresh for this turn.
	a.StreamStartedAt = time.Now()
	a.StreamPromptTokens = 0
	a.StreamCompletionTokens = 0
	a.LastTokenAt = time.Now()
	a.streamHasContent = false
}

func (a *App) finishStream() {
	elapsed := formatElapsed(time.Since(a.StreamStartedAt))
	tokens := a.StreamCompletionTokens
	for i := range a.Turns {
		t := &a.Turns[i]
		if t.Role == RoleAssistant && t.Streaming {
			t.Streaming = false
			if !a.StreamStartedAt.IsZero() {
				// /usage off|tokens|full (OpenClaw parity) shapes this
				// footnote; "" == "tokens" (the default).
				switch a.UsageMode {
				case "off":
					t.Meta = ""
				case "full":
					t.Meta = fmt.Sprintf("%s · %d in · %d out · %d total",
						elapsed, a.StreamPromptTokens, tokens, a.StreamPromptTokens+tokens)
				default:
					if tokens > 0 {
						t.Meta = fmt.Sprintf("%s · %d tok", elapsed, tokens)
					} else {
						t.Meta = elapsed
					}
				}
			}
			t.markDirty()
			break
		}
	}
	// Preserve StateError: a mid-stream error sets StateError (via
	// pushAssistantError) and the recovery loop (retryLastMessage,
	// auto-retry-on-zero) relies on the user staying in that state
	// after the stream ends. finishStream must not clobber it.
	if a.State == StateStreaming || a.State == StateThinking || a.State == StateWaiting {
		a.State = StateReady
	}
	// Streaming state changed → auxH drops → viewport height must be
	// recalculated on the next View() pass.
	a.needsRebuild = true
	a.StreamBuf.Reset()
	// Flush any runtime events that queued during streaming (spec §11).
	a.flushPendingEvents()
	// Clear streaming stats — the footer reverts to the shortcut row until
	// the next turn begins. The per-turn cost is preserved on the Turn
	// itself (Meta, set above), not here.
	a.StreamStartedAt = time.Time{}
	a.StreamPromptTokens = 0
	a.StreamCompletionTokens = 0
}

func (a *App) stopStream() {
	a.flushPending()
	for i := range a.Turns {
		t := &a.Turns[len(a.Turns)-1-i]
		if t.Role == RoleAssistant && t.Streaming {
			t.Interrupted = true
			t.markDirty()
			break
		}
	}
	a.finishStream()
	a.setFlash("cancelled")
}

// openToolViewer rebuilds the flattened tool list from the current Turns
// (newest first — reverse iteration so the most recent call is at the top,
// which is what users want when they ask "what did the agent just do?")
// and shows the overlay. Idx resets to the top; Expanded stays off so the
// user gets a clean first look.
//
// The overlay is always re-populated from scratch (rather than diffed)
// because the call sites are rare (`/tools`) and a stale row pointing to
// a removed tool would be worse than a brief re-build.
func (a *App) openToolViewer() {
	rows := make([]ToolViewerRow, 0)
	for ti := len(a.Turns) - 1; ti >= 0; ti-- {
		t := a.Turns[ti]
		if t.Role != RoleAssistant {
			continue
		}
		// Within a turn, also newest first.
		for tci := len(t.Tools) - 1; tci >= 0; tci-- {
			rows = append(rows, ToolViewerRow{
				TurnIdx: ti,
				ToolIdx: tci,
				Call:    t.Tools[tci],
			})
		}
	}
	a.ToolViewer.Show = true
	a.ToolViewer.Rows = rows
	a.ToolViewer.Idx = 0
	a.ToolViewer.Expanded = false
}

// openModelPicker kicks off the model picker overlay. Returns a fetch
// command that populates `ModelPicker.Rows` from `/runtime/models` —
// the overlay renders a "loading…" placeholder until the response lands.
func (a *App) openModelPicker() tea.Cmd {
	a.ModelPicker.Show = true
	a.ModelPicker.Loading = true
	a.ModelPicker.LoadErr = ""
	a.ModelPicker.Rows = nil
	a.ModelPicker.Idx = 0
	return a.listModelsCmd()
}

// recomputeCompletion inspects the current textarea value and shows/hides
// the autocomplete popup. Called after every keystroke that touches the
// input, so the popup tracks the prefix without an explicit "open" key.
//
// Rules:
//   - Input must start with `/` (slash commands only — the popup is for
//     commands, not general history).
//   - The popup hides on any non-`/` leading content and reappears on `/`.
//   - When the prefix narrows the matches to exactly one, the popup stays
//     open but the user can just press Enter to accept (Tab still cycles,
//     harmless when there's nothing to cycle).
//   - When no command matches the prefix, the popup hides — typing `/zzz`
//     shouldn't keep a stale empty list on screen.
func (a *App) recomputeCompletion() {
	v := a.Input.Value()
	if !strings.HasPrefix(v, "/") {
		a.Completion.Show = false
		a.Completion.List = nil
		a.Completion.Idx = 0
		return
	}
	list := computeCompletions(v)
	if len(list) == 0 {
		a.Completion.Show = false
		a.Completion.List = nil
		a.Completion.Idx = 0
		return
	}
	// First keystroke after the popup opens (e.g. user types `/` then a
	// letter that matches multiple): reset highlight so the first match
	// is preselected rather than whatever was highlighted before.
	if !a.Completion.Show || a.Completion.Idx >= len(list) {
		a.Completion.Idx = 0
	}
	a.Completion.Show = true
	a.Completion.List = list
}

// acceptCompletion replaces the textarea contents with the highlighted
// completion's `Insert` string (which may differ from `Text` for commands
// like `/model <id>` where the placeholder must survive the insert so the
// user can type the model id). Hides the popup.
func (a *App) acceptCompletion() {
	if !a.Completion.Show || len(a.Completion.List) == 0 {
		return
	}
	sel := a.Completion.List[a.Completion.Idx]
	a.Input.SetValue(sel.Insert)
	a.Input.CursorEnd()
	a.Completion.Show = false
	a.Completion.List = nil
	a.Completion.Idx = 0
}

func (a *App) listModelsCmd() tea.Cmd {
	return func() tea.Msg {
		ids, active, err := api.ListModels(a.BaseURL, a.Token)
		return ModelListMsg{IDs: ids, Active: active, Err: err}
	}
}

func (a *App) switchModelCmd(id string) tea.Cmd {
	return func() tea.Msg {
		active, err := api.SetModel(a.BaseURL, a.Token, id)
		return ModelSwitchMsg{Active: active, Err: err}
	}
}

func (a *App) startStream(content string) tea.Cmd {
	return func() tea.Msg {
		chunks := make(chan api.Chunk, 100)
		done := make(chan error, 1)
		go api.StreamChat(a.BaseURL, a.Token, content, "chat", chunks, done)
		for {
			select {
			case chunk, ok := <-chunks:
				if !ok {
					return nil
				}
				a.Prog.Send(StreamChunkMsg{Chunk: chunk})
			case err, ok := <-done:
				if !ok {
					return nil
				}
				// Drain remaining chunks before signalling done
				// (last SSE line may have both content and finish_reason).
				for {
					select {
					case chunk, ok := <-chunks:
						if !ok {
							break
						}
						a.Prog.Send(StreamChunkMsg{Chunk: chunk})
					default:
						goto sendDone
					}
				}
			sendDone:
				a.Prog.Send(StreamDoneMsg{Err: err})
				return nil
			}
		}
	}
}

// startEventsCmd launches the background /events SSE reader. The goroutine
// runs until the connection drops or the context is cancelled (on shutdown).
// Each event is pushed through Program.Send so Update handles it on the
// single loop thread.
func (a *App) startEventsCmd() tea.Cmd {
	return func() tea.Msg {
		events := make(chan api.RuntimeEvent, 64)
		done := make(chan error, 1)
		go api.StreamEvents(a.BaseURL, a.Token, events, done)
		for {
			select {
			case ev, ok := <-events:
				if !ok {
					return nil
				}
				a.Prog.Send(RuntimeEventMsg{Event: ev})
			case <-done:
				return nil
			}
		}
	}
}

func (a *App) handleStreamChunk(chunk api.Chunk) {
	switch {
	case chunk.AskUser != nil:
		a.PendingAsk = chunk.AskUser
		a.pushAssistantText("\n" + renderAskQuestions(chunk.AskUser.Questions) + "\n")
		a.streamHasContent = true
		a.needsRebuild = true
	case chunk.AskUserCancelled != "":
		if a.PendingAsk != nil && a.PendingAsk.ID == chunk.AskUserCancelled {
			a.PendingAsk = nil
			a.setFlash("question expired — continuing with the default")
		}
	case chunk.ToolStart.ID != "":
		a.pushToolStart(chunk.ToolStart)
		a.streamHasContent = true
		if a.State == StateThinking {
			a.State = StateStreaming
		}
	case chunk.ToolDone.ID != "":
		a.finishToolCall(chunk.ToolDone)
	case chunk.ToolProgress.ID != "":
		a.noteToolProgress(chunk.ToolProgress)
	case chunk.Error != "":
		a.pushAssistantError(chunk.Error)
	case chunk.Reasoning != "":
		if !a.streamHasContent && a.State == StateStreaming {
			a.State = StateThinking
		}
		a.pushAssistantReasoning(chunk.Reasoning)
	case chunk.Content != "":
		a.streamHasContent = true
		if a.State == StateThinking {
			a.State = StateStreaming
		}
		a.pushAssistantText(chunk.Content)
		a.LastTokenAt = time.Now()
	}
	// The host emits cumulative `prompt_tokens` / `completion_tokens` in
	// `usage` events — we just keep the latest so the footer shows
	// authoritative numbers rather than our running estimate.
	if chunk.Prompt > 0 {
		a.StreamPromptTokens = chunk.Prompt
	}
	if chunk.Completion > 0 {
		a.StreamCompletionTokens = chunk.Completion
	}
}

// renderAskQuestions formats an ask_user question block for the transcript.
func renderAskQuestions(questions []api.AskQuestion) string {
	var b strings.Builder
	b.WriteString("❓ I need your input:\n")
	multi := len(questions) > 1
	for i, q := range questions {
		if multi {
			fmt.Fprintf(&b, "%d. %s\n", i+1, q.Question)
		} else {
			b.WriteString(q.Question + "\n")
		}
		for j, o := range q.Options {
			star := ""
			if o.Recommended {
				star = " ⭐"
			}
			desc := ""
			if o.Description != "" {
				desc = " — " + o.Description
			}
			fmt.Fprintf(&b, "  %d) %s%s%s\n", j+1, o.Label, star, desc)
		}
	}
	if multi {
		b.WriteString(`Reply with one option number per question, comma-separated (e.g. "1, 2") — or just type your answer.`)
	} else {
		b.WriteString("Reply with the option number, or just type your answer.")
	}
	return b.String()
}

// answerAskCmd resolves a pending ask_user question over the gateway. The
// agent turn resumes on its original SSE stream, so there is nothing to
// re-subscribe here — a failure is surfaced as a flash.
func (a *App) answerAskCmd(req *api.AskUserRequest, reply string) tea.Cmd {
	baseURL, token := a.BaseURL, a.Token
	answers := api.ParseAskReply(req.Questions, reply)
	id := req.ID
	return func() tea.Msg {
		if err := api.AskRespond(baseURL, token, id, answers); err != nil {
			return FlashMsg{Text: "answer failed: " + err.Error()}
		}
		return nil
	}
}

// needsConfirmation reports whether a tool call should pause for user
// approval before executing (spec §8). The sidecar will eventually own
// this decision; for now the TUI uses name-based heuristics.
func needsConfirmation(name string) bool {
	switch name {
	case "shell_exec", "write_file", "delete_file", "batch", "execute",
		"bash", "powershell", "cmd", "sudo":
		return true
	}
	return false
}

// pushToolStart appends a new running ToolCall to the trailing assistant
// turn. If no assistant turn exists yet (race before beginAssistant), we
// drop the call — the host only emits tool_start after the agent loop has
// already started, so in practice one is always present.
//
// For confirmation-gated tools (§8) the app enters StateWaiting and stores
// the tool ID so the user can approve (y) or decline (n) before the tool
// proceeds. The prior state is saved for restoration on approval.
func (a *App) pushToolStart(ts api.ToolStart) {
	t := a.lastAssistantTurn()
	if t == nil {
		return
	}
	tc := ToolCall{
		ID:        ts.ID,
		Name:      ts.Name,
		Main:      mainArgFromArgs(ts.Args),
		Status:    ToolRunning,
		StartedAt: time.Now(),
	}
	if needsConfirmation(ts.Name) && a.State == StateStreaming {
		a.PriorState = a.State
		a.State = StateWaiting
		a.ApprovalToolID = ts.ID
	}
	t.Tools = append(t.Tools, tc)
	t.markDirty()
}

// finishToolCall flips a running tool pill to its terminal state (done or
// error) and records any result preview / error message.
func (a *App) finishToolCall(td api.ToolDone) {
	for i := len(a.Turns) - 1; i >= 0; i-- {
		t := &a.Turns[i]
		if t.Role != RoleAssistant {
			continue
		}
		for j := range t.Tools {
			if t.Tools[j].ID == td.ID {
				t.Tools[j].EndedAt = time.Now()
				if td.OK {
					t.Tools[j].Status = ToolDone
				} else {
					t.Tools[j].Status = ToolError
					t.Tools[j].ErrMsg = td.Error
				}
				if len(td.Result) > 0 {
					t.Tools[j].Preview = truncateRunes(string(td.Result), 80)
				}
				t.markDirty()
				return
			}
		}
		break
	}
}

// noteToolProgress updates the live progress note on a running tool
// (e.g. "retry 2/3"). The note renders indented under the pill on the
// transcript.
func (a *App) noteToolProgress(tp api.ToolProgress) {
	for i := len(a.Turns) - 1; i >= 0; i-- {
		t := &a.Turns[i]
		if t.Role != RoleAssistant {
			continue
		}
		for j := range t.Tools {
			if t.Tools[j].ID == tp.ID {
				t.Tools[j].Note = tp.Message
				t.markDirty()
				return
			}
		}
		break
	}
}

// mainArgFromArgs extracts a one-line preview from the raw tool args
// object. Tools tend to have one "obvious" argument (path, query,
// command) that tells the user what's being called; we look for a few
// well-known keys first and fall back to the JSON serialisation
// truncated to 40 runes.
func mainArgFromArgs(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return truncateRunes(string(raw), 40)
	}
	for _, k := range []string{"path", "file_path", "query", "command", "cmd", "url", "pattern", "input"} {
		if v, ok := m[k]; ok {
			s := jsonStrFromRaw(v)
			if s != "" {
				return truncateRunes(s, 50)
			}
		}
	}
	return truncateRunes(string(raw), 40)
}

func jsonStrFromRaw(b json.RawMessage) string {
	if len(b) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return ""
	}
	return s
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max < 1 {
		return ""
	}
	return string(runes[:max-1]) + "…"
}

func (a *App) pushAssistantText(piece string) {
	a.pendingText.WriteString(piece)
}

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
		if text != "" || reasoning != "" {
			t.markDirty()
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

// immediateFrameTick sends one FrameTickMsg right away so the streaming
// view renders at least once before any error chunks arrive. Without this,
// a fast-failing stream (e.g. sidecar down) transitions StateStreaming →
// StateError before the first 33ms frame tick, leaving the user with zero
// visual feedback.
func immediateFrameTick() tea.Cmd {
	return func() tea.Msg {
		return FrameTickMsg(time.Now())
	}
}

// pushAssistantError appends an ErrorCard to the trailing assistant turn.
// Falls back silently if there's no active assistant turn (the only
// realistic scenario: an error fires before the model emits any token —
// the host reported the failure synchronously). Such errors land in the
// flash banner instead, see caller.
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
		t.markDirty()
		return
	}
}

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

// inferErrorKind classifies an error message into one of the colour
// buckets the renderer uses. Substring match is plenty — the host sends
// a handful of stable messages (timeout / permission / network) and the
// renderer doesn't need exact equality. Returns ("timeout", "Try …") etc.
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

func (a *App) pushAssistantReasoning(piece string) {
	a.pendingReasoning.WriteString(piece)
}

func (a *App) toggleThinking() {
	for i := range a.Turns {
		t := &a.Turns[len(a.Turns)-1-i]
		if t.Role == RoleAssistant && t.Reasoning != "" {
			t.ThinkingOpen = !t.ThinkingOpen
			t.markDirty()
			return
		}
	}
}

func (a *App) setFlash(text string) {
	a.FlashText = text
	a.FlashUntil = time.Now().Add(5 * time.Second)
}

// WizardTestItResult is sent by startWizardHealthCheck when all health
// checks complete. Response is the full assistant reply text; Err is
// non-nil on any check failure. The handler advances the wizard to
// WizFinish on success. Timing fields are set for the benchmark display
// on the finish screen.
type WizardTestItResult struct {
	Response string
	Err      error

	// F3.1: timing metrics for the connection benchmark.
	HealthLatency time.Duration // wall time for phase 1 (parallel checks)
	StreamLatency time.Duration // wall time for streaming round-trip
	StreamVerified bool         // streaming response matched deterministic token
}

// WizardHealthProgress is an intermediate progress update from the
// F3 multi-step health check. Sent for each check status change so the
// UI shows live progress across all four granular checks.
type WizardHealthProgress struct {
	Checks [4]HealthCheck
}

// WizardCatalogsLoadedMsg (Phase 1, 2026-07-07) is emitted by
// `fetchCatalogsCmd` once both /runtime/providers/catalog and
// /runtime/connectors/catalog have responded (or timed out / errored).
// The handler writes the parsed entries into the wizard cache; the
// renderers then read `WizardState.ProviderCatalog()` / `ConnectorCatalog()`
// which fall back to the bundled slices when the cache is empty.
type WizardCatalogsLoadedMsg struct {
	Providers  []api.ProviderCatalogEntry
	Connectors []api.ConnectorCatalogEntry
	Version    int
	Offline    bool   // true if both fetches failed; renderers surface a small banner
	Drift      bool   // true if the version differs from api.CatalogVersionExpected
}

// ── Setup Wizard (§13) ────────────────────────────────────────

// startWizard begins the Setup Wizard. Called on first launch when no
// config is detected (§2 J2.3) or via the /setup command.
//
// F1 onboarding flow (OpenClaw-style):
//   1. Welcome  (logo, tagline, Enter to continue)
//   2. Security (one-screen disclaimer, y/n)
//   3. Setup mode (QuickStart / Manual / Import)
//   4. Config handling (only if hasExistingConfig: Keep / Review / Reset)
//   5. Hardware probe  → 6. Runtime choice  → 7. Provider
//   8. Test-it  → 9. Finish
//
// beginWizardFlow is the entry point from the F1 pre-flow (WizSetupMode /
// WizConfigHandling) into the heavy steps. It transitions to WizHardware,
// sets the detecting state, and kicks off the hardware probe in a goroutine
// with the same a.Prog != nil guard startWizard uses (so tests can exercise
// the flow without a real program).
func (a *App) beginWizardFlow() {
	a.Wizard.Step = WizHardware
	a.Wizard.lastCompleted = WizSetupMode
	a.State = StateDetectingHardware
	cmd := a.startWizardHardwareProbe()
	if a.Prog != nil {
		go func() { a.Prog.Send(cmd()) }()
	}
}

func (a *App) startWizard() {
	a.Wizard = WizardState{
		Show:              true,
		Step:              WizWelcome,
		Choice:            WizChoiceLocal,
		SetupMode:         SetupQuickStart,
		SetupModeIdx:      0,
		ConfigHandlingIdx: 0,
		HasExistingConfig: hasExistingConfig(),
		Tagline:           ui.RandomTagline(),
		PreflightNotes:    preflightNotices(),
		// P1: Welcome (with mode select) → Engine (Hardware). The path
		// branches into the local/cloud work screen only once the user
		// picks a runtime on the Engine screen (pruneAtEngine).
		Path:              wizardBasePath(),
		PathIndex:         0,
		StepHistory:       nil,
	}
	// Phase 1 (2026-07-07): fire the catalog fetch in parallel with the
	// synchronous setup steps. The catalog populates `a.Wizard.providerCatalog`
	// / `connectorCatalog` via a `WizardCatalogsLoadedMsg` once both
	// /runtime/{providers,connectors}/catalog have returned.
	if a.Prog != nil {
		go func() {
			a.Prog.Send(a.fetchCatalogsCmd())
		}()
	}
	// ONB-002: set default model for local path so the download can start
	// without a model picker step (matches frontend recommended model).
	a.Wizard.ModelID = "bartowski/Qwen_Qwen3.5-9B-GGUF"
	a.Wizard.ModelSize = "~5.5 GB"
	// F2 / spec §PARTIAL PROGRESS PERSISTENCE: detect partial state
	// (user exited mid-onboarding) and offer Resume / Start Over.
	// Partial = progress file exists, wizard-done marker does NOT.
	// Distinct from hasExistingConfig (prior run completed).
	if saved, savedMode, savedChoice, partial := hasPartialProgress(); partial {
		a.Wizard.SetupMode = savedMode
		a.Wizard.Choice = savedChoice
		a.Wizard.Step = WizResume
		a.Wizard.ResumeStep = saved
		a.Wizard.ResumeIdx = 0
		// No probe / no welcome — the user picks Resume or Start Over first.
		return
	}
}

// resumeWizardAt rebuilds the branched path from persisted state and jumps
// to the correct in-path step (P0.4), then kicks off whatever async work
// that step needs (hardware probe / health checks). Never lands on a step
// outside the reconstructed path.
func (a *App) resumeWizardAt(saved WizardStep, mode SetupMode, choice WizardChoice) {
	w := &a.Wizard
	w.SetupMode = mode
	w.Choice = choice
	step, path := resumeStepFor(saved, choice)
	w.Path = path
	w.lastCompleted = saved
	w.Step = step
	for i, s := range path {
		if s == step {
			w.PathIndex = i
			break
		}
	}
	switch {
	case w.Step == WizTestIt:
		w.TestItRunning = true
		for i := range w.HealthChecks {
			w.HealthChecks[i] = HealthCheck{Kind: HealthCheckKind(i), Status: CheckPending}
		}
		if a.Prog != nil {
			cmd := a.startWizardHealthCheck()
			go func() { a.Prog.Send(cmd()) }()
		}
	case w.Step == WizHardware:
		a.State = StateDetectingHardware
		if a.Prog != nil {
			cmd := a.startWizardHardwareProbe()
			go func() { a.Prog.Send(cmd()) }()
		}
	}
}

// enterEngine advances from Welcome (screen 1) to the Engine screen
// (screen 2), stamping progress and kicking off the hardware probe.
func (a *App) enterEngine() tea.Cmd {
	w := &a.Wizard
	w.pushStepHistory()
	w.Step = WizHardware
	w.PathIndex = 1
	w.lastCompleted = WizWelcome
	saveWizardProgress(WizWelcome, w.SetupMode, w.Choice)
	a.State = StateDetectingHardware
	return a.startWizardHardwareProbe()
}

// wizardAsyncInFlight reports whether an async wizard op is running (probe,
// key validation, or health checks — all set StateDetectingHardware or
// TestItRunning; or an in-progress download). The first Esc cancels it and
// stays on the step rather than exiting the wizard (P0.3).
func (a *App) wizardAsyncInFlight() bool {
	w := &a.Wizard
	if w.TestItRunning {
		return true
	}
	if a.State == StateDetectingHardware {
		return true
	}
	if w.Step == WizLocalDownload && w.DownloadID != "" && w.DownloadErr == nil && w.Progress < 1 {
		return true
	}
	return false
}

// cancelWizardAsync marks the in-flight op cancelled and leaves a
// "cancelled — Enter to retry" affordance on the step. The op's message,
// if it still lands, is harmless: the renderer keys off these fields.
func (a *App) cancelWizardAsync() {
	w := &a.Wizard
	switch {
	case w.TestItRunning:
		w.TestItRunning = false
		w.TestItError = "cancelled — press r to retry"
	case a.State == StateDetectingHardware && w.Step == WizHardware:
		a.State = StateReady
		w.HardwareProbeErr = fmt.Errorf("cancelled — press Enter to retry")
	case a.State == StateDetectingHardware && w.Step == WizCloudKey:
		a.State = StateReady
		w.KeyValid = false
		w.KeyValidMsg = "cancelled — press Enter to retry"
	case w.Step == WizLocalDownload:
		w.DownloadErr = fmt.Errorf("cancelled — press r to retry")
	default:
		a.State = StateReady
	}
}

// startWizardHardwareProbe begins the W1 hardware scan. Sprint 2 / audit
// C-1 — this used to hard-code "rtx 4070 · 12 GB" — now it actually calls
// the gateway `/system_info` endpoint and surfaces the real GPU/VRAM/RAM.
// Returns a tea.Cmd that emits a HardwareProbeMsg; the wizard advances to
// WizModelChoice on success or shows a Retry CTA on failure.

// fetchCatalogsCmd fires GET /runtime/providers/catalog and
// GET /runtime/connectors/catalog against the gateway and emits a
// WizardCatalogsLoadedMsg with the parsed entries (or, on failure, an
// Offline=true so renderers can fall back to the bundled slices).
// Phase 1 (2026-07-07): replaces the prior "Go source is the catalog"
// model — see `byok::provider_catalog` for the canonical Rust side.
func (a *App) fetchCatalogsCmd() tea.Cmd {
	url, token := a.BaseURL, a.Token
	return func() tea.Msg {
		providersRes, perr := api.FetchProviderCatalog(url, token)
		connectorsRes, cerr := api.FetchConnectorCatalog(url, token)

		msg := WizardCatalogsLoadedMsg{}

		if providersRes != nil && providersRes.OK {
			var parsed []api.ProviderCatalogEntry
			if jerr := json.Unmarshal(providersRes.Body, &parsed); jerr == nil {
				msg.Providers = parsed
				msg.Version = providersRes.Version
				msg.Drift = !providersRes.VersionMatchesExpected
			}
		}
		if connectorsRes != nil && connectorsRes.OK {
			var parsed []api.ConnectorCatalogEntry
			if jerr := json.Unmarshal(connectorsRes.Body, &parsed); jerr == nil {
				msg.Connectors = parsed
				if msg.Version == 0 {
					msg.Version = connectorsRes.Version
				}
				if !connectorsRes.VersionMatchesExpected {
					msg.Drift = true
				}
			}
		}
		if (providersRes == nil || !providersRes.OK) && (connectorsRes == nil || !connectorsRes.OK) {
			msg.Offline = true
		}
		// Quietly drop per-endpoint errors — the Offline flag covers the
		// "no usable data" case; per-endpoint partial success keeps the
		// version-pin behaviour intact without spamming the user.
		_ = perr
		_ = cerr
		return msg
	}
}
func (a *App) startWizardHardwareProbe() tea.Cmd {
	url, token := a.BaseURL, a.Token
	return func() tea.Msg {
		info, err := api.FetchSystemInfo(url, token)
		return HardwareProbeMsg{Info: info, Err: err}
	}
}

// startWizardProviderTest runs the W3b provider key check. Sprint 2 /
// audit C-2: the previous implementation set `w.KeyValid = true` on any
// non-empty string; this calls `/providers/test` and surfaces the real
// provider response. Returns a tea.Cmd that emits a ProvidersTestMsg.
func (a *App) startWizardProviderTest(providerID, apiKey string) tea.Cmd {
	url, token := a.BaseURL, a.Token
	return func() tea.Msg {
		msg, err := api.TestProviderKey(url, token, providerID, apiKey, "")
		if err != nil {
			return ProvidersTestMsg{Success: false, Err: err, Msg: err.Error()}
		}
		return ProvidersTestMsg{Success: true, Msg: msg}
	}
}

// saveCloudProvider persists the validated cloud provider to the OS
// keychain (via POST /runtime/byok/save) and switches the runtime model so
// the next chat request goes to the cloud endpoint (ONB-004 +
// Phase 0b 2026-07-07).
//
// Pre-Phase-0b this function wrote only non-secret metadata to
// ~/.feral/byok.json and relied on a non-existent code path to put the
// key into the keychain — first-time cloud users saw "✓ Connection
// successful", finished the wizard, and on the next launch got "No API
// key configured" because the key never persisted. The single
// `/runtime/byok/save` call replaces that with one atomic write that
// either succeeds in full (keychain + metadata) or surfaces a typed
// failure so the wizard can render the right next-step.
func (a *App) saveCloudProvider() error {
	w := &a.Wizard
	if w.Provider == "" {
		return fmt.Errorf("no provider selected")
	}
	// Find the provider's default model from the curated list.
	var defaultModel string
	for _, p := range CloudProviders {
		if p.ID == w.Provider {
			defaultModel = p.DefaultModel
			break
		}
	}
	if defaultModel == "" {
		defaultModel = w.ModelID
	}
	if w.APIKey == "" {
		// Defensive: a successful Validate pass already guarantees a
		// non-empty key, but a corrupt state in a resumed wizard could
		// land us here. The gateway would reject an empty key server-side
		// anyway; rejecting here keeps the failure local.
		return fmt.Errorf("API key is empty — re-enter it before saving")
	}

	// Resolve the provider's optional base URL. The curated list sets
	// BaseURL == "" to mean "use the gateway's default for this
	// provider"; a non-empty value means a custom URL the user picked in
	// an earlier wizard step (F4 Track Custom URL is in scope of the
	// connector-side slice, not Phase 0b). We forward both shapes — the
	// gateway treats absent == "" == default.
	var baseURL string
	for _, p := range CloudProviders {
		if p.ID == w.Provider {
			baseURL = p.BaseURL
			break
		}
	}

	// Persist keychain + metadata in one atomic write.
	baseURLOpt := stringPtr(baseURL)   // empty string → omit (server keeps prior base_url)
	defaultModelOpt := stringPtr(defaultModel)
	res, err := api.SaveByokKey(
		a.BaseURL,
		a.Token,
		w.Provider,
		w.APIKey,
		baseURLOpt,
		defaultModelOpt,
	)
	if err != nil {
		return err
	}
	if res == nil || !res.OK {
		// Prefer the gateway's category + hint; fall back to a generic
		// message if the body didn't parse.
		msg := ""
		if res != nil {
			msg = res.Message
		}
		if msg == "" {
			msg = "Could not save the API key."
		}
		if res != nil && res.Hint != "" {
			return fmt.Errorf("%s — %s", msg, res.Hint)
		}
		return fmt.Errorf("%s", msg)
	}

	// Switch the runtime model to provider:default so the gateway routes
	// the next /runtime/chat to the cloud endpoint.
	_, err = api.SetModel(a.BaseURL, a.Token, w.Provider+":"+defaultModel)
	return err
}

// stringPtr returns a pointer to the supplied string, or nil if the
// string is empty (so the JSON serialiser omits the field, and the
// gateway's `Option<String>` deserialiser treats it as "leave
// unchanged").
func stringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// startWizardDownload kicks off the W3a model download (audit C-5).
// Returns a tea.Cmd that POSTs `/runtime/models/install`; the next step
// (pollDownload) polls `/runtime/models/download/:id` for progress.
//
// On the dev box the install endpoint may not exist yet (depends on the
// gateway build), so a clean error from InstallModel is surfaced to the
// wizard via a DownloadModelMsg with `Err` set — the user sees a Retry
// CTA instead of an infinite spinner.
func (a *App) startWizardDownload(repoID, filename string) tea.Cmd {
	url, token := a.BaseURL, a.Token
	return func() tea.Msg {
		id, err := api.InstallModel(url, token, repoID, filename)
		if err != nil {
			return DownloadModelMsg{Err: err}
		}
		return DownloadStartedMsg{ID: id}
	}
}

// DownloadStartedMsg is the internal handshake between the install POST
// and the first progress poll. We split it from DownloadModelMsg so the
// wizard can stash the id in WizardState and the renderer can show
// "starting…" before the first poll lands.
type DownloadStartedMsg struct {
	ID string
}

// pollDownload fetches the next progress snapshot for the active download.
// Repeated by the wizard's poll loop (the wizard calls this every time
// the previous DownloadModelMsg was a transient error or a "downloading"
// status).
func (a *App) pollDownload() tea.Cmd {
	id := a.Wizard.DownloadID
	if id == "" {
		return nil
	}
	url, token := a.BaseURL, a.Token
	return func() tea.Msg {
		dl, err := api.DownloadModel(url, token, id)
		// Sleep 500ms before returning so the wizard's progress bar
		// visibly moves on small downloads. The user-facing latency
		// is acceptable; the gateway work is bounded by the actual
		// download rate.
		time.Sleep(500 * time.Millisecond)
		return DownloadModelMsg{Download: dl, Err: err}
	}
}

// startWizardHealthCheck runs the F3 multi-step health check pipeline
// in two phases:
//
//   Phase 1 (parallel): API reachable + auth valid + model accessible —
//   all three run concurrently so the user perceives lower latency.
//
//   Phase 2 (sequential): deterministic streaming round-trip. Sends
//   "Return exactly: FERAL_OK" and verifies the response contains the
//   expected token (StreamVerified).
//
// Sends WizardHealthProgress for each check status change and returns a
// WizardTestItResult when all checks complete or any check fails.
func (a *App) startWizardHealthCheck() tea.Cmd {
	url, token := a.BaseURL, a.Token
	provider := a.Wizard.Provider
	apiKey := a.Wizard.APIKey
	choice := a.Wizard.Choice
	return func() tea.Msg {
		var checks [4]HealthCheck
		for i := range checks {
			checks[i] = HealthCheck{Kind: HealthCheckKind(i), Status: CheckPending}
		}

		sendProgress := func() {
			a.Prog.Send(WizardHealthProgress{Checks: checks})
		}

		// ── Phase 1: Parallel — API reachable, auth valid, model accessible ──
		healthStart := time.Now()
		checks[0].Status = CheckRunning
		checks[1].Status = CheckRunning
		checks[2].Status = CheckRunning
		sendProgress()

		type phase1Result struct {
			idx int
			ok  bool
			msg string
			err error
		}
		resultCh := make(chan phase1Result, 3)

		// Check 1: API reachable
		go func() {
			status, err := api.FetchStatus(url, token)
			if err != nil {
				resultCh <- phase1Result{0, false, err.Error(), err}
				return
			}
			if !status.Online {
				resultCh <- phase1Result{0, false, "gateway offline", fmt.Errorf("gateway offline")}
				return
			}
			resultCh <- phase1Result{0, true, "gateway online", nil}
		}()

		// Check 2: Auth valid (cloud only)
		go func() {
			if choice != WizChoiceCloud {
				resultCh <- phase1Result{1, true, "local mode", nil}
				return
			}
			msg, err := api.TestProviderKey(url, token, provider, apiKey, "")
			if err != nil {
				resultCh <- phase1Result{1, false, err.Error(), err}
				return
			}
			resultCh <- phase1Result{1, true, msg, nil}
		}()

		// Check 3: Model accessible
		go func() {
			ids, _, err := api.ListModels(url, token)
			if err != nil {
				resultCh <- phase1Result{2, false, err.Error(), err}
				return
			}
			if len(ids) == 0 {
				resultCh <- phase1Result{2, false, "no models available", fmt.Errorf("no models available")}
				return
			}
			resultCh <- phase1Result{2, true, fmt.Sprintf("%d model(s) available", len(ids)), nil}
		}()

		// Collect phase-1 results as they arrive — each one updates the UI
		// immediately so the user sees checks completing progressively.
		var phase1Err error
		for i := 0; i < 3; i++ {
			r := <-resultCh
			if r.ok {
				checks[r.idx].Status = CheckPassed
				checks[r.idx].Message = r.msg
			} else {
				checks[r.idx].Status = CheckFailed
				checks[r.idx].Message = r.msg
				if phase1Err == nil {
					phase1Err = r.err
				}
			}
			sendProgress()
		}
		healthLatency := time.Since(healthStart)

		// Short-circuit on any phase-1 failure.
		if phase1Err != nil {
			return WizardTestItResult{
				Err:           phase1Err,
				HealthLatency: healthLatency,
			}
		}

		// ── Phase 2: Streaming — "Return exactly: FERAL_OK" ──
		streamStart := time.Now()
		checks[3].Status = CheckRunning
		sendProgress()

		chunks := make(chan api.Chunk, 100)
		done := make(chan error, 1)
		go api.StreamChat(url, token, "Return exactly: FERAL_OK", "test-it", chunks, done)

		var resp strings.Builder
		timeout := time.After(60 * time.Second)
	streamLoop:
		for {
			select {
			case chunk, ok := <-chunks:
				if !ok {
					break streamLoop
				}
				if chunk.Error != "" {
					checks[3].Status = CheckFailed
					checks[3].Message = chunk.Error
					sendProgress()
					return WizardTestItResult{
						Response:      resp.String(),
						Err:           fmt.Errorf("stream error: %s", chunk.Error),
						HealthLatency: healthLatency,
						StreamLatency: time.Since(streamStart),
					}
				}
				resp.WriteString(chunk.Content)
			case err, ok := <-done:
				if !ok {
					break streamLoop
				}
				if err != nil {
					checks[3].Status = CheckFailed
					checks[3].Message = err.Error()
					sendProgress()
					return WizardTestItResult{
						Response:      resp.String(),
						Err:           err,
						HealthLatency: healthLatency,
						StreamLatency: time.Since(streamStart),
					}
				}
				break streamLoop
			case <-timeout:
				checks[3].Status = CheckFailed
				checks[3].Message = "timed out after 60s"
				sendProgress()
				return WizardTestItResult{
					Err:           fmt.Errorf("test timed out after 60s"),
					HealthLatency: healthLatency,
					StreamLatency: time.Since(streamStart),
				}
			}
		}

		streamLatency := time.Since(streamStart)
		s := resp.String()
		if s == "" {
			checks[3].Status = CheckFailed
			checks[3].Message = "empty response"
			sendProgress()
			return WizardTestItResult{
				Err:           fmt.Errorf("empty response from model"),
				HealthLatency: healthLatency,
				StreamLatency: streamLatency,
			}
		}

		// Deterministic verification: does the response contain FERAL_OK?
		verified := strings.Contains(strings.ToUpper(s), "FERAL_OK")
		checks[3].Status = CheckPassed
		if verified {
			checks[3].Message = fmt.Sprintf("responds %s FERAL_OK", ui.G.OK)
		} else {
			checks[3].Message = "responds (unexpected)"
		}
		sendProgress()

		return WizardTestItResult{
			Response:       s,
			HealthLatency:  healthLatency,
			StreamLatency:  streamLatency,
			StreamVerified: verified,
		}
	}
}

// wizardHandleKey processes key events while the wizard is showing.
// Returns the tea.Cmd to dispatch (usually nil) — the caller in Update
// already calls a.rebuildViewport on every wizard keypress so we keep the
// return type as tea.Cmd so wizard steps can trigger async work (e.g.
// retrying the hardware probe from the W1 screen).
func (a *App) wizardHandleKey(key tea.KeyMsg) tea.Cmd {
	if !a.Wizard.Show {
		return nil
	}
	w := &a.Wizard

	// ── P0.3: one back-navigation system ──────────────────────────
	// Esc is the single Escape handler, in priority order:
	//   1. provider search with a live query → clear the query (only)
	//   2. an async op in flight (probe / key validation / health check /
	//      download) → cancel it and STAY on the step, never exit
	//   3. Welcome → exit the wizard
	//   4. otherwise → previous path step
	if key.Type == tea.KeyEscape {
		if w.Step == WizCloudProvider && w.SearchQuery != "" {
			w.SearchQuery = ""
			w.ProviderIdx = 0
			a.rebuildViewport()
			return nil
		}
		if a.wizardAsyncInFlight() {
			a.cancelWizardAsync()
			a.rebuildViewport()
			return nil
		}
		if w.Step == WizWelcome {
			a.Wizard.Show = false
			a.State = StateReady
			return nil
		}
		if w.Step == WizResume {
			// Esc on the resume prompt = Start Over (less destructive than
			// re-running checks the user already passed).
			clearWizardProgress()
			w.Step = WizWelcome
			w.lastCompleted = WizWelcome
			a.rebuildViewport()
			return nil
		}
		if prev := prevPathStep(w); prev != 0 {
			w.Step = prev
			w.PathIndex--
			a.rebuildViewport()
			return nil
		}
		return nil
	}
	// Backspace-as-back only when the step has no active text buffer.
	// The text steps (CloudKey; CloudProvider while a query is being typed)
	// consume Backspace for editing — handled inside their cases.
	if key.Type == tea.KeyBackspace {
		textStep := w.Step == WizCloudKey ||
			(w.Step == WizCloudProvider && w.SearchQuery != "") ||
			(w.Step == WizCloudKey && w.custom())
		if !textStep && len(w.StepHistory) > 0 {
			if prev := prevPathStep(w); prev != 0 {
				w.Step = prev
				w.PathIndex--
				a.rebuildViewport()
				return nil
			}
		}
	}

	switch w.Step {
	case WizWelcome:
		// P1 screen 1: Welcome + mode select. Options: Quick start (0),
		// Custom setup (1), and — only when prior state exists — Use
		// existing config (2). `r` starts a destructive reset behind a
		// y/N confirm.
		n := welcomeOptionCount(w)
		if w.ResetPending {
			// Confirming a wipe of ~/.feral.
			if key.Type == tea.KeyRunes && len(key.Runes) == 1 &&
				(key.Runes[0] == 'y' || key.Runes[0] == 'Y') {
				wipeFeralHome()
				a.Wizard = WizardState{}
				a.startWizard()
				a.rebuildViewport()
				return nil
			}
			w.ResetPending = false
			a.rebuildViewport()
			return nil
		}
		switch key.Type {
		case tea.KeyEnter:
			switch w.SetupModeIdx {
			case 0:
				w.SetupMode = SetupQuickStart
				return a.enterEngine()
			case 1:
				w.SetupMode = SetupManual
				return a.enterEngine()
			case 2:
				// Use existing config — close the wizard, keep config as-is.
				a.Wizard.Show = false
				a.State = StateReady
			}
		case tea.KeyUp:
			if w.SetupModeIdx > 0 {
				w.SetupModeIdx--
			}
		case tea.KeyDown:
			if w.SetupModeIdx < n-1 {
				w.SetupModeIdx++
			}
		case tea.KeyRunes:
			if len(key.Runes) == 1 {
				switch key.Runes[0] {
				case '1':
					w.SetupModeIdx = 0
				case '2':
					w.SetupModeIdx = 1
				case '3':
					if n > 2 {
						w.SetupModeIdx = 2
					}
				case 'j', 'J':
					if w.SetupModeIdx < n-1 {
						w.SetupModeIdx++
					}
				case 'k', 'K':
					if w.SetupModeIdx > 0 {
						w.SetupModeIdx--
					}
				case 'r', 'R':
					if w.HasExistingConfig {
						w.ResetPending = true
					}
				case 'q', 'Q':
					a.Wizard.Show = false
					a.State = StateReady
				}
			}
		}
		return nil
	case WizHardware:
		// P1 screen 2: Engine. The probe result shows here; the user picks
		// Local or Cloud and Enter branches the path (and, for Local, kicks
		// off the download). While the probe is in flight, Enter waits.
		if w.HardwareProbeErr != nil {
			if key.Type == tea.KeyEnter ||
				(key.Type == tea.KeyRunes && len(key.Runes) == 1 && (key.Runes[0] == 'r' || key.Runes[0] == 'R')) {
				a.State = StateDetectingHardware
				a.rebuildViewport()
				return a.startWizardHardwareProbe()
			}
			return nil
		}
		if a.State == StateDetectingHardware {
			return nil // probe in flight; wait
		}
		switch key.Type {
		case tea.KeyEnter:
			w.pushStepHistory()
			w.Path = wizardPathFor(w.Choice)
			for i, s := range w.Path {
				if s == WizHardware {
					w.PathIndex = i
					break
				}
			}
			w.Step = nextPathStep(w)
			w.lastCompleted = WizHardware
			saveWizardProgress(WizHardware, w.SetupMode, w.Choice)
			if w.Choice == WizChoiceLocal && w.ModelID != "" {
				return a.startWizardDownload(w.ModelID, "")
			}
		case tea.KeyUp:
			if w.Choice > WizChoiceLocal {
				w.Choice--
			}
		case tea.KeyDown:
			if w.Choice < WizChoiceCloud {
				w.Choice++
			}
		case tea.KeyRunes:
			if len(key.Runes) == 1 {
				switch key.Runes[0] {
				case '1':
					w.Choice = WizChoiceLocal
				case '2':
					w.Choice = WizChoiceCloud
				case 'k', 'K':
					if w.Choice > WizChoiceLocal {
						w.Choice--
					}
				case 'j', 'J':
					if w.Choice < WizChoiceCloud {
						w.Choice++
					}
				}
			}
		}
		return nil
	case WizResume:
		// F2 / spec §PARTIAL PROGRESS PERSISTENCE: the user exited
		// mid-onboarding. Offer Resume (jump to saved step) or
		// Start Over (clear progress and re-run from WizWelcome).
		switch key.Type {
		case tea.KeyEnter:
			switch w.ResumeIdx {
			case 0: // Resume — rebuild the branched path and jump in (P0.4).
				a.resumeWizardAt(w.ResumeStep, w.SetupMode, w.Choice)
			case 1: // Start Over
				clearWizardProgress()
				w.ResumeStep = WizWelcome
				w.Step = WizWelcome
				w.lastCompleted = WizWelcome
			}
		case tea.KeyUp, tea.KeyDown:
			if key.Type == tea.KeyDown && w.ResumeIdx < 1 {
				w.ResumeIdx++
			} else if key.Type == tea.KeyUp && w.ResumeIdx > 0 {
				w.ResumeIdx--
			}
		case tea.KeyRunes:
			if len(key.Runes) == 1 {
				switch key.Runes[0] {
				case '1':
					w.ResumeIdx = 0
				case '2':
					w.ResumeIdx = 1
				case 'j', 'J':
					if w.ResumeIdx < 1 {
						w.ResumeIdx++
					}
				case 'k', 'K':
					if w.ResumeIdx > 0 {
						w.ResumeIdx--
					}
				}
			}
		}
		return nil
	case WizLocalDownload:
		// P1 screen 3a — Retry on failure (r/Enter); `s` continues anyway
		// (sets Skipped, P0.9). Successful downloads auto-advance into the
		// health checks via the DownloadModelMsg handler.
		if w.DownloadErr != nil {
			switch key.Type {
			case tea.KeyEnter:
				return a.startWizardDownload(w.ModelID, "")
			case tea.KeyRunes:
				if len(key.Runes) == 1 {
					switch key.Runes[0] {
					case 'r', 'R':
						return a.startWizardDownload(w.ModelID, "")
					case 's', 'S':
						w.TestItSkipped = true
						w.DownloadErr = nil
						w.pushStepHistory()
						w.Step = WizFinish
						w.lastCompleted = WizLocalDownload
						saveWizardProgress(WizLocalDownload, w.SetupMode, w.Choice)
					}
				}
			}
		}
		return nil
	case WizCloudProvider:
		// F2 / spec §SEARCHABLE LISTS: typing filters the provider list
		// incrementally. Up/Down (or j/k) navigates the filtered list;
		// Enter confirms; Backspace deletes from the query; Esc clears
		// the query first, then goes back.
		filtered := FilteredProviders(w.SearchQuery)
		switch key.Type {
		case tea.KeyEnter:
			if len(filtered) > 0 && w.ProviderIdx >= 0 && w.ProviderIdx < len(filtered) {
				w.Provider = filtered[w.ProviderIdx].ID
				w.SearchQuery = ""
				w.ProviderIdx = 0
				// P1 3b: provider chosen → collapse to a line and move focus
				// to the key field (WizCloudKey). Seed the default model; in
				// Custom mode it's editable on the key screen (`m`).
				for _, p := range CloudProviders {
					if p.ID == w.Provider {
						w.ModelID = p.DefaultModel
						break
					}
				}
				w.pushStepHistory()
				w.Step = nextPathStep(w)
				w.lastCompleted = WizCloudProvider
				saveWizardProgress(WizCloudProvider, w.SetupMode, w.Choice)
			}
		case tea.KeyUp:
			if w.ProviderIdx > 0 {
				w.ProviderIdx--
			}
		case tea.KeyDown:
			if w.ProviderIdx < len(filtered)-1 {
				w.ProviderIdx++
			}
		case tea.KeyBackspace:
			if len(w.SearchQuery) > 0 {
				w.SearchQuery = w.SearchQuery[:len(w.SearchQuery)-1]
				w.ProviderIdx = 0
			}
		case tea.KeyRunes:
			r := string(key.Runes)
			switch r {
			case "j", "J":
				if w.ProviderIdx < len(filtered)-1 {
					w.ProviderIdx++
				}
			case "k", "K":
				if w.ProviderIdx > 0 {
					w.ProviderIdx--
				}
			default:
				// Any other rune extends the search query (incremental
				// filter). Esc/Backspace are handled by the global nav.
				w.SearchQuery += r
				w.ProviderIdx = 0
			}
		}
		return nil
	case WizCloudKey:
		// P1 3b: key field. Enter validates the pasted key; `p` (when the
		// field is still empty) goes back to the provider picker; in Custom
		// mode `m` toggles inline editing of the model id.
		switch key.Type {
		case tea.KeyEnter:
			if w.ModelEditing {
				w.ModelEditing = false
				return nil
			}
			if w.APIKey == "" {
				return nil
			}
			// Sprint 2 / audit C-2 — real key validation. Triggers a
			// ProvidersTestMsg; on success the health checks auto-run.
			a.State = StateDetectingHardware
			a.rebuildViewport()
			return a.startWizardProviderTest(w.Provider, w.APIKey)
		case tea.KeyBackspace:
			if w.ModelEditing {
				if len(w.ModelID) > 0 {
					w.ModelID = w.ModelID[:len(w.ModelID)-1]
				}
			} else if len(w.APIKey) > 0 {
				w.APIKey = w.APIKey[:len(w.APIKey)-1]
			}
		case tea.KeyRunes:
			s := string(key.Runes)
			// `p` / `m` are commands only before the key field has any
			// content (real keys are pasted as multi-rune bursts, so a
			// single 'p'/'m' here is unambiguous).
			if !w.ModelEditing && w.APIKey == "" && s == "p" {
				w.Step = WizCloudProvider
				w.PathIndex--
				return nil
			}
			if !w.ModelEditing && w.APIKey == "" && w.custom() && s == "m" {
				w.ModelEditing = true
				return nil
			}
			if w.ModelEditing {
				w.ModelID += s
			} else {
				w.APIKey += s
			}
		}
		return nil
	case WizTestIt:
		if w.TestItRunning {
			// Checks in flight — Esc is handled by the global async-cancel
			// handler above, so nothing to do here.
			return nil
		}
		// Failure options. `p`/`m` are only offered when the corresponding
		// step is actually in the path (P0.10): the local path must not
		// offer "change provider", and cloud has no local model to change.
		if key.Type == tea.KeyRunes && len(key.Runes) == 1 {
			switch key.Runes[0] {
			case 'r', 'R':
				w.TestItRunning = true
				w.TestItError = ""
				w.TestItResponse = ""
				w.TestItAttempts = 0
				for i := range w.HealthChecks {
					w.HealthChecks[i] = HealthCheck{Kind: HealthCheckKind(i), Status: CheckPending}
				}
				return a.startWizardHealthCheck()
			case 'p', 'P':
				if pathHasStep(w, WizCloudProvider) {
					w.Step = WizCloudProvider
					w.PathIndex = pathIndexOf(w, WizCloudProvider)
					w.TestItAttempts = 0
				}
				return nil
			case 'm', 'M':
				// Change model — only meaningful on the cloud path in Custom
				// mode (edit the model id on the key screen).
				if pathHasStep(w, WizCloudKey) && w.custom() {
					w.Step = WizCloudKey
					w.PathIndex = pathIndexOf(w, WizCloudKey)
					w.ModelEditing = true
					w.APIKey = ""
					w.TestItAttempts = 0
				}
				return nil
			case 's', 'S':
				// Continue anyway — set Skipped (not Succeeded), advance to
				// Ready which renders a ⚠ warning (P0.9).
				w.TestItSkipped = true
				w.TestItError = ""
				w.pushStepHistory()
				w.Step = nextPathStep(w)
				w.lastCompleted = WizTestIt
				saveWizardProgress(WizTestIt, w.SetupMode, w.Choice)
				return nil
			}
		}
		return nil
	case WizFinish:
		switch key.Type {
		case tea.KeyEnter:
			a.finishWizard()
		}
		return nil
	default:
		// WizLocalDownload: auto-advance only.
		return nil
	}
}

// advanceWizardStep returns the next wizard step based on the user's choice.
func advanceWizardStep(c WizardChoice) WizardStep {
	switch c {
	case WizChoiceLocal:
		return WizLocalDownload
	case WizChoiceCloud:
		return WizCloudProvider
	default:
		return WizFinish
	}
}

// finishWizard exits the wizard, writes the wizard-done marker, adds the
// welcome message, and transitions to the normal chat state.
func (a *App) finishWizard() {
	a.Wizard.Show = false
	a.State = StateReady

	// Write wizard-done marker so subsequent launches skip the wizard (§2 J2.3).
	marker, err := wizardDonePath()
	if err == nil {
		os.WriteFile(marker, []byte("done\n"), 0644)
	}
	// Clear the per-step progress file — wizard-done marker replaces it.
	clearWizardProgress()

	// P1 screen 4: pre-fill the composer with the try-this suggestion (do
	// not auto-send). The user can edit or clear it before pressing Enter.
	if a.Input.Value() == "" {
		a.Input.SetValue("summarize the files in this folder")
		a.Input.CursorEnd()
	}

	// First-reply connector discovery tip (P1.1): after the first clean
	// StreamDoneMsg following setup, one event nudges /connectors. Armed here.
	a.connectorTipArmed = true

	a.rebuildViewport()
}

// ── Slash command helpers (§12) ─────────────────────────────────

type doctorCheck struct {
	Name   string
	Detail string
	Ok     bool
}

// runDoctorChecks returns a list of health checks from cached state.
func (a *App) runDoctorChecks() []doctorCheck {
	return []doctorCheck{
		{Name: "gateway", Detail: fmt.Sprintf("port %d", api.DefaultPort), Ok: a.Status.Online},
		{Name: "model", Detail: orStr(a.Status.Model, "none loaded"), Ok: a.Status.Model != ""},
		{Name: "lora", Detail: orStr(a.Status.LoRA, "none"), Ok: a.Status.LoRA != ""},
		{Name: "backend", Detail: a.Status.Backend, Ok: a.Status.Online},
		{Name: "provider", Detail: orStr(a.Status.Provider, "local"), Ok: true},
		{Name: "events", Detail: fmt.Sprintf("%d events seen", len(a.RuntimeEvents)), Ok: true},
	}
}

// appendTranscriptLines adds text lines as a synthetic user turn then an
// assistant turn — they render as transcript content that scrolls normally.
func (a *App) appendTranscriptLines(lines []string) {
	a.Turns = append(a.Turns, Turn{Role: RoleUser, Text: "", turnVer: 1})
	body := strings.Join(lines, "\n")
	a.Turns = append(a.Turns, Turn{Role: RoleAssistant, Text: body, turnVer: 1})
	a.rebuildViewport()
}

func (a *App) handleConnectors(args []string) tea.Cmd {
	if len(args) > 0 && args[0] == "reload" {
		return func() tea.Msg {
			err := api.ReloadConnectors(a.BaseURL, a.Token)
			if err != nil {
				a.Prog.Send(FlashMsg{Text: fmt.Sprintf("connectors reload failed: %v", err)})
			} else {
				a.Prog.Send(FlashMsg{Text: "connectors reloaded"})
			}
			return nil
		}
	}
	if len(args) >= 1 && args[0] == "qr" {
		// Show the current WhatsApp pairing code (fresh read — Baileys
		// rotates it every ~20s and the sidecar rewrites the file each time).
		a.appendTranscriptLines(whatsappQRLines())
		return nil
	}
	if len(args) >= 1 && args[0] == "add" {
		// Task #4: fail-loud credentials. /connectors add <id> <field>=<val>...
		// Rejects unknown ids, ComingSoon connectors (Telegram — no live
		// backend yet), QR connectors (WhatsApp — use the wizard flow),
		// and missing required fields. Saves via api.SaveConnectorConfig
		// then pokes the gateway to reload.
		if len(args) < 2 {
			a.setFlash("usage: /connectors add <id> <field>=<value> …")
			return nil
		}
		id := strings.ToLower(strings.TrimSpace(args[1]))
		def, ok := connectorDefs[id]
		if !ok {
			a.setFlash(fmt.Sprintf("unknown connector %q — supported: discord, slack, telegram, whatsapp", id))
			return nil
		}
		if def.ComingSoon {
			a.setFlash(fmt.Sprintf("%s connector is not available yet — coming soon, no live backend", def.Name))
			return nil
		}
		if def.AuthKind == "qr" || len(def.Fields) == 0 {
			// WhatsApp: no token — enabling starts QR pairing. Enable, poke
			// the gateway, then wait off-thread for the sidecar to drop the
			// QR file and print it into the transcript (the old flash sent
			// users to a wizard flow that no longer exists).
			return func() tea.Msg {
				if whatsappLinked() {
					return TranscriptLinesMsg{Lines: []string{"whatsapp · already linked " + ui.G.OK}}
				}
				if err := api.SaveConnectorConfig(id, map[string]string{}, true); err != nil {
					return FlashMsg{Text: fmt.Sprintf("save failed for %s: %v", id, err)}
				}
				if err := api.ReloadConnectors(a.BaseURL, a.Token); err != nil {
					return FlashMsg{Text: fmt.Sprintf("saved %s, reload failed: %v", id, err)}
				}
				// The sidecar needs a moment to open the socket and get a QR.
				for i := 0; i < 30; i++ {
					if _, _, ok := readWhatsAppQR(); ok {
						return TranscriptLinesMsg{Lines: whatsappQRLines()}
					}
					time.Sleep(time.Second)
				}
				return FlashMsg{Text: "whatsapp: no QR after 30s — check `cinderpaw logs`, then /connectors qr"}
			}
		}
		// Parse key=value pairs from remaining args. A positional fallback
		// accepts plain values in field order (e.g. `add discord mytoken`).
		secrets := make(map[string]string)
		positional := make([]string, 0, len(def.Fields))
		for _, kv := range args[2:] {
			if eq := strings.IndexByte(kv, '='); eq > 0 {
				key := kv[:eq]
				val := kv[eq+1:]
				secrets[key] = val
			} else {
				positional = append(positional, kv)
			}
		}
		for i, f := range def.Fields {
			if _, present := secrets[f.Key]; present {
				continue
			}
			if i < len(positional) {
				secrets[f.Key] = positional[i]
			}
		}
		// Verify every required field got a value.
		var missing []string
		for _, f := range def.Fields {
			if strings.TrimSpace(secrets[f.Key]) == "" {
				missing = append(missing, f.Key)
			}
		}
		if len(missing) > 0 {
			a.setFlash(fmt.Sprintf("%s: missing fields %v — usage: /connectors add %s <field>=<value> …",
				def.Name, missing, id))
			return nil
		}
		// Persist + reload. Run in a goroutine via tea.Cmd so the TUI
		// doesn't block on the HTTP round-trip.
		return func() tea.Msg {
			if err := api.SaveConnectorConfig(id, secrets, true); err != nil {
				return FlashMsg{Text: fmt.Sprintf("save failed for %s: %v", id, err)}
			}
			if err := api.ReloadConnectors(a.BaseURL, a.Token); err != nil {
				return FlashMsg{Text: fmt.Sprintf("saved %s, reload failed: %v", id, err)}
			}
			return FlashMsg{Text: fmt.Sprintf("%s saved — gateway reloaded", def.Name)}
		}
	}
	// Bare /connectors: list the persisted connectors (redacted) from the
	// gateway — same data the desktop Connectors page shows.
	return func() tea.Msg {
		views, err := api.FetchConnectors(a.BaseURL, a.Token)
		if err != nil {
			return FlashMsg{Text: fmt.Sprintf("connectors: %v", err)}
		}
		lines := []string{"connectors"}
		for _, v := range views {
			mark, state := ui.G.Off, "disabled"
			if v.Enabled {
				mark, state = ui.G.On, "enabled"
			}
			detail := state
			if len(v.Filled) > 0 {
				detail += " · " + strings.Join(v.Filled, ", ") + " set"
			}
			if len(v.Channels) > 0 {
				detail += " · channels: " + strings.Join(v.Channels, ", ")
			}
			lines = append(lines, fmt.Sprintf("%s %-10s %s", mark, v.ID, detail))
		}
		if len(views) == 0 {
			lines = append(lines, "(none configured)")
		}
		lines = append(lines, "add: /connectors add <id> <field>=<value> · qr: /connectors qr · reload: /connectors reload")
		return TranscriptLinesMsg{Lines: lines}
	}
}

func (a *App) handleDream(args []string) tea.Cmd {
	if len(args) > 0 && args[0] == "now" {
		// Trigger a dream cycle via the gateway (stub).
		return func() tea.Msg {
			err := api.TriggerDream(a.BaseURL, a.Token)
			if err != nil {
				return FlashMsg{Text: fmt.Sprintf("dream trigger failed: %v", err)}
			}
			return FlashMsg{Text: "dream cycle triggered — watch /events for progress"}
		}
	}
	// Show last dream event from the runtime events log.
	for i := len(a.RuntimeEvents) - 1; i >= 0; i-- {
		if a.RuntimeEvents[i].Kind == "dream_cycle" {
			a.setFlash("last dream: " + a.RuntimeEvents[i].Message)
			return nil
		}
	}
	a.setFlash("no dream events recorded yet — try /dream now")
	return nil
}

func (a *App) handleLora() tea.Cmd {
	return func() tea.Msg {
		status, err := api.FetchLoraStatus(a.BaseURL, a.Token)
		if err != nil {
			return FlashMsg{Text: fmt.Sprintf("lora status: %v", err)}
		}
		msg := fmt.Sprintf("lora: %s", orStr(status, "none"))
		return FlashMsg{Text: msg}
	}
}

func (a *App) handleMemory(args []string) tea.Cmd {
	if len(args) > 0 && args[0] == "search" && len(args) >= 2 {
		query := strings.Join(args[1:], " ")
		msg := fmt.Sprintf("memory search for %q — use the web dashboard for full results", query)
		a.setFlash(msg)
		return nil
	}
	// Show memory stats from cached status.
	model := orStr(a.Status.Model, "—")
	backend := a.Status.Backend
	nTurns := len(a.Turns)
	a.setFlash(fmt.Sprintf("memory: model %s · backend: %s · session: %d turns", model, backend, nTurns))
	return nil
}

func (a *App) handleProviders() tea.Cmd {
	return func() tea.Msg {
		providers, defaultProvider, err := api.FetchProviders(a.BaseURL, a.Token)
		if err != nil {
			return FlashMsg{Text: fmt.Sprintf("providers: %v", err)}
		}
		if len(providers) == 0 {
			return FlashMsg{Text: "no providers configured — using local inference"}
		}
		lines := make([]string, 0, len(providers)+1)
		for _, p := range providers {
			dot := ui.G.Off
			if p.Online {
				dot = ui.G.On
			}
			def := ""
			if p.ID == defaultProvider {
				def = " · default"
			}
			lines = append(lines, fmt.Sprintf("%s %s%s", dot, p.ID, def))
		}
		// Run from a goroutine, so send via FlashMsg.
		msg := strings.Join(lines, "  ")
		return FlashMsg{Text: msg}
	}
}

func formatTokens(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM tok", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk tok", float64(n)/1_000)
	default:
		return fmt.Sprintf("%d tok", n)
	}
}

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
	// Save wizard progress so Ctrl+C mid-wizard doesn't force restart (spec §13).
	if a.Wizard.Show && a.Wizard.lastCompleted > WizHardware {
		saveWizardProgress(a.Wizard.lastCompleted, a.Wizard.SetupMode, a.Wizard.Choice)
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

func clamp(min, val, max int) int {
	if val < min {
		return min
	}
	if val > max {
		return max
	}
	return val
}
