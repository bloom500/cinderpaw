package ui

import (
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)

var (
	Accent    = lipgloss.Color("#EC8C4C")
	AccentHi  = lipgloss.Color("#F2A466")
	AccentDim = lipgloss.Color("#89532F")
	Text      = lipgloss.Color("#E4DDD2")
	Meta      = lipgloss.Color("#7A746B")
	Ok        = lipgloss.Color("#8FB77A")
	Warn      = lipgloss.Color("#D6A95A")
	Fail      = lipgloss.Color("#D16B5A")
)

// TagWidth is the fixed left column both turn tags align to — "you" right-
// aligned, "◆ feral" left-aligned — so messages start at the same column
// regardless of role, matching the two-column transcript grid in the design.
const TagWidth = 9

var (
	HeaderStyle = lipgloss.NewStyle()

	StatusOnline  = lipgloss.NewStyle().Foreground(Ok).SetString("●")
	StatusOffline = lipgloss.NewStyle().Foreground(Fail).SetString("●")

	BrandStyle = lipgloss.NewStyle().Foreground(Accent).Bold(true)
	CaretStyle = lipgloss.NewStyle().Foreground(AccentDim)

	TagYou   = lipgloss.NewStyle().Foreground(AccentHi).Width(TagWidth).Align(lipgloss.Right)
	TagFeral = lipgloss.NewStyle().Foreground(Accent).Width(TagWidth).Align(lipgloss.Left)
	Cursor   = lipgloss.NewStyle().Foreground(Accent).SetString("▌")

	UserContent  = lipgloss.NewStyle().Foreground(Text)
	FeralContent = lipgloss.NewStyle().Foreground(Text)

	// Welcome screen — bigger surface, more breathing room than a transcript row.
	WelcomeTagline = lipgloss.NewStyle().Foreground(AccentHi)
	WelcomeLabel   = lipgloss.NewStyle().Foreground(Meta).Width(9).Align(lipgloss.Right)
	WelcomeValue   = lipgloss.NewStyle().Foreground(Text)
	WelcomeSess    = lipgloss.NewStyle().Foreground(Text)
	WelcomeSessMeta = lipgloss.NewStyle().Foreground(Meta)
	WelcomeSection = lipgloss.NewStyle().Foreground(Meta).Bold(true)
	KbdStyle       = lipgloss.NewStyle().Foreground(Text).Background(lipgloss.Color("#1b1b1f")).Padding(0, 1)

	// Tool-call pills — three statuses share the same shape so the eye
	// reads the coloured leading dot and trailing ✓/!/⏱ first.
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

	// Error cards — one border per kind. Same shape, different tint so the
	// eye categorises the failure before reading the message.
	ErrorTitle  = lipgloss.NewStyle().Foreground(Fail).Bold(true)
	ErrorMeta   = lipgloss.NewStyle().Foreground(Warn).Bold(true)
	ErrorMsg    = lipgloss.NewStyle().Foreground(Text)
	ErrorHint   = lipgloss.NewStyle().Foreground(Meta).Italic(true)

	// Tool-result viewer overlay (full-screen, mirrors help/history).
	ToolViewerBox = lipgloss.NewStyle().Padding(0, 2)
	ToolViewerTitle = lipgloss.NewStyle().Foreground(AccentHi).Bold(true)
	ToolViewerRow   = lipgloss.NewStyle().Foreground(Text)
	ToolViewerSel   = lipgloss.NewStyle().Foreground(Accent).Bold(true)
	ToolViewerMeta  = lipgloss.NewStyle().Foreground(Meta)
	ToolViewerPreview = lipgloss.NewStyle().Foreground(Meta).Italic(true)

	// Autocomplete popup — slim box, dim border, one row per completion.
	CompletionBox = lipgloss.NewStyle().Padding(0, 1)
	CompletionSel  = lipgloss.NewStyle().Foreground(Accent).Bold(true)
	CompletionItem = lipgloss.NewStyle().Foreground(Text)
	CompletionDesc = lipgloss.NewStyle().Foreground(Meta)
	CompletionHint = lipgloss.NewStyle().Foreground(Meta).Italic(true)

	// Streaming footer — the rich status line that replaces "streaming… ⠿"
	// while the agent is mid-turn. Tokens/tps/elapsed are right-aligned so
	// the eye reads left-to-right: status → numbers.
	StreamStatus  = lipgloss.NewStyle().Foreground(Accent)
	StreamDim     = lipgloss.NewStyle().Foreground(Meta)
	StreamNumber  = lipgloss.NewStyle().Foreground(Text)
	StreamHint    = lipgloss.NewStyle().Foreground(Meta)
	StreamStalled = lipgloss.NewStyle().Foreground(Warn).Italic(true)

	ThinkingHeader    = lipgloss.NewStyle().Foreground(Meta).SetString("▾ thinking")
	ThinkingContent   = lipgloss.NewStyle().Foreground(Meta).Italic(true)
	ThinkingCollapsed = lipgloss.NewStyle().Foreground(Meta).SetString("▸ thinking…")

	SeparatorStyle = lipgloss.NewStyle().Foreground(Meta)
	// InputPrompt is the leading glyph on the input row — Claude-Code style
	// "› " prompt instead of a bordered box. No Border/Background: the
	// horizontal rule already drawn above the input (see view.go's `sep`)
	// is the only visual separator.
	InputPrompt = lipgloss.NewStyle().Foreground(Accent).SetString("›")
	InputStyle  = lipgloss.NewStyle().Padding(0, 1)
	InputPlaceholder = lipgloss.NewStyle().Foreground(Meta).Italic(true)
	FooterStyle    = lipgloss.NewStyle().Foreground(Meta).Padding(0, 1)

	FlashStyle = lipgloss.NewStyle().Foreground(Warn)
	MetaStyle  = lipgloss.NewStyle().Foreground(Meta)

	SpinnerStyle = lipgloss.NewStyle().Foreground(Accent)

	HelpTitle = lipgloss.NewStyle().Foreground(AccentHi).Bold(true)
	HelpKey   = lipgloss.NewStyle().Foreground(Accent)
	HelpDesc  = lipgloss.NewStyle().Foreground(Text)
	HelpMeta  = lipgloss.NewStyle().Foreground(Meta)
)

var glamourRenderer *glamour.TermRenderer

func init() {
	r, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(10000),
	)
	if err == nil {
		glamourRenderer = r
	}
}

func RenderMarkdown(md string, width int) string {
	if glamourRenderer == nil || md == "" {
		return md
	}
	// Strip trailing newline glamour adds
	out, err := glamourRenderer.Render(md)
	if err != nil {
		return md
	}
	out = strings.TrimRight(out, "\n")
	return out
}
