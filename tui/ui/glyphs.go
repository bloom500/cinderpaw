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
	Running     string // ⠿  / |  (static "in flight" indicator on tool pills)
	Down        string // ↓  / v
	Up          string // ↑  / ^
	Ellipsis    string // …  / ...
	Cursor      string // ▍  / |
	Stream      string // ▌  / |  (streaming cursor indicator)
	Timer       string // ⏱  / t:  (elapsed timer glyph)
	Stalled     string // ⏳  / ...  (stalled/thinking indicator)
	Spinner     []string
}

var Unicode = GlyphSet{
	Prompt: "›", ToolMark: "⏺", Result: "⎿", ThinkClosed: "▸", ThinkOpen: "▾",
	On: "●", Off: "○", Event: "◦", Spark: "✻", OK: "✓", Err: "✗",
	Running: "⠿",
	Down: "↓", Up: "↑", Ellipsis: "…", Cursor: "▍",
	Stream: "▌", Timer: "⏱", Stalled: "⏳",
	Spinner: []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"},
}

var Ascii = GlyphSet{
	Prompt: ">", ToolMark: "*", Result: "`-", ThinkClosed: "+", ThinkOpen: "-",
	On: "o", Off: ".", Event: "-", Spark: "*", OK: "ok", Err: "x",
	Running: "|",
	Down: "v", Up: "^", Ellipsis: "...", Cursor: "|",
	Stream: "|", Timer: "t:", Stalled: "...",
	Spinner: []string{"|", "/", "-", "\\"},
}

// pickWith selects Ascii when CINDERPAW_ASCII=1, TERM=dumb, or the locale
// isn't UTF-8 — env is injected so tests don't need to mutate process env.
//
// FERAL_ASCII is the old name and still works: someone who put it in a shell
// profile before the rename is exactly the person who needs ASCII glyphs, and
// silently dropping back to Unicode fills their terminal with boxes.
func pickWith(env func(string) string) GlyphSet {
	if env("CINDERPAW_ASCII") == "1" || env("FERAL_ASCII") == "1" {
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
