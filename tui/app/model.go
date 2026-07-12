package app

import (
	"fmt"
	"os"
	"strings"
	"time"

	"feral-tui/api"
	"feral-tui/ui"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

type TickMsg time.Time

type Role int

const (
	RoleUser Role = iota
	RoleAssistant
)

// ToolStatus mirrors the three end-states a tool pill can be in.
type ToolStatus int

const (
	ToolRunning ToolStatus = iota
	ToolDone
	ToolError
	ToolDeclined
)

// CompletionItem is one row in the slash-command autocomplete popup.
// `Insert` is what replaces the current input prefix when the user accepts
// the row (Tab → cycle, Enter → accept the highlighted one).
type CompletionItem struct {
	// Text is the literal command form shown to the user (`/model list`,
	// `/help`, `/model <id>`).
	Text string
	// Desc is the human description on the right side of the popup row.
	Desc string
	// Insert is what goes back into the textarea on accept. Often equals
	// `Text` but is split out so we can leave placeholders untouched
	// (`/model <id>` keeps the `<id>` for the user to fill in).
	Insert string
}

// ToolCall is one tool invocation surfaced under an assistant turn. `Main`
// is a short human-readable argument preview ("file.rs:42", `"search query"`,
// `cargo test`), `Note` carries any progress/retry text from the sidecar
// (`tool_progress` events).
type ToolCall struct {
	ID       string
	Name     string
	Main     string
	Status   ToolStatus
	StartedAt time.Time
	EndedAt  time.Time
	Note     string
	ErrMsg   string
	Preview  string
}

type Turn struct {
	Role         Role
	Text         string
	Reasoning    string
	Streaming    bool
	ThinkingOpen bool
	Tools        []ToolCall
	// Errors is the list of error events the host surfaced during this
	// turn — usually zero, populated when a tool errored or the model
	// timed out. Rendered as bordered cards in the transcript so a
	// transient failure is visible without hunting through inline text.
	Errors []ErrorCard
	// Meta is a one-line trailing footnote set once the turn finishes
	// streaming — "12.4s · 842 tok", mirroring Claude Code's dim
	// "✻ Cooked for Ns" note under a completed reply.
	Meta string

	// Interrupted is set when the user cancelled this turn mid-stream (Esc or
	// Ctrl+C). Rendered as one dim "◦ interrupted" line after the turn's
	// content — the partial text itself is never discarded (spec §7).
	Interrupted bool

	// mdCacheSrc/mdCacheOut/mdCacheWidth memoize the last glamour render of
	// Text. Every tea.Msg (a token, a spinner tick, a resize) rebuilds the
	// WHOLE transcript, so without this every past turn's markdown was
	// re-rendered on every frame — O(history size) work per keystroke.
	// Only the actively-streaming turn's Text actually changes between
	// frames, so this makes every other turn a cache hit.
	mdCacheSrc   string
	mdCacheOut   string
	mdCacheWidth int

	// turnVer and turnCache form the per-turn render cache (§16). turnVer
	// increments on every mutation to this turn's content; turnCache holds
	// the last full render of this turn. buildChatContent skips re-render
	// when turnCacheVer == turnVer (same width verified at call site).
	turnVer     uint64
	turnCacheVer uint64
	turnCache    string
}

// markDirty increments the turn version, invalidating any cached render.
func (t *Turn) markDirty() {
	t.turnVer++
}

// renderMarkdownCached returns the glamour render of Text, reusing the last
// render when neither Text nor width has changed since.
func (t *Turn) renderMarkdownCached(width int) string {
	if t.Text == t.mdCacheSrc && width == t.mdCacheWidth {
		return t.mdCacheOut
	}
	out := ui.RenderMarkdown(t.Text, width)
	t.mdCacheSrc = t.Text
	t.mdCacheOut = out
	t.mdCacheWidth = width
	return out
}

// ErrorCard is one error event attached to an assistant turn.
// `Kind` lets the renderer pick a colour (timeout/permission/network/
// unknown) — see `inferErrorKind`. `Hint` is an optional human-friendly
// next-step shown under the message (e.g. "Try: ^C to cancel and
// shorten the prompt").
type ErrorCard struct {
	Message string
	Kind    string
	Hint    string
}

type StreamChunkMsg struct {
	Chunk api.Chunk
}

type StreamDoneMsg struct {
	Err error
}

type FlashMsg struct {
	Text string
}

// TranscriptLinesMsg appends informational lines to the transcript from an
// async tea.Cmd (e.g. the WhatsApp pairing QR fetched off the UI thread).
type TranscriptLinesMsg struct {
	Lines []string
}

type ModelListMsg struct {
	IDs    []string
	Active string
	Err    error
}

type ModelSwitchMsg struct {
	Active string
	Err    error
}

// SessionsMsg is the result of fetching `/runtime/sessions` for the welcome
// screen. Err is non-nil on transport failure (empty list, no rendering).
type SessionsMsg struct {
	Sessions []api.SessionSummary
	Err      error
}

// LastTaskMsg is the Sprint 1.8 payload for the welcome-screen last-task
// row. View is the gateway `/runtime/resume` response (nil on transport
// failure or first launch — both render the same "fresh start" copy).
type LastTaskMsg struct {
	View *api.ResumeView
	Err  error
}

// HardwareProbeMsg is the Sprint 2 / audit C-1 payload. On success Info is
// the real `/system_info` response (GPU/VRAM/RAM) and the wizard advances
// to WizModelChoice. On failure the wizard surfaces a Retry CTA so the
// user can recover from a transient gateway hiccup.
type HardwareProbeMsg struct {
	Info *api.SystemInfo
	Err  error
}

// ProvidersTestMsg is the Sprint 2 / audit C-2 payload. On success the
// wizard advances to WizConnectors; on failure the user sees the real
// provider error verbatim ("401 Unauthorized", "Invalid API key", …).
// `Msg` is empty on success.
type ProvidersTestMsg struct {
	Success bool
	Msg     string
	Err     error
}

// DownloadModelMsg is the Sprint 2 / audit C-5 payload. The wizard's
// `W3a` step POSTs `/runtime/models/install` (gets back a download id),
// then polls `/runtime/models/download/:id` every 500ms; each poll
// returns one of these. Status == "complete" advances the wizard;
// status == "failed" / "cancelled" surfaces the real error verbatim.
type DownloadModelMsg struct {
	Download *api.ModelDownload
	Err      error
}

// RuntimeEventMsg wraps one event from the /events SSE stream.
type RuntimeEventMsg struct {
	Event api.RuntimeEvent
}

// BootComplete is sent by Init() after the first frame so the header
// renders at least once with "○ starting" before transitioning (§2 J2.1).
type BootComplete struct{}

// StatusPollTickMsg drives the 5s header refresh — fetches /runtime/status
// so model/lora/backend/online never go stale after launch (spec §29).
type StatusPollTickMsg struct{}

// StatusPollResult holds the response from FetchStatus for the poll handler.
type StatusPollResult struct {
	Status *api.StatusSnapshot
	Err    error
}

type App struct {
	Width, Height int

	Status  *api.StatusSnapshot
	BaseURL string
	Token   string

	Turns []Turn
	State State

	// connectorTipArmed is set when the wizard finishes; after the first
	// clean StreamDoneMsg one connector-discovery tip is pushed (P1.1).
	connectorTipArmed bool

	Sessions      []api.SessionSummary
	SessionsErr   error
	SessionsAt    time.Time

	// Sprint 1.8 — Memory Resume. Last-task row on the welcome screen.
	// Populated by fetchResumeCmd on init; nil on first launch. Cached for
	// 30s so window resize / Tab navigation doesn't refetch. The row renders
	// as "Welcome back to <title> · in <workspace>" and is suppressed when
	// stale (>30 days) or absent.
	LastTask      *api.LastTask
	LastTaskView  *api.ResumeView
	LastTaskErr   error
	LastTaskAt    time.Time

	ChatVP      viewport.Model
	Input       textarea.Model
	Loader      spinner.Model
	PrevContent string
	Wizard      WizardState
	// Guided is the OpenClaw-parity guided first-run flow (guided.go) —
	// the default on a fresh install; the classic Wizard stays behind
	// `/setup classic` and `--wizard`.
	Guided GuidedState
	// ForceClassicWizard is set by the `--wizard` CLI flag (the
	// `feral setup --classic` path) so BootComplete opens the classic
	// wizard instead of the guided flow.
	ForceClassicWizard bool
	// renderWidth tracks the msgWidth used during the last buildChatContent
	// pass. When it matches, per-turn caches are valid (spec §16).
	renderWidth int
	// FollowBottom is true while the transcript should auto-scroll to the
	// newest content (the default, and what streaming needs). It flips to
	// false the moment the user scrolls up on purpose (PgUp / mouse wheel
	// up) and flips back once they've scrolled back down to the bottom —
	// mirrors how a normal terminal pager or chat client behaves, and
	// stops streaming tokens from yanking the view back down mid-read.
	FollowBottom bool

	// needsRebuild is set when the viewport content or dimensions change
	// and cleared after rebuildViewport() runs. View() checks this flag
	// instead of unconditionally rebuilding on every frame.
	needsRebuild bool
	// prevChatH tracks the chat viewport height from the last rebuild so
	// View() can detect height changes (auxH transitions) and set
	// needsRebuild without running the full rebuild itself.
	prevChatH int

	ShowHelp    bool
	// ToolViewer is the full-screen tool-result overlay. Built lazily
	// from the current Turns when `/tools` fires (so re-opening reflects
	// any tools that completed since the last open). Idx is the row
	// cursor; Expanded flips a single-row preview panel under the list.
	ToolViewer ToolViewerState

	// ModelPicker is the full-screen model picker overlay. Opened by
	// `/model` (no args) or `/models` — shows local GGUF + BYOK cloud
	// entries. ↑/↓ cycles, Enter picks, Esc dismisses.
	ModelPicker ModelPickerState

	FlashText  string
	FlashUntil time.Time

	// PendingSubmit holds text the user typed while a stream was running
	// (P2.3). Enter during StateStreaming captures the composed text into
	// this field and clears the textarea; the next clean StreamDoneMsg
	// auto-submits it. Empty when nothing queued.
	PendingSubmit string

	StreamBuf strings.Builder
	Prog      *tea.Program

	// pendingText/pendingReasoning buffer incoming stream deltas between
	// frame flushes so the viewport rebuilds at most once per 33ms (spec
	// §7/§31.3) instead of on every token. lastFrameFlush is a monotonic guard
	// consulted only by the frameTick handler — it is not read by View().
	pendingText      strings.Builder
	pendingReasoning strings.Builder
	lastFrameFlush   time.Time

	// StreamStartedAt is when the current assistant turn began emitting
	// tokens. Zero when idle. Used by the streaming footer to render an
	// `elapsed` and a tokens-per-second number without recomputing on
	// every tick.
	StreamStartedAt    time.Time
	StreamPromptTokens int
	// StreamCompletionTokens tracks the highest completion_tokens value the
	// host has reported for this turn (`usage` events). LLMs report
	// cumulative counts, so we just take the max rather than summing
	// deltas — saves us from losing precision on out-of-order events.
	StreamCompletionTokens int
	// LastTokenAt is the timestamp of the most recent token emitted during
	// the current stream. Powers the "stalled" indicator: if (now - last)
	// exceeds ~3s without a `done` event, we tag the spinner as stalled so
	// the user knows the agent is still working but not making progress.
	LastTokenAt time.Time
	// streamHasContent is true once the first content (non-reasoning)
	// token arrives. Used to transition StateThinking → StateStreaming
	// (the thinking footer hints only while reasoning precedes text).
	streamHasContent bool

	// RecoverAttempts counts how many reconnect attempts have happened in
	// the current Recovery cycle (spec §3: footer reads "reconnecting…
	// (attempt N)"). Reset to 0 on successful return to StateReady.
	RecoverAttempts int

	// DownloadProgress is the current download byte count + total for the
	// DownloadingModel footer progress line (spec §3). Zero values mean
	// no active download.
	DownloadBytesDone int64
	DownloadBytesTot  int64
	DownloadMBps      float64

	// Completion is one entry in the slash-command autocomplete popup that
	// floats above the input while the user types `/`.
	Completion struct {
		Show bool
		List []CompletionItem
		Idx  int
	}

	// StartedAt is when the TUI booted — used by the welcome screen to
	// show a session-elapsed timer (`⏱ 0:42`).
	StartedAt time.Time

	// Cwd is the working directory the TUI was launched from — shown on
	// the welcome screen, mirroring Claude Code's boot banner.
	Cwd string

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

	// lastUserText is the most recently submitted user message — restored
	// into the textarea (or auto-resent, for rate_limited) on recovery
	// (spec §7 "Interruptions", §14 "auto-retry once at 0").
	lastUserText string

	// RateLimitUntil is non-zero while a rate_limited error's cooldown is
	// counting down. Cleared on the auto-retry.
	RateLimitUntil   time.Time
	retriedRateLimit bool

	// RuntimeEvents are the rendered event lines in the transcript (spec
	// §11). Events arriving during streaming queue in PendingEvents and
	// flush into RuntimeEvents when the stream ends.
	RuntimeEvents   []api.RuntimeEvent
	PendingEvents   []api.RuntimeEvent

	// UsageMode controls the per-turn meta footnote (/usage off|tokens|full,
	// OpenClaw slash parity). "" and "tokens" render the default
	// "12.4s · 842 tok" line; "off" drops it; "full" adds prompt/completion
	// split. Events keep collecting regardless — this is display only.
	UsageMode string

	// EventsHidden suppresses runtime-event lines in the transcript
	// (/verbose off). Default false = curated events shown.
	EventsHidden bool

	// VerboseEvents (/verbose on) shows every raw runtime event instead of
	// the curated allowlist in visibleRuntimeEvents.
	VerboseEvents bool

	// eventsCtx is cancelled when the events SSE goroutine should stop.
	// Set when the app shuts down so we don't leak the HTTP reader.
	eventsCancel func()

	// PriorState stores the state before entering StateWaiting so
	// y/n can restore the right prior state (spec §8 approval prompts).
	PriorState State

	// ApprovalToolID is the tool call ID currently awaiting user approval
	// in StateWaiting. Empty when not in an approval flow.
	ApprovalToolID string

	// Now is the cached wall-clock time for the current Update/View cycle.
	// View() and all renderers read this instead of calling time.Now()
	// directly (spec §34.4: "View and renderers never call time.Now()").
	Now time.Time
}

// ToolViewerRow is one entry in the `/tools` overlay — the flattened
// list of every tool call across every turn, newest first.
type ToolViewerRow struct {
	TurnIdx int
	ToolIdx int
	Call    ToolCall
}

// ToolViewerState holds the open state of the overlay. `Rows` is rebuilt
// every time the overlay opens, so a tool that finished after the last
// open automatically appears. PreviewOffset tracks the scroll position
// inside an expanded preview (P2.4): PgUp/PgDn advances/retreats the
// window of preview lines shown when the result is taller than the
// visible cap.
type ToolViewerState struct {
	Show          bool
	Rows          []ToolViewerRow
	Idx           int
	Expanded      bool
	PreviewOffset int
}

// ModelEntry is one selectable row in the model picker overlay. `ID`
// is passed to `/runtime/model` on switch — local GGUFs use the
// filename, cloud entries carry the `provider:model` tag.
type ModelEntry struct {
	ID       string
	Active   bool
	Kind     string // "local" or "cloud"
	Provider string // cloud provider id (e.g. "nvidia"); empty for local
}

// ModelPickerState is the full-screen model picker overlay. `Rows`
// is rebuilt on open from the latest `/runtime/models` fetch so a
// switch reflects any models added since the last open.
type ModelPickerState struct {
	Show     bool
	Rows     []ModelEntry
	Idx      int
	Loading  bool
	LoadErr  string
}

func New(baseURL, token string, status *api.StatusSnapshot) *App {
	ti := textarea.New()
	ti.Placeholder = "type a message…"
	ti.CharLimit = 0
	ti.ShowLineNumbers = false
	// bubbles' default Prompt is a thick-border "┃ " printed on every line,
	// and the default focused CursorLine paints a filled background — both
	// recreate the boxed look the flat redesign removed from InputStyle.
	// We already render our own "›" once in view.go's renderInput, so strip
	// both here rather than fighting them from the outside.
	ti.Prompt = ""
	ti.FocusedStyle.CursorLine = ti.FocusedStyle.CursorLine.UnsetBackground()
	ti.BlurredStyle.CursorLine = ti.BlurredStyle.CursorLine.UnsetBackground()
	ti.Focus()

	vp := viewport.New(80, 20)
	vp.KeyMap = viewport.DefaultKeyMap()

	sp := spinner.New()
	sp.Style = ui.SpinnerStyle
	// MiniDot matches the spec's braille inventory (§5/§25.3 — ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
	// at ~83 ms/frame, the closest match to spec §31.2's 80 ms/frame target.
	// spinner.Dot uses a different braille sequence at 100 ms/frame.
	sp.Spinner = spinner.MiniDot

	cwd, _ := os.Getwd()

	return &App{
		Status:        status,
		BaseURL:       baseURL,
		Token:         token,
		Input:         ti,
		ChatVP:        vp,
		Loader:        sp,
		StartedAt:     time.Now(),
		FollowBottom:  true,
		needsRebuild:  true,
		Cwd:           cwd,
		State:         StateBoot,
		HistoryIdx:    -1,
		Now:           time.Now(),
	}
}

func (a *App) IsStreaming() bool { return a.State == StateStreaming }

// toolsRunning reports whether any tool in any assistant turn is still
// in-flight. Drives the periodic TickMsg that re-renders the elapsed-time
// column on each running tool pill.
func (a *App) toolsRunning() bool {
	for i := len(a.Turns) - 1; i >= 0; i-- {
		t := a.Turns[i]
		if t.Role != RoleAssistant {
			continue
		}
		for j := range t.Tools {
			if t.Tools[j].Status == ToolRunning {
				return true
			}
		}
		break
	}
	return false
}

// lastAssistantTurn returns a pointer to the trailing assistant turn, or
// nil if none exists yet. Used as the attachment point for new tool calls
// arriving mid-stream.
func (a *App) lastAssistantTurn() *Turn {
	for i := len(a.Turns) - 1; i >= 0; i-- {
		if a.Turns[i].Role == RoleAssistant {
			return &a.Turns[i]
		}
	}
	return nil
}

// runningToolName returns the name of the currently-running tool, or "" if
// no tool is in flight. Drives the ToolRunning footer text (§3).
func (a *App) runningToolName() string {
	for i := len(a.Turns) - 1; i >= 0; i-- {
		t := a.Turns[i]
		if t.Role != RoleAssistant {
			continue
		}
		for j := range t.Tools {
			if t.Tools[j].Status == ToolRunning {
				return t.Tools[j].Name
			}
		}
		break
	}
	return ""
}

// gutter is the 2-space left margin for all transcript content (spec §5).
// Continuation lines, thinking lines, and tool pills all align under this.
var gutter = strings.Repeat(" ", ui.ContentIndent)

// narrowToolLayout reports whether the terminal is in the 60–79 col range
// where the tool tail moves onto the ⎿ line (spec §17).
func (a *App) narrowToolLayout() bool {
	return a.Width >= 60 && a.Width < 80
}

func (a *App) buildChatContent() string {
	if len(a.Turns) == 0 {
		welcome := a.renderWelcomeContent()
		if evs := a.visibleRuntimeEvents(); len(evs) > 0 {
			var b strings.Builder
			b.WriteString(welcome)
			b.WriteByte('\n')
			for _, ev := range evs {
				b.WriteString(gutter + ui.EventStyle.Render(ui.G.Event+" "+formatRuntimeEvent(ev)))
				b.WriteByte('\n')
			}
			return b.String()
		}
		return welcome
	}
	msgWidth := a.ChatVP.Width - ui.ContentIndent
	if msgWidth > ui.MaxProseWidth {
		msgWidth = ui.MaxProseWidth
	}
	widthOK := msgWidth == a.renderWidth

	var b strings.Builder
	for i := range a.Turns {
		turn := &a.Turns[i]

		// Per-turn render cache (§16). When the width hasn't changed and the
		// turn's data hasn't changed, reuse the previous render. This means
		// streaming only re-renders the last one or two turns instead of the
		// entire transcript.
		if widthOK && turn.turnCacheVer == turn.turnVer {
			b.WriteString(turn.turnCache)
			continue
		}

		rendered := a.renderTurn(turn, msgWidth)
		turn.turnCache = rendered
		turn.turnCacheVer = turn.turnVer
		b.WriteString(rendered)
	}
	a.renderWidth = msgWidth

	// Runtime events (§11) — rendered after all turns, between-turn position.
	// Display only; the slice keeps collecting so /verbose on shows what
	// happened meanwhile.
	for _, ev := range a.visibleRuntimeEvents() {
		b.WriteString(gutter + ui.EventStyle.Render(ui.G.Event+" "+formatRuntimeEvent(ev)))
		b.WriteByte('\n')
	}
	return b.String()
}

// visibleRuntimeEvents is the display filter between the raw event slice
// and the transcript (Claude-Code-quiet by default). Three modes:
//   - /verbose off  → nothing
//   - default       → only kinds a user can act on (allowlist), last 3
//   - /verbose on   → everything, uncapped
func (a *App) visibleRuntimeEvents() []api.RuntimeEvent {
	if a.EventsHidden || len(a.RuntimeEvents) == 0 {
		return nil
	}
	if a.VerboseEvents {
		return a.RuntimeEvents
	}
	out := make([]api.RuntimeEvent, 0, 4)
	for _, ev := range a.RuntimeEvents {
		switch ev.Kind {
		case "dream_cycle", "memory_indexed", "memory_indexing",
			"lora_training", "genome_evolution", "genome_tick",
			"meta_evolution", "model_set", "fallback", "tip",
			"connector_event":
			out = append(out, ev)
		}
		// Everything else (heartbeat, usage, done, chunk, fractal_activity,
		// empty kinds…) is plumbing — hidden unless /verbose on.
	}
	if len(out) > 3 {
		out = out[len(out)-3:]
	}
	return out
}

// renderTurn renders one full turn block — the tag line, any reasoning,
// content, tool pills, error cards, meta, and interrupted marker.
func (a *App) renderTurn(turn *Turn, msgWidth int) string {
	var b strings.Builder
	switch turn.Role {
	case RoleUser:
		lines := reflow(turn.Text, msgWidth)
		b.WriteString(gutter + ui.MetaStyle.Render(ui.G.Prompt) + " " + ui.UserContent.Render(lines[0]))
		b.WriteByte('\n')
		for _, line := range lines[1:] {
			b.WriteString(gutter + ui.UserContent.Render(line))
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
		return b.String()
	case RoleAssistant:
		// Reasoning reads like a dim, tag-less "sys" preamble — same
		// gutter indent as continuation lines — before the tagged
		// answer row, since the tag marks the answer, not the thinking.
		if turn.Reasoning != "" {
			if turn.ThinkingOpen {
				b.WriteString(gutter + ui.ThinkingHeader.Render(ui.G.ThinkOpen+" thinking"))
				b.WriteByte('\n')
				for _, line := range reflow(turn.Reasoning, msgWidth-2) {
					b.WriteString(gutter + "  " + ui.ThinkingContent.Render(line))
					b.WriteByte('\n')
				}
			} else {
				// Collapsed mode: live spinner + elapsed while the
				// active turn is still streaming (§9).
				var prefix string
				if turn.Streaming {
					prefix = a.Loader.View() + " thinking"
					if elapsed := a.Now.Sub(a.StreamStartedAt); elapsed > 3*time.Second {
						prefix += fmt.Sprintf(" · %s", formatElapsed(elapsed))
					}
				} else {
					prefix = ui.G.ThinkClosed + " thinking…"
				}
				first := turn.Reasoning
				if idx := strings.Index(first, "\n"); idx >= 0 {
					first = first[:idx]
				}
				first = first[:clampLen(first, msgWidth-2)]
				b.WriteString(gutter + ui.ThinkingCollapsed.Render(prefix) + " " + first)
				b.WriteByte('\n')
			}
		}

		if turn.Text == "" && len(turn.Tools) == 0 && !turn.Streaming && turn.Reasoning == "" {
			// Empty, finished assistant turn with no tools — skip rendering
			// (no content, no tag, nothing to show).
			b.WriteByte('\n')
			return b.String()
		}
		if turn.Text != "" {
			// Plain text during streaming, markdown on completion
			// (§30.8: partial fences produce garbage; defer glamour).
			var rendered string
			if turn.Streaming {
				rendered = turn.Text
			} else {
				rendered = turn.renderMarkdownCached(msgWidth)
			}
			lines := strings.Split(rendered, "\n")
			for i, line := range lines {
				if turn.Streaming && i == len(lines)-1 {
					line += ui.Cursor.Render(ui.G.Cursor)
				}
				b.WriteString(gutter + ui.FeralContent.Render(line))
				b.WriteByte('\n')
			}
		} else {
			b.WriteString(gutter)
			if turn.Streaming {
				b.WriteString(a.Loader.View())
			}
			b.WriteByte('\n')
		}
		if collapsed := collapsedToolSummary(turn, gutter, a.Now); collapsed != "" {
			b.WriteString(collapsed)
			b.WriteByte('\n')
		} else {
			for _, tc := range turn.Tools {
				pill := a.renderToolPill(tc, gutter, msgWidth)
				b.WriteString(gutter + pill)
				b.WriteByte('\n')
			}
		}
		for _, e := range turn.Errors {
			b.WriteString(gutter + a.renderErrorCard(e, msgWidth))
			b.WriteByte('\n')
		}
		if turn.Meta != "" {
			b.WriteString(gutter + ui.MetaStyle.Render(ui.G.Spark+" "+turn.Meta))
			b.WriteByte('\n')
		}
		if turn.Interrupted {
			b.WriteString(gutter + ui.EventStyle.Render(ui.G.Event+" interrupted"))
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
		return b.String()
	}
	return ""
}

func (a *App) rebuildViewport() {
	content := a.buildChatContent()
	a.PrevContent = content
	a.ChatVP.SetContent(content)
	if a.FollowBottom {
		a.ChatVP.GotoBottom()
	}
	a.needsRebuild = false
}

// formatRuntimeEvent renders one event line — the part after the `◦` glyph
// (spec §11 table). Unknown event kinds fall back to `ev.Message` for
// forward-compatibility.
func formatRuntimeEvent(ev api.RuntimeEvent) string {
	switch ev.Kind {
	case "dream_cycle":
		if ev.Message == "" {
			return "dreaming…"
		}
		return "dream: " + ev.Message
	case "memory_indexed", "memory_indexing":
		return "indexing memory… " + ev.Message
	case "lora_training":
		return "lora: " + ev.Message
	case "genome_evolution", "genome_tick":
		return "genome: " + ev.Message
	case "meta_evolution":
		return "meta: " + ev.Message
	case "model_set":
		if ev.Model != "" {
			short := ev.Model
			if idx := strings.LastIndex(short, "/"); idx >= 0 {
				short = short[idx+1:]
			}
			return fmt.Sprintf("routed to %s", short)
		}
		return "routed"
	case "fallback":
		return ui.G.Err + " " + ev.Message
	default:
		if ev.Message != "" {
			return ev.Message
		}
		return ev.Kind
	}
}

// flushPendingEvents drains the PendingEvents queue into RuntimeEvents
// (spec §11: events arriving during streaming flush when the stream ends).
// Applies coalescing: same-kind events within 1s collapse to a summary line.
func (a *App) flushPendingEvents() {
	if len(a.PendingEvents) == 0 {
		return
	}
	for _, ev := range a.PendingEvents {
		a.RuntimeEvents = append(a.RuntimeEvents, ev)
	}
	a.PendingEvents = nil
	// Coalesce: merge consecutive same-kind events into one summary.
	a.coalesceRuntimeEvents()
}

// coalesceRuntimeEvents merges same-kind events that arrived within 1s of
// each other into one summary line (spec §22 acceptance #26).
func (a *App) coalesceRuntimeEvents() {
	if len(a.RuntimeEvents) < 2 {
		return
	}
	merged := make([]api.RuntimeEvent, 0, len(a.RuntimeEvents))
	i := 0
	for i < len(a.RuntimeEvents) {
		j := i + 1
		kind := a.RuntimeEvents[i].Kind
		for j < len(a.RuntimeEvents) && a.RuntimeEvents[j].Kind == kind {
			j++
		}
		count := j - i
		if count > 1 {
			merged = append(merged, api.RuntimeEvent{
				Kind:    kind,
				Message: fmt.Sprintf("%d %s events · /status for detail", count, kind),
			})
		} else {
			merged = append(merged, a.RuntimeEvents[i])
		}
		i = j
	}
	a.RuntimeEvents = merged
}
