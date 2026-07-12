package app

import (
	"fmt"
	"time"

	"feral-tui/api"
	"feral-tui/ui"

	tea "github.com/charmbracelet/bubbletea"
)

// Command is one slash command. The Registry below is the single source of
// truth for dispatch (handleSlash), completion (recomputeCompletion), and
// the help overlay (renderHelpOverlay) — so the three can never drift
// (P0.8 / C8). Adding a command = one Registry entry.
type Command struct {
	Name    string // canonical name without the leading slash ("status")
	Aliases []string
	Desc    string // one line, shown in /help + completion
	Args    string // "" or "<id>" / "reload" — appended to completion Insert
	Hidden  bool   // works but not listed in /help or completion
	// Extra completion rows beyond the primary one (e.g. /model sub-commands).
	Extra []CompletionItem
	Run   func(a *App, args []string) tea.Cmd
}

// Registry is the ordered list of every slash command.
var Registry = []Command{
	{Name: "help", Aliases: []string{"?"}, Desc: "show this overlay",
		Run: func(a *App, _ []string) tea.Cmd { a.ShowHelp = true; return nil }},
	{Name: "tools", Desc: "browse tool calls + their results",
		Run: func(a *App, _ []string) tea.Cmd { a.openToolViewer(); return nil }},
	{Name: "new", Aliases: []string{"reset"}, Desc: "archive session and start fresh",
		Run: func(a *App, _ []string) tea.Cmd { a.resetSession(); return nil }},
	{Name: "clear", Aliases: []string{"cls"}, Desc: "clear this session's history",
		Run: func(a *App, _ []string) tea.Cmd { a.clearSession(); return nil }},
	{Name: "sessions", Aliases: []string{"history"}, Desc: "list recent sessions from disk",
		Run: func(a *App, _ []string) tea.Cmd { return a.cmdSessions() }},
	{Name: "status", Desc: "show model, provider, uptime, tokens",
		Run: func(a *App, _ []string) tea.Cmd { a.cmdStatus(); return nil }},
	{Name: "whoami", Desc: "show session key and gateway info",
		Run: func(a *App, _ []string) tea.Cmd {
			a.appendTranscriptLines([]string{
				fmt.Sprintf("base_url · %s", a.BaseURL),
				fmt.Sprintf("online · %t", a.Status.Online),
			})
			return nil
		}},
	{Name: "usage", Args: "off|tokens|full", Desc: "token counts; set the per-reply usage footer",
		Run: func(a *App, args []string) tea.Cmd {
			// OpenClaw parity: /usage <mode> controls the per-turn meta
			// footnote; plain /usage keeps printing session totals.
			if len(args) > 0 {
				switch args[0] {
				case "off", "tokens", "full":
					a.UsageMode = args[0]
					a.setFlash("usage footer: " + args[0])
				default:
					a.setFlash("usage: /usage [off|tokens|full]")
				}
				return nil
			}
			p, c := a.StreamPromptTokens, a.StreamCompletionTokens
			a.appendTranscriptLines([]string{
				fmt.Sprintf("prompt · %d tokens", p),
				fmt.Sprintf("completion · %d tokens", c),
				fmt.Sprintf("total · %d tokens", p+c),
			})
			return nil
		}},
	{Name: "context", Desc: "explain how context is assembled",
		Run: func(a *App, _ []string) tea.Cmd {
			total, nTools := 0, 0
			for _, t := range a.Turns {
				total += len(t.Text)
				nTools += len(t.Tools)
			}
			a.appendTranscriptLines([]string{
				fmt.Sprintf("turns · %d", len(a.Turns)),
				fmt.Sprintf("chars · %d", total),
				fmt.Sprintf("tools · %d", nTools),
			})
			return nil
		}},
	{Name: "tasks", Desc: "list background tool tasks",
		Run: func(a *App, _ []string) tea.Cmd {
			nRunning, nDone := 0, 0
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
			a.appendTranscriptLines([]string{
				fmt.Sprintf("running · %d", nRunning),
				fmt.Sprintf("completed · %d", nDone),
			})
			return nil
		}},
	{Name: "reasoning", Aliases: []string{"think"}, Desc: "toggle reasoning visibility",
		Run: func(a *App, _ []string) tea.Cmd {
			a.toggleThinking()
			a.rebuildViewport()
			a.setFlash("reasoning toggled")
			return nil
		}},
	{Name: "verbose", Args: "on|off", Desc: "show all runtime events (off hides them)",
		Run: func(a *App, args []string) tea.Cmd {
			switch {
			case len(args) == 0:
				a.VerboseEvents = !a.VerboseEvents
				a.EventsHidden = false
			case args[0] == "on":
				a.VerboseEvents = true
				a.EventsHidden = false
			case args[0] == "off":
				a.VerboseEvents = false
				a.EventsHidden = true
			default:
				a.setFlash("usage: /verbose on|off")
				return nil
			}
			a.rebuildViewport()
			switch {
			case a.VerboseEvents:
				a.setFlash("all runtime events shown")
			case a.EventsHidden:
				a.setFlash("runtime events hidden")
			default:
				a.setFlash("curated runtime events shown")
			}
			return nil
		}},
	{Name: "doctor", Desc: "run gateway health checks",
		Run: func(a *App, _ []string) tea.Cmd {
			checks := a.runDoctorChecks()
			lines := make([]string, 0, len(checks))
			for _, c := range checks {
				mark := ui.OkMark.Render(ui.G.OK)
				if !c.Ok {
					mark = ui.ErrorTitle.Render(ui.G.Err)
				}
				lines = append(lines, fmt.Sprintf("%s %s · %s", mark, c.Name, c.Detail))
			}
			a.appendTranscriptLines(lines)
			return nil
		}},
	{Name: "providers", Desc: "list providers with health status",
		Run: func(a *App, _ []string) tea.Cmd { return a.handleProviders() }},
	{Name: "connectors", Args: "add|qr|reload", Desc: "manage chat-platform connectors",
		Run: func(a *App, args []string) tea.Cmd { return a.handleConnectors(args) }},
	{Name: "memory", Args: "search <q>", Desc: "memory stats; /memory search <q>",
		Run: func(a *App, args []string) tea.Cmd { return a.handleMemory(args) }},
	{Name: "dream", Args: "now", Desc: "dream summary; /dream now triggers one",
		Run: func(a *App, args []string) tea.Cmd { return a.handleDream(args) }},
	{Name: "lora", Desc: "show LoRA training status",
		Run: func(a *App, _ []string) tea.Cmd { return a.handleLora() }},
	{Name: "compact", Desc: "summarize older context into a note",
		Run: func(a *App, _ []string) tea.Cmd {
			// Real compaction via /runtime/session/compact (closes P0.9).
			// The summarizer is a full LLM completion — run it off the UI
			// thread and report the outcome as a flash.
			a.setFlash("compacting session context…")
			base, token := a.BaseURL, a.Token
			return func() tea.Msg {
				res, err := api.CompactSession(base, token, "chat")
				if err != nil {
					return FlashMsg{Text: fmt.Sprintf("compact failed: %v", err)}
				}
				return FlashMsg{Text: "compact: " + res}
			}
		}},
	{Name: "restart", Desc: "restart the gateway and reconnect",
		Run: func(a *App, _ []string) tea.Cmd { return a.cmdRestartGateway() }},
	{Name: "model", Args: "<id>", Desc: "open model picker / switch model",
		Extra: []CompletionItem{
			{Text: "/model status", Desc: "show model details (ctx window, provider)", Insert: "/model status"},
			{Text: "/model <id>", Desc: "switch the loaded model", Insert: "/model "},
		},
		Run: func(a *App, args []string) tea.Cmd { return a.cmdModel(args) }},
	{Name: "stop", Desc: "abort the current streaming run",
		Run: func(a *App, _ []string) tea.Cmd {
			if a.State != StateStreaming {
				a.setFlash("nothing is running")
				return nil
			}
			a.stopStream()
			a.setFlash("aborted")
			return nil
		}},
	{Name: "setup", Args: "classic", Desc: "re-run guided setup (/setup classic = full wizard)",
		Run: func(a *App, args []string) tea.Cmd {
			if len(args) > 0 && args[0] == "classic" {
				a.startWizard()
				return nil
			}
			return a.startGuided()
		}},
	{Name: "genome", Hidden: true, Desc: "current genome layers + fitness",
		Run: func(a *App, _ []string) tea.Cmd {
			a.setFlash("genome status: use /status or check the web dashboard")
			return nil
		}},
	{Name: "meta", Hidden: true, Desc: "meta-evolution epoch status",
		Run: func(a *App, _ []string) tea.Cmd {
			a.setFlash("meta evolution status: use /status or check the web dashboard")
			return nil
		}},
	{Name: "exit", Aliases: []string{"quit", ":q"}, Desc: "quit the TUI",
		Run: func(a *App, _ []string) tea.Cmd { a.State = StateShutdown; return tea.Quit }},
}

// lookupCommand resolves a name (or alias) to a Registry entry.
func lookupCommand(name string) (*Command, bool) {
	for i := range Registry {
		if Registry[i].Name == name {
			return &Registry[i], true
		}
		for _, al := range Registry[i].Aliases {
			if al == name {
				return &Registry[i], true
			}
		}
	}
	return nil, false
}

// nonHiddenCommands returns the primary (non-hidden) Registry entries in
// order — the exact set the help overlay lists. The P0.8 drift test asserts
// len(helpOverlayCommands) == len(this).
func nonHiddenCommands() []Command {
	out := make([]Command, 0, len(Registry))
	for _, c := range Registry {
		if !c.Hidden {
			out = append(out, c)
		}
	}
	return out
}

// registryCompletions builds the completion rows from the Registry:
// one primary row per non-hidden command, plus alias rows and any Extra
// rows. Hidden commands (genome, meta) are excluded.
func registryCompletions() []CompletionItem {
	var out []CompletionItem
	for _, c := range Registry {
		if c.Hidden {
			continue
		}
		insert := "/" + c.Name
		if c.Args != "" {
			insert += " "
		}
		out = append(out, CompletionItem{Text: "/" + c.Name, Desc: c.Desc, Insert: insert})
		for _, al := range c.Aliases {
			out = append(out, CompletionItem{Text: "/" + al, Desc: "alias for /" + c.Name, Insert: "/" + al})
		}
		out = append(out, c.Extra...)
	}
	return out
}

// helpCommandLine formats one Registry command for the help overlay:
// "/status" (+ " <args>" when it takes arguments) → desc.
func helpCommandLine(c Command) string {
	name := "/" + c.Name
	if c.Args != "" {
		name += " " + c.Args
	}
	return helpLine(name, c.Desc)
}

// ── shared command bodies (used by Registry Run closures) ──────────

func (a *App) clearSession() {
	a.Turns = nil
	a.RuntimeEvents = nil
	a.StreamBuf.Reset()
	a.PrevContent = ""
	a.ChatVP.SetContent("")
	a.ChatVP.GotoBottom()
	a.FollowBottom = true
	a.setFlash("cleared")
}

func (a *App) resetSession() {
	a.Turns = nil
	a.RuntimeEvents = nil
	a.StreamBuf.Reset()
	a.PrevContent = ""
	a.ChatVP.SetContent("")
	a.ChatVP.GotoBottom()
	a.FollowBottom = true
	a.setFlash("session reset")
}

// cmdSessions routes recent-session output to the transcript (P0.7) so it
// is scrollable and survives longer than a flash.
func (a *App) cmdSessions() tea.Cmd {
	if len(a.Sessions) == 0 {
		return a.fetchSessionsCmd()
	}
	lines := make([]string, 0, len(a.Sessions))
	for _, s := range a.Sessions {
		title := s.Title
		if title == "" {
			title = "untitled"
		}
		lines = append(lines, "· "+title)
	}
	a.appendTranscriptLines(lines)
	return nil
}

// cmdStatus routes full status to the transcript (P0.7) — one dim line per
// field, so the multi-field output survives and scrolls.
func (a *App) cmdStatus() {
	provider := a.Status.Provider
	if a.Status.ByokProvider != "" {
		provider = a.Status.ByokProvider
	}
	online := "offline"
	if a.Status.Online {
		online = "online"
	}
	a.appendTranscriptLines([]string{
		fmt.Sprintf("model · %s", orStr(a.Status.Model, "—")),
		fmt.Sprintf("lora · %s", orStr(a.Status.LoRA, "none")),
		fmt.Sprintf("backend · %s", a.Status.Backend),
		fmt.Sprintf("provider · %s", orStr(provider, "—")),
		fmt.Sprintf("session · %s · %s", formatElapsed(time.Since(a.StartedAt)), online),
		fmt.Sprintf("tokens · %d", a.StreamPromptTokens+a.StreamCompletionTokens),
	})
}

// cmdRestartGateway drains the gateway and starts a fresh one (/restart,
// OpenClaw parity). The gateway going down flips the TUI into its existing
// recovery machinery, which reconnects the SSE stream once the new process
// is up — this command only sequences shutdown → start.
func (a *App) cmdRestartGateway() tea.Cmd {
	a.setFlash("restarting gateway…")
	base, token := a.BaseURL, a.Token
	return func() tea.Msg {
		_ = api.ShutdownGateway(base, token)
		settings, err := api.LoadSettings()
		if err != nil {
			return FlashMsg{Text: fmt.Sprintf("restart: %v", err)}
		}
		port := settings.APIPort
		// Wait for the old process to release the port — the D7 drain is
		// bounded server-side at 30s; give it that plus margin.
		for i := 0; i < 140 && api.PortInUse(port); i++ {
			time.Sleep(250 * time.Millisecond)
		}
		if api.PortInUse(port) {
			return FlashMsg{Text: "restart: old gateway did not exit — run `feral gateway restart`"}
		}
		if _, err := api.StartGateway(port); err != nil {
			return FlashMsg{Text: fmt.Sprintf("restart: %v — run `feral gateway start`", err)}
		}
		for i := 0; i < 40 && !api.PortInUse(port); i++ {
			time.Sleep(250 * time.Millisecond)
		}
		if !api.PortInUse(port) {
			return FlashMsg{Text: "restart: gateway not responding — run `feral doctor`"}
		}
		return FlashMsg{Text: "gateway restarted"}
	}
}

// cmdModel dispatches /model and its sub-commands. /model status routes to
// the transcript (P0.7); /model / /model list open the picker; /model <id>
// switches.
func (a *App) cmdModel(args []string) tea.Cmd {
	if len(args) == 0 {
		return a.openModelPicker()
	}
	switch args[0] {
	case "list":
		return a.openModelPicker()
	case "status":
		provider := a.Status.Provider
		if a.Status.ByokProvider != "" {
			provider = a.Status.ByokProvider
		}
		a.appendTranscriptLines([]string{
			fmt.Sprintf("model · %s", orStr(a.Status.Model, "—")),
			fmt.Sprintf("lora · %s", orStr(a.Status.LoRA, "none")),
			fmt.Sprintf("backend · %s", a.Status.Backend),
			fmt.Sprintf("provider · %s", orStr(provider, "—")),
			fmt.Sprintf("online · %t", a.Status.Online),
		})
		return nil
	default:
		return a.switchModelCmd(args[0])
	}
}
