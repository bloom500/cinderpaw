package api

import (
	"encoding/json"
	"strings"
	"testing"
)

// sseLine wraps an event the way the gateway's /events stream does, built
// with json.Marshal so the test holds no hand-escaped JSON-in-JSON.
func sseLine(inner any) string {
	b, _ := json.Marshal(inner)
	outer, _ := json.Marshal(map[string]any{
		"event": "cinderpaw://agent-output",
		"data":  map[string]string{"data": string(b)},
	})
	return string(outer)
}

func TestParseCoworkEventKeepsItsPayload(t *testing.T) {
	ev, ok := parseRuntimeEventSSE(sseLine(map[string]any{
		"type":      "cowork_event",
		"eventType": "approval_requested",
		"title":     "Shipper: Run command: rm -rf dist/",
		"data":      map[string]any{"requestId": "r1", "agentName": "Shipper"},
	}))
	if !ok {
		t.Fatal("a cowork_event must parse")
	}
	if ev.EventType != "approval_requested" || ev.Title == "" {
		t.Fatalf("eventType/title lost: %+v", ev)
	}
	if !strings.Contains(string(ev.Data), `"r1"`) {
		t.Fatalf("payload lost: %s", ev.Data)
	}
}

// Other event kinds use `data` too, not always for an object. Decoding it
// into a typed field would fail the whole event, and it would vanish.
func TestParseEventWhoseDataIsNotAnObject(t *testing.T) {
	ev, ok := parseRuntimeEventSSE(sseLine(map[string]any{"type": "artifact", "data": "plain text"}))
	if !ok || ev.Kind != "artifact" {
		t.Fatalf("event with a string data field was dropped: ok=%v ev=%+v", ok, ev)
	}
}
