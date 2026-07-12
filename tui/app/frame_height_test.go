package app

// The frame must NEVER be taller than the terminal: any overflow makes the
// terminal scroll on every repaint and Bubble Tea's diff renderer desyncs —
// the "blank screen, only the input line visible" report (2026-07-11).

import (
	"testing"

	"github.com/charmbracelet/lipgloss"
	tea "github.com/charmbracelet/bubbletea"
)

func TestFrameNeverTallerThanTerminal(t *testing.T) {
	sizes := [][2]int{{80, 24}, {100, 30}, {120, 40}, {239, 64}, {60, 15}, {40, 10}}
	for _, s := range sizes {
		a := newTestApp()
		a.Update(tea.WindowSizeMsg{Width: s[0], Height: s[1]})
		a.Update(BootComplete{})
		for _, r := range "dadada" {
			a.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		}
		// Streaming state adds the aux status strip — the frame must still fit.
		a.State = StateStreaming
		a.StreamStartedAt = a.Now
		if got := lipgloss.Height(a.View()); got > s[1] {
			t.Errorf("%dx%d streaming: frame %d lines > %d rows", s[0], s[1], got, s[1])
		}
		a.State = StateReady

		frame := a.View()
		if got := lipgloss.Height(frame); got > s[1] {
			// Break the frame down so the failure names the culprit.
			headerH := lipgloss.Height(a.renderHeader())
			chatH := lipgloss.Height(a.ChatVP.View())
			inH := clamp(1, a.Input.Height()+2, 6)
			inputH := lipgloss.Height(a.renderInput(inH))
			footerH := lipgloss.Height(a.renderFooter())
			t.Errorf("%dx%d: frame %d lines > %d rows (header=%d chat=%d input=%d[inH=%d, ta=%d] footer=%d)",
				s[0], s[1], got, s[1], headerH, chatH, inputH, inH, a.Input.Height(), footerH)
		}
	}
}
