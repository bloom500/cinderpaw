package app

// Repro for the 2026-07-11 blank-screen report: maximized terminal
// (~239×64), fresh boot, user types — screen shows only the input line.
// Drives the REAL message flow (WindowSizeMsg → BootComplete → keys) and
// asserts the frame still contains header, welcome content, and footer.

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestMaximizedTerminalRendersFullFrame(t *testing.T) {
	a := newTestApp()
	a.Update(tea.WindowSizeMsg{Width: 239, Height: 64})
	a.Update(BootComplete{})
	for _, r := range "dadada" {
		a.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	out := stripAnsi(a.View())
	lines := strings.Split(out, "\n")

	t.Logf("frame: %d lines, first=%q", len(lines), lines[0])
	if len(lines) < 30 {
		t.Fatalf("frame collapsed to %d lines:\n%s", len(lines), out)
	}
	if !strings.Contains(out, "cinderpaw") {
		t.Fatalf("header/brand missing from frame:\n%s", firstN(out, 800))
	}
	if !strings.Contains(out, "dadada") {
		t.Fatalf("typed text missing from frame:\n%s", firstN(out, 800))
	}
	if !strings.Contains(out, "shortcuts") && !strings.Contains(out, "F1") {
		t.Fatalf("footer missing from frame:\n%s", firstN(out, 800))
	}
}

func firstN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
