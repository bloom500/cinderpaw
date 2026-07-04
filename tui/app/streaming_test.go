package app

import (
	"strings"
	"testing"

	"feral-tui/api"
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
