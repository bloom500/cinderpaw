package ui

import (
	"os"
	"strings"
)

// GlyphSet is the complete glyph inventory (spec §5/§25.3). Renderers use
// ui.G.X, never a literal glyph — this is the entire ASCII-mode
// implementation: one table, one switch, zero scattered literals.
type GlyphSet struct {
	Prompt      string // ›  / >
	ToolMark    string // ⏺  / *
	Result      string // ⎿  / `-
	ThinkClosed string // ▸  / +
	ThinkOpen   string // ▾  / -
	On          string // ●  / o
	Off         string // ○  / .
	Event       string // ◦  / -
	Spark       string // ✻  / *
	OK          string // ✓  / ok
	Err         string // ✗  / x
	Down        string // ↓  / v
	Up          string // ↑  / ^
	Ellipsis    string // …  / ...
	Cursor      string // ▍  / |
	Spinner     []string
}

var Unicode = GlyphSet{
	Prompt: "›", ToolMark: "⏺", Result: "⎿", ThinkClosed: "▸", ThinkOpen: "▾",
	On: "●", Off: "○", Event: "◦", Spark: "✻", OK: "✓", Err: "✗",
	Down: "↓", Up: "↑", Ellipsis: "…", Cursor: "▍",
	Spinner: []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"},
}

var Ascii = GlyphSet{
	Prompt: ">", ToolMark: "*", Result: "`-", ThinkClosed: "+", ThinkOpen: "-",
	On: "o", Off: ".", Event: "-", Spark: "*", OK: "ok", Err: "x",
	Down: "v", Up: "^", Ellipsis: "...", Cursor: "|",
	Spinner: []string{"|", "/", "-", "\\"},
}

// pickWith selects Ascii when FERAL_ASCII=1, TERM=dumb, or the locale isn't
// UTF-8 — env is injected so tests don't need to mutate process env.
func pickWith(env func(string) string) GlyphSet {
	if env("FERAL_ASCII") == "1" {
		return Ascii
	}
	if env("TERM") == "dumb" {
		return Ascii
	}
	locale := env("LC_ALL")
	if locale == "" {
		locale = env("LANG")
	}
	if locale != "" && !strings.Contains(strings.ToUpper(locale), "UTF-8") &&
		!strings.Contains(strings.ToUpper(locale), "UTF8") {
		return Ascii
	}
	return Unicode
}

// G is the process-wide picked glyph set, resolved once at package init
// from the real environment.
var G = pickWith(os.Getenv)
