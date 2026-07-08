package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestFilteredProvidersEmptyQueryReturnsAll verifies that an empty query
// returns the full provider list (F2 / spec §SEARCHABLE LISTS).
func TestFilteredProvidersEmptyQueryReturnsAll(t *testing.T) {
	got := FilteredProviders("")
	if len(got) != len(CloudProviders) {
		t.Fatalf("empty query returned %d providers, want %d", len(got), len(CloudProviders))
	}
}

// TestFilteredProvidersByName verifies substring match on Name field
// (case-insensitive).
func TestFilteredProvidersByName(t *testing.T) {
	got := FilteredProviders("open")
	found := false
	for _, p := range got {
		if p.ID == "openai" {
			found = true
		}
	}
	if !found {
		t.Fatalf("query 'open' should match openai, got %d providers", len(got))
	}
}

// TestFilteredProvidersByID verifies substring match on ID field
// (case-insensitive).
func TestFilteredProvidersByID(t *testing.T) {
	got := FilteredProviders("nim")
	found := false
	for _, p := range got {
		if p.ID == "nvidia" {
			found = true
		}
	}
	if !found {
		t.Fatalf("query 'nim' should match nvidia (NVIDIA NIM), got %d providers", len(got))
	}
}

// TestFilteredProvidersNoMatch verifies an empty result for a query
// that matches nothing.
func TestFilteredProvidersNoMatch(t *testing.T) {
	got := FilteredProviders("xyzzy-not-a-provider")
	if len(got) != 0 {
		t.Fatalf("no-match query returned %d providers, want 0", len(got))
	}
}

// TestFilteredProvidersCaseInsensitive verifies the case-insensitive
// match (F2 requirement).
func TestFilteredProvidersCaseInsensitive(t *testing.T) {
	queries := []string{"OPEN", "open", "Open", "oPeN"}
	for _, q := range queries {
		got := FilteredProviders(q)
		if len(got) == 0 {
			t.Fatalf("query %q returned 0 providers, want at least 1", q)
		}
	}
}

// TestFilteredProvidersTrimsWhitespace verifies leading/trailing
// whitespace is ignored (so the search box doesn't get tripped up
// by accidental spaces from copy-paste).
func TestFilteredProvidersTrimsWhitespace(t *testing.T) {
	got := FilteredProviders("  open  ")
	if len(got) == 0 {
		t.Fatal("padded query returned 0 providers, want at least 1")
	}
}

// TestResumeStepLabel verifies the human-readable label for the
// resume screen (so the user can see where they'd be jumping back to).
func TestResumeStepLabel(t *testing.T) {
	cases := []struct {
		step WizardStep
		want string
	}{
		{WizWelcome, "welcome"},
		{WizSecurity, "security disclaimer"},
		{WizSetupMode, "setup mode"},
		{WizConfigHandling, "config handling"},
		{WizResume, "unknown"},
		{WizHardware, "hardware probe"},
		{WizModelChoice, "runtime choice"},
		{WizLocalDownload, "model download"},
		{WizCloudProvider, "cloud provider"},
		{WizCloudModel, "cloud model"},
		{WizCloudKeyMode, "key storage"},
		{WizCloudKey, "API key"},
		{WizConnectors, "connectors"},
		{WizConnectorPrompt, "connector prompt"},
		{WizTestIt, "health check"},
		{WizFinish, "finish"},
	}
	for _, c := range cases {
		if got := resumeStepLabel(c.step); got != c.want {
			t.Errorf("resumeStepLabel(%v) = %q, want %q", c.step, got, c.want)
		}
	}
}

// TestHasPartialProgressNotPartialOnFreshDir verifies a brand-new
// install is NOT partial state (F2 / spec §PARTIAL PROGRESS PERSISTENCE).
func TestHasPartialProgressNotPartialOnFreshDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	if _, _, _, partial := hasPartialProgress(); partial {
		t.Fatal("fresh dir reported as partial progress, want false")
	}
}

// TestHasPartialProgressTrueOnSavedStep verifies a saved step without
// wizard-done IS partial state.
func TestHasPartialProgressTrueOnSavedStep(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	saveWizardProgress(WizCloudProvider, SetupManual, WizChoiceCloud)
	step, _, _, partial := hasPartialProgress()
	if !partial {
		t.Fatal("saved step without wizard-done reported as not partial, want true")
	}
	if step != WizCloudProvider {
		t.Fatalf("partial step = %v, want WizCloudProvider", step)
	}
}

// TestHasPartialProgressFalseWhenDone verifies that wizard-done
// present means "completed", not partial.
func TestHasPartialProgressFalseWhenDone(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	saveWizardProgress(WizCloudProvider, SetupManual, WizChoiceCloud)

	dir := filepath.Join(tmp, ".feral")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".wizard-done"), []byte("done\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, _, partial := hasPartialProgress(); partial {
		t.Fatal("wizard-done present reported as partial, want false")
	}
}

// TestFilterTrimsDontChangeLowercase guards against a future refactor
// that breaks the case-insensitive contract.
func TestFilterTrimsDontChangeLowercase(t *testing.T) {
	got := FilteredProviders(strings.ToUpper("OPEN"))
	if len(got) == 0 {
		t.Fatal("uppercase query should still match")
	}
}

// TestHealthCheckKindStrings verifies the four HealthCheckKind String()
// methods return the expected labels (F3 multi-step health check).
func TestHealthCheckKindStrings(t *testing.T) {
	cases := []struct {
		kind HealthCheckKind
		want string
	}{
		{HealthCheckAPI, "API reachable"},
		{HealthCheckAuth, "auth valid"},
		{HealthCheckModel, "model accessible"},
		{HealthCheckStream, "streaming works"},
	}
	for _, c := range cases {
		if got := c.kind.String(); got != c.want {
			t.Errorf("HealthCheckKind(%d).String() = %q, want %q", c.kind, got, c.want)
		}
	}
}

// TestAnyCheckRunning verifies the helper that detects in-flight checks.
func TestAnyCheckRunning(t *testing.T) {
	// All pending — not running.
	checks := [4]HealthCheck{
		{Kind: HealthCheckAPI, Status: CheckPending},
		{Kind: HealthCheckAuth, Status: CheckPending},
		{Kind: HealthCheckModel, Status: CheckPending},
		{Kind: HealthCheckStream, Status: CheckPending},
	}
	if anyCheckRunning(checks) {
		t.Fatal("all pending should not be running")
	}

	// One running — should be detected.
	checks[1].Status = CheckRunning
	if !anyCheckRunning(checks) {
		t.Fatal("one running should be detected")
	}

	// All passed — not running.
	checks[1].Status = CheckPassed
	if anyCheckRunning(checks) {
		t.Fatal("all passed should not be running")
	}
}

// TestWizardResetInitializesHealthChecks verifies that reset() creates
// the initial pending health check array (F3).
func TestWizardResetInitializesHealthChecks(t *testing.T) {
	var ws WizardState
	ws.reset()
	for i, hc := range ws.HealthChecks {
		if hc.Status != CheckPending {
			t.Fatalf("HealthChecks[%d].Status = %v, want CheckPending", i, hc.Status)
		}
		if hc.Kind != HealthCheckKind(i) {
			t.Fatalf("HealthChecks[%d].Kind = %v, want %v", i, hc.Kind, HealthCheckKind(i))
		}
	}
}
