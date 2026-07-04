package ui

import (
	"strings"
	"testing"
)

// TestNoColorStripsAnsi is the automatable half of spec §22 acceptance #18:
// with NO_COLOR set, a rendered style must carry zero ANSI escape bytes.
func TestNoColorStripsAnsi(t *testing.T) {
	ApplyNoColor(func(k string) string {
		if k == "NO_COLOR" {
			return "1"
		}
		return ""
	})
	defer ApplyNoColor(func(string) string { return "" }) // reset for other tests

	out := ToolRunning.Render("x")
	if strings.Contains(out, "\x1b[") {
		t.Fatalf("expected no ANSI escapes under NO_COLOR, got %q", out)
	}
}
