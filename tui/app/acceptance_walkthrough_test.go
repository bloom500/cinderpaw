package app

import (
	"strings"
	"testing"
	"time"

	"cinderpaw-tui/api"

	tea "github.com/charmbracelet/bubbletea"
)

// ── P1 acceptance: 4-screen wizard walkthrough ──────────────────────
//
// The user-facing contract for the P1 wizard cut-down (spec §"Accept for
// P1"): from startWizard() to chat input the QuickStart path takes ≤4
// user interactions on a GPU machine (welcome-select Enter, engine-select
// Enter, [download+checks auto], ready Enter). The no-GPU path adds the
// provider pick and key paste on screen 3. The "step N of 4" counter must
// show on every in-path screen (Welcome, Engine, the work screen, Ready).

// TestQuickStartGPUWalkthrough_AcceptanceP1 drives the wizard end to end
// on a simulated GPU host and asserts the user interaction budget is ≤4.
func TestQuickStartGPUWalkthrough_AcceptanceP1(t *testing.T) {
	a := newTestApp()
	clearWizardProgress()
	a.Wizard.HasExistingConfig = false
	a.startWizard()
	if !a.Wizard.Show {
		t.Fatal("startWizard should set Wizard.Show=true")
	}

	interactions := 0
	count := func() { interactions++ }

	// Screen 1 — Welcome. SetupModeIdx defaults to 0 (Quick start).
	// Enter advances to Engine. 1 interaction.
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter})
	count()
	assertStep(t, a, WizHardware, "welcome→engine")

	// Probe arrives, Choice pre-selects Local.
	a.Update(HardwareProbeMsg{Info: &api.SystemInfo{
		GpuName: "rtx 4070", VramTotalMB: 12 * 1024, RamTotalMB: 64 * 1024,
	}})

	// Screen 2 — Engine. Enter on the highlighted Local kicks off the
	// download and advances to WizLocalDownload. 2 interactions.
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter})
	count()
	assertStep(t, a, WizLocalDownload, "engine→download")

	// Screen 3 — auto: download completes then health checks auto-run.
	a.Update(DownloadStartedMsg{ID: "acceptance-gpu"})
	a.Update(DownloadModelMsg{
		Download: &api.ModelDownload{ID: "acceptance-gpu", Status: "complete", Progress: 1.0},
	})
	assertStep(t, a, WizTestIt, "download→testit (auto)")
	a.Update(WizardTestItResult{
		Response: "CINDERPAW_OK", HealthLatency: 300 * time.Millisecond,
		StreamLatency: 1500 * time.Millisecond, StreamVerified: true,
	})
	assertStep(t, a, WizFinish, "testit→ready (auto)")

	// Screen 4 — Ready. Enter closes the wizard. 3 interactions total.
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter})
	count()
	if a.Wizard.Show {
		t.Fatal("Enter on Ready should close wizard")
	}
	if a.State != StateReady {
		t.Fatalf("Enter on Ready should set StateReady, got %v", a.State)
	}

	if interactions > 4 {
		t.Fatalf("QuickStart-GPU took %d user interactions; spec budget ≤4", interactions)
	}
	t.Logf("QuickStart-GPU walkthrough: %d user interactions", interactions)
}

// TestQuickStartNoGPUWalkthrough_AcceptanceP1 — no-GPU host adds provider
// pick + key paste on screen 3 (the spec's "4 + provider pick + key paste").
func TestQuickStartNoGPUWalkthrough_AcceptanceP1(t *testing.T) {
	a := newTestApp()
	clearWizardProgress()
	a.Wizard.HasExistingConfig = false
	a.startWizard()

	interactions := 0
	count := func() { interactions++ }

	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter}) // welcome→engine (default QuickStart)
	count()

	// No-GPU probe → Choice pre-selects Cloud.
	a.Update(HardwareProbeMsg{Info: &api.SystemInfo{
		GpuName: "", VramTotalMB: 0, RamTotalMB: 16 * 1024,
	}})
	if a.Wizard.Choice != WizChoiceCloud {
		t.Fatalf("no-GPU probe should pre-select Cloud, got %v", a.Wizard.Choice)
	}

	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter}) // engine→cloud provider (default highlighted)
	count()
	assertStep(t, a, WizCloudProvider, "engine→provider")

	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter}) // provider→key field (default idx 0)
	count()
	assertStep(t, a, WizCloudKey, "provider→key")

	// Paste the key (treated as a single user gesture for the budget —
	// the spec says "key paste", one interaction, regardless of length).
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("sk-acceptance-test")})
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter})
	count()
	if a.Wizard.APIKey != "sk-acceptance-test" {
		t.Fatalf("expected APIKey captured, got %q", a.Wizard.APIKey)
	}

	// Auto: provider test → health checks → Ready.
	a.Update(ProvidersTestMsg{Success: true, Msg: "ok"})
	assertStep(t, a, WizTestIt, "provider-test→testit (auto)")
	a.Update(WizardTestItResult{
		Response: "CINDERPAW_OK", HealthLatency: 400 * time.Millisecond,
		StreamLatency: 2000 * time.Millisecond, StreamVerified: true,
	})
	assertStep(t, a, WizFinish, "testit→ready (auto)")

	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter}) // ready→chat
	count()

	budget := 4 + 2 // 4 screen transitions + provider pick + key paste
	if interactions > budget {
		t.Fatalf("QuickStart-no-GPU took %d user interactions; spec budget %d (4 + provider + key)", interactions, budget)
	}
	t.Logf("QuickStart-no-GPU walkthrough: %d user interactions (budget %d)", interactions, budget)
}

// TestWizardCounterShowsOf4_AcceptanceP1 — for every in-path wizard step,
// the rendered frame header must show "step N of 4" (visibleScreen + 4).
// Conditional steps (WizResume) collapse to a static title (visibleScreen
// returns 0) — we don't assert on those.
func TestWizardCounterShowsOf4_AcceptanceP1(t *testing.T) {
	cases := []struct {
		name string
		step WizardStep
		want int
	}{
		{"Welcome=1", WizWelcome, 1},
		{"Engine=2", WizHardware, 2},
		{"Download=3", WizLocalDownload, 3},
		{"CloudProvider=3", WizCloudProvider, 3},
		{"CloudKey=3", WizCloudKey, 3},
		{"TestIt=3", WizTestIt, 3},
		{"Ready=4", WizFinish, 4},
	}
	for _, c := range cases {
		a := newTestApp()
		a.Wizard.HasExistingConfig = false
		a.startWizard()
		// Force the wizard to the step we want to render. The step body
		// renderers check the current step directly so the rendered frame
		// reflects the step under test.
		a.Wizard.Step = c.step
		a.Wizard.Path = wizardPathFor(WizChoiceLocal)
		a.Wizard.PathIndex = pathIndexOf(&a.Wizard, c.step)
		if a.Wizard.PathIndex < 0 {
			a.Wizard.PathIndex = 0
		}
		// The renderer for screen 3 branches on Choice, so set it to the
		// branch the step expects.
		if c.step == WizCloudProvider || c.step == WizCloudKey {
			a.Wizard.Choice = WizChoiceCloud
		} else {
			a.Wizard.Choice = WizChoiceLocal
		}
		// Hardware probe must have landed so the engine screen renders.
		a.Wizard.Hardware.GpuOK = true

		out := stripAnsi(a.renderWizard())
		want := "step " + itoaLocal(c.want) + " of " + itoaLocal(visibleScreenTotal)
		if !strings.Contains(out, want) {
			t.Errorf("%s: rendered frame missing %q\nframe:\n%s", c.name, want, out)
		}
	}
}

// itoaLocal is a tiny int-to-string helper so the header counter test
// avoids importing strconv just for this one line.
func itoaLocal(n int) string {
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
