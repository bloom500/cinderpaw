package app

// Agent Cowork in the terminal.
//
// The TUI had no Cowork surface at all: teammate events arrived on /events
// and were hidden as plumbing, so a teammate's answer never showed and its
// approval request expired here unseen after five minutes, failing closed.
// This file is the whole terminal side: answers and failures as transcript
// lines, a waiting-approval count in the header, and /team, /approve, /deny.

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"cinderpaw-tui/api"
	"cinderpaw-tui/ui"

	tea "github.com/charmbracelet/bubbletea"
)

// CoworkTeamMsg carries GET /runtime/cowork/team. Show is set when the
// person typed /team; the start-up fetch only picks up waiting approvals.
type CoworkTeamMsg struct {
	Team *api.CoworkTeam
	Err  error
	Show bool
}

// CoworkResolvedMsg reports whether a verdict reached the gateway.
type CoworkResolvedMsg struct {
	RequestID string
	Approve   bool
	Err       error
}

// coworkEventData is the part of a cowork_event payload the terminal uses.
type coworkEventData struct {
	RequestID     string `json:"requestId"`
	AgentName     string `json:"agentName"`
	Description   string `json:"description"`
	ApprovalClass string `json:"approvalClass"`
	Output        string `json:"output"`
	Result        string `json:"result"`
	Reason        string `json:"reason"`
}

// coworkAnswerMax bounds an answer shown inline; /team and the desktop panel
// hold the rest.
const coworkAnswerMax = 600

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + ui.G.Ellipsis
}

// handleCoworkEvent turns one cowork_event into what a person needs to see.
// A "received" event is skipped: the answer that follows says the same thing
// with content.
func (a *App) handleCoworkEvent(ev api.RuntimeEvent) {
	var d coworkEventData
	if len(ev.Data) > 0 {
		_ = json.Unmarshal(ev.Data, &d)
	}
	who := d.AgentName
	if who == "" {
		who = "A teammate"
	}
	switch ev.EventType {
	case "approval_requested":
		if d.RequestID == "" {
			return
		}
		for _, p := range a.PendingApprovals {
			if p.RequestID == d.RequestID {
				return
			}
		}
		a.PendingApprovals = append(a.PendingApprovals, api.CoworkApproval{
			RequestID: d.RequestID, AgentName: who, Description: d.Description, ApprovalClass: d.ApprovalClass,
		})
		a.setFlash(fmt.Sprintf("%s needs your approval: /approve or /deny", who))
		a.addCoworkLines([]string{approvalLine(len(a.PendingApprovals), who, d.Description, d.ApprovalClass)})
	case "approval_approved", "approval_denied", "approval_expired":
		a.dropApproval(d.RequestID)
		verdict := map[string]string{
			"approval_approved": "approved",
			"approval_denied":   "denied",
			"approval_expired":  "expired: no answer in time, so it was refused",
		}[ev.EventType]
		a.addCoworkLines([]string{fmt.Sprintf("%s %s: %s", ui.G.Event, who, verdict)})
	case "message_processed", "handoff_completed":
		body := d.Output
		if body == "" {
			body = d.Result
		}
		a.addCoworkLines([]string{fmt.Sprintf("%s %s: %s", ui.G.Event, ev.Title, clip(body, coworkAnswerMax))})
	case "message_rejected", "handoff_failed":
		a.addCoworkLines([]string{fmt.Sprintf("%s %s failed: %s", ui.G.Err, ev.Title, clip(d.Reason, 200))})
	}
}

func approvalLine(n int, who, what, class string) string {
	line := fmt.Sprintf("%s [%d] %s needs your approval: %s", ui.G.Event, n, who, what)
	if class != "" {
		line += " (" + class + ")"
	}
	return line + fmt.Sprintf(". /approve %d or /deny %d", n, n)
}

func (a *App) dropApproval(id string) {
	kept := a.PendingApprovals[:0]
	for _, p := range a.PendingApprovals {
		if p.RequestID != id {
			kept = append(kept, p)
		}
	}
	a.PendingApprovals = kept
}

// addCoworkLines shows lines now, or after the reply being streamed: a line
// appended mid-stream would land inside the agent's answer.
func (a *App) addCoworkLines(lines []string) {
	if a.State == StateStreaming {
		a.PendingCoworkLines = append(a.PendingCoworkLines, lines...)
		return
	}
	a.appendTranscriptLines(lines)
}

func (a *App) flushCoworkLines() {
	if len(a.PendingCoworkLines) == 0 {
		return
	}
	lines := a.PendingCoworkLines
	a.PendingCoworkLines = nil
	a.appendTranscriptLines(lines)
}

func (a *App) fetchCoworkCmd(show bool) tea.Cmd {
	baseURL, token := a.BaseURL, a.Token
	return func() tea.Msg {
		team, err := api.FetchCoworkTeam(baseURL, token)
		return CoworkTeamMsg{Team: team, Err: err, Show: show}
	}
}

func (a *App) onCoworkTeam(msg CoworkTeamMsg) {
	if msg.Err != nil {
		// Silent at start-up: the gateway may still be coming up, and the
		// live /events stream covers what happens next.
		if msg.Show {
			a.setFlash("teammates unavailable: " + msg.Err.Error())
		}
		return
	}
	for _, p := range msg.Team.Pending {
		known := false
		for _, q := range a.PendingApprovals {
			known = known || q.RequestID == p.RequestID
		}
		if !known {
			a.PendingApprovals = append(a.PendingApprovals, p)
		}
	}
	if !msg.Show {
		if len(msg.Team.Pending) > 0 {
			a.setFlash(fmt.Sprintf("%d teammate approval(s) waiting: /team to see them", len(a.PendingApprovals)))
		}
		return
	}
	a.appendTranscriptLines(teamLines(msg.Team.Roster, a.PendingApprovals))
}

func teamLines(roster []api.CoworkTeammate, pending []api.CoworkApproval) []string {
	if len(roster) == 0 {
		return []string{
			"no teammates yet",
			`ask in chat, for example: "make me a teammate who reviews my pull requests"`,
		}
	}
	lines := []string{fmt.Sprintf("teammates · %d", len(roster))}
	for _, t := range roster {
		tools := "every tool, including writing, sending and running commands"
		if t.Tools != nil {
			tools = strings.Join(t.Tools, ", ")
			if len(t.Tools) == 0 {
				tools = "no tools"
			}
		}
		model := "chosen per task"
		if t.Model != nil {
			model = *t.Model
		}
		line := "  " + t.Name
		if t.Role != "" {
			line += " · " + t.Role
		}
		lines = append(lines, line, "    can use · "+tools, "    model · "+model)
	}
	for i, p := range pending {
		lines = append(lines, approvalLine(i+1, p.AgentName, p.Description, p.ApprovalClass))
	}
	lines = append(lines, "to change or remove one, ask in chat")
	return lines
}

// resolveCoworkCmd answers the n-th waiting approval (1-based, default 1).
func (a *App) resolveCoworkCmd(args []string, approve bool) tea.Cmd {
	verb := "/deny"
	if approve {
		verb = "/approve"
	}
	if len(a.PendingApprovals) == 0 {
		a.setFlash("no teammate is waiting for an approval")
		return nil
	}
	n := 1
	if len(args) > 0 {
		v, err := strconv.Atoi(args[0])
		if err != nil || v < 1 || v > len(a.PendingApprovals) {
			a.setFlash(fmt.Sprintf("usage: %s [1-%d]", verb, len(a.PendingApprovals)))
			return nil
		}
		n = v
	}
	id := a.PendingApprovals[n-1].RequestID
	baseURL, token := a.BaseURL, a.Token
	return func() tea.Msg {
		err := api.ResolveCoworkApproval(baseURL, token, id, approve)
		return CoworkResolvedMsg{RequestID: id, Approve: approve, Err: err}
	}
}

func (a *App) onCoworkResolved(msg CoworkResolvedMsg) {
	if msg.Err != nil {
		// Kept in the list: the teammate is still blocked, and the person can
		// try again rather than lose the only way to answer.
		a.setFlash("not sent: " + msg.Err.Error())
		return
	}
	a.dropApproval(msg.RequestID)
	if msg.Approve {
		a.setFlash(ui.G.OK + " approved")
	} else {
		a.setFlash(ui.G.OK + " denied")
	}
}
