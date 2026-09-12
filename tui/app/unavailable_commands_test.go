package app

import (
	"strings"
	"testing"

	"cinderpaw-tui/api"
)

func TestUnavailableMemoryAndDreamCommandsDoNotStartWork(t *testing.T) {
	for _, command := range []string{"dream now", "memory", "memory search", "memory search remembered fact"} {
		t.Run(command, func(t *testing.T) {
			a := App{Status: &api.StatusSnapshot{}}
			if cmd := a.handleSlash(command); cmd != nil {
				t.Fatal("unavailable command scheduled work")
			}
			if !strings.Contains(a.FlashText, "unavailable") {
				t.Fatalf("command did not disclose unavailability: %q", a.FlashText)
			}
		})
	}
}

func TestDreamSummaryUsesOnlyObservedEvents(t *testing.T) {
	a := App{}
	a.handleSlash("dream")
	if strings.Contains(a.FlashText, "/dream now") {
		t.Fatalf("empty summary recommended an unavailable action: %q", a.FlashText)
	}
	a.RuntimeEvents = []api.RuntimeEvent{
		{Kind: "dream_cycle", Message: "older cycle"},
		{Kind: "dream_cycle", Message: "latest cycle"},
		{Kind: "other", Message: "unrelated event"},
	}
	a.handleSlash("dream")
	if !strings.Contains(a.FlashText, "latest cycle") || strings.Contains(a.FlashText, "unrelated event") {
		t.Fatalf("summary did not show the latest observed dream: %q", a.FlashText)
	}
}
