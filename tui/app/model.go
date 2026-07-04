package app

import (
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

	// mdCacheSrc/mdCacheOut/mdCacheWidth memoize the last glamour render of
	// Text. Every tea.Msg (a token, a spinner tick, a resize) rebuilds the
	// WHOLE transcript, so without this every past turn's markdown was
	// re-rendered on every frame — O(history size) work per keystroke.
	// Only the actively-streaming turn's Text actually changes between
	// frames, so this makes every other turn a cache hit.
	mdCacheSrc   string
	mdCacheOut   string
	mdCacheWidth int
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

type App struct {
	Width, Height int

	Status  *api.StatusSnapshot
	BaseURL string
	Token   string

	Turns []Turn
	State State

	Sessions      []api.SessionSummary
	SessionsErr   error
	SessionsAt    time.Time

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

	ShowHelp    bool
	ShowHistory bool
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

	StreamBuf strings.Builder
	Prog      *tea.Program

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
// open automatically appears.
type ToolViewerState struct {
	Show     bool
	Rows     []ToolViewerRow
	Idx      int
	Expanded bool
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
	sp.Spinner = spinner.Dot

	cwd, _ := os.Getwd()

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
		HistoryIdx:   -1,
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

// gutter is the blank left margin every continuation line (wrapped message
// lines, thinking lines) aligns under — one space past the tag column, so
// text starts at the same column the tag's own text ends on.
var gutter = strings.Repeat(" ", ui.TagWidth+1)

func (a *App) buildChatContent() string {
	if len(a.Turns) == 0 {
		return a.renderWelcomeContent()
	}
	msgWidth := a.ChatVP.Width - ui.TagWidth - 1
	var b strings.Builder
	for i := range a.Turns {
		turn := &a.Turns[i]
		switch turn.Role {
		case RoleUser:
			tag := ui.TagYou.Render("you")
			lines := reflow(turn.Text, msgWidth)
			b.WriteString(tag + " " + ui.UserContent.Render(lines[0]))
			b.WriteByte('\n')
			for _, line := range lines[1:] {
				b.WriteString(gutter + ui.UserContent.Render(line))
				b.WriteByte('\n')
			}
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
					first := turn.Reasoning
					if idx := strings.Index(first, "\n"); idx >= 0 {
						first = first[:idx]
					}
					first = first[:clampLen(first, msgWidth-2)]
					b.WriteString(gutter + ui.ThinkingCollapsed.Render(ui.G.ThinkClosed+" thinking…") + " " + first)
					b.WriteByte('\n')
				}
			}

			tag := ui.TagFeral.Render("◆ feral")
			if turn.Text == "" && len(turn.Tools) == 0 {
				b.WriteString(tag)
				if turn.Streaming {
					b.WriteString(" " + a.Loader.View())
				}
				b.WriteByte('\n')
				break
			}
			if turn.Text != "" {
				rendered := turn.renderMarkdownCached(msgWidth)
				lines := strings.Split(rendered, "\n")
				for i, line := range lines {
					if turn.Streaming && i == len(lines)-1 {
						line += ui.Cursor.Render(ui.G.Cursor)
					}
					if i == 0 {
						b.WriteString(tag + " " + ui.FeralContent.Render(line))
					} else {
						b.WriteString(gutter + ui.FeralContent.Render(line))
					}
					b.WriteByte('\n')
				}
			} else {
				// Empty body but tool calls present — still emit the tag so
				// the pill block below has a visual owner.
				b.WriteString(tag)
				if turn.Streaming {
					b.WriteString(" " + a.Loader.View())
				}
				b.WriteByte('\n')
			}
			// Tool pills — rendered under the tag, indented to the gutter
			// so they read as part of this turn's transcript. A long burst
			// of successful calls collapses to one summary line (full
			// detail stays one keystroke away via /tools) so a 20-tool-call
			// turn doesn't push the whole scrollback off-screen; streaming
			// turns and any turn with an error always show every pill so
			// live progress and failures stay visible.
			if collapsed := collapsedToolSummary(turn, gutter); collapsed != "" {
				b.WriteString(collapsed)
				b.WriteByte('\n')
			} else {
				for _, tc := range turn.Tools {
					pill := a.renderToolPill(tc, gutter, msgWidth)
					b.WriteString(gutter + pill)
					b.WriteByte('\n')
				}
			}
			// Error cards — bordered boxes, prefixed with the gutter so
			// they align with the pills above.
			for _, e := range turn.Errors {
				b.WriteString(gutter + a.renderErrorCard(e, msgWidth-TagIndent))
				b.WriteByte('\n')
			}
			// Per-turn cost footnote, dim — Claude Code's "✻ Cooked for Ns".
			if turn.Meta != "" {
				b.WriteString(gutter + ui.MetaStyle.Render(ui.G.Spark+" "+turn.Meta))
				b.WriteByte('\n')
			}
		}
		b.WriteByte('\n')
	}
	return b.String()
}

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
