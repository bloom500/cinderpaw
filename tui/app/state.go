package app

// State is the single top-level FSM (spec §3) that drives what the footer
// and input show. Renderers switch on State; no other field on App may
// shadow what State already encodes ("boolean soup" is banned by §3).
//
// StateLoadingRuntime, StateDetectingHardware, StateDownloadingModel,
// StateLoadingModel, and StateLoadingMemory are wizard/first-run states
// (spec §13, phase P3). They are declared here for completeness with the
// spec's exhaustive table but are unreachable until the Setup Wizard lands —
// main.go's synchronous preflight (gateway-up check, status fetch) currently
// happens before the Bubble Tea program even starts, so this app never
// observes Boot/Initializing/LoadingRuntime today either. New() starts
// directly in StateReady.
type State int

const (
	StateBoot State = iota
	StateInitializing
	StateLoadingRuntime
	StateDetectingHardware
	StateDownloadingModel
	StateLoadingModel
	StateLoadingMemory
	StateReady
	StateThinking
	StateStreaming
	StateToolRunning
	StateWaiting
	StateIdle
	StateError
	StateRecovery
	StateShutdown
)

// FooterHint returns the default footer text for a state per spec §3's
// table. States whose footer needs live data (Error's kind/hint, Recovery's
// attempt count, DownloadingModel's progress line) are rendered by
// dedicated functions in view.go that call this only as their fallback.
func (s State) FooterHint() string {
	switch s {
	case StateBoot:
		return "starting…"
	case StateInitializing:
		return "connecting to runtime"
	case StateLoadingRuntime:
		return "starting runtime…"
	case StateDetectingHardware:
		return "detecting hardware…"
	case StateLoadingModel:
		return "loading model…"
	case StateLoadingMemory:
		return "loading memory…"
	case StateReady, StateIdle:
		return "F1 for shortcuts · Ctrl+C to exit"
	case StateThinking:
		return "thinking…"
	case StateStreaming:
		return "esc to interrupt"
	case StateToolRunning:
		return "running…"
	case StateWaiting:
		return "waiting for approval — y/n"
	case StateRecovery:
		return "reconnecting…"
	default:
		return ""
	}
}
