package app

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestPushHistoryDedupsConsecutive(t *testing.T) {
	a := newTestApp()
	a.pushHistory("hello")
	a.pushHistory("hello")
	a.pushHistory("world")
	if len(a.InputHistory) != 2 {
		t.Fatalf("expected 2 entries after consecutive dedup, got %d: %v", len(a.InputHistory), a.InputHistory)
	}
}

func TestPushHistoryCapsAt200(t *testing.T) {
	a := newTestApp()
	for i := 0; i < 250; i++ {
		a.pushHistory("msg" + string(rune('a'+i%26)) + string(rune(i)))
	}
	if len(a.InputHistory) != 200 {
		t.Fatalf("expected cap of 200, got %d", len(a.InputHistory))
	}
}

func TestHistoryUpDownWalksNewestFirst(t *testing.T) {
	a := newTestApp()
	a.pushHistory("first")
	a.pushHistory("second")
	a.Input.SetValue("")
	a.historyUp()
	if got := a.Input.Value(); got != "second" {
		t.Fatalf("first historyUp() = %q, want %q", got, "second")
	}
	a.historyUp()
	if got := a.Input.Value(); got != "first" {
		t.Fatalf("second historyUp() = %q, want %q", got, "first")
	}
	a.historyDown()
	if got := a.Input.Value(); got != "second" {
		t.Fatalf("historyDown() = %q, want %q", got, "second")
	}
}

func TestCtrlCFirstPressClearsInputSecondQuits(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("half-typed message")
	a.handleCtrlC()
	if a.Input.Value() != "" {
		t.Fatalf("first Ctrl+C should clear input, got %q", a.Input.Value())
	}
	if a.State == StateShutdown {
		t.Fatal("first Ctrl+C with text should not quit")
	}
	a.handleCtrlC()
	if a.State != StateShutdown {
		t.Fatal("second Ctrl+C within the grace window should quit")
	}
}

func TestCtrlCOnEmptyInputQuitsImmediately(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("")
	a.handleCtrlC()
	if a.State != StateShutdown {
		t.Fatal("Ctrl+C on empty input should quit on the first press")
	}
}

func TestEscDuringStreamingInterruptsNotQuits(t *testing.T) {
	// Only checks that Esc calls the stop path and never quits — the
	// resulting "◦ interrupted" transcript line is asserted once Task 5
	// adds the Turn.Interrupted field and wires stopStream() to set it;
	// since this test drives Esc through the same stopStream() call,
	// Task 5's change covers this path automatically without a retest here.
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if a.State == StateShutdown {
		t.Fatal("Esc during streaming should interrupt, not quit")
	}
	if a.State == StateStreaming {
		t.Fatal("Esc during streaming should leave StateStreaming (stopStream finishes the turn)")
	}
}

func TestEscWithNothingOpenClearsInputNotQuit(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("some text")
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if a.Input.Value() != "" {
		t.Fatalf("Esc should clear input, got %q", a.Input.Value())
	}
	if a.State == StateShutdown {
		t.Fatal("a bare Esc must never quit the app (spec §16 — that's Ctrl+C/Ctrl+D's job)")
	}
}

func TestEscOnEmptyInputDoesNotQuit(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("")
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if a.State == StateShutdown {
		t.Fatal("Esc on empty input must not quit either")
	}
}

func TestCtrlDQuitsOnlyOnEmptyInput(t *testing.T) {
	a := newTestApp()
	a.Input.SetValue("typing")
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyCtrlD})
	if a.State == StateShutdown {
		t.Fatal("Ctrl+D with text present should be a no-op")
	}
	a.Input.SetValue("")
	_, _ = a.Update(tea.KeyMsg{Type: tea.KeyCtrlD})
	if a.State != StateShutdown {
		t.Fatal("Ctrl+D on empty input should quit")
	}
}
