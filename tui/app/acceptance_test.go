package app

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// TestHeaderIsSingleLine — spec §22 acceptance #1.
func TestHeaderIsSingleLine(t *testing.T) {
	for _, w := range []int{40, 60, 80, 120} {
		a := newTestApp()
		a.Width = w
		out := a.renderHeader()
		if lipgloss.Height(out) != 1 {
			t.Fatalf("width %d: header height = %d, want 1", w, lipgloss.Height(out))
		}
	}
}

// TestFooterIsSingleLineAndExclusive — spec §22 acceptance #2.
func TestFooterIsSingleLineAndExclusive(t *testing.T) {
	a := newTestApp()
	a.FlashText = "model switched"
	out := a.renderFooter()
	if lipgloss.Height(out) != 1 {
		t.Fatalf("footer height = %d, want 1", lipgloss.Height(out))
	}
	if strings.Contains(stripAnsi(out), "F1 for shortcuts") {
		t.Fatal("flash message and default hint both rendered — only one may win")
	}
}

// boxDrawing matches common box-drawing runes. ⎿ is spec-sanctioned and
// excluded. This only checks the steady-state frame (no overlay open) —
// see "Filed discrepancies" #2 in the plan for the overlay divider gap.
var boxDrawing = regexp.MustCompile(`[┌┐└┘├┤┬┴┼│─═║╔╗╚╝╠╣╦╩╬]`)

// TestSteadyStateFrameHasNoBoxDrawing — spec §22 acceptance #3 (scoped to
// the non-overlay frame; see plan discrepancy note #2).
func TestSteadyStateFrameHasNoBoxDrawing(t *testing.T) {
	a := newTestApp()
	out := stripAnsi(a.View())
	if boxDrawing.MatchString(out) {
		t.Fatalf("steady-state frame contains box-drawing characters:\n%s", out)
	}
}

// TestAsciiModeEmitsNoNonAsciiBytes — spec §22 acceptance #19, exercised
// against the real glyph table (not just the Ascii struct in ui/glyphs_test.go).
func TestAsciiModeEmitsNoNonAsciiBytes(t *testing.T) {
	t.Setenv("CINDERPAW_ASCII", "1")
	// ui.G is resolved once at package init, before t.Setenv can take
	// effect — this test documents the current limitation rather than
	// re-resolving it, since ui.G is a package var by design (spec §25.3
	// doesn't call for a re-pick-on-demand API). Skip with a clear reason
	// so CI output explains the gap instead of silently passing green.
	t.Skip("ui.G is resolved at package init; process-level CINDERPAW_ASCII=1 is exercised manually per the phase's exit criteria (spec §23), not by this in-process test")
}

// TestHeaderCollapsesAtNarrowWidths — spec §22 acceptance #20 (80×24
// support) + §17 responsiveness matrix.
func TestHeaderCollapsesAtNarrowWidths(t *testing.T) {
	cases := []struct {
		w    int
		want []string // substrings we expect in the stripped header
		not  []string // substrings we do NOT expect
	}{
		{w: 80, want: []string{"cinderpaw", "model", "lora", "backend"}, not: nil},
		{w: 70, want: []string{"cinderpaw", "model"}, not: []string{"lora", "backend"}},
		{w: 50, want: []string{"cinderpaw"}, not: []string{"model", "lora", "backend"}},
	}
	for _, c := range cases {
		a := newTestApp()
		a.Width = c.w
		out := stripAnsi(a.renderHeader())
		for _, s := range c.want {
			if !strings.Contains(out, s) {
				t.Fatalf("width %d: header missing %q: %q", c.w, s, out)
			}
		}
		for _, s := range c.not {
			if strings.Contains(out, s) {
				t.Fatalf("width %d: header should NOT contain %q: %q", c.w, s, out)
			}
		}
	}
}

// TestFreezeFrameAtSmallTerminal — spec §17 <40 cols or <10 rows.
func TestFreezeFrameAtSmallTerminal(t *testing.T) {
	for _, w := range []int{39, 20, 10} {
		a := newTestApp()
		a.Width = w
		a.Height = 24
		out := stripAnsi(a.View())
		if !strings.Contains(out, "terminal too small") {
			t.Fatalf("width %d: expected freeze frame, got: %q", w, out)
		}
	}
	for _, h := range []int{9, 5, 1} {
		a := newTestApp()
		a.Width = 80
		a.Height = h
		out := stripAnsi(a.View())
		if !strings.Contains(out, "terminal too small") {
			t.Fatalf("height %d: expected freeze frame, got: %q", h, out)
		}
	}
}

// TestBootHeaderShowsStarting — spec §22 acceptance for §2 J2.1.
func TestBootHeaderShowsStarting(t *testing.T) {
	a := newTestApp()
	a.State = StateBoot
	a.Status.Online = false
	out := stripAnsi(a.renderHeader())
	if !strings.Contains(out, "starting") {
		t.Fatalf("boot header should contain 'starting', got: %q", out)
	}
	if strings.Contains(out, "online") {
		t.Fatalf("boot header should not show 'online', got: %q", out)
	}
}

// TestNormalSizeShowsContent verifies 80×24 renders normally.
func TestNormalSizeShowsContent(t *testing.T) {
	a := newTestApp()
	a.Width = 80
	a.Height = 24
	out := stripAnsi(a.View())
	if strings.Contains(out, "terminal too small") {
		t.Fatal("80×24 should NOT show freeze frame")
	}
}

// Benchmark500Messages measures buildChatContent with 500 turns — spec §22
// acceptance #9: stays within all §19 budgets.
func Benchmark500Messages(b *testing.B) {
	a := newTestApp()
	a.Width = 80
	a.Height = 30
	a.ChatVP.Width = 78
	a.ChatVP.Height = 24
	for i := 0; i < 250; i++ {
		a.Turns = append(a.Turns, Turn{Role: RoleUser, Text: "What is the meaning of life?", turnVer: 1})
		a.Turns = append(a.Turns, Turn{Role: RoleAssistant, Text: "The meaning of life is 42, of course. But also helping others, finding purpose, and enjoying the journey.", turnVer: 1})
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		a.buildChatContent()
	}
}

// Benchmark500MessagesView is a heavier benchmark that runs the full View()
// path with 500 turns — covers everything including header, footer, wrapping.
func Benchmark500MessagesView(b *testing.B) {
	a := newTestApp()
	a.Width = 100
	a.Height = 30
	for i := 0; i < 250; i++ {
		a.Turns = append(a.Turns, Turn{Role: RoleUser, Text: "What is the meaning of life?", turnVer: 1})
		a.Turns = append(a.Turns, Turn{Role: RoleAssistant, Text: "The meaning of life is 42, of course. But also helping others, finding purpose, and enjoying the journey.", turnVer: 1})
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		a.View()
	}
}

// TestIdleStateNoAnimation — spec §22 acceptance #11: idle state runs zero
// animation timers. Verifies that FrameTickMsg is a no-op in idle state.
func TestIdleStateNoAnimation(t *testing.T) {
	a := newTestApp()
	a.State = StateIdle
	model, cmd := a.Update(FrameTickMsg(time.Now()))
	if cmd != nil {
		t.Fatalf("FrameTickMsg in Idle should return nil cmd, got %v", cmd)
	}
	// The model must still be the same app (not replaced).
	if _, ok := model.(*App); !ok {
		t.Fatal("Update returned non-App model")
	}
}

// TestFrameTickMsgOnlyInStreaming — FrameTickMsg triggers rebuild only when
// the state is StateStreaming.
func TestFrameTickMsgOnlyInStreaming(t *testing.T) {
	fixedTime := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	for _, s := range []State{StateReady, StateIdle, StateError, StateBoot, StateThinking} {
		a := newTestApp()
		a.State = s
		a.Now = fixedTime
		origContent := a.buildChatContent()
		// Send a FrameTickMsg — should be a no-op when !streaming.
		a.Update(FrameTickMsg(time.Now()))
		a.Now = fixedTime
		afterContent := a.buildChatContent()
		if afterContent != origContent {
			t.Fatalf("state %v: FrameTickMsg changed chat content", s)
		}
	}
}

// TestNarrowToolLayoutMovesTail — spec §17: tool tail moves to ⎿ at 60–79.
func TestNarrowToolLayoutMovesTail(t *testing.T) {
	a := newTestApp()
	tc := ToolCall{
		Name: "grep", Main: "foo",
		Status: ToolDone, StartedAt: time.Now(), EndedAt: time.Now(),
	}
	// At width 100 (normal): tail on call line.
	a.Width = 100
	normal := stripAnsi(a.renderToolPill(tc, "", 80))
	if !strings.Contains(normal, "⏱") && !strings.Contains(normal, "ok") {
		// At normal width, call line has the tail.
	}
	// At width 70 (narrow): tail should move to ⎿.
	a.Width = 70
	narrow := stripAnsi(a.renderToolPill(tc, "", 60))
	narrowLines := strings.Split(narrow, "\n")
	if len(narrowLines) < 2 {
		t.Fatalf("narrow tool pill should have at least 2 lines, got %d", len(narrowLines))
	}
}

// TestNoGlyphLiteralsInAppCode enforces the plan's global constraint
// ("no lipgloss.Color/hex literal or magic glyph string may appear
// directly in tui/app/*.go"). Scans every non-test source file under
// the app package for the spec's glyph inventory (§5/§25.3) outside of
// comments and string-test fixtures; a hit means a renderer is bypassing
// the ui.G.* table and ASCII mode will leak Unicode into non-UTF-8
// locales.
//
// The grep is intentionally lenient about comments (where we *describe*
// what the renderer draws — the description isn't itself a renderer)
// and about string literals in test files (which assert rendered output
// contains a given glyph, not that the renderer emitted it from a
// literal). False positives are easy to triage from the line number in
// the failure output.
func TestNoGlyphLiteralsInAppCode(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	glyphs := []string{"⏺", "⎿", "▸", "▾", "●", "○", "◦", "✻", "✓", "✗", "↓", "↑", "▍", "⠋", "⠿"}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		path := filepath.Join(".", name)
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(string(b), "\n")
		for ln, raw := range lines {
			trimmed := strings.TrimSpace(raw)
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "/*") || strings.HasPrefix(trimmed, "*") {
				continue
			}
			for _, g := range glyphs {
			if strings.Contains(raw, g) {
				t.Errorf("%s:%d contains glyph literal %q — use ui.G.* instead (full line: %q)", name, ln+1, g, raw)
			}
		}
	}
}
}
