package api

import (
	"strings"
	"testing"
)

// parseToolFrame is package-private; the regression tests below pin its
// behaviour from inside the package.
func TestParseToolFrameStart(t *testing.T) {
	body := `{"type":"tool_start","id":"c1","tool":"web_search","args":{"query":"rust vulkan"}}`
	c, ok := parseToolFrame("tool_start", body)
	if !ok {
		t.Fatalf("expected ok")
	}
	if c.ToolStart.ID != "c1" || c.ToolStart.Name != "web_search" {
		t.Fatalf("bad tool_start: %+v", c.ToolStart)
	}
	if !strings.Contains(string(c.ToolStart.Args), "rust vulkan") {
		t.Fatalf("args not preserved: %s", c.ToolStart.Args)
	}
}

func TestParseToolFrameDoneOK(t *testing.T) {
	body := `{"type":"tool_done","id":"c1","tool":"web_search","ok":true,"result":"5 hits"}`
	c, ok := parseToolFrame("tool_done", body)
	if !ok {
		t.Fatalf("expected ok")
	}
	if !c.ToolDone.OK {
		t.Fatalf("expected ok=true, got %+v", c.ToolDone)
	}
	if c.ToolDone.ID != "c1" || c.ToolDone.Tool != "web_search" {
		t.Fatalf("bad tool_done: %+v", c.ToolDone)
	}
}

func TestParseToolFrameDoneError(t *testing.T) {
	body := `{"type":"tool_done","id":"c2","tool":"shell_exec","ok":false,"error":"permission denied"}`
	c, ok := parseToolFrame("tool_done", body)
	if !ok {
		t.Fatalf("expected ok")
	}
	if c.ToolDone.OK {
		t.Fatalf("expected ok=false")
	}
	if c.ToolDone.Error != "permission denied" {
		t.Fatalf("expected error message, got %q", c.ToolDone.Error)
	}
}

func TestParseToolFrameProgress(t *testing.T) {
	body := `{"type":"tool_progress","id":"c3","tool":"scan_workspace","message":"retry 2/3","stage":"retry"}`
	c, ok := parseToolFrame("tool_progress", body)
	if !ok {
		t.Fatalf("expected ok")
	}
	if c.ToolProgress.Message != "retry 2/3" || c.ToolProgress.Stage != "retry" {
		t.Fatalf("bad progress: %+v", c.ToolProgress)
	}
}

func TestParseToolFrameUnknownEvent(t *testing.T) {
	if _, ok := parseToolFrame("heartbeat", `{"x":1}`); ok {
		t.Fatalf("unknown event must return ok=false")
	}
}

func TestParseRuntimeEventSSE(t *testing.T) {
	// Simulate the exact SSE data line the host emits for a dream event.
	sseData := `{"event":"feral://agent-output","data":{"data":"{\"type\":\"dream_cycle\",\"stage\":\"reflect\",\"message\":\"2 insights\"}"}}`
	ev, ok := parseRuntimeEventSSE(sseData)
	if !ok {
		t.Fatal("expected ok for valid SSE data")
	}
	if ev.Kind != "dream_cycle" {
		t.Fatalf("expected kind dream_cycle, got %q", ev.Kind)
	}
	if ev.Message != "2 insights" {
		t.Fatalf("expected message '2 insights', got %q", ev.Message)
	}
	if ev.Stage != "reflect" {
		t.Fatalf("expected stage reflect, got %q", ev.Stage)
	}
}

func TestParseRuntimeEventSSEGarbage(t *testing.T) {
	if _, ok := parseRuntimeEventSSE(`not json`); ok {
		t.Fatal("expected ok=false for garbage")
	}
	if _, ok := parseRuntimeEventSSE(`{"event":"x","data":{"data":"not json"}}`); ok {
		t.Fatal("expected ok=false for invalid inner JSON")
	}
}

func TestParseRuntimeEventSSEConnectorType(t *testing.T) {
	sseData := `{"event":"feral://agent-output","data":{"data":"{\"type\":\"connector_event\",\"message\":\"telegram: reply sent to @dan\"}"}}`
	ev, ok := parseRuntimeEventSSE(sseData)
	if !ok {
		t.Fatal("expected ok for connector event")
	}
	if ev.Kind != "connector_event" {
		t.Fatalf("expected kind connector_event, got %q", ev.Kind)
	}
	if ev.Message != "telegram: reply sent to @dan" {
		t.Fatalf("unexpected message: %q", ev.Message)
	}
}

func TestIsToolEvent(t *testing.T) {
	for _, ev := range []string{"tool_start", "tool_progress", "tool_done"} {
		if !isToolEvent(ev) {
			t.Fatalf("%q should be a tool event", ev)
		}
	}
	for _, ev := range []string{"", "message", "done", "chunk", "tool_start_extra"} {
		if isToolEvent(ev) {
			t.Fatalf("%q must NOT be a tool event", ev)
		}
	}
}