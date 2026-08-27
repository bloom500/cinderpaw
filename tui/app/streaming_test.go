package app

import (
	"strings"
	"testing"

	"cinderpaw-tui/api"

	tea "github.com/charmbracelet/bubbletea"
)

func TestStreamChunksBufferUntilFlush(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming
	a.handleStreamChunk(api.Chunk{Content: "hello "})
	a.handleStreamChunk(api.Chunk{Content: "world"})
	last := &a.Turns[len(a.Turns)-1]
	if last.Text != "" {
		t.Fatalf("Text should stay empty until flushPending, got %q", last.Text)
	}
	a.flushPending()
	if last.Text != "hello world" {
		t.Fatalf("after flushPending Text = %q, want %q", last.Text, "hello world")
	}
}

func TestStopStreamMarksInterrupted(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming
	a.handleStreamChunk(api.Chunk{Content: "partial"})
	a.flushPending()
	a.stopStream()
	last := &a.Turns[len(a.Turns)-1]
	if !last.Interrupted {
		t.Fatal("stopStream should mark the turn Interrupted")
	}
	if last.Text != "partial" {
		t.Fatalf("partial text must survive interruption, got %q", last.Text)
	}
	content := a.buildChatContent()
	if !strings.Contains(content, "interrupted") {
		t.Fatalf("expected an interrupted line in transcript content, got:\n%s", content)
	}
}

// TestTypeAheadDuringStreaming_P2_3 — Enter during StateStreaming queues
// the text into PendingSubmit and clears the textarea. A clean
// StreamDoneMsg auto-submits the queued text (handleSubmit produces a
// fresh user turn and returns to StateStreaming).
func TestTypeAheadDuringStreaming_P2_3(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming

	// User types ahead while a stream is running.
	a.Input.SetValue("queued follow-up")
	// Send (Enter) during streaming should capture and clear, NOT submit.
	a.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if a.PendingSubmit != "queued follow-up" {
		t.Fatalf("PendingSubmit = %q, want %q", a.PendingSubmit, "queued follow-up")
	}
	if a.Input.Value() != "" {
		t.Fatalf("Input should be cleared after Enter-during-streaming, got %q", a.Input.Value())
	}
	if a.State != StateStreaming {
		t.Fatalf("state should still be StateStreaming (current stream not interrupted), got %v", a.State)
	}
	// We shouldn't have started a new turn yet — only one turn (the in-flight assistant).
	if got := len(a.Turns); got != 1 {
		t.Fatalf("Enter during streaming should not start a new turn yet; got %d turns", got)
	}

	// Clean StreamDoneMsg lands → auto-submit fires.
	a.handleStreamChunk(api.Chunk{Content: "first reply"})
	a.flushPending()
	a.Update(StreamDoneMsg{})

	if a.PendingSubmit != "" {
		t.Fatalf("PendingSubmit should be cleared after auto-submit, got %q", a.PendingSubmit)
	}
	if a.State != StateStreaming {
		t.Fatalf("auto-submit should put us back in StateStreaming, got %v", a.State)
	}
	// Now we should have the original assistant turn + the new user turn
	// + a fresh assistant turn beginAssistant() started for the queued
	// reply (handleSubmit calls beginAssistant before returning).
	if got := len(a.Turns); got < 3 {
		t.Fatalf("auto-submit should have added user + assistant turns; total turns = %d", got)
	}
	// The new user turn is the second-to-last (last is the fresh assistant
	// placeholder that beginAssistant() spun up for the queued reply).
	userTurn := a.Turns[len(a.Turns)-2]
	if userTurn.Role != RoleUser {
		t.Fatalf("second-to-last turn role = %v, want RoleUser", userTurn.Role)
	}
	if userTurn.Text != "queued follow-up" {
		t.Fatalf("second-to-last turn text = %q, want %q", userTurn.Text, "queued follow-up")
	}
}

// TestEscDuringStreamingKeepsComposedText_P2_3 — Esc interrupts the stream
// but does NOT clear composed text (the input is what the user just typed
// or the queued PendingSubmit they may have wanted).
func TestEscDuringStreamingKeepsComposedText_P2_3(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming
	a.Input.SetValue("half-typed reply")

	a.Update(tea.KeyMsg{Type: tea.KeyEsc})

	if !a.Turns[len(a.Turns)-1].Interrupted {
		t.Fatal("Esc during streaming should mark the turn Interrupted")
	}
	if a.Input.Value() != "half-typed reply" {
		t.Fatalf("Esc should NOT clear composed text; got %q", a.Input.Value())
	}
}
