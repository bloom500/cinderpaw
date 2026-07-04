package app

import (
	"feral-tui/api"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func TestInferErrorKindTimeout(t *testing.T) {
	for _, msg := range []string{
		"model timed out after 120s",
		"deadline exceeded",
		"TTFT timeout",
	} {
		kind, _ := inferErrorKind(msg)
		if kind != "timeout" {
			t.Fatalf("inferErrorKind(%q) = %q, want timeout", msg, kind)
		}
	}
}

func TestInferErrorKindPermission(t *testing.T) {
	for _, msg := range []string{
		"permission denied",
		"write not allowed in this profile",
		"EACCES: /etc/passwd",
	} {
		kind, _ := inferErrorKind(msg)
		if kind != "permission" {
			t.Fatalf("inferErrorKind(%q) = %q, want permission", msg, kind)
		}
	}
}

func TestInferErrorKindNetwork(t *testing.T) {
	for _, msg := range []string{
		"connection refused",
		"connection reset by peer",
		"host unreachable",
		"ECONNREFUSED 127.0.0.1:11435",
	} {
		kind, _ := inferErrorKind(msg)
		if kind != "network" {
			t.Fatalf("inferErrorKind(%q) = %q, want network", msg, kind)
		}
	}
}

func TestInferErrorKindTool(t *testing.T) {
	for _, msg := range []string{
		"not_available: shell_exec",
		"unknown tool: made_up_tool",
	} {
		kind, _ := inferErrorKind(msg)
		if kind != "tool" {
			t.Fatalf("inferErrorKind(%q) = %q, want tool", msg, kind)
		}
	}
}

func TestInferErrorKindUnknown(t *testing.T) {
	kind, hint := inferErrorKind("something completely novel happened")
	if kind != "unknown" {
		t.Fatalf("expected kind=unknown, got %q", kind)
	}
	if hint != "" {
		t.Fatalf("unknown errors should have empty hint, got %q", hint)
	}
}

func TestInferErrorKindHintProvided(t *testing.T) {
	_, hint := inferErrorKind("model timed out after 120s")
	if hint == "" {
		t.Fatal("timeout errors should carry a hint")
	}
}

func TestInferErrorKindNoModel(t *testing.T) {
	for _, msg := range []string{"no model loaded", "model not found", "no_model_selected"} {
		kind, hint := inferErrorKind(msg)
		if kind != "no_model" {
			t.Fatalf("inferErrorKind(%q) = %q, want no_model", msg, kind)
		}
		if hint == "" {
			t.Fatal("no_model errors should carry a hint")
		}
	}
}

func TestInferErrorKindOffline(t *testing.T) {
	kind, hint := inferErrorKind("offline: no network reachable")
	if kind != "offline" {
		t.Fatalf("inferErrorKind = %q, want offline", kind)
	}
	if hint == "" {
		t.Fatal("offline errors should carry a hint")
	}
}

func TestInferErrorKindRuntimeLost(t *testing.T) {
	for _, msg := range []string{"runtime lost", "gateway unreachable", "gateway down"} {
		kind, _ := inferErrorKind(msg)
		if kind != "runtime_lost" {
			t.Fatalf("inferErrorKind(%q) = %q, want runtime_lost", msg, kind)
		}
	}
}

func TestInferErrorKindRateLimited(t *testing.T) {
	for _, msg := range []string{"429 too many requests", "rate limit exceeded"} {
		kind, hint := inferErrorKind(msg)
		if kind != "rate_limited" {
			t.Fatalf("inferErrorKind(%q) = %q, want rate_limited", msg, kind)
		}
		if hint == "" {
			t.Fatal("rate_limited errors should carry a hint")
		}
	}
}

func TestRateLimitEntersErrorStateWithDeadline(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.lastUserText = "hi"
	a.pushAssistantError("429 too many requests")
	if a.RateLimitUntil.IsZero() {
		t.Fatal("expected RateLimitUntil to be set on a rate_limited error")
	}
}

// TestStreamDoneAfterErrorPreservesStateError pins the contract that
// finishStream does not clobber StateError when StreamDoneMsg follows a
// mid-stream error chunk. Before the fix, the countdown hint vanished
// from the footer the instant the stream ended and the `r` keybind
// stopped working (r only fires in StateError). Driving the full path —
// error chunk → StreamDoneMsg — exercises the bug end-to-end.
func TestStreamDoneAfterErrorPreservesStateError(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming
	a.lastUserText = "hi"

	a.handleStreamChunk(api.Chunk{Error: "429 too many requests"})
	if a.State != StateError {
		t.Fatalf("after error chunk: State = %v, want StateError", a.State)
	}
	if a.RateLimitUntil.IsZero() {
		t.Fatal("expected RateLimitUntil to be set after rate_limited error")
	}

	_, _ = a.Update(StreamDoneMsg{Err: nil})
	if a.State != StateError {
		t.Fatalf("after StreamDone: State = %v, want StateError (finishStream must not clobber)", a.State)
	}
	if a.RateLimitUntil.IsZero() {
		t.Fatal("RateLimitUntil must survive StreamDone — auto-retry depends on it")
	}
}

// TestStreamDoneAfterSuccessRestoresReady is the positive-path companion
// to the test above: when no error fired, StreamDone must land the app
// in StateReady (not leave it dangling in StateStreaming).
func TestStreamDoneAfterSuccessRestoresReady(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming

	_, _ = a.Update(StreamDoneMsg{Err: nil})
	if a.State != StateReady {
		t.Fatalf("after clean StreamDone: State = %v, want StateReady", a.State)
	}
}

func TestOpenToolViewerNewestFirst(t *testing.T) {
	a := newTestApp()
	// Build three turns each with one tool, then open the viewer.
	a.Turns = []Turn{
		{Role: RoleUser, Text: "first"},
		{Role: RoleAssistant, Tools: []ToolCall{{ID: "t1", Name: "read_file", Status: ToolDone, StartedAt: time.Now().Add(-2 * time.Second), EndedAt: time.Now()}}},
		{Role: RoleUser, Text: "second"},
		{Role: RoleAssistant, Tools: []ToolCall{{ID: "t2", Name: "grep", Status: ToolDone, StartedAt: time.Now(), EndedAt: time.Now()}}},
		{Role: RoleUser, Text: "third"},
		{Role: RoleAssistant, Tools: []ToolCall{{ID: "t3", Name: "shell_exec", Status: ToolRunning, StartedAt: time.Now()}}},
	}
	a.openToolViewer()
	if !a.ToolViewer.Show {
		t.Fatal("ToolViewer.Show should be true after openToolViewer")
	}
	if len(a.ToolViewer.Rows) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(a.ToolViewer.Rows))
	}
	// Newest first means t3 at idx 0, t1 at idx 2.
	if a.ToolViewer.Rows[0].Call.ID != "t3" {
		t.Fatalf("newest tool should be first, got %q", a.ToolViewer.Rows[0].Call.ID)
	}
	if a.ToolViewer.Rows[2].Call.ID != "t1" {
		t.Fatalf("oldest tool should be last, got %q", a.ToolViewer.Rows[2].Call.ID)
	}
	if a.ToolViewer.Expanded {
		t.Fatal("Expanded should default to false")
	}
	if a.ToolViewer.Idx != 0 {
		t.Fatalf("Idx should reset to 0, got %d", a.ToolViewer.Idx)
	}
}

func TestOpenToolViewerSkipsUserTurns(t *testing.T) {
	a := newTestApp()
	// Two user turns with no assistant response → 0 tools, but the
	// overlay should still open with the empty-state hint.
	a.Turns = []Turn{
		{Role: RoleUser, Text: "hi"},
		{Role: RoleUser, Text: "again"},
	}
	a.openToolViewer()
	if !a.ToolViewer.Show {
		t.Fatal("Show should be true even when no tools exist")
	}
	if len(a.ToolViewer.Rows) != 0 {
		t.Fatalf("expected 0 rows from user-only turns, got %d", len(a.ToolViewer.Rows))
	}
}

func TestPlural(t *testing.T) {
	if plural(0) != "s" || plural(1) != "" || plural(2) != "s" || plural(42) != "s" {
		t.Fatalf("plural broken: %q/%q/%q/%q", plural(0), plural(1), plural(2), plural(42))
	}
}

// ── Runtime event tests (§11 / §22 acceptance 25–26) ──────────────

func TestFormatRuntimeEventDreamCycle(t *testing.T) {
	cases := []struct {
		ev   api.RuntimeEvent
		want string
	}{
		{ev: api.RuntimeEvent{Kind: "dream_cycle", Message: ""}, want: "dreaming…"},
		{ev: api.RuntimeEvent{Kind: "dream_cycle", Message: "2 insights added to memory"}, want: "dream: 2 insights added to memory"},
		{ev: api.RuntimeEvent{Kind: "memory_indexed", Message: "done (12 s)"}, want: "indexing memory… done (12 s)"},
		{ev: api.RuntimeEvent{Kind: "lora_training", Message: "eval +4.2% — approve in /lora"}, want: "lora: eval +4.2% — approve in /lora"},
		{ev: api.RuntimeEvent{Kind: "genome_evolution", Message: "layer L3 fitness 0.83 → 0.85"}, want: "genome: layer L3 fitness 0.83 → 0.85"},
		{ev: api.RuntimeEvent{Kind: "meta_evolution", Message: "epoch 7 — mutation budget tightened"}, want: "meta: epoch 7 — mutation budget tightened"},
		{ev: api.RuntimeEvent{Kind: "connector_event", Message: "telegram: reply sent to @dan"}, want: "telegram: reply sent to @dan"},
		{ev: api.RuntimeEvent{Kind: "model_set", Model: "gpt-4o"}, want: "routed to gpt-4o"},
		{ev: api.RuntimeEvent{Kind: "model_set", Model: "stepfun-ai/step-3.7-flash"}, want: "routed to step-3.7-flash"},
		{ev: api.RuntimeEvent{Kind: "fallback", Message: "primary unreachable, switching to local"}, want: "⚠ primary unreachable, switching to local"},
		// Unknown kind — forward-compatible fallback to Message
		{ev: api.RuntimeEvent{Kind: "unknown_new_feature", Message: "something happened"}, want: "something happened"},
	}
	for _, c := range cases {
		got := formatRuntimeEvent(c.ev)
		if got != c.want {
			t.Fatalf("formatRuntimeEvent(%+v) = %q, want %q", c.ev, got, c.want)
		}
	}
}

// TestRuntimeEventQueueDuringStreaming — spec §22 acceptance #25.
func TestRuntimeEventQueueDuringStreaming(t *testing.T) {
	a := newTestApp()
	a.State = StateStreaming
	a.beginAssistant()

	// Send two runtime events while streaming.
	a.Update(RuntimeEventMsg{Event: api.RuntimeEvent{Kind: "dream_cycle", Message: "2 insights"}})
	a.Update(RuntimeEventMsg{Event: api.RuntimeEvent{Kind: "connector_event", Message: "telegram: replied"}})

	if len(a.RuntimeEvents) != 0 {
		t.Fatalf("expected 0 rendered events during streaming, got %d", len(a.RuntimeEvents))
	}
	if len(a.PendingEvents) != 2 {
		t.Fatalf("expected 2 pending events, got %d", len(a.PendingEvents))
	}

	// Flush by ending the stream (simulates StreamDoneMsg path).
	_, _ = a.Update(StreamDoneMsg{Err: nil})

	if len(a.PendingEvents) != 0 {
		t.Fatalf("expected 0 pending after flush, got %d", len(a.PendingEvents))
	}
	if len(a.RuntimeEvents) != 2 {
		t.Fatalf("expected 2 rendered events after flush, got %d", len(a.RuntimeEvents))
	}

	content := a.buildChatContent()
	if !strings.Contains(content, "dream: 2 insights") {
		t.Fatalf("expected dream event in transcript, got:\n%s", content)
	}
	if !strings.Contains(content, "telegram: replied") {
		t.Fatalf("expected connector event in transcript, got:\n%s", content)
	}
}

// TestRuntimeEventCoalesce — spec §22 acceptance #26.
func TestRuntimeEventCoalesce(t *testing.T) {
	a := newTestApp()
	// Insert 3 same-kind events followed by a different one.
	a.RuntimeEvents = []api.RuntimeEvent{
		{Kind: "connector_event", Message: "discord: reconnected"},
		{Kind: "connector_event", Message: "telegram: reply sent"},
		{Kind: "connector_event", Message: "whatsapp: message received"},
		{Kind: "dream_cycle", Message: "2 insights"},
	}
	a.coalesceRuntimeEvents()
	if len(a.RuntimeEvents) != 2 {
		t.Fatalf("expected 2 coalesced events, got %d", len(a.RuntimeEvents))
	}
	if a.RuntimeEvents[0].Kind != "connector_event" {
		t.Fatalf("first coalesced kind = %q, want connector_event", a.RuntimeEvents[0].Kind)
	}
	if !strings.Contains(a.RuntimeEvents[0].Message, "3") || !strings.Contains(a.RuntimeEvents[0].Message, "connector_event") {
		t.Fatalf("coalesced message should mention count and kind, got %q", a.RuntimeEvents[0].Message)
	}
	if a.RuntimeEvents[1].Kind != "dream_cycle" {
		t.Fatalf("second event kind = %q, want dream_cycle", a.RuntimeEvents[1].Kind)
	}
}

// TestRuntimeEventAppendsDirectlyWhenIdle verifies that events arrive
// immediately in RuntimeEvents when not streaming.
// TestEveryErrorKindHasActionableHint — spec §22 acceptance #14.
// Every error card's hint must name an action the user can take.
func TestEveryErrorKindHasActionableHint(t *testing.T) {
	kinds := []string{
		"429 too many requests",
		"no model loaded",
		"runtime lost",
		"offline",
		"timed out",
		"permission denied",
		"connection refused",
		"unknown tool: foo",
		"something completely novel",
	}
	for _, msg := range kinds {
		kind, hint := inferErrorKind(msg)
		// Only "unknown" has no hint — that's the fallthrough case.
		if kind == "unknown" {
			if hint != "" {
				t.Fatalf("inferErrorKind(%q) = (%q, %q): unknown should have empty hint", msg, kind, hint)
			}
			continue
		}
		if hint == "" {
			t.Fatalf("inferErrorKind(%q) = (%q, %q): expected non-empty hint for acceptance #14", msg, kind, hint)
		}
	}
}

// TestThinkingStateTransition verifies that StateThinking is entered when
// reasoning arrives before the first content token (§9).
func TestThinkingStateTransition(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateStreaming

	// Reasoning arrives — should enter StateThinking.
	a.handleStreamChunk(api.Chunk{Reasoning: "thinking step 1"})
	if a.State != StateThinking {
		t.Fatalf("expected StateThinking after reasoning, got %v", a.State)
	}
	if a.streamHasContent {
		t.Fatal("streamHasContent should remain false after reasoning only")
	}

	// Content arrives — should revert to StateStreaming.
	a.handleStreamChunk(api.Chunk{Content: "Hello"})
	if a.State != StateStreaming {
		t.Fatalf("expected StateStreaming after content, got %v", a.State)
	}
	if !a.streamHasContent {
		t.Fatal("streamHasContent should be true after content")
	}
}

// TestThinkingFinishStreamRestoresReady verifies finishStream handles
// StateThinking → StateReady.
func TestThinkingFinishStreamRestoresReady(t *testing.T) {
	a := newTestApp()
	a.beginAssistant()
	a.State = StateThinking

	_, _ = a.Update(StreamDoneMsg{Err: nil})
	if a.State != StateReady {
		t.Fatalf("after StreamDone in Thinking: State = %v, want StateReady", a.State)
	}
}

// TestToolDeclinedStatusRendersDeclined verifies a declined tool call
// produces a "⎿ declined" result line.
func TestToolDeclinedStatusRendersDeclined(t *testing.T) {
	a := newTestApp()
	tc := ToolCall{
		ID: "t1", Name: "shell_exec", Main: "rm -rf /",
		Status: ToolDeclined, StartedAt: time.Now(), EndedAt: time.Now(),
	}
	out := a.renderToolPill(tc, "", 80)
	stripped := stripAnsi(out)
	if !strings.Contains(stripped, "declined") {
		t.Fatalf("declined tool pill should contain 'declined', got:\n%s", stripped)
	}
	if !strings.Contains(stripped, "rm -rf") {
		t.Fatalf("declined tool pill should show the tool args, got:\n%s", stripped)
	}
}

// TestToolResultBudget verifies the 3-line result budget (§8).
func TestToolResultBudget(t *testing.T) {
	a := newTestApp()
	tc := ToolCall{
		Name: "grep", Status: ToolDone,
		Note:    "searched 42 files",
		ErrMsg:  "2 matches found",
		Preview: "line 1\nline 2\nline 3\nline 4\nline 5",
		StartedAt: time.Now(), EndedAt: time.Now(),
	}
	out := a.renderToolPill(tc, "", 80)
	lines := strings.Split(out, "\n")
	if len(lines) > 4 {
		t.Fatalf("tool pill should have at most 4 lines (1 call + 3 ⎿), got %d", len(lines))
	}
	// When the budget is exceeded, the last line should mention /tools.
	last := stripAnsi(lines[len(lines)-1])
	if strings.Contains(last, "more") && !strings.Contains(last, "/tools") {
		t.Fatalf("overflow line should mention /tools, got: %q", last)
	}
}

// TestWizardFlow — spec §22 acceptance #22-24: wizard flow, resume, key validation.
func TestWizardFlow(t *testing.T) {
	a := newTestApp()

	// Start wizard.
	a.startWizard()
	if !a.Wizard.Show {
		t.Fatal("startWizard should set Show=true")
	}
	if a.Wizard.Step != WizModelChoice {
		t.Fatalf("expected WizModelChoice after hardware probe, got %v", a.Wizard.Step)
	}

	// Select local.
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("1")})
	if a.Wizard.Choice != WizChoiceLocal {
		t.Fatal("key 1 should select local")
	}
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if a.Wizard.Step != WizLocalDownload {
		t.Fatalf("expected WizLocalDownload after enter, got %v", a.Wizard.Step)
	}

	// Simulate download progress.
	a.Wizard.Progress = 0.5
	a.Wizard.ProgressMsg = "downloading — 3 minutes"
	content := a.renderWizard()
	if content == "" {
		t.Fatal("wizard render should not be empty")
	}
}

// TestWizardCloudKeyValidation — spec §22 acceptance #24.
func TestWizardCloudKeyValidation(t *testing.T) {
	a := newTestApp()
	a.startWizard()
	a.Wizard.Choice = WizChoiceCloud
	a.Wizard.Step = WizCloudKey
	a.Wizard.Provider = "openai"

	// Enter with empty key: noop.
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if a.Wizard.Step != WizCloudKey {
		t.Fatal("enter with empty key should stay on WizCloudKey")
	}

	// Type a key.
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("sk-xxxx")})
	if a.Wizard.APIKey != "sk-xxxx" {
		t.Fatalf("expected APIKey=sk-xxxx, got %q", a.Wizard.APIKey)
	}

	// Enter validates.
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if !a.Wizard.KeyValid {
		t.Fatal("enter should validate key")
	}
	if a.Wizard.Step != WizConnectors {
		t.Fatalf("expected WizConnectors after key val, got %v", a.Wizard.Step)
	}
}

func TestModelSetEventUpdatesStatus(t *testing.T) {
	a := newTestApp()
	a.Update(RuntimeEventMsg{Event: api.RuntimeEvent{
		Kind: "model_set", Provider: "openai", Model: "gpt-4o",
	}})
	if a.Status.Model != "gpt-4o" {
		t.Fatalf("expected model=gpt-4o, got %q", a.Status.Model)
	}
	if a.Status.Provider != "openai" {
		t.Fatalf("expected provider=openai, got %q", a.Status.Provider)
	}
}

// TestTurnRenderCache — calls buildChatContent twice; the second call should
// hit cache for every clean turn and produce identical output.
func TestTurnRenderCache(t *testing.T) {
	a := newTestApp()
	a.Width = 80
	a.Height = 24
	a.ChatVP.Width = 78
	a.ChatVP.Height = 20

	// Add a few turns.
	a.Turns = []Turn{
		{Role: RoleUser, Text: "hello", turnVer: 1},
		{Role: RoleAssistant, Text: "world", Streaming: false, turnVer: 1},
		{Role: RoleUser, Text: "second question", turnVer: 1},
		{Role: RoleAssistant, Text: "second answer", Streaming: false, turnVer: 1},
	}
	first := a.buildChatContent()
	if first == "" {
		t.Fatal("buildChatContent returned empty")
	}

	// All cached entries should be populated.
	for i := range a.Turns {
		if a.Turns[i].turnCache == "" {
			t.Fatalf("turn %d cache is empty after buildChatContent", i)
		}
		if a.Turns[i].turnCacheVer != a.Turns[i].turnVer {
			t.Fatalf("turn %d cache version mismatch: %d != %d", i, a.Turns[i].turnCacheVer, a.Turns[i].turnVer)
		}
	}

	// Second call with no mutations: same output, cache hits.
	second := a.buildChatContent()
	if second != first {
		t.Fatal("second buildChatContent with no mutations produced different output")
	}
}

func TestRuntimeEventAppendsDirectlyWhenIdle(t *testing.T) {
	a := newTestApp()
	a.State = StateReady

	a.Update(RuntimeEventMsg{Event: api.RuntimeEvent{Kind: "dream_cycle", Message: "2 insights"}})

	if len(a.PendingEvents) != 0 {
		t.Fatalf("expected no pending events in idle state, got %d", len(a.PendingEvents))
	}
	if len(a.RuntimeEvents) != 1 {
		t.Fatalf("expected 1 rendered event, got %d", len(a.RuntimeEvents))
	}
}