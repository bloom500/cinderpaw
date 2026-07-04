package app

import (
	"feral-tui/api"
	"testing"
	"time"
)

func TestInferErrorKindTimeout(t *testing.T) {
	for _, msg := range []string{
		"model timed out after 120s",
		"deadline exceeded",
		"TTFT timeout",
	} {
		kind, _ := inferErrorKind(msg)
		if kind != "timeout" {
			t.Fatalf("inferErrorKind(%q) = %q, want timeout", msg, kind)
		}
	}
}

func TestInferErrorKindPermission(t *testing.T) {
	for _, msg := range []string{
		"permission denied",
		"write not allowed in this profile",
		"EACCES: /etc/passwd",
	} {
		kind, _ := inferErrorKind(msg)
		if kind != "permission" {
			t.Fatalf("inferErrorKind(%q) = %q, want permission", msg, kind)
		}
	}
}

func TestInferErrorKindNetwork(t *testing.T) {
	for _, msg := range []string{
		"connection refused",
		"connection reset by peer",
		"host unreachable",
		"ECONNREFUSED 127.0.0.1:11435",
	} {
		kind, _ := inferErrorKind(msg)
		if kind != "network" {
			t.Fatalf("inferErrorKind(%q) = %q, want network", msg, kind)
		}
	}
}

func TestInferErrorKindTool(t *testing.T) {
	for _, msg := range []string{
		"not_available: shell_exec",
		"unknown tool: made_up_tool",
	} {
		kind, _ := inferErrorKind(msg)
		if kind != "tool" {
			t.Fatalf("inferErrorKind(%q) = %q, want tool", msg, kind)
		}
	}
}

func TestInferErrorKindUnknown(t *testing.T) {
	kind, hint := inferErrorKind("something completely novel happened")
	if kind != "unknown" {
		t.Fatalf("expected kind=unknown, got %q", kind)
	}
	if hint != "" {
		t.Fatalf("unknown errors should have empty hint, got %q", hint)
	}
}

func TestInferErrorKindHintProvided(t *testing.T) {
	_, hint := inferErrorKind("model timed out after 120s")
	if hint == "" {
		t.Fatal("timeout errors should carry a hint")
	}
}

func TestInferErrorKindNoModel(t *testing.T) {
	for _, msg := range []string{"no model loaded", "model not found", "no_model_selected"} {
		kind, hint := inferErrorKind(msg)
		if kind != "no_model" {
			t.Fatalf("inferErrorKind(%q) = %q, want no_model", msg, kind)
		}
		if hint == "" {
			t.Fatal("no_model errors should carry a hint")
		}
	}
}

func TestInferErrorKindOffline(t *testing.T) {
	kind, hint := inferErrorKind("offline: no network reachable")
	if kind != "offline" {
		t.Fatalf("inferErrorKind = %q, want offline", kind)
	}
	if hint == "" {
		t.Fatal("offline errors should carry a hint")
	}
}

func TestInferErrorKindRuntimeLost(t *testing.T) {
	for _, msg := range []string{"runtime lost", "gateway unreachable", "gateway down"} {
		kind, _ := inferErrorKind(msg)
		if kind != "runtime_lost" {
			t.Fatalf("inferErrorKind(%q) = %q, want runtime_lost", msg, kind)
		}
	}
}

func TestInferErrorKindRateLimited(t *testing.T) {
	for _, msg := range []string{"429 too many requests", "rate limit exceeded"} {
		kind, hint := inferErrorKind(msg)
		if kind != "rate_limited" {
			t.Fatalf("inferErrorKind(%q) = %q, want rate_limited", msg, kind)
		}
		if hint == "" {
			t.Fatal("rate_limited errors should carry a hint")
		}
	}
}

func TestRateLimitEntersErrorStateWithDeadline(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.lastUserText = "hi"
	a.pushAssistantError("429 too many requests")
	if a.RateLimitUntil.IsZero() {
		t.Fatal("expected RateLimitUntil to be set on a rate_limited error")
	}
}

// TestStreamDoneAfterErrorPreservesStateError pins the contract that
// finishStream does not clobber StateError when StreamDoneMsg follows a
// mid-stream error chunk. Before the fix, the countdown hint vanished
// from the footer the instant the stream ended and the `r` keybind
// stopped working (r only fires in StateError). Driving the full path —
// error chunk → StreamDoneMsg — exercises the bug end-to-end.
func TestStreamDoneAfterErrorPreservesStateError(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming
	a.lastUserText = "hi"

	a.handleStreamChunk(api.Chunk{Error: "429 too many requests"})
	if a.State != StateError {
		t.Fatalf("after error chunk: State = %v, want StateError", a.State)
	}
	if a.RateLimitUntil.IsZero() {
		t.Fatal("expected RateLimitUntil to be set after rate_limited error")
	}

	_, _ = a.Update(StreamDoneMsg{Err: nil})
	if a.State != StateError {
		t.Fatalf("after StreamDone: State = %v, want StateError (finishStream must not clobber)", a.State)
	}
	if a.RateLimitUntil.IsZero() {
		t.Fatal("RateLimitUntil must survive StreamDone — auto-retry depends on it")
	}
}

// TestStreamDoneAfterSuccessRestoresReady is the positive-path companion
// to the test above: when no error fired, StreamDone must land the app
// in StateReady (not leave it dangling in StateStreaming).
func TestStreamDoneAfterSuccessRestoresReady(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming

	_, _ = a.Update(StreamDoneMsg{Err: nil})
	if a.State != StateReady {
		t.Fatalf("after clean StreamDone: State = %v, want StateReady", a.State)
	}
}

func TestOpenToolViewerNewestFirst(t *testing.T) {
	a := newTestApp()
	// Build three turns each with one tool, then open the viewer.
	a.Turns = []Turn{
		{Role: RoleUser, Text: "first"},
		{Role: RoleAssistant, Tools: []ToolCall{{ID: "t1", Name: "read_file", Status: ToolDone, StartedAt: time.Now().Add(-2 * time.Second), EndedAt: time.Now()}}},
		{Role: RoleUser, Text: "second"},
		{Role: RoleAssistant, Tools: []ToolCall{{ID: "t2", Name: "grep", Status: ToolDone, StartedAt: time.Now(), EndedAt: time.Now()}}},
		{Role: RoleUser, Text: "third"},
		{Role: RoleAssistant, Tools: []ToolCall{{ID: "t3", Name: "shell_exec", Status: ToolRunning, StartedAt: time.Now()}}},
	}
	a.openToolViewer()
	if !a.ToolViewer.Show {
		t.Fatal("ToolViewer.Show should be true after openToolViewer")
	}
	if len(a.ToolViewer.Rows) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(a.ToolViewer.Rows))
	}
	// Newest first means t3 at idx 0, t1 at idx 2.
	if a.ToolViewer.Rows[0].Call.ID != "t3" {
		t.Fatalf("newest tool should be first, got %q", a.ToolViewer.Rows[0].Call.ID)
	}
	if a.ToolViewer.Rows[2].Call.ID != "t1" {
		t.Fatalf("oldest tool should be last, got %q", a.ToolViewer.Rows[2].Call.ID)
	}
	if a.ToolViewer.Expanded {
		t.Fatal("Expanded should default to false")
	}
	if a.ToolViewer.Idx != 0 {
		t.Fatalf("Idx should reset to 0, got %d", a.ToolViewer.Idx)
	}
}

func TestOpenToolViewerSkipsUserTurns(t *testing.T) {
	a := newTestApp()
	// Two user turns with no assistant response → 0 tools, but the
	// overlay should still open with the empty-state hint.
	a.Turns = []Turn{
		{Role: RoleUser, Text: "hi"},
		{Role: RoleUser, Text: "again"},
	}
	a.openToolViewer()
	if !a.ToolViewer.Show {
		t.Fatal("Show should be true even when no tools exist")
	}
	if len(a.ToolViewer.Rows) != 0 {
		t.Fatalf("expected 0 rows from user-only turns, got %d", len(a.ToolViewer.Rows))
	}
}

func TestPlural(t *testing.T) {
	if plural(0) != "s" || plural(1) != "" || plural(2) != "s" || plural(42) != "s" {
		t.Fatalf("plural broken: %q/%q/%q/%q", plural(0), plural(1), plural(2), plural(42))
	}
}