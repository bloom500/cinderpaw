package app

import (
	"strings"
	"testing"
	"time"

	"feral-tui/api"
	"feral-tui/ui"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
)

// newTestApp returns an App sized to a typical terminal, with the
// bubbletea sub-components properly initialized so View() can be called
// without booting the full program. Mirrors the constructor in New().
func newTestApp() *App {
	ti := textarea.New()
	ti.Placeholder = "type a message…"
	ti.Prompt = ""
	ti.FocusedStyle.CursorLine = ti.FocusedStyle.CursorLine.UnsetBackground()
	ti.BlurredStyle.CursorLine = ti.BlurredStyle.CursorLine.UnsetBackground()
	ti.Focus()
	ti.SetWidth(98)
	ti.SetHeight(3)

	vp := viewport.New(100, 20)
	vp.KeyMap = viewport.DefaultKeyMap()

	sp := spinner.New()
	sp.Style = ui.SpinnerStyle
	sp.Spinner = spinner.MiniDot

	a := &App{
		Width:     100,
		Height:    30,
		Status:    &api.StatusSnapshot{Online: true, Model: "qwen2.5-7b", Backend: "llama.cpp", LoRA: "none"},
		BaseURL:   "http://127.0.0.1:11435",
		Token:     "x",
		StartedAt: time.Now().Add(-2 * time.Minute),
		Input:     ti,
		ChatVP:    vp,
		Loader:    sp,
		State:     StateReady,
	}
	return a
}

func TestViewRendersIdle(t *testing.T) {
	a := newTestApp()
	out := a.View()
	if out == "" || out == "Loading…" {
		t.Fatalf("View() returned empty/loading for a sized app: %q", out)
	}
	if !strings.Contains(out, "feral") {
		t.Fatalf("expected 'feral' brand in view, got:\n%s", out)
	}
}

func TestViewRendersStreamingStatus(t *testing.T) {
	a := newTestApp()
	a.State = StateStreaming
	a.StreamStartedAt = time.Now().Add(-5 * time.Second)
	a.StreamCompletionTokens = 142
	out := a.View()
	if !strings.Contains(out, "streaming") {
		t.Fatalf("expected 'streaming' marker in view, got:\n%s", out)
	}
	if !strings.Contains(out, "tok") {
		t.Fatalf("expected token count in view, got:\n%s", out)
	}
	if !strings.Contains(out, "t/s") {
		t.Fatalf("expected tokens-per-second in view, got:\n%s", out)
	}
}

func TestViewRendersCompletionPopup(t *testing.T) {
	a := newTestApp()
	a.Completion.Show = true
	a.Completion.Idx = 0
	a.Completion.List = computeCompletions("/mo")
	out := a.View()
	// The popup box border is rendered as one of lipgloss's normal-border
	// chars. We just check the command text leaked through (lipgloss can
	// paint over it, so we strip ANSI for the assertion).
	stripped := stripAnsi(out)
	if !strings.Contains(stripped, "/model") {
		t.Fatalf("expected /model in popup view, got:\n%s", out)
	}
	if !strings.Contains(stripped, "switch") {
		t.Fatalf("expected description text in popup view, got:\n%s", out)
	}
}

// stripAnsi is a tiny helper that drops CSI escape sequences from a string
// so test assertions can match against human-readable text. A CSI sequence
// is ESC '[' followed by any number of parameter/intermediate bytes
// (0x20-0x3f) and a single final byte (0x40-0x7e); the whole sequence is
// discarded, including multi-parameter truecolor SGR codes like
// "\x1b[38;2;121;116;107m".
func stripAnsi(s string) string {
	var b strings.Builder
	i := 0
	for i < len(s) {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) && s[j] >= 0x20 && s[j] <= 0x3f {
				j++
			}
			if j < len(s) {
				j++ // consume the final byte (0x40-0x7e)
			}
			i = j
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

func TestStripAnsiTruecolorMultiParam(t *testing.T) {
	in := "\x1b[38;2;121;116;107m⎿\x1b[0m \x1b[3;38;2;121;116;107mcached\x1b[0m"
	got := stripAnsi(in)
	want := "⎿ cached"
	if got != want {
		t.Fatalf("stripAnsi truecolor multi-param: got %q, want %q (raw %q)", got, want, in)
	}
}

// ensure tea import is referenced even when no test below uses it directly
// — keeps the import block honest if we add bubble-tea-driven tests later.
var _ tea.Model = (*App)(nil)

// keep the time import live even when tests stop using it explicitly
var _ = time.Now