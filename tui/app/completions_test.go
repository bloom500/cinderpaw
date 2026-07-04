package app

import "testing"

func TestComputeCompletionsSlashOnly(t *testing.T) {
	list := computeCompletions("/")
	// Every known command must show up — `/` alone is "show me everything".
	if len(list) != len(KnownCommands) {
		t.Fatalf("`/` should return all %d commands, got %d", len(KnownCommands), len(list))
	}
}

func TestComputeCompletionsNarrowed(t *testing.T) {
	for _, prefix := range []string{"/h", "/?", "/cle", "/mod", "/ex", "/q"} {
		list := computeCompletions(prefix)
		if len(list) == 0 {
			t.Fatalf("prefix %q matched nothing", prefix)
		}
		for _, c := range list {
			if !hasPrefix(c.Text, prefix) {
				t.Fatalf("completion %q does not start with %q", c.Text, prefix)
			}
		}
	}
}

func TestComputeCompletionsEmpty(t *testing.T) {
	if list := computeCompletions("/zzz_no_such_command"); len(list) != 0 {
		t.Fatalf("expected empty list for unknown prefix, got %d", len(list))
	}
}

func TestComputeCompletionsCaseSensitive(t *testing.T) {
	// Slash commands are exact — uppercase prefixes must not match.
	if list := computeCompletions("/H"); len(list) != 0 {
		t.Fatalf("`/H` must not match (commands are lowercase), got %d", len(list))
	}
}

func TestComputeCompletionsPreservesOrder(t *testing.T) {
	// `/mo` should hit `/model` before `/model list` before `/model <id>` —
	// registry order is the visual order in the popup.
	list := computeCompletions("/mo")
	if len(list) < 3 {
		t.Fatalf("expected 3 matches for /mo, got %d", len(list))
	}
	if list[0].Text != "/model" {
		t.Fatalf("first match should be /model, got %q", list[0].Text)
	}
}