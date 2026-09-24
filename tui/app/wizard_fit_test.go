package app

import (
	"strings"
	"testing"

	"cinderpaw-tui/api"

	"github.com/charmbracelet/lipgloss"
)

// A stranger's first screen has to fit their terminal. At 120x36 the welcome
// frame was 61 rows (menu below the bottom edge) and every header was one
// column too wide, which wraps on a real terminal (24 Sep).
func TestWizardFramesFitTheTerminal(t *testing.T) {
	t.Setenv("CINDERPAW_HOME", t.TempDir())
	for _, size := range [][2]int{{80, 24}, {100, 30}, {120, 36}} {
		a := newTestApp()
		a.Width, a.Height = size[0], size[1]
		a.Wizard.HasExistingConfig = false
		a.startWizard()

		check := func(label string) {
			t.Helper()
			lines := strings.Split(stripAnsi(a.View()), "\n")
			if len(lines) > a.Height {
				t.Errorf("%dx%d %s: %d rows, terminal has %d", a.Width, a.Height, label, len(lines), a.Height)
			}
			for i, l := range lines {
				if w := lipgloss.Width(l); w > a.Width {
					t.Errorf("%dx%d %s: row %d is %d columns wide", a.Width, a.Height, label, i, w)
				}
			}
		}
		check("welcome")
		if !strings.Contains(stripAnsi(a.View()), "Quick start") {
			t.Errorf("%dx%d: the Quick start option is not on the welcome screen", a.Width, a.Height)
		}
		a.Wizard.Step = WizHardware
		a.Update(HardwareProbeMsg{Info: &api.SystemInfo{RamTotalMB: 8 * 1024}})
		check("engine")
	}
}

// A 4 GB card cannot hold the ~5.5 GB Quick start model: Cloud is the default
// and Local says why it would be slow. A 12 GB card still gets Local.
func TestEngineDefaultFollowsGPUMemory(t *testing.T) {
	cases := []struct {
		name   string
		vramMB int64
		want   WizardChoice
	}{
		{"rx580 4GB", 4 * 1024, WizChoiceCloud},
		{"rtx4070 12GB", 12 * 1024, WizChoiceLocal},
	}
	for _, c := range cases {
		a := newTestApp()
		a.startWizard()
		a.Update(HardwareProbeMsg{Info: &api.SystemInfo{GpuName: c.name, VramTotalMB: c.vramMB, RamTotalMB: 16 * 1024}})
		if a.Wizard.Choice != c.want {
			t.Errorf("%s: default %v, want %v", c.name, a.Wizard.Choice, c.want)
		}
		body := stripAnsi(renderWizEngine(&a.Wizard, 100))
		if c.want == WizChoiceCloud && strings.Contains(body, "runs on your GPU") {
			t.Errorf("%s: Local still promises to run on the GPU:\n%s", c.name, body)
		}
	}
}
