package app

// Run with:  go test ./app/... -run TestPrintScreens -v
//
// The other tests are silent; this one dumps the rendered TUI to stdout so
// you can eyeball colours and alignment when iterating on style. Not
// part of the regular test suite — guarded behind `-run` so `go test`
// without flags stays green and fast.

import (
	"fmt"
	"testing"
	"time"
)

func TestPrintScreens(t *testing.T) {
	cases := []struct {
		name string
		mut  func(a *App)
	}{
		{"welcome", func(a *App) {}},
		{"welcome_wide", func(a *App) {
			a.Width = 120
			a.Height = 40
			a.ChatVP.Width = 118
			a.ChatVP.Height = 30
		}},
		{"welcome_narrow_60", func(a *App) {
			a.Width = 60
			a.Height = 30
			a.ChatVP.Width = 58
			a.ChatVP.Height = 22
		}},
		{"welcome_narrow_50", func(a *App) {
			a.Width = 50
			a.Height = 30
			a.ChatVP.Width = 48
			a.ChatVP.Height = 22
		}},
		{"welcome_narrow_30", func(a *App) {
			a.Width = 30
			a.Height = 25
			a.ChatVP.Width = 28
			a.ChatVP.Height = 17
		}},
		{"welcome_tiny_20", func(a *App) {
			a.Width = 20
			a.Height = 20
			a.ChatVP.Width = 18
			a.ChatVP.Height = 12
		}},
		{"streaming", func(a *App) {
			a.State = StateStreaming
			a.StreamStartedAt = time.Now().Add(-7 * time.Second)
			a.StreamCompletionTokens = 312
		}},
		{"completion", func(a *App) {
			a.Completion.Show = true
			a.Completion.Idx = 1
			a.Completion.List = computeCompletions("/mo")
		}},
		{"completion_stalled", func(a *App) {
			a.State = StateStreaming
			a.StreamStartedAt = time.Now().Add(-22 * time.Second)
			a.StreamCompletionTokens = 180
			a.LastTokenAt = time.Now().Add(-4 * time.Second)
		}},
		{"error_card_turn", func(a *App) {
			a.Turns = []Turn{
				{Role: RoleUser, Text: "why does the embed crash?"},
				{Role: RoleAssistant,
					Text: "Looking at the logs…",
					Tools: []ToolCall{{ID: "c1", Name: "read_file", Main: "inference.rs:42", Status: ToolDone, StartedAt: time.Now().Add(-2 * time.Second), EndedAt: time.Now()}},
					Errors: []ErrorCard{{Message: "model timed out after 120s", Kind: "timeout", Hint: "Try: shorter prompt, or ^C to cancel"}},
				},
			}
		}},
		{"tool_viewer", func(a *App) {
			a.Turns = []Turn{
				{Role: RoleUser, Text: "first"},
				{Role: RoleAssistant, Tools: []ToolCall{
					{ID: "t1", Name: "read_file", Main: "project_local_models_gpu.md", Status: ToolDone, StartedAt: time.Now().Add(-2 * time.Second), EndedAt: time.Now().Add(-1900 * time.Millisecond), Preview: "# project_local_models_gpu.md\n\nOn-disk models:\n- bge-small-en-v1.5 (default embed)\n- qwen2.5-coder-7b (chat)\n- llama-3.1-8b (fallback)"},
					{ID: "t2", Name: "shell_exec", Main: "ls models/", Status: ToolError, StartedAt: time.Now().Add(-1 * time.Second), EndedAt: time.Now(), ErrMsg: "permission denied", Preview: ""},
					{ID: "t3", Name: "tool_health", Status: ToolRunning, StartedAt: time.Now()},
				}},
				{Role: RoleUser, Text: "second"},
				{Role: RoleAssistant, Tools: []ToolCall{
					{ID: "t4", Name: "grep", Main: "CINDERPAW_EMBED_GPU_LAYERS", Status: ToolDone, StartedAt: time.Now().Add(-3 * time.Second), EndedAt: time.Now().Add(-2900 * time.Millisecond), Preview: "src-tauri/src/inference.rs:42:env_or(\"CINDERPAW_EMBED_GPU_LAYERS\", \"0\")"},
				}},
			}
			a.openToolViewer()
		}},
		{"tool_viewer_expanded", func(a *App) {
			a.Turns = []Turn{
				{Role: RoleUser, Text: "x"},
				{Role: RoleAssistant, Tools: []ToolCall{
					{ID: "t1", Name: "read_file", Main: "x.md", Status: ToolDone, StartedAt: time.Now().Add(-2 * time.Second), EndedAt: time.Now(), Preview: "# x.md\n\nLine one\nLine two\nLine three\nLine four\nLine five"},
				}},
			}
			a.openToolViewer()
			a.ToolViewer.Expanded = true
			a.ToolViewer.Idx = 0
		}},
	}
	for _, c := range cases {
		a := newTestApp()
		c.mut(a)
		fmt.Printf("\n===== %s =====\n%s\n", c.name, a.View())
	}
}