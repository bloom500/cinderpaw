package app

// Regression tests for the 2026-07-11 chat UX fixes (Darius' manual smoke):
//   1. j/k must type into the textarea when no overlay is open.
//   2. Raw runtime events (heartbeat, usage, …) stay hidden by default;
//      /verbose on shows them.
//   3. A submitted user message renders in the transcript.

import (
	"strings"
	"testing"

	"cinderpaw-tui/api"

	tea "github.com/charmbracelet/bubbletea"
)

func keyRunes(r rune) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}}
}

func TestJKTypeIntoInputWithoutOverlay(t *testing.T) {
	a := newTestApp()
	a.State = StateReady
	for _, r := range []rune{'j', 'k'} {
		a.Update(keyRunes(r))
	}
	if got := a.Input.Value(); got != "jk" {
		t.Fatalf("typing j,k with no overlay: input = %q, want %q", got, "jk")
	}
}

func TestJKNavigateWhenOverlayOpen(t *testing.T) {
	a := newTestApp()
	a.State = StateReady
	a.ModelPicker.Show = true
	a.ModelPicker.Rows = []ModelEntry{{ID: "a"}, {ID: "b"}}
	a.Update(keyRunes('j'))
	if a.ModelPicker.Idx != 1 {
		t.Fatalf("j with model picker open: Idx = %d, want 1", a.ModelPicker.Idx)
	}
	if a.Input.Value() != "" {
		t.Fatalf("j with overlay open leaked into input: %q", a.Input.Value())
	}
}

func TestRuntimeEventsFilteredByDefault(t *testing.T) {
	a := newTestApp()
	a.RuntimeEvents = []api.RuntimeEvent{
		{Kind: "heartbeat"},
		{Kind: "usage"},
		{Kind: "fractal_activity"},
		{Kind: "model_set", Model: "MiniMax-M3"},
		{Kind: "done"},
	}
	evs := a.visibleRuntimeEvents()
	if len(evs) != 1 || evs[0].Kind != "model_set" {
		t.Fatalf("default filter: got %v, want only model_set", evs)
	}

	a.VerboseEvents = true
	if got := len(a.visibleRuntimeEvents()); got != 5 {
		t.Fatalf("/verbose on: got %d events, want 5", got)
	}

	a.VerboseEvents = false
	a.EventsHidden = true
	if got := len(a.visibleRuntimeEvents()); got != 0 {
		t.Fatalf("/verbose off: got %d events, want 0", got)
	}
}

func TestSlashCommandClearsInput(t *testing.T) {
	a := newTestApp()
	a.State = StateReady
	a.Input.SetValue("/help")
	a.handleSubmit()
	if got := a.Input.Value(); got != "" {
		t.Fatalf("input after slash command = %q, want empty", got)
	}
}

func TestSubmittedUserMessageRenders(t *testing.T) {
	a := newTestApp()
	a.State = StateReady
	a.Input.SetValue("hello cinderpaw")
	a.handleSubmit()
	content := stripAnsi(a.buildChatContent())
	if !strings.Contains(content, "hello cinderpaw") {
		t.Fatalf("user message missing from transcript:\n%s", content)
	}
}
