package app

import (
	"strings"
	"testing"
)

// An error that arrives before any reply belongs under the message that
// failed, not under the previous answer (24 Sep: the card went off screen).
func TestErrorCardLandsUnderTheFailedMessage(t *testing.T) {
	a := newTestApp()
	a.Turns = []Turn{
		{Role: RoleUser, Text: "first"},
		{Role: RoleAssistant, Text: "first answer"},
		{Role: RoleUser, Text: "second"},
	}
	a.pushAssistantError("429 Too Many Requests")
	if len(a.Turns) != 4 {
		t.Fatalf("want a new reply turn for the failed message, got %d turns", len(a.Turns))
	}
	if len(a.Turns[1].Errors) != 0 {
		t.Fatal("the error was pinned to the previous answer")
	}
	if got := stripAnsi(a.renderTurn(&a.Turns[3], 80)); !strings.Contains(got, "429") {
		t.Fatalf("an error-only reply renders nothing:\n%s", got)
	}
}

// The search comes before the answer it produced, on screen as in time.
func TestToolsRenderBeforeTheAnswer(t *testing.T) {
	a := newTestApp()
	turn := Turn{Role: RoleAssistant, Text: "the answer", Tools: []ToolCall{{ID: "1", Name: "web_search", Main: "q", Status: ToolDone}}}
	out := stripAnsi(a.renderTurn(&turn, 80))
	if strings.Index(out, "web_search") > strings.Index(out, "the answer") {
		t.Fatalf("tool rendered after the answer:\n%s", out)
	}
}
