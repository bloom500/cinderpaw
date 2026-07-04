package app

import (
	"strings"
	"time"

	"feral-tui/api"
	"feral-tui/ui"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

type (
	Mode    int
	TickMsg time.Time
)

const (
	ModeEditing Mode = iota
	ModeStreaming
	ModeQuitting
)

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
	Mode  Mode

	Sessions      []api.SessionSummary
	SessionsErr   error
	SessionsAt    time.Time

	ChatVP      viewport.Model
	Input       textarea.Model
	Loader      spinner.Model
	PrevContent string

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
	ti.Focus()

	vp := viewport.New(80, 20)
	vp.KeyMap = viewport.DefaultKeyMap()

	sp := spinner.New()
	sp.Style = ui.SpinnerStyle
	sp.Spinner = spinner.Dot

	return &App{
		Status:    status,
		BaseURL:   baseURL,
		Token:     token,
		Input:     ti,
		ChatVP:    vp,
		Loader:    sp,
		StartedAt: time.Now(),
	}
}

func (a *App) IsStreaming() bool { return a.Mode == ModeStreaming }

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
	for _, turn := range a.Turns {
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
					b.WriteString(gutter + ui.ThinkingHeader.String())
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
					b.WriteString(gutter + ui.ThinkingCollapsed.String() + " " + first)
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
				rendered := ui.RenderMarkdown(turn.Text, msgWidth)
				lines := strings.Split(rendered, "\n")
				for i, line := range lines {
					if turn.Streaming && i == len(lines)-1 {
						line += ui.Cursor.String()
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
			// so they read as part of this turn's transcript.
			for _, tc := range turn.Tools {
				pill := a.renderToolPill(tc, gutter, msgWidth)
				b.WriteString(gutter + pill)
				b.WriteByte('\n')
			}
			// Error cards — bordered boxes, prefixed with the gutter so
			// they align with the pills above.
			for _, e := range turn.Errors {
				b.WriteString(gutter + a.renderErrorCard(e, msgWidth-TagIndent))
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
		if !a.ChatVP.AtBottom() {
			a.ChatVP.GotoBottom()
		}
	}
}
