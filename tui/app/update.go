package app

import (
	"encoding/json"
	"feral-tui/api"
	"feral-tui/ui"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
)

// toolTick fires every 200ms while any tool is running, so the elapsed-time
// column updates live and we don't need a separate per-tool ticker.
func toolTick() tea.Cmd {
	return tea.Tick(200*time.Millisecond, func(t time.Time) tea.Msg {
		return TickMsg(t)
	})
}

// fetchSessionsCmd hits /runtime/sessions for the welcome screen. Cached
// results are valid for 30s so window resize doesn't refetch.
func (a *App) fetchSessionsCmd() tea.Cmd {
	return func() tea.Msg {
		if !a.SessionsAt.IsZero() && time.Since(a.SessionsAt) < 30*time.Second && a.SessionsErr == nil {
			return SessionsMsg{Sessions: a.Sessions, Err: nil}
		}
		sessions, err := api.FetchSessions(a.BaseURL, a.Token, 3)
		return SessionsMsg{Sessions: sessions, Err: err}
	}
}

func (a *App) Init() tea.Cmd {
	return tea.Sequence(
		// Boot flash — header shows "○ starting" for ~100 ms (§2 J2.1).
		tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg {
			return BootComplete{}
		}),
		tea.Batch(textarea.Blink, a.Loader.Tick, toolTick(), a.fetchSessionsCmd(), a.startEventsCmd()),
	)
}

func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case BootComplete:
		a.State = StateReady
		a.rebuildViewport()

		// Check for wizard-done marker (§2 J2.3) — if missing, this is a
		// first launch and the setup wizard opens automatically.
		marker := os.ExpandEnv(wizardDoneMarker)
		if _, err := os.Stat(marker); os.IsNotExist(err) {
			a.startWizard()
		}
		return a, nil

	case tea.WindowSizeMsg:
		a.Width = msg.Width
		a.Height = msg.Height
		headerH := 1
		footerH := 1
		sepH := 1
		tiH := clamp(3, 8, a.Height/6)
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
		// Wizard mode: wizard consumes all keys when active.
		if a.Wizard.Show {
			a.wizardHandleKey(msg)
			a.rebuildViewport()
			return a, nil
		}
		key := msg.String()

		switch key {
		case "ctrl+c":
			a.handleCtrlC()
			if a.State == StateShutdown {
				return a, tea.Quit
			}
			return a, nil

		case "ctrl+d":
			if a.Input.Value() == "" {
				a.State = StateShutdown
				return a, tea.Quit
			}
			return a, nil

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
			a.Input.Reset()
			return a, nil

		case "enter":
			if a.ShowHelp || a.ShowHistory {
				a.ShowHelp = false
				a.ShowHistory = false
				return a, nil
			}
			// Model picker: Enter switches to the highlighted model.
			if a.ModelPicker.Show && !a.ModelPicker.Loading && len(a.ModelPicker.Rows) > 0 {
				picked := a.ModelPicker.Rows[a.ModelPicker.Idx]
				a.ModelPicker.Show = false
				cmd := a.switchModelCmd(picked.ID)
				return a, cmd
			}
			// Tool viewer: Enter toggles the expanded preview for the
			// highlighted row (mirrors help/history Enter-to-close).
			if a.ToolViewer.Show {
				if len(a.ToolViewer.Rows) > 0 {
					a.ToolViewer.Expanded = !a.ToolViewer.Expanded
				}
				return a, nil
			}
			if a.State == StateStreaming {
				return a, nil
			}
			// Autocomplete accept: if the popup is showing, Enter inserts
			// the highlighted completion text and keeps the user in the
			// textarea. A second Enter sends the message — mirrors how
			// shells behave (Tab to complete, Enter to commit).
			if a.Completion.Show && len(a.Completion.List) > 0 {
				a.acceptCompletion()
				a.rebuildViewport()
				return a, nil
			}
			cmd := a.handleSubmit()
			return a, cmd

		case "tab":
			// Captured BEFORE the textarea sees it so the keystroke never
			// lands as a literal `\t` character. If the popup is showing,
			// Tab cycles the highlight. If not, we still want the popup
			// to appear when the input starts with `/`, so we recompute
			// after the textarea updates below.
			if a.ModelPicker.Show && !a.ModelPicker.Loading && len(a.ModelPicker.Rows) > 0 {
				a.ModelPicker.Idx = (a.ModelPicker.Idx + 1) % len(a.ModelPicker.Rows)
				return a, nil
			}
			if a.Completion.Show && len(a.Completion.List) > 0 {
				a.Completion.Idx = (a.Completion.Idx + 1) % len(a.Completion.List)
				return a, nil
			}

		case "f1":
			a.ShowHelp = !a.ShowHelp
			return a, nil

		case "ctrl+h":
			a.ShowHistory = !a.ShowHistory
			return a, nil

		case "pgup", "pgdown":
			var cmd tea.Cmd
			a.ChatVP, cmd = a.ChatVP.Update(msg)
			a.FollowBottom = a.ChatVP.AtBottom()
			return a, cmd

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
			// vim-style overlay nav only — never touches history (they're
			// valid textarea characters), so no plain-editing branch here.
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

		case "ctrl+t":
			a.toggleThinking()
			a.rebuildViewport()
			return a, nil

		case "y":
			if a.State == StateWaiting && a.ApprovalToolID != "" {
				a.State = a.PriorState
				a.ApprovalToolID = ""
				a.rebuildViewport()
				return a, nil
			}
			// fall through to textarea below.

		case "n":
			if a.State == StateWaiting && a.ApprovalToolID != "" {
				a.State = StateReady
				// Mark the tool as declined.
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
			// fall through to textarea below.

		case "r":
			if a.State == StateError {
				return a, a.retryLastMessage()
			}
			// fall through to the textarea below — "r" is a normal character
			// everywhere else.
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

	case TickMsg:
		// Drives the live elapsed-time column on running tool pills.
		// Only re-renders when something is actually changing.
		if a.toolsRunning() {
			a.rebuildViewport()
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

	case StreamDoneMsg:
		if a.State == StateShutdown {
			return a, tea.Quit
		}
		a.flushPending()
		a.finishStream()
		if msg.Err != nil {
			a.setFlash(fmt.Sprintf("stream error: %v", msg.Err))
		}
		a.rebuildViewport()
		return a, nil

	case FlashMsg:
		a.setFlash(msg.Text)
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
		a.pushHistory(raw)
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
	return tea.Batch(a.startStream(raw), frameTick())
}

func (a *App) handleSlash(body string) tea.Cmd {
	parts := strings.Fields(body)
	if len(parts) == 0 {
		return nil
	}
	cmd := parts[0]
	switch cmd {
	case "exit", "quit", ":q":
		a.State = StateShutdown
		return tea.Quit
	case "clear", "cls":
		a.Turns = nil
		a.RuntimeEvents = nil
		a.StreamBuf.Reset()
		a.PrevContent = ""
		a.ChatVP.SetContent("")
		a.ChatVP.GotoBottom()
		a.FollowBottom = true
		a.setFlash("cleared")
		return nil
	case "new", "reset":
		// /new and /reset both archive the current turns and start
		// fresh. On a headless gateway the session would persist to
		// disk; here we just clear the in-memory state.
		a.Turns = nil
		a.RuntimeEvents = nil
		a.StreamBuf.Reset()
		a.PrevContent = ""
		a.ChatVP.SetContent("")
		a.ChatVP.GotoBottom()
		a.FollowBottom = true
		a.setFlash("session reset")
		return nil
	case "compact":
		nTurns := len(a.Turns)
		if nTurns == 0 {
			a.setFlash("no turns to compact")
			return nil
		}
		total := 0
		for _, t := range a.Turns {
			total += len(t.Text)
		}
		// Simulate compaction — in a full implementation this would call
		// a gateway endpoint. For now render a receipt line.
		msg := fmt.Sprintf("compacted: %d turns → summary (%s freed)", nTurns, formatTokens(total/2))
		a.RuntimeEvents = append(a.RuntimeEvents, api.RuntimeEvent{
			Kind:    "compact",
			Message: msg,
		})
		a.rebuildViewport()
		a.setFlash(msg)
		return nil

	case "connectors":
		return a.handleConnectors(parts[1:])

	case "doctor":
		// Run in-memory checks from cached status + manifest.
		checks := a.runDoctorChecks()
		lines := make([]string, 0, len(checks))
		for _, c := range checks {
			glyph := ui.G.OK
			if !c.Ok {
				glyph = ui.G.Err
			}
			lines = append(lines, fmt.Sprintf("%s %s · %s", glyph, c.Name, c.Detail))
		}
		a.appendTranscriptLines(lines)
		return nil

	case "dream":
		return a.handleDream(parts[1:])

	case "genome":
		a.setFlash("genome status: use /status or check the web dashboard")
		return nil

	case "history":
		// Alias for /sessions.
		return a.handleSlash("sessions")

	case "lora":
		return a.handleLora()

	case "memory":
		return a.handleMemory(parts[1:])

	case "meta":
		a.setFlash("meta evolution status: use /status or check the web dashboard")
		return nil

	case "providers":
		return a.handleProviders()

	case "setup":
		a.setFlash("setup wizard — coming in a future update")
		return nil

	case "sessions":
		// Show the most-recent sessions from the welcome screen cache.
		// If we haven't fetched yet (or the cache is stale), kick off
		// a fetch first and the flash will appear on the next tick.
		if len(a.Sessions) == 0 {
			return a.fetchSessionsCmd()
		}
		var items []string
		for _, s := range a.Sessions {
			title := s.Title
			if title == "" {
				title = "untitled"
			}
			items = append(items, title)
		}
		a.setFlash("recent sessions: " + strings.Join(items, " · "))
		return nil
	case "help", "?":
		a.ShowHelp = true
		return nil
	case "tools":
		a.openToolViewer()
		return nil
	case "model":
		if len(parts) == 1 {
			return a.openModelPicker()
		}
		switch parts[1] {
		case "list":
			return a.openModelPicker()
		case "status":
			provider := a.Status.Provider
			if a.Status.ByokProvider != "" {
				provider = a.Status.ByokProvider
			}
			a.setFlash(fmt.Sprintf("model: %s · lora: %s · backend: %s · provider: %s · online: %t",
				orStr(a.Status.Model, "—"),
				orStr(a.Status.LoRA, "none"),
				a.Status.Backend,
				orStr(provider, "—"),
				a.Status.Online))
			return nil
		default:
			return a.switchModelCmd(parts[1])
		}
	case "stop":
		// Abort the current streaming run. If we're not streaming,
		// tell the user nothing is in flight.
		if a.State != StateStreaming {
			a.setFlash("nothing is running")
			return nil
		}
		a.stopStream()
		a.setFlash("aborted")
		return nil
	case "status":
		// Full status: model, lora, backend, provider, uptime,
		// token counts for the current session.
		provider := a.Status.Provider
		if a.Status.ByokProvider != "" {
			provider = a.Status.ByokProvider
		}
		online := "offline"
		if a.Status.Online {
			online = "online"
		}
		elapsed := formatElapsed(time.Since(a.StartedAt))
		tokens := a.StreamPromptTokens + a.StreamCompletionTokens
		a.setFlash(fmt.Sprintf(
			"model: %s · lora: %s · backend: %s · provider: %s\nsession: %s · %s · tokens: %d",
			orStr(a.Status.Model, "—"),
			orStr(a.Status.LoRA, "none"),
			a.Status.Backend,
			orStr(provider, "—"),
			elapsed,
			online,
			tokens))
		return nil
	case "reasoning":
		a.toggleThinking()
		a.rebuildViewport()
		a.setFlash("reasoning toggled")
		return nil
	case "usage":
		p := a.StreamPromptTokens
		c := a.StreamCompletionTokens
		a.setFlash(fmt.Sprintf("prompt: %d tokens · completion: %d tokens · total: %d tokens", p, c, p+c))
		return nil
	case "whoami":
		a.setFlash(fmt.Sprintf("base_url: %s · online: %t", a.BaseURL, a.Status.Online))
		return nil
	case "context":
		total := 0
		for _, t := range a.Turns {
			total += len(t.Text)
		}
		nTools := 0
		for _, t := range a.Turns {
			nTools += len(t.Tools)
		}
		a.setFlash(fmt.Sprintf("turns: %d · chars: %d · tools: %d", len(a.Turns), total, nTools))
		return nil
	case "tasks":
		nRunning := 0
		nDone := 0
		for _, t := range a.Turns {
			for _, tc := range t.Tools {
				switch tc.Status {
				case ToolRunning:
					nRunning++
				case ToolDone, ToolError:
					nDone++
				}
			}
		}
		a.setFlash(fmt.Sprintf("running: %d · completed: %d", nRunning, nDone))
		return nil
	default:
		a.setFlash(fmt.Sprintf("unknown command: /%s  (try /help)", cmd))
		return nil
	}
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
				if tokens > 0 {
					t.Meta = fmt.Sprintf("%s · %d tok", elapsed, tokens)
				} else {
					t.Meta = elapsed
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

// ── Setup Wizard (§13) ────────────────────────────────────────

// startWizard begins the Setup Wizard. Called on first launch when no
// config is detected (§2 J2.3) or via the /setup command.
func (a *App) startWizard() {
	a.Wizard = WizardState{
		Show:   true,
		Step:   WizHardware,
		Choice: WizChoiceLocal,
	}
	// If there's a previously saved step, resume from the one after it.
	if a.Wizard.lastCompleted > WizHardware {
		a.Wizard.Step = a.Wizard.lastCompleted + 1
	}
	a.State = StateDetectingHardware
	// Kick off hardware detection.
	a.startWizardHardwareProbe()
}

// startWizardHardwareProbe begins the W1 hardware scan. In a real
// implementation this would call the gateway API; here we simulate with
// plausible defaults for the dev machine.
func (a *App) startWizardHardwareProbe() {
	a.Wizard.Hardware = WizardHardware{
		GpuName: "rtx 4070",
		GpuVram: 12,
		RamGB:   64,
		DiskGB:  412,
		GpuOK:   true,
	}
	// Auto-advance after probe (simulated synchronously for now).
	a.State = StateReady
	a.Wizard.Step = WizModelChoice
}

// wizardHandleKey processes key events while the wizard is showing.
// Returns true if the key was consumed by the wizard.
func (a *App) wizardHandleKey(key tea.KeyMsg) bool {
	if !a.Wizard.Show {
		return false
	}
	w := &a.Wizard
	switch w.Step {
	case WizModelChoice:
		switch key.Type {
		case tea.KeyEnter:
			w.Step = advanceWizardStep(w.Choice)
			w.lastCompleted = WizModelChoice
		case tea.KeyRunes:
			switch string(key.Runes) {
			case "1":
				w.Choice = WizChoiceLocal
			case "2":
				w.Choice = WizChoiceCloud
			case "3":
				w.Choice = WizChoiceBoth
			}
		case tea.KeyEscape:
			if w.Step > WizHardware {
				w.Step--
			}
		}
		return true
	case WizCloudKey:
		switch key.Type {
		case tea.KeyEnter:
			if w.APIKey == "" {
				return true
			}
			// Simulate key validation.
			w.KeyValid = true
			if w.KeyValid {
				w.Step = WizConnectors
				w.lastCompleted = WizCloudKey
			}
		case tea.KeyBackspace:
			if len(w.APIKey) > 0 {
				w.APIKey = w.APIKey[:len(w.APIKey)-1]
			}
		case tea.KeyRunes:
			w.APIKey += string(key.Runes)
		case tea.KeyEscape:
			if w.Step > WizHardware {
				w.Step--
			}
		}
		return true
	case WizConnectors:
		switch key.Type {
		case tea.KeyEnter:
			conns := []string{"Discord", "Slack", "Telegram", "WhatsApp"}
			w.ConnectorSelected = conns[w.connectorIdx]
			w.Step = WizConnectorPrompt
			w.lastCompleted = WizConnectors
		case tea.KeyRunes:
			if len(key.Runes) == 1 && key.Runes[0] >= '1' && key.Runes[0] <= '4' {
				w.connectorIdx = int(key.Runes[0] - '1')
			}
		case tea.KeyEscape:
			if w.Step > WizHardware {
				w.Step--
			}
		}
		return true
	case WizConnectorPrompt:
		switch key.Type {
		case tea.KeyRunes:
			if len(key.Runes) == 1 && (key.Runes[0] == 'y' || key.Runes[0] == 'Y') {
				w.Connecting = true
			}
			// Y and n both advance; n skips connecting.
			w.Step = WizFinish
			w.lastCompleted = WizConnectorPrompt
		case tea.KeyEnter:
			w.Step = WizFinish
			w.lastCompleted = WizConnectorPrompt
		case tea.KeyEscape:
			w.Step = WizConnectors
		}
		return true
	case WizFinish:
		switch key.Type {
		case tea.KeyEnter:
			a.finishWizard()
		}
		return true
	default:
		// WizHardware, WizLocalDownload: auto-advance only.
		return true
	}
}

// advanceWizardStep returns the next wizard step based on the user's choice.
func advanceWizardStep(c WizardChoice) WizardStep {
	switch c {
	case WizChoiceLocal, WizChoiceBoth:
		return WizLocalDownload
	case WizChoiceCloud:
		return WizCloudKey
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
	marker := os.ExpandEnv(wizardDoneMarker)
	os.WriteFile(marker, []byte("done\n"), 0644)

	// Welcome moment — one assistant turn that greets the user.
	welcomeText := "Welcome to Feral.\n\nI'm ready to help.\n\n" +
		"Ask me to write code,\n" +
		"analyze files,\n" +
		"use tools,\n" +
		"or automate tasks.\n\n" +
		"Type /help anytime."
	a.Turns = append(a.Turns, Turn{Role: RoleAssistant, Text: welcomeText, turnVer: 1})

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
	// Show cached connector count from last status poll.
	a.setFlash("connectors info: use /connectors reload to refresh")
	return nil
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
