package app

import (
	"strings"
	"testing"
	"time"
)

// ponytail: smallest check that fails if reflow/clampLen go back to
// byte-slicing and corrupt UTF-8 multi-byte runes.
func TestReflowUnicodeSafe(t *testing.T) {
	text := "the plan → don't break “quotes” — verify"
	for _, line := range reflow(text, 12) {
		for i, r := range line {
			_ = i
			if r == '�' {
				t.Fatalf("reflow produced replacement rune in %q from %q", line, text)
			}
		}
	}
}

func TestClampLenRuneSafe(t *testing.T) {
	s := "→→→→→→→→→→" // 10 multi-byte runes
	idx := clampLen(s, 3)
	out := s[:idx]
	if n := len([]rune(out)); n != 3 {
		t.Fatalf("clampLen(3) gave %d runes (%q), want 3", n, out)
	}
}

// TestRenderToolPillIndentation pins the gutter-indentation contract:
// renderToolPill joins its lines with "\n"+gutter, so every continuation
// line (Note, error ErrMsg, Preview) must start with the "  ⎿" marker at
// a fixed offset. The shared `gutter` prefix itself is the caller's
// (buildChatContent's) responsibility, not asserted here.
func TestRenderToolPillIndentation(t *testing.T) {
	a := newTestApp()
	started := time.Now().Add(-time.Second)

	cases := []struct {
		name      string
		tc        ToolCall
		wantLines int
	}{
		{
			name:      "bare call has no continuation lines",
			tc:        ToolCall{Name: "list_files", Status: ToolDone, StartedAt: started, EndedAt: time.Now()},
			wantLines: 1,
		},
		{
			name:      "note adds one continuation line",
			tc:        ToolCall{Name: "read_file", Status: ToolDone, StartedAt: started, EndedAt: time.Now(), Note: "cached"},
			wantLines: 2,
		},
		{
			name:      "error adds one continuation line",
			tc:        ToolCall{Name: "shell_exec", Status: ToolError, StartedAt: started, EndedAt: time.Now(), ErrMsg: "exit code 1"},
			wantLines: 2,
		},
		{
			name:      "preview adds one continuation line",
			tc:        ToolCall{Name: "grep", Status: ToolDone, StartedAt: started, EndedAt: time.Now(), Preview: "match found"},
			wantLines: 2,
		},
		{
			name:      "note + error stack as two continuation lines",
			tc:        ToolCall{Name: "shell_exec", Status: ToolError, StartedAt: started, EndedAt: time.Now(), Note: "retrying", ErrMsg: "timeout"},
			wantLines: 3,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out := a.renderToolPill(c.tc, "", 80)
			lines := strings.Split(out, "\n")
			if len(lines) != c.wantLines {
				t.Fatalf("expected %d lines, got %d:\n%q", c.wantLines, len(lines), out)
			}
			for _, l := range lines[1:] {
				stripped := stripAnsi(l)
				if !strings.HasPrefix(stripped, "  ⎿") {
					t.Fatalf("continuation line missing '  ⎿' prefix: %q (raw %q)", stripped, l)
				}
			}
		})
	}
}
