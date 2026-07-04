package app

import "testing"

func TestStateFooterHintMatchesSpecTable(t *testing.T) {
	cases := []struct {
		state State
		want  string
	}{
		{StateReady, "F1 for shortcuts · Ctrl+C to exit"},
		{StateThinking, "thinking…"},
		{StateStreaming, "esc to interrupt"},
		{StateToolRunning, "running…"},
		{StateIdle, "F1 for shortcuts · Ctrl+C to exit"},
		{StateRecovery, "reconnecting…"},
	}
	for _, c := range cases {
		if got := c.state.FooterHint(); got != c.want {
			t.Fatalf("State(%d).FooterHint() = %q, want %q", c.state, got, c.want)
		}
	}
}

func TestNewAppStartsReady(t *testing.T) {
	a := newTestApp()
	if a.State != StateReady {
		t.Fatalf("newTestApp() State = %v, want StateReady", a.State)
	}
}
