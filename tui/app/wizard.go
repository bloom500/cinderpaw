package app

import "fmt"

// WizardStep identifies which Setup Wizard screen is active (§13).
type WizardStep int

const (
	WizHardware WizardStep = iota
	WizModelChoice
	WizLocalDownload
	WizCloudKey
	WizConnectors
	WizFinish
)

// WizardChoice is the user's model-path selection from W2.
type WizardChoice int

const (
	WizChoiceLocal WizardChoice = iota
	WizChoiceCloud
	WizChoiceBoth
)

// WizardHardware holds the result of the hardware detection probe (W1).
type WizardHardware struct {
	GpuName string
	GpuVram int // GB
	RamGB   int
	DiskGB  int
	GpuOK   bool
}

// WizardState holds all mutable state for the Setup Wizard flow.
type WizardState struct {
	Show     bool
	Step     WizardStep
	Choice   WizardChoice // user's model-path choice (W2)
	Provider string       // selected provider id for cloud path (W3b)
	APIKey   string       // masked input buffer
	KeyValid bool         // true after successful live validation

	Hardware WizardHardware // probed hardware (W1)
	ModelID  string         // selected model id
	ModelSize string        // human size, e.g. "4.1 GB"
	Progress  float64       // download progress 0..1 (W3a)
	ProgressMsg string      // live progress text

	// Resumability: when the wizard is interrupted (Ctrl+C), the last
	// completed step is saved. On next launch the wizard resumes from
	// that step + 1 (spec §13).
	lastCompleted WizardStep
}

func (ws *WizardState) reset() {
	ws.Show = false
	ws.Step = WizHardware
	ws.Choice = WizChoiceLocal
	ws.Provider = ""
	ws.APIKey = ""
	ws.KeyValid = false
	ws.Progress = 0
	ws.ProgressMsg = ""
	ws.lastCompleted = WizHardware
}

// wizardFooterHint returns the footer text for the current wizard step.
func (ws *WizardState) footerHint() string {
	switch ws.Step {
	case WizHardware:
		return "detecting hardware…"
	case WizModelChoice:
		return "enter to select"
	case WizLocalDownload:
		if ws.Progress > 0 {
			return fmt.Sprintf("downloading %s — %.0f%%", ws.ModelID, ws.Progress*100)
		}
		return "preparing download…"
	case WizCloudKey:
		if ws.KeyValid {
			return "enter continue"
		}
		return "paste your api key and press enter"
	case WizConnectors:
		return "enter to skip · esc back"
	case WizFinish:
		return "enter to start chatting"
	default:
		return ""
	}
}
