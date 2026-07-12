package app

// Guided first-run flow (OpenClaw parity) — pins the ladder mechanics:
// hardware downloads are consent-gated (skipped by auto-test), a failing
// existing-config stops the ladder instead of being silently replaced,
// success lands on the Done screen, and the manual stage always offers
// classic-wizard + skip escape hatches.

import (
	"strings"
	"testing"

	"feral-tui/api"
)

func guidedApp() *App {
	a := New("http://127.0.0.1:0", "t", &api.StatusSnapshot{})
	a.Guided = GuidedState{Show: true, Step: GuidedDetect}
	return a
}

func detectMsg(acked bool, cands ...api.SetupCandidate) GuidedDetectMsg {
	return GuidedDetectMsg{Res: &api.SetupDetectResult{Acked: acked, Candidates: cands}}
}

func TestGuidedAutoTestSkipsHardwareDownload(t *testing.T) {
	a := guidedApp()
	handled, cmd := a.handleGuidedMsg(detectMsg(true,
		api.SetupCandidate{Kind: "hardware_download", Label: "Qwen", DownloadSize: "2.5 GB"},
		api.SetupCandidate{Kind: "env_key", Label: "OpenAI", Raw: []byte(`{}`)},
	))
	if !handled {
		t.Fatal("detect msg should be handled")
	}
	if a.Guided.Step != GuidedTesting {
		t.Fatalf("expected GuidedTesting, got %v", a.Guided.Step)
	}
	if a.Guided.TestIdx != 1 {
		t.Fatalf("auto-test should skip the download rung (consent-gated); TestIdx=%d", a.Guided.TestIdx)
	}
	if cmd == nil {
		t.Fatal("expected a verify cmd for the env_key candidate")
	}
}

func TestGuidedSecurityGateShownWhenNotAcked(t *testing.T) {
	a := guidedApp()
	a.handleGuidedMsg(detectMsg(false))
	if a.Guided.Step != GuidedSecurity {
		t.Fatalf("expected GuidedSecurity, got %v", a.Guided.Step)
	}
}

func TestGuidedExistingConfigFailureStopsLadder(t *testing.T) {
	a := guidedApp()
	a.handleGuidedMsg(detectMsg(true,
		api.SetupCandidate{Kind: "existing_config", Label: "current", Raw: []byte(`{}`)},
		api.SetupCandidate{Kind: "env_key", Label: "OpenAI", Raw: []byte(`{}`)},
	))
	// The existing-config candidate fails its probe.
	_, cmd := a.handleGuidedMsg(GuidedVerifyMsg{
		Idx: 0, Candidate: api.SetupCandidate{Kind: "existing_config", Label: "current"},
		OK: false, Msg: "timeout",
	})
	if a.Guided.Step != GuidedManual {
		t.Fatalf("failing existing_config must drop to manual, got %v", a.Guided.Step)
	}
	if cmd != nil {
		t.Fatal("ladder must STOP — no further auto-test after a failing existing_config")
	}
}

func TestGuidedVerifySuccessLandsOnDone(t *testing.T) {
	a := guidedApp()
	a.handleGuidedMsg(detectMsg(true, api.SetupCandidate{Kind: "env_key", Label: "MiniMax", Raw: []byte(`{}`)}))
	a.handleGuidedMsg(GuidedVerifyMsg{
		Idx: 0, Candidate: api.SetupCandidate{Kind: "env_key", Label: "MiniMax"},
		OK: true, Msg: "replied in 1.9s",
	})
	if a.Guided.Step != GuidedDone {
		t.Fatalf("expected GuidedDone, got %v", a.Guided.Step)
	}
	if a.Guided.VerifiedLabel != "MiniMax" {
		t.Fatalf("VerifiedLabel=%q", a.Guided.VerifiedLabel)
	}
}

func TestGuidedManualMenuHasEscapeHatches(t *testing.T) {
	a := guidedApp()
	a.handleGuidedMsg(detectMsg(true)) // no candidates → straight to manual
	if a.Guided.Step != GuidedManual {
		t.Fatalf("expected GuidedManual, got %v", a.Guided.Step)
	}
	var labels []string
	for _, e := range a.guidedMenu() {
		labels = append(labels, e.label)
	}
	joined := strings.Join(labels, "|")
	for _, want := range []string{"Enter an API key", "classic", "Skip AI setup"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("manual menu missing %q in %q", want, joined)
		}
	}
}
