package ui

import (
	"os"
	"strings"
	"sync"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// Palette is AdaptiveColor so light terminals get a legible dark-on-light
// variant (P0.5 / C6). Both AdaptiveColor and Color satisfy
// lipgloss.TerminalColor, so every .Foreground(X) call site compiles
// unchanged.
var (
	Accent    = lipgloss.AdaptiveColor{Light: "#C2632A", Dark: "#EC8C4C"}
	AccentHi  = lipgloss.AdaptiveColor{Light: "#A85520", Dark: "#F2A466"}
	AccentDim = lipgloss.AdaptiveColor{Light: "#D9A87E", Dark: "#89532F"}
	Text      = lipgloss.AdaptiveColor{Light: "#2B2620", Dark: "#E4DDD2"}
	Meta      = lipgloss.AdaptiveColor{Light: "#8A8378", Dark: "#7A746B"}
	Ok        = lipgloss.AdaptiveColor{Light: "#4F7A38", Dark: "#8FB77A"}
	Warn      = lipgloss.AdaptiveColor{Light: "#9A741F", Dark: "#D6A95A"}
	Fail      = lipgloss.AdaptiveColor{Light: "#B23A28", Dark: "#D16B5A"}
)

// TagWidth is the retiring two-column tag width — kept for backward compat
// but superseded by ContentIndent (2-space gutter, spec §5/§26).
const TagWidth = 9

// ContentIndent is the 2-space gutter prefix for all transcript content
// (§25.2). Replaces the retired TagWidth in the gutter layout.
const ContentIndent = 2

// ResultIndent is the 4-space indent for tool result lines (§25.2).
// One level deeper than ContentIndent so results read as children of the
// tool call pill above them.
const ResultIndent = 4

// MaxProseWidth caps the message text column width in ultrawide terminals
// (§30.5). On displays wider than 160 cols prose wraps at min(W-4, 110).
const MaxProseWidth = 110

var (
	HeaderStyle = lipgloss.NewStyle().Padding(0, 1)

	StatusOnline  = lipgloss.NewStyle().Foreground(Ok)
	StatusOffline = lipgloss.NewStyle().Foreground(Fail)

	BrandStyle   = lipgloss.NewStyle().Foreground(Accent).Bold(true)
	HeaderValue  = lipgloss.NewStyle().Foreground(Text) // header segment values

	TagYou   = lipgloss.NewStyle().Foreground(AccentHi).Width(TagWidth).Align(lipgloss.Right)
	TagFeral = lipgloss.NewStyle().Foreground(Accent).Width(TagWidth).Align(lipgloss.Left)
	Cursor   = lipgloss.NewStyle().Foreground(Accent)

	UserContent  = lipgloss.NewStyle().Foreground(Meta) // settled history (§6)
	FeralContent = lipgloss.NewStyle().Foreground(Text)

	// Welcome screen — bigger surface, more breathing room than a transcript row.
	WelcomeTagline  = lipgloss.NewStyle().Foreground(AccentHi)
	WelcomeLabel    = lipgloss.NewStyle().Foreground(Meta).Width(9).Align(lipgloss.Right)
	WelcomeValue    = lipgloss.NewStyle().Foreground(Text)
	WelcomeSess     = lipgloss.NewStyle().Foreground(Text)
	WelcomeSessMeta = lipgloss.NewStyle().Foreground(Meta)
	WelcomeSection  = lipgloss.NewStyle().Foreground(Meta).Bold(true)
	KbdStyle        = lipgloss.NewStyle().Foreground(Text).Background(lipgloss.AdaptiveColor{Light: "#E8E2D8", Dark: "#1b1b1f"}).Padding(0, 1)

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
	ToolMark   = lipgloss.NewStyle()
	ToolResult = lipgloss.NewStyle().Foreground(Meta)

	// Error cards — one border per kind. Same shape, different tint so the
	// eye categorises the failure before reading the message.
	ErrorTitle = lipgloss.NewStyle().Foreground(Fail).Bold(true)
	ErrorMsg   = lipgloss.NewStyle().Foreground(Text)
	ErrorHint  = lipgloss.NewStyle().Foreground(Meta).Italic(true)

	// Tool-result viewer overlay (full-screen, mirrors help/history).
	ToolViewerBox     = lipgloss.NewStyle().Padding(0, 2)
	ToolViewerTitle   = lipgloss.NewStyle().Foreground(AccentHi).Bold(true)
	ToolViewerRow     = lipgloss.NewStyle().Foreground(Text)
	ToolViewerSel     = lipgloss.NewStyle().Foreground(Accent).Bold(true)
	ToolViewerMeta    = lipgloss.NewStyle().Foreground(Meta)
	ToolViewerPreview = lipgloss.NewStyle().Foreground(Meta).Italic(true)

	// Autocomplete popup — slim box, dim border, one row per completion.
	CompletionBox  = lipgloss.NewStyle().Padding(0, 1)
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

	ThinkingHeader    = lipgloss.NewStyle().Foreground(Meta)
	ThinkingContent   = lipgloss.NewStyle().Foreground(Meta).Italic(true)
	ThinkingCollapsed = lipgloss.NewStyle().Foreground(Meta)

	SeparatorStyle = lipgloss.NewStyle().Foreground(Meta)

	// Diff line styles for unified-diff previews (git_diff tool output, or
	// any tool result that looks like one). Bold +/- so the color reads at
	// a glance even in terminals with a low-contrast theme.
	DiffAdd  = lipgloss.NewStyle().Foreground(Ok)
	DiffDel  = lipgloss.NewStyle().Foreground(Fail)
	DiffHunk = lipgloss.NewStyle().Foreground(Meta).Italic(true)
	DiffFile = lipgloss.NewStyle().Foreground(AccentHi).Bold(true)
	// InputPrompt is the leading glyph on the input row — Claude-Code style
	// "› " prompt instead of a bordered box. No Border/Background: the
	// blank line above the input (see view.go's `sep`) is the only visual
	// separator.
	InputPrompt      = lipgloss.NewStyle().Foreground(Accent)
	InputStyle       = lipgloss.NewStyle().Padding(0, 1)
	InputPlaceholder = lipgloss.NewStyle().Foreground(Meta).Italic(true)
	FooterStyle      = lipgloss.NewStyle().Foreground(Meta).Padding(0, 1)

	FlashStyle = lipgloss.NewStyle().Foreground(Warn)
	MetaStyle  = lipgloss.NewStyle().Foreground(Meta)

	// EventStyle renders the "◦ …" receipt lines (spec §11/§15).
	EventStyle    = lipgloss.NewStyle().Foreground(Meta)
	EventWarnMark = lipgloss.NewStyle().Foreground(Warn) // warn-event glyph (§11)

	// ProgressStyle renders footer progress for downloads (§15).
	ProgressStyle = lipgloss.NewStyle().Foreground(Meta)

	// ApprovalStyle renders confirmation prompts (§8).
	ApprovalStyle = lipgloss.NewStyle().Foreground(Warn)

	// Wizard styles (§13, §26).
	OkStyle     = lipgloss.NewStyle().Foreground(Ok)
	WarnStyle   = lipgloss.NewStyle().Foreground(Warn)
	AccentStyle = lipgloss.NewStyle().Foreground(Accent)
	WizardTitle = lipgloss.NewStyle().Foreground(AccentHi) // ✻ setting up feral
	WizardBody  = lipgloss.NewStyle().Foreground(Text)     // body prose
	WizardKey   = lipgloss.NewStyle().Foreground(Accent)   // option number
	WizardNote  = lipgloss.NewStyle().Foreground(Meta).Italic(true) // recommendation text

	// Wizard frame — the chrome that wraps every wizard step
	// (wizard_frame.go). Two halves: left side ("FERAL  setup wizard")
	// is brand-coloured, right side ("step N of M  -  Title") is meta.
	// Footer style already declared above; aliased here for one-call use.
	WizardHeaderLeft   = BrandStyle.Render(AppName) + " " + MetaStyle.Render("setup wizard")
	HeaderStepStyle    = lipgloss.NewStyle().Foreground(Meta)
	WizardFooterStyle  = FooterStyle

	OkMark = lipgloss.NewStyle().Foreground(Ok) // success glyph

	SpinnerStyle = lipgloss.NewStyle().Foreground(Accent)

	HelpTitle = lipgloss.NewStyle().Foreground(AccentHi).Bold(true)
	HelpKey   = lipgloss.NewStyle().Foreground(Accent)
	HelpDesc  = lipgloss.NewStyle().Foreground(Text)
	HelpMeta  = lipgloss.NewStyle().Foreground(Meta)
)

// feralStyleJSON is the Glamour brand theme (§30.2) — headings bold Text,
// links underlined Accent, code spans AccentHi on no background, blockquotes
// Meta italic with 2-space indent.
var feralStyleJSON = []byte(`{
  "document": {
    "block_prefix": "\n",
    "block_suffix": "\n",
    "color": "#E4DDD2",
    "margin": 2
  },
  "block_quote": {
    "indent": 2,
    "indent_token": "",
    "color": "#7A746B",
    "italic": true
  },
  "paragraph": {},
  "list": {
    "level_indent": 2
  },
  "heading": {
    "block_suffix": "\n",
    "color": "#E4DDD2",
    "bold": true
  },
  "h1": { "color": "#E4DDD2", "bold": true },
  "h2": { "color": "#E4DDD2", "bold": true },
  "h3": { "color": "#E4DDD2", "bold": true },
  "h4": { "color": "#E4DDD2", "bold": true },
  "h5": { "color": "#E4DDD2", "bold": true },
  "h6": { "color": "#E4DDD2", "bold": true },
  "text": {},
  "strikethrough": { "crossed_out": true },
  "emph": { "italic": true },
  "strong": { "bold": true },
  "hr": { "color": "#7A746B", "format": "\n\n" },
  "item": { "block_prefix": "\u2022 " },
  "enumeration": { "block_prefix": ". " },
  "task": { "ticked": "[\u2713] ", "unticked": "[ ] " },
  "link": { "color": "#EC8C4C", "underline": true },
  "link_text": { "color": "#EC8C4C", "bold": true },
  "image": { "color": "#EC8C4C", "underline": true },
  "image_text": { "color": "#7A746B", "format": "Image: {{.text}} \u2192" },
  "code": { "prefix": " ", "suffix": " ", "color": "#F2A466" },
  "code_block": {
    "color": "#7A746B",
    "margin": 2,
    "chroma": {
      "text": { "color": "#7A746B" },
      "error": { "color": "#D16B5A" },
      "comment": { "color": "#6E6A63" },
      "keyword": { "color": "#EC8C4C" },
      "literal_string": { "color": "#8FB77A" },
      "literal_number": { "color": "#D6A95A" },
      "name_function": { "color": "#F2A466" },
      "name_tag": { "color": "#EC8C4C" },
      "operator": { "color": "#E4DDD2" }
    }
  },
  "table": { "wrap": true },
  "definition_list": {},
  "definition_term": {},
  "definition_description": {},
  "html_block": {},
  "html_span": {}
}`)

var (
	glamourRenderers   = make(map[int]*glamour.TermRenderer)
	glamourRenderersMu sync.RWMutex
)

// ApplyNoColor collapses every lipgloss style process-wide to plain
// text+bold when NO_COLOR is set (spec §18, §30.8) — one global switch,
// not per-style handling. env is injected so tests can exercise both
// branches without mutating the real process environment.
func ApplyNoColor(env func(string) string) {
	if env("NO_COLOR") != "" {
		lipgloss.SetColorProfile(termenv.Ascii)
	} else {
		lipgloss.SetColorProfile(termenv.TrueColor)
	}
}

func init() {
	ApplyNoColor(os.Getenv)
}

func RenderMarkdown(md string, width int) string {
	if md == "" {
		return md
	}

	glamourRenderersMu.RLock()
	r, ok := glamourRenderers[width]
	glamourRenderersMu.RUnlock()
	if !ok {
		var err error
		r, err = glamour.NewTermRenderer(
			glamour.WithStylesFromJSONBytes(feralStyleJSON),
			glamour.WithWordWrap(width),
		)
		if err != nil {
			return md
		}
		glamourRenderersMu.Lock()
		glamourRenderers[width] = r
		glamourRenderersMu.Unlock()
	}

	out, err := r.Render(md)
	if err != nil {
		return md
	}
	out = strings.TrimRight(out, "\n")
	return out
}
