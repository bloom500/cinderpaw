package app

import (
	"encoding/json"
	"strings"
	"testing"

	"cinderpaw-tui/api"
)

func coworkEvent(eventType, title string, data map[string]any) RuntimeEventMsg {
	raw, _ := json.Marshal(data)
	return RuntimeEventMsg{Event: api.RuntimeEvent{Kind: "cowork_event", EventType: eventType, Title: title, Data: raw}}
}

func transcript(a *App) string {
	var b strings.Builder
	for _, t := range a.Turns {
		b.WriteString(t.Text)
		b.WriteString("\n")
	}
	return b.String()
}

// Before this, a teammate's request was hidden as plumbing and expired here
// unseen, failing closed: the work silently did not happen.
func TestApprovalRequestIsShownAndCounted(t *testing.T) {
	a := newTestApp()
	a.State = StateReady
	a.Update(coworkEvent("approval_requested", "Shipper: rm", map[string]any{
		"requestId": "r1", "agentName": "Shipper", "description": "Run command: rm -rf dist/", "approvalClass": "delete",
	}))
	if len(a.PendingApprovals) != 1 {
		t.Fatalf("pending = %d, want 1", len(a.PendingApprovals))
	}
	if !strings.Contains(transcript(a), "Shipper needs your approval: Run command: rm -rf dist/") {
		t.Fatalf("request not in transcript:\n%s", transcript(a))
	}
	if !strings.Contains(a.renderHeader(), "1 approval waiting") {
		t.Fatalf("header does not say an approval is waiting: %q", a.renderHeader())
	}
	// The same request twice (reconnect, start-up fetch) is one request.
	a.Update(coworkEvent("approval_requested", "Shipper: rm", map[string]any{"requestId": "r1", "agentName": "Shipper"}))
	if len(a.PendingApprovals) != 1 {
		t.Fatalf("duplicate request stacked: %d", len(a.PendingApprovals))
	}
}

func TestVerdictClearsTheRequest(t *testing.T) {
	a := newTestApp()
	a.State = StateReady
	a.Update(coworkEvent("approval_requested", "", map[string]any{"requestId": "r1", "agentName": "Shipper"}))
	a.Update(coworkEvent("approval_expired", "", map[string]any{"requestId": "r1", "agentName": "Shipper"}))
	if len(a.PendingApprovals) != 0 {
		t.Fatalf("expired request still pending")
	}
	if !strings.Contains(transcript(a), "Shipper: expired") {
		t.Fatalf("expiry not reported:\n%s", transcript(a))
	}
}

func TestTeammateAnswerWaitsForTheStreamingReply(t *testing.T) {
	a := newTestApp()
	a.State = StateStreaming
	before := len(a.Turns)
	a.Update(coworkEvent("message_processed", "Human → Atlas", map[string]any{"output": "The bug is in the parser."}))
	if len(a.Turns) != before {
		t.Fatalf("a line landed inside the reply being streamed")
	}
	a.State = StateReady
	a.flushCoworkLines()
	if !strings.Contains(transcript(a), "Human → Atlas: The bug is in the parser.") {
		t.Fatalf("answer not shown after the stream:\n%s", transcript(a))
	}
}

func TestApproveWithNothingWaitingSaysSo(t *testing.T) {
	a := newTestApp()
	if cmd := a.resolveCoworkCmd(nil, true); cmd != nil {
		t.Fatal("sent a verdict with nothing waiting")
	}
	if !strings.Contains(a.FlashText, "no teammate is waiting") {
		t.Fatalf("flash = %q", a.FlashText)
	}
}

func TestApproveRejectsAnOutOfRangeNumber(t *testing.T) {
	a := newTestApp()
	a.PendingApprovals = []api.CoworkApproval{{RequestID: "r1", AgentName: "Shipper"}}
	if cmd := a.resolveCoworkCmd([]string{"3"}, true); cmd != nil {
		t.Fatal("sent a verdict for a request that does not exist")
	}
	if !strings.Contains(a.FlashText, "usage: /approve [1-1]") {
		t.Fatalf("flash = %q", a.FlashText)
	}
}

func TestStartUpPicksUpRequestsRaisedBeforeConnecting(t *testing.T) {
	a := newTestApp()
	a.onCoworkTeam(CoworkTeamMsg{Team: &api.CoworkTeam{
		Pending: []api.CoworkApproval{{RequestID: "r7", AgentName: "Bolt", Description: "POST https://x.y"}},
	}})
	if len(a.PendingApprovals) != 1 || a.PendingApprovals[0].RequestID != "r7" {
		t.Fatalf("pending = %+v", a.PendingApprovals)
	}
}

func TestTeamListFlagsATeammateWithEveryTool(t *testing.T) {
	lines := strings.Join(teamLines([]api.CoworkTeammate{{ID: "old", Name: "Old", Tools: nil}}, nil), "\n")
	if !strings.Contains(lines, "every tool") {
		t.Fatalf("unscoped teammate not flagged:\n%s", lines)
	}
	empty := strings.Join(teamLines(nil, nil), "\n")
	if !strings.Contains(empty, "no teammates yet") {
		t.Fatalf("empty roster gives no way forward:\n%s", empty)
	}
}
