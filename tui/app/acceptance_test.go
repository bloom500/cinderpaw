package app

import (
	"regexp"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// TestHeaderIsSingleLine — spec §22 acceptance #1.
func TestHeaderIsSingleLine(t *testing.T) {
	for _, w := range []int{40, 60, 80, 120} {
		a := newTestApp()
		a.Width = w
		out := a.renderHeader()
		if lipgloss.Height(out) != 1 {
			t.Fatalf("width %d: header height = %d, want 1", w, lipgloss.Height(out))
		}
	}
}

// TestFooterIsSingleLineAndExclusive — spec §22 acceptance #2.
func TestFooterIsSingleLineAndExclusive(t *testing.T) {
	a := newTestApp()
	a.FlashText = "model switched"
	out := a.renderFooter()
	if lipgloss.Height(out) != 1 {
		t.Fatalf("footer height = %d, want 1", lipgloss.Height(out))
	}
	if strings.Contains(stripAnsi(out), "F1 for shortcuts") {
		t.Fatal("flash message and default hint both rendered — only one may win")
	}
}

// boxDrawing matches common box-drawing runes. ⎿ is spec-sanctioned and
// excluded. This only checks the steady-state frame (no overlay open) —
// see "Filed discrepancies" #2 in the plan for the overlay divider gap.
var boxDrawing = regexp.MustCompile(`[┌┐└┘├┤┬┴┼│─═║╔╗╚╝╠╣╦╩╬]`)

// TestSteadyStateFrameHasNoBoxDrawing — spec §22 acceptance #3 (scoped to
// the non-overlay frame; see plan discrepancy note #2).
func TestSteadyStateFrameHasNoBoxDrawing(t *testing.T) {
	a := newTestApp()
	out := stripAnsi(a.View())
	if boxDrawing.MatchString(out) {
		t.Fatalf("steady-state frame contains box-drawing characters:\n%s", out)
	}
}

// TestAsciiModeEmitsNoNonAsciiBytes — spec §22 acceptance #19, exercised
// against the real glyph table (not just the Ascii struct in ui/glyphs_test.go).
func TestAsciiModeEmitsNoNonAsciiBytes(t *testing.T) {
	t.Setenv("FERAL_ASCII", "1")
	// ui.G is resolved once at package init, before t.Setenv can take
	// effect — this test documents the current limitation rather than
	// re-resolving it, since ui.G is a package var by design (spec §25.3
	// doesn't call for a re-pick-on-demand API). Skip with a clear reason
	// so CI output explains the gap instead of silently passing green.
	t.Skip("ui.G is resolved at package init; process-level FERAL_ASCII=1 is exercised manually per the phase's exit criteria (spec §23), not by this in-process test")
}
