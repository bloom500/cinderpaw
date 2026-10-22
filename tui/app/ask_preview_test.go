package app

import (
	"strings"
	"testing"

	"cinderpaw-tui/api"
)

// A skill installed from a link is shown in full before the person answers:
// before 13 Oct the TUI dropped the preview and showed only name and source.
func TestAskShowsTheWholePreview(t *testing.T) {
	lines := make([]string, 120)
	for i := range lines {
		lines[i] = "step"
	}
	lines[119] = "hidden at the end"
	out := renderAskQuestions([]api.AskQuestion{{
		Question: `Install the skill "PDF Tools" from github.com/acme/skills?`,
		Options:  []api.AskOption{{Label: "Install it"}, {Label: "Not now"}},
		Preview:  strings.Join(lines, "\n"),
	}})
	if !strings.Contains(out, "│ hidden at the end") {
		t.Fatalf("the end of the skill was not shown:\n%s", out)
	}
	if strings.Index(out, "hidden at the end") > strings.Index(out, "1) Install it") {
		t.Fatal("the skill text must come before the options")
	}
}
