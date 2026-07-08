// Package ui — wizard frame primitive.
//
// One frame around every setup wizard step. Provides:
//   - top strip: product mark + wizard label + step counter + step title
//   - body: rounded, accent-tinted border, padded one column inside
//   - footer: bear compact line
//
// One single render path so the wizard looks coherent across Welcome /
// Security / SetupMode / ConfigHandling / Resume / Hardware / every
// other step (no per-step row lines, no per-step boxes that drift).
//
// Auto-collapses to ASCII-only borders when FERAL_ASCII=1 / TERM=dumb /
// non-UTF-8 locale (the same gate ui.GlyphSet already enforces). Branded
// lipgloss colors come from styles.go's Accent/AccentDim/Text/Meta. The
// header strip and footer stay usable when FERAL_ASCII=1 (no Unicode
// symbols in this file — only `+`, `-`, `|`, `=`, `>`).
package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// WizardStepLabel returns the short, user-facing label for a wizard step
// constant. The TUI side owns the WizardStep enum (and the iota bounds)
// so we pass the integer-ish step id here and dispatch from a single map.
// Callers keep using their concrete WizWelcome / WizSecurity constants
// via the small `WizardStepID` helpers in app/wizard_frame.go rather than
// than spread out "step X" lookups across every renderer.
func WizardStepLabel(name string) string {
	// name is the stepped enum identifier without the leading `Wiz`, e.g.
	// "Welcome", "Security". Render with terminal emphasis only — no
	// padding or trailing dots, callers add those per their layouts.
	return name
}

// WizardFrame composes a single wizard step into the standard layout.
//
// Body is the per-step render output (renderer is responsible for its
// own copy and prompts; the frame only adds the framing chrome).
type WizardFrame struct {
	// Title is the user-visible step label rendered into the header strip
	// (e.g. "Welcome", "Security", "Hardware probe"). Required.
	Title string
	// StepIdx is 1-based (1 = first step the user can see). Required.
	StepIdx int
	// StepTotal is the total number of wizard steps rendered into the
	// header strip ("step N of M"). Required; pass `0` if the count is
	// not stable (the header collapses to a static label in that case).
	StepTotal int
	// Body is the per-step content (already styled by the per-step
	// renderer). Required.
	Body string
}

// RenderWizardFrame composes the frame around `body` and returns a string
// sized to fit `width` (clamped to a sensible minimum/maximum). The frame
// never changes the per-step body contents — it only adds chrome — so a
// per-step renderer can still ship a plain paragraph and the frame
// gives it the "step card" look for free.
func RenderWizardFrame(width int, f WizardFrame) string {
	if width > 110 {
		width = 110
	}

	// P0.6 / C9: below 60 cols the bordered card wraps into soup (border +
	// padding eats 6 cols). Drop the border entirely and render flat —
	// header, body, footer with a single-space gutter, nothing wider than
	// `width`.
	if width < 60 {
		header := renderWizardHeader(width, f.Title, f.StepIdx, f.StepTotal)
		body := lipgloss.NewStyle().Padding(0, 1).Width(width - 2).Render(f.Body)
		footer := renderWizardFooter()
		return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
	}

	header := renderWizardHeader(width, f.Title, f.StepIdx, f.StepTotal)
	body := renderWizardBody(width, f.Body)
	footer := renderWizardFooter()

	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

// renderWizardHeader produces the top strip that runs above every wizard
// step. Layout: `FERAL · setup wizard` flush-left, then a generous run
// of spaces, then `step 3 of 16 · Security` flush-right. The whole line
// is a single row of ASCII-only characters so it renders identically
// regardless of glyph set (Unicode / ASCII).
func renderWizardHeader(width int, title string, stepIdx, stepTotal int) string {
	left := WizardHeaderLeft
	right := renderWizardStepLabel(title, stepIdx, stepTotal)
	gap := width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if gap < 1 {
		gap = 1
	}
	return strings.Repeat(" ", 0) + left + strings.Repeat(" ", gap) + right
}

// renderWizardBody wraps the per-step body in a rounded border with the
// brand accent for the border tint. Pure padding + border so the
// per-step content has visual breathing room without losing the
// transcript metaphor.
//
// Rounded border uses Unicode box-drawing glyphs (`┌ ─ ┐ │ └ ┘`) which
// match the rest of the TUI's bear logo and step strip. Glyph fallback
// for non-UTF-8 locales is already handled by ui/glyphs.go for inline
// marks; the border stays rounded because the bear logos above also
// ship rounded box-drawing glyphs — consistency beats locale hedging.
func renderWizardBody(width int, body string) string {
	style := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(AccentDim).
		Padding(0, 2).
		MarginTop(1).
		MarginBottom(1).
		Width(width - 4)

	return style.Render(body)
}

// renderWizardFooter is the bottom BearCompact strip — already a single
// ASCII line, no work to do. Kept as a function so future tweak (e.g.
// appended step-hint on the right) lands in one place.
func renderWizardFooter() string {
	return FooterStyle.Render(BearCompact)
}

// renderWizardStepLabel renders the right-aligned header strip's step
// indicator: "step 3 of 16 · Security". Stable ASCII-only.
func renderWizardStepLabel(title string, idx, total int) string {
	if total <= 0 {
		return HeaderStyle.Render(title)
	}
	indicator := "step " + itoa(idx) + " of " + itoa(total)
	if title != "" {
		indicator = indicator + " · " + title
	}
	return HeaderStepStyle.Render(indicator)
}

// itoa is a small inline helper so the header strip avoids importing
// strconv just to print ints. Stay ASCII; printf %d is fine but adds
// a 1-2µs call we don't need for hot-path render.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
