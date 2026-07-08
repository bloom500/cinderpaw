package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"feral-tui/api"
	"feral-tui/ui"
)

// wizardProgressFile stores the last completed step so Ctrl+C mid-wizard
// doesn't force the user to start over (spec §13: resumable wizard).
const wizardProgressFile = ".wizard-progress"

// wizardStepOrder is the canonical ordering of wizard steps as they
// appear in the header strip's "step N of M" counter. Conditional
// steps (Resume, ConfigHandling) live outside this list — they carry
// StepTotal=0 in the frame and collapse to a static title, since
// "which N" depends on whether the prior path executed. Keeping this
// list aligned with the iota block above is part of the wizard
// contract; the version gate (wizardProgressVersion) catches new
// entries that ship before this list is updated.
//
// Phase 1 (2026-07-07): aligned to the post-F1/F2/F3 flow per
// `docs/agents-memory/project_tui_openclaw_parity.md` Slice 2. Same
// topology as the previous (F3) flow, just labelled consistently.
var wizardStepOrder = []WizardStep{
	WizWelcome,
	WizSecurity,
	WizSetupMode,
	WizHardware,
	WizModelChoice,
	WizLocalDownload,
	WizCloudProvider,
	WizCloudModel,
	WizCloudKeyMode,
	WizCloudKey,
	WizConnectors,
	WizConnectorPrompt,
	WizTestIt,
	WizFinish,
}

// wizardStepLabel returns the user-visible step label rendered into the
// header strip ("Welcome", "Security", etc). Conditional steps get a
// short contextual label.
func wizardStepLabel(s WizardStep) string {
	switch s {
	case WizWelcome:
		return "Welcome"
	case WizSecurity:
		return "Security"
	case WizSetupMode:
		return "Setup mode"
	case WizConfigHandling:
		return "Existing config"
	case WizResume:
		return "Resume"
	case WizHardware:
		return "Hardware probe"
	case WizModelChoice:
		return "Model"
	case WizLocalDownload:
		return "Download"
	case WizCloudProvider:
		return "Provider"
	case WizCloudModel:
		return "Model id"
	case WizCloudKeyMode:
		return "Key storage"
	case WizCloudKey:
		return "API key"
	case WizConnectors:
		return "Connectors"
	case WizConnectorPrompt:
		return "Pair channel"
	case WizTestIt:
		return "Test it"
	case WizFinish:
		return "Ready"
	default:
		return ""
	}
}

// wizardStepIndex returns the 1-based position of `s` in the current
// wizard path. Returns 0 if the step is not in the path (conditional
// steps like Resume).
func wizardStepIndex(s WizardStep) int {
	for i, step := range wizardStepOrder {
		if step == s {
			return i + 1
		}
	}
	return 0
}

// visibleScreen maps a wizard step to its user-visible screen number (P1).
// The 14 enum steps collapse to 4 screens: Welcome (1), Engine (2), the
// work screen — download+verify or the cloud form (3), and Ready (4).
// Several enum steps share screen 3 because they auto-chain with no user
// interaction (download → health checks; provider → key → health checks),
// so the "step N of 4" counter must show them as one screen (P1.1).
// Returns 0 for conditional steps (Resume) so the frame drops the counter.
func visibleScreen(s WizardStep) int {
	switch s {
	case WizWelcome:
		return 1
	case WizHardware:
		return 2
	case WizLocalDownload, WizCloudProvider, WizCloudKey, WizTestIt:
		return 3
	case WizFinish:
		return 4
	default:
		return 0
	}
}

// visibleScreenTotal is the fixed screen count both paths walk (P1): 4.
const visibleScreenTotal = 4

// currentStepIndex returns the 1-based position within the active path.
func currentStepIndex(ws *WizardState) int {
	if len(ws.Path) == 0 {
		return wizardStepIndex(ws.Step)
	}
	for i, s := range ws.Path {
		if s == ws.Step {
			return i + 1
		}
	}
	return 0
}

// pathTotal returns the total step count in the current path.
func pathTotal(ws *WizardState) int {
	if len(ws.Path) == 0 {
		return len(wizardStepOrder)
	}
	return len(ws.Path)
}

// pushStepHistory records the current step before advancing forward.
func (ws *WizardState) pushStepHistory() {
	ws.StepHistory = append(ws.StepHistory, ws.Step)
}

// popStepHistory returns the previous step, or WizWelcome if empty.
func (ws *WizardState) popStepHistory() WizardStep {
	if len(ws.StepHistory) == 0 {
		return WizWelcome
	}
	n := len(ws.StepHistory)
	prev := ws.StepHistory[n-1]
	ws.StepHistory = ws.StepHistory[:n-1]
	return prev
}

// nextPathStep returns the step after the current one in the path,
// or 0 if at the end. Advances PathIndex.
func nextPathStep(ws *WizardState) WizardStep {
	for i, s := range ws.Path {
		if s == ws.Step && i+1 < len(ws.Path) {
			ws.PathIndex = i + 1
			return ws.Path[i+1]
		}
	}
	return 0
}

// prevPathStep returns the step before the current one in the path,
// or 0 if at the start. Used by back navigation.
func prevPathStep(ws *WizardState) WizardStep {
	for i, s := range ws.Path {
		if s == ws.Step && i > 0 {
			return ws.Path[i-1]
		}
	}
	return 0
}

// wizardProgressVersion is bumped whenever the wizard flow changes shape
// (F1 added the welcome/security/setup/config steps). The progress file
// is prefixed with "v<N>:" so an older file is detected and reset to the
// beginning instead of resuming on the wrong step.
//
//  v1: original 8-step flow (WizHardware…WizFinish, 0..7)
//  v2: F1 added 4 new pre-steps (WizWelcome..WizConfigHandling, 0..3)
//  v3: F3 added WizCloudModel (between WizCloudProvider and WizCloudKeyMode)
//  v4: P1 (2026-07-08) 4-screen flow; payload gains the local/cloud choice
//      so resume can rebuild the branched path (P0.4).
const wizardProgressVersion = 4

// feralHomeDir returns ~/.feral/ and ensures the directory exists.
// Like feralHome but returns the string only (no error) for use in places
// that don't propagate errors, e.g. ConfigHandling Reset. Errors are
// silently swallowed: the worst case is a no-op reset, which the next
// launch of the wizard will detect via hasExistingConfig.
func feralHomeDir() string {
	dir, err := feralHome()
	if err != nil {
		return ""
	}
	return dir
}

// feralHome returns ~/.feral/ and ensures the directory exists.
// Uses os.UserHomeDir() instead of os.ExpandEnv("~") because the
// latter does NOT expand ~ on Windows (ONB-001 fix).
func feralHome() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot find home directory: %w", err)
	}
	dir := filepath.Join(home, ".feral")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("cannot create %s: %w", dir, err)
	}
	return dir, nil
}

// wizardProgressPath returns the absolute path to the wizard progress file.
func wizardProgressPath() (string, error) {
	home, err := feralHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, wizardProgressFile), nil
}

// wizardDonePath returns the absolute path to the wizard-done marker.
func wizardDonePath() (string, error) {
	home, err := feralHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".wizard-done"), nil
}

// hasExistingConfig reports whether a previous Feral run left state on disk.
// The wizard shows the "Keep / Review / Reset" config-handling screen when
// this is true.
func hasExistingConfig() bool {
	home, err := feralHome()
	if err != nil {
		return false
	}
	// wizard-done marker from a completed prior setup.
	if _, err := os.Stat(filepath.Join(home, ".wizard-done")); err == nil {
		return true
	}
	// byok.json from a configured cloud provider.
	if _, err := os.Stat(filepath.Join(home, "byok.json")); err == nil {
		return true
	}
	return false
}

// hasPartialProgress reports whether the user exited mid-onboarding (F2 /
// spec §PARTIAL PROGRESS PERSISTENCE). Partial state = progress file
// exists but no wizard-done marker. Distinct from hasExistingConfig:
// partial means "in flight", complete means "finished".
func hasPartialProgress() (WizardStep, SetupMode, WizardChoice, bool) {
	step, mode, choice := loadWizardProgress()
	// loadWizardProgress returns WizWelcome when no file exists; that's
	// not partial state, that's a fresh start.
	if step <= WizWelcome {
		return WizWelcome, mode, choice, false
	}
	// If wizard-done is present, the prior run finished — not partial.
	if _, err := os.Stat(filepath.Join(feralHomeDir(), ".wizard-done")); err == nil {
		return step, mode, choice, false
	}
	return step, mode, choice, true
}

// saveWizardProgress writes the last completed step to disk so the wizard
// can resume after an interruption (Ctrl+C). The file is version-prefixed
// (see wizardProgressVersion) so older formats are detected on load and
// reset to the beginning.
func saveWizardProgress(step WizardStep, mode SetupMode, choice WizardChoice) {
	path, err := wizardProgressPath()
	if err != nil {
		return
	}
	payload := fmt.Sprintf("v%d:%d:%d:%d", wizardProgressVersion, int(step), int(mode), int(choice))
	os.WriteFile(path, []byte(payload), 0644)
}

// loadWizardProgress reads the last completed step and setup mode from
// disk. Returns (WizWelcome, SetupManual) when no progress file exists,
// the version doesn't match, or the value is out of range. The mode
// field is backward-compatible: old "vN:step" files default to Manual.
func loadWizardProgress() (WizardStep, SetupMode, WizardChoice) {
	path, err := wizardProgressPath()
	if err != nil {
		return WizWelcome, SetupQuickStart, WizChoiceLocal
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return WizWelcome, SetupQuickStart, WizChoiceLocal
	}
	s := strings.TrimSpace(string(data))
	// Parse the "vN:step[:mode[:choice]]" prefix; if missing or version
	// mismatched, reset to a fresh start.
	prefix := fmt.Sprintf("v%d:", wizardProgressVersion)
	if !strings.HasPrefix(s, prefix) {
		return WizWelcome, SetupQuickStart, WizChoiceLocal
	}
	s = strings.TrimPrefix(s, prefix)
	parts := strings.Split(s, ":")
	n, err := strconv.Atoi(parts[0])
	if err != nil || n < int(WizWelcome) || n > int(WizFinish) {
		return WizWelcome, SetupQuickStart, WizChoiceLocal
	}
	mode := SetupQuickStart
	if len(parts) > 1 {
		if m, err := strconv.Atoi(parts[1]); err == nil && m >= 0 && m <= int(SetupImport) {
			mode = SetupMode(m)
		}
	}
	choice := WizChoiceLocal
	if len(parts) > 2 {
		if c, err := strconv.Atoi(parts[2]); err == nil && (c == int(WizChoiceLocal) || c == int(WizChoiceCloud)) {
			choice = WizardChoice(c)
		}
	}
	return WizardStep(n), mode, choice
}

// clearWizardProgress deletes the progress file after the wizard completes
// successfully — the wizard-done marker replaces it.
func clearWizardProgress() {
	path, err := wizardProgressPath()
	if err != nil {
		return
	}
	os.Remove(path)
}

// WizardStep identifies which Setup Wizard screen is active (§13).
type WizardStep int

const (
	// F1 onboarding foundation (OpenClaw-style): welcome → security → setup
	// mode → config handling → hardware probe → runtime choice. The four
	// new steps are shown only on the first launch / explicit /setup call.
	WizWelcome        WizardStep = iota
	WizSecurity
	WizSetupMode
	WizConfigHandling
	// F2 / spec §PARTIAL PROGRESS PERSISTENCE: when the user exits
	// mid-onboarding, the wizard re-opens on this screen offering
	// Resume / Start Over. Distinct from WizWelcome (fresh) and
	// WizConfigHandling (complete prior run).
	WizResume
	// Existing flow — step numbers shift to make room for the new ones.
	// The .wizard-progress file is version-gated (see loadWizardProgress)
	// so old progress files reset cleanly instead of resuming on the wrong
	// step.
	WizHardware
	WizModelChoice
	WizLocalDownload
	WizCloudProvider
	// F3: explicit model picker after provider selection (F2.5 deferred).
	// The user accepts the provider's default model or types a custom ID.
	WizCloudModel
	WizCloudKeyMode
	WizCloudKey
	WizConnectors
	WizConnectorPrompt
	WizTestIt
	WizFinish
)

// SetupMode is the user's choice at WizSetupMode. QuickStart uses
// sensible defaults and a minimal step count; Manual exposes every
// step; Import reads an existing config and skips what it can.
type SetupMode int

const (
	SetupQuickStart SetupMode = iota
	SetupManual
	SetupImport
)

// wizardBasePath is the common prefix walked before the local/cloud branch
// is chosen on the Engine screen (WizHardware): Welcome → Engine.
func wizardBasePath() []WizardStep {
	return []WizardStep{WizWelcome, WizHardware}
}

// wizardPathFor returns the full 4-screen path for the chosen runtime (P1).
// Both branches present the same four visible screens; only the work screen
// (3) differs — a local download+verify or the cloud provider/key form.
// QuickStart vs Custom no longer changes the path shape (P1.1) — Custom only
// unlocks inline edits and extra failure options on the same screens.
func wizardPathFor(choice WizardChoice) []WizardStep {
	base := wizardBasePath()
	if choice == WizChoiceCloud {
		return append(base, WizCloudProvider, WizCloudKey, WizTestIt, WizFinish)
	}
	return append(base, WizLocalDownload, WizTestIt, WizFinish)
}

// resumeStepFor rebuilds the branched path from the persisted (mode, choice)
// and returns the step to resume on: the one after `saved` in that path
// (P0.4). When `saved` is not in the reconstructed path (e.g. a stale enum
// from an interrupted branch switch), it returns the branch point
// (WizHardware) so we never guess a dead-end step.
func resumeStepFor(saved WizardStep, choice WizardChoice) (WizStep WizardStep, path []WizardStep) {
	path = wizardPathFor(choice)
	for i, s := range path {
		if s == saved {
			if i+1 < len(path) {
				return path[i+1], path
			}
			return path[i], path // clamp to last (Finish)
		}
	}
	return WizHardware, path
}

// ConfigHandling is the user's choice at WizConfigHandling. Shown only
// when an existing ~/.feral/wizard-done marker or byok.json is detected.
// Reset wipes the local state and restarts the wizard from the top.
type ConfigHandling int

const (
	ConfigKeep ConfigHandling = iota
	ConfigReview
	ConfigReset
)

// WizardChoice is the user's model-path selection from W2.
type WizardChoice int

const (
	WizChoiceLocal WizardChoice = iota
	WizChoiceCloud
)

// WizardHardware holds the result of the hardware detection probe (W1).
type WizardHardware struct {
	GpuName string
	GpuVram int // GB
	RamGB   int
	DiskGB  int
	GpuOK   bool
}

// CloudProvider is one entry in the ONB-003 provider picker. The list mirrors
// the Rust `byok::ByokSettings::default_provider_configs` in
// crates/feral-core/src/byok.rs — keep them in sync when adding providers.
type CloudProvider struct {
	ID           string // provider id used in byok.json and /runtime/model
	Name         string // human label
	DefaultModel string // fallback when user doesn't specify a model
	BaseURL      string // optional custom base URL (empty = provider default)
}

// ── Connector field definitions (F4) ────────────────────────────

// ConnectorFieldDef describes one secret field a connector requires
// (e.g. "Discord bot token"). Mirrors the Rust catalog_def() in
// src-tauri/src/connectors.rs — keep in sync.
type ConnectorFieldDef struct {
	Key    string
	Label  string
	Secret bool
}

// ConnectorDef describes a chat-platform connector the TUI can configure.
// AuthKind is "token" (fields are entered one by one) or "qr" (WhatsApp
// style, no secret fields). ComingSoon marks connectors whose Rust
// catalog entry still has no live backend — `/connectors add` rejects
// these fail-loud so the user doesn't paste a token that would be
// silently dropped (task #4 explicit requirement).
type ConnectorDef struct {
	Name       string
	Fields     []ConnectorFieldDef
	AuthKind   string
	ComingSoon bool
}

// connectorDefs maps connector id → definition. Keep in sync with the
// Rust catalog in src-tauri/src/connectors.rs.
var connectorDefs = map[string]ConnectorDef{
	"discord": {
		Name: "Discord",
		Fields: []ConnectorFieldDef{
			{Key: "DISCORD_TOKEN", Label: "Discord bot token", Secret: true},
		},
		AuthKind: "token",
	},
	"slack": {
		Name: "Slack",
		Fields: []ConnectorFieldDef{
			{Key: "SLACK_APP_TOKEN", Label: "App-level token (xapp-…)", Secret: true},
			{Key: "SLACK_BOT_TOKEN", Label: "Bot token (xoxb-…)", Secret: true},
		},
		AuthKind: "token",
	},
	"telegram": {
		Name: "Telegram",
		Fields: []ConnectorFieldDef{
			{Key: "TELEGRAM_BOT_TOKEN", Label: "Telegram bot token", Secret: true},
		},
		AuthKind:   "token",
		ComingSoon: true, // no live connector backend yet (task #4)
	},
	"whatsapp": {
		Name:     "WhatsApp",
		Fields:   nil,
		AuthKind: "qr",
	},
}

// CloudProviders is the curated list shown in the WizCloudKey step.
// ONB-003: the previous wizard had no provider selection — Provider was
// always "". The user now picks from this list before pasting a key.
var CloudProviders = []CloudProvider{
	{ID: "openai", Name: "OpenAI", DefaultModel: "gpt-4o", BaseURL: ""},
	{ID: "anthropic", Name: "Anthropic", DefaultModel: "claude-sonnet-4-20250514", BaseURL: ""},
	{ID: "google", Name: "Google", DefaultModel: "gemini-2.0-flash", BaseURL: ""},
	{ID: "nvidia", Name: "NVIDIA NIM", DefaultModel: "stepfun-ai/step-3.7-flash", BaseURL: ""},
	{ID: "minimax", Name: "MiniMax", DefaultModel: "MiniMax-M3", BaseURL: ""},
	{ID: "groq", Name: "Groq", DefaultModel: "llama-3.1-70b-versatile", BaseURL: ""},
	{ID: "mistral", Name: "Mistral AI", DefaultModel: "mistral-large-latest", BaseURL: ""},
	{ID: "deepseek", Name: "DeepSeek", DefaultModel: "deepseek-chat", BaseURL: ""},
	{ID: "openrouter", Name: "OpenRouter", DefaultModel: "openai/gpt-4o", BaseURL: ""},
	{ID: "kimi", Name: "Kimi (Moonshot AI)", DefaultModel: "moonshot-v1-8k", BaseURL: ""},
	{ID: "glm", Name: "GLM (Zhipu)", DefaultModel: "glm-4-plus", BaseURL: ""},
}

// providerByID is a thin lookup over the CloudProviders slice. It is
// the canonical "is this id known" check — used by the preflight
// sweep (`wizard_preflight.go`) and any future caller that wants to
// validate a stored id against the catalog.
func providerByID(id string) (CloudProvider, bool) {
	for _, p := range CloudProviders {
		if p.ID == id {
			return p, true
		}
	}
	return CloudProvider{}, false
}

// HealthCheckKind identifies one of the four granular health checks
// in the F3 multi-step health check (replaces the single streaming test).
type HealthCheckKind int

const (
	HealthCheckAPI      HealthCheckKind = iota
	HealthCheckAuth
	HealthCheckModel
	HealthCheckStream
)

func (k HealthCheckKind) String() string {
	switch k {
	case HealthCheckAPI:
		return "API reachable"
	case HealthCheckAuth:
		return "auth valid"
	case HealthCheckModel:
		return "model accessible"
	case HealthCheckStream:
		return "streaming works"
	default:
		return "unknown"
	}
}

// CheckStatus is the state of one health check step.
type CheckStatus int

const (
	CheckPending CheckStatus = iota
	CheckRunning
	CheckPassed
	CheckFailed
)

// HealthCheck records the state and message of one multi-step check.
type HealthCheck struct {
	Kind    HealthCheckKind
	Status  CheckStatus
	Message string
}

// FilteredProviders returns the providers matching the search query
// (case-insensitive substring on Name and ID). F2 / spec §SEARCHABLE LISTS.
// When the query is empty, all providers are returned.
func FilteredProviders(query string) []CloudProvider {
	if query == "" {
		return CloudProviders
	}
	q := strings.ToLower(strings.TrimSpace(query))
	out := make([]CloudProvider, 0, len(CloudProviders))
	for _, p := range CloudProviders {
		if strings.Contains(strings.ToLower(p.Name), q) ||
			strings.Contains(strings.ToLower(p.ID), q) {
			out = append(out, p)
		}
	}
	return out
}

// WizardState holds all mutable state for the Setup Wizard flow.
type WizardState struct {
	Show     bool
	Step     WizardStep
	Choice   WizardChoice // user's model-path choice (W2)
	Provider string       // selected provider id for cloud path (W3b)
	APIKey   string       // masked input buffer
	KeyValid bool         // true after successful live validation
	KeyValidMsg string    // last validation message (success or error text)

	// F1 onboarding foundation. SetupMode is the user's pick on the
	// QuickStart/Manual/Import screen; SetupModeIdx tracks the highlight.
	// HasExistingConfig is set on startWizard based on the presence of
	// ~/.feral/wizard-done or ~/.feral/byok.json — drives whether the
	// WizConfigHandling screen is shown.
	SetupMode         SetupMode
	SetupModeIdx      int
	ConfigHandling    ConfigHandling
	ConfigHandlingIdx int
	HasExistingConfig bool
	SecurityAccepted  bool
	Tagline           string // rotated on startWizard

	// P1: Welcome-screen "r reset" confirm gate, and Custom-mode inline
	// model-id editing on the cloud key screen.
	ResetPending bool
	ModelEditing bool

	// PreflightNotes is populated by startWizard from `preflightNotices()`
	// (wizard_preflight.go). Rendered inside the first frame the user
	// sees (Welcome) so existing-state anomalies surface before any
	// input is taken. Mirrors OpenClaw's pre-input plugin-compat
	// snapshot (setup.ts:122) without copying code.
	PreflightNotes []preflightNotice

	// Path is the ordered step list for the chosen setup mode, set
	// after WizHardware completes. Dynamic per route: QuickStart
	// branches on GPU (6 steps), Manual exposes all (12 steps).
	Path      []WizardStep
	PathIndex int // 0-based index into Path

	// StepHistory tracks previously visited steps for back navigation.
	// Pushed on every forward advance; popped on Esc/Backspace.
	StepHistory []WizardStep

	// F2: when WizResume is shown, ResumeStep holds the saved step to
	// jump to on "Resume". ResumeIdx tracks the highlight on the picker.
	ResumeStep WizardStep
	ResumeIdx  int

	// F2: incremental search on the provider picker (WizCloudProvider).
	// Type to filter CloudProviders; Esc clears the query; Enter picks.
	SearchQuery string

	// F2 / spec §CREDENTIAL STORAGE OPTION: KeyStorageMode picks between
	// "Enter directly" (the key is stored in Feral config) and
	// "Use external secret provider" (env var, placeholder for future).
	KeyStorageMode int

	// ProviderIdx is the currently highlighted provider in the ONB-003
	// cloud provider picker (W3b). Set to 0 on reset.
	ProviderIdx int

	Hardware   WizardHardware // probed hardware (W1)
	ModelID    string         // selected model id
	ModelSize  string         // human size, e.g. "4.1 GB"
	Progress   float64        // download progress 0..1 (W3a)
	ProgressMsg string        // live progress text

	// connectorIdx is the currently highlighted connector index (0-3) in W4.
	connectorIdx int
	// ConnectorSelected is the connector confirmed in W4 → WizConnectorPrompt.
	ConnectorSelected string

	// F4 / real connectors — field-by-field token entry. ConnectorFieldIdx is
	// the 0-based index into the connector's Fields slice; ConnectorTokenInput
	// is the current text buffer; ConnectorTokenValues holds completed fields
	// keyed by the field key ("DISCORD_TOKEN", …).
	ConnectorFieldIdx    int
	ConnectorTokenInput  string
	ConnectorTokenValues map[string]string

	// Resumability: when the wizard is interrupted (Ctrl+C), the last
	// completed step is saved. On next launch the wizard resumes from
	// that step + 1 (spec §13).
	lastCompleted WizardStep

// Sprint 2 / audit C-1 — when the hardware probe fails (gateway down,
// `/system_info` returned 5xx, etc.) we keep the user on the same
// screen and surface a Retry CTA. The renderer reads this and the
// keymap triggers `startWizardHardwareProbe` again on Enter/R.
	HardwareProbeErr error

	// Sprint 2 / audit C-5 — in-flight model download tracking. The id
	// comes from `/runtime/models/install`; the gateway stores the
	// progress snapshot for polling. Err surfaces hard failures
	// (network drop, gateway 404, 5xx after retries) without crashing
	// the wizard.
	DownloadID   string
	DownloadErr  error
	// DownloadStartedAt is the time the current download started; used to
	// compute real download speed/ETA instead of fabricating stats (ONB-014).
	DownloadStartedAt time.Time

	// Sprint 3 — Test-it step. Run a real "Hello." round-trip before
	// allowing the wizard to finish (spec §1: "Never open chat before
	// this succeeds"). Response is collected by startWizardTestIt and
	// displayed inline; TestItSucceeded gates the Enter-to-finish.
	TestItSucceeded bool
	// TestItSkipped is set when the user chooses "continue anyway" past a
	// failed health check (P0.9). Distinct from Succeeded: the Ready screen
	// renders a ⚠ warning instead of the ✓ rows when Skipped.
	TestItSkipped   bool
	TestItError     string
	TestItResponse  string
	TestItRunning   bool
	// F2 / spec §HEALTH CHECK FAILURE HANDLING: count auto-retries.
	// After 1 auto-retry the user is shown the failure screen with
	// explicit Retry / Change provider / Change model / Skip. The
	// auto-retry cap prevents the silent infinite-loop anti-pattern
	// called out by the spec.
	TestItAttempts int

	// F3 / spec §MULTI-STEP HEALTH CHECK: 4 granular checks replacing
	// the single streaming round-trip test. Each check has a kind,
	// status, and optional message. Indexes map to HealthCheckKind.
	HealthChecks [4]HealthCheck

	// F3.1: timing metrics for the connection benchmark display.
	// HealthCheckLatency is the wall time for phase 1 (parallel checks).
	// StreamLatency is the wall time for the streaming round-trip.
	// StreamVerified is true when the streaming response contained
	// the expected deterministic token (FERAL_OK).
	HealthCheckLatency time.Duration
	StreamLatency      time.Duration
	StreamVerified     bool

	// SpinnerView is the current frame of the app's loader spinner,
	// refreshed on every spinner.TickMsg so health checks animate.
	SpinnerView string

	// Phase 1 (2026-07-07) — fetcher-populated provider + connector
	// catalogs. Empty until `startWizardCatalogFetch` runs; refresh
	// from the gateway on every wizard start. The render code reads
	// `ProviderCatalog()` / `ConnectorCatalog()` helpers below, which
	// fall back to the bundled local slices when the fetch fails or
	// returns a version mismatch (Decision C).
	providerCatalog    []api.ProviderCatalogEntry
	connectorCatalog   []api.ConnectorCatalogEntry
	catalogVersion     int
	catalogOffline     bool   // true when the fetch failed; renderers show a small banner
	catalogDriftWarned bool   // true once the user has been shown a version-mismatch banner this session
}

// ProviderCatalog returns the wizard's effective provider list:
//   - gateway-fetched rows when the cache is populated
//   - otherwise: the bundled `CloudProviders` slice (offline fallback)
//
// Wrapped once so renderers don't have to branch.
func (ws *WizardState) ProviderCatalog() []api.ProviderCatalogEntry {
	if len(ws.providerCatalog) > 0 {
		return ws.providerCatalog
	}
	// Fallback: map the bundled slice into the catalog-entry shape so the
	// renderer reads a uniform type. Empty optional fields stay nil; the
	// renderer knows what to do with them.
	out := make([]api.ProviderCatalogEntry, 0, len(CloudProviders))
	for _, p := range CloudProviders {
		name := stringPtr(p.Name)
		baseURL := stringPtr(p.BaseURL)
		out = append(out, api.ProviderCatalogEntry{
			ID:                    p.ID,
			Name:                  p.Name,
			Provider:              p.ID, // serialized enum id matches the legacy slice ID
			DefaultBaseURL:        stringOr(p.BaseURL, ""),
			DefaultModel:          p.DefaultModel,
			KeyFormat:             nil,
			KeyFormatHint:         nil,
			FreeTierNote:          nil,
			SupportsCustomBaseURL: p.BaseURL != "",
			ConsoleURL:            nil,
			AuthStyle:             "bearer",
		})
		_ = name
		_ = baseURL
	}
	return out
}

// ConnectorCatalog returns the wizard's effective connector list.
func (ws *WizardState) ConnectorCatalog() []api.ConnectorCatalogEntry {
	if len(ws.connectorCatalog) > 0 {
		return ws.connectorCatalog
	}
	out := make([]api.ConnectorCatalogEntry, 0, len(connectorDefs))
	for id, d := range connectorDefs {
		authKind := d.AuthKind
		if authKind == "" {
			authKind = "bot_token"
		}
		pairingFields := make([]api.ConnectorPairingFieldDef, 0, len(d.Fields))
		for _, f := range d.Fields {
			pairingFields = append(pairingFields, api.ConnectorPairingFieldDef{
				Key:    f.Key,
				Label:  f.Label,
				Secret: f.Secret,
			})
		}
		out = append(out, api.ConnectorCatalogEntry{
			ID:                  id,
			Name:                d.Name,
			Description:         "",
			Icon:                "",
			LogoURL:             nil,
			PairingFields:       pairingFields,
			PairingMethod:       authKind,
			ComingSoon:          d.ComingSoon,
			ConsoleURL:          nil,
			FreeTierNote:        nil,
			ValidateEndpoint:    nil,
			OAuthScopes:         nil,
			OAuthClientIDSource: nil,
			QRSetupEndpoint:     nil,
		})
	}
	return out
}

func stringOr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// stringPtr helper is defined in update.go (used by saveCloudProvider
// for the SaveByokKey optional fields). Both files live in package `app`
// so the symbol resolves at the call site.

func (ws *WizardState) reset() {
	ws.Show = false
	ws.Step = WizWelcome
	ws.Choice = WizChoiceLocal
	ws.Provider = ""
	ws.APIKey = ""
	ws.KeyValid = false
	ws.KeyValidMsg = ""
	ws.SetupMode = SetupQuickStart
	ws.SetupModeIdx = 0
	ws.ResetPending = false
	ws.ModelEditing = false
	ws.ConfigHandling = ConfigKeep
	ws.ConfigHandlingIdx = 0
	ws.HasExistingConfig = false
	ws.SecurityAccepted = false
	ws.Tagline = ui.RandomTagline()
	ws.ResumeStep = WizWelcome
	ws.ResumeIdx = 0
	ws.SearchQuery = ""
	ws.KeyStorageMode = 0
	ws.Progress = 0
	ws.ProgressMsg = ""
	ws.connectorIdx = 0
	ws.ConnectorSelected = ""
	ws.ConnectorFieldIdx = 0
	ws.ConnectorTokenInput = ""
	ws.ConnectorTokenValues = nil
	ws.lastCompleted = WizWelcome
	ws.HardwareProbeErr = nil
	ws.DownloadID = ""
	ws.DownloadErr = nil
	ws.DownloadStartedAt = time.Time{}
	ws.TestItSucceeded = false
	ws.TestItSkipped = false
	ws.TestItError = ""
	ws.TestItResponse = ""
	ws.TestItRunning = false
	ws.TestItAttempts = 0
	ws.ProviderIdx = 0
	ws.HealthCheckLatency = 0
	ws.StreamLatency = 0
	ws.StreamVerified = false
	// Phase 1 — clear the catalog cache so every wizard session re-fetches.
	// The fetch itself fires from `startWizard`; if it fails, the
	// `ProviderCatalog()` / `ConnectorCatalog()` helpers fall back to the
	// bundled slice and `ws.catalogOffline` flips to true to render a banner.
	ws.providerCatalog = nil
	ws.connectorCatalog = nil
	ws.catalogVersion = 0
	ws.catalogOffline = false
	ws.catalogDriftWarned = false
	for i := range ws.HealthChecks {
		ws.HealthChecks[i] = HealthCheck{Kind: HealthCheckKind(i), Status: CheckPending}
	}
}

// custom reports whether the wizard is in Custom setup mode (P1.1 — the
// SetupMode enum degrades to this bool; Custom unlocks inline model edits
// and extra failure options on the shared screens).
func (ws *WizardState) custom() bool { return ws.SetupMode == SetupManual }

// welcomeOptionCount returns how many options the Welcome screen shows:
// Quick start + Custom setup, plus "Use existing config" when prior state
// is on disk (P1 screen 1).
func welcomeOptionCount(ws *WizardState) int {
	if ws.HasExistingConfig {
		return 3
	}
	return 2
}

// pathHasStep reports whether `s` is in the wizard's current path.
func pathHasStep(ws *WizardState, s WizardStep) bool {
	for _, p := range ws.Path {
		if p == s {
			return true
		}
	}
	return false
}

// pathIndexOf returns the 0-based index of `s` in the path, or 0 if absent.
func pathIndexOf(ws *WizardState, s WizardStep) int {
	for i, p := range ws.Path {
		if p == s {
			return i
		}
	}
	return 0
}

// wipeFeralHome deletes ~/.feral so the wizard can start fresh (Welcome
// "r reset"). Best-effort: a failed delete just means the next launch still
// detects existing config, which is safe.
func wipeFeralHome() {
	if dir := feralHomeDir(); dir != "" {
		os.RemoveAll(dir)
	}
}

// wizardFooterHint returns the footer text for the current wizard step.
// anyCheckRunning returns true when at least one health check is in
// the Running state (F3 multi-step health check).
func anyCheckRunning(checks [4]HealthCheck) bool {
	for _, hc := range checks {
		if hc.Status == CheckRunning {
			return true
		}
	}
	return false
}

func (ws *WizardState) footerHint() string {
	switch ws.Step {
	case WizWelcome:
		return ui.AccentStyle.Render("Enter") + "  continue  ·  esc  exit"
	case WizSecurity:
		return "y accept  ·  n decline"
	case WizSetupMode:
		return ui.G.Up + ui.G.Down + " navigate  ·  enter select"
	case WizConfigHandling:
		return ui.G.Up + ui.G.Down + " navigate  ·  enter select"
	case WizResume:
		return ui.G.Up + ui.G.Down + " navigate  ·  enter select  ·  esc start over"
	case WizHardware:
		return "detecting hardware…"
	case WizModelChoice:
		return "enter to select"
	case WizLocalDownload:
		if ws.Progress > 0 {
			return fmt.Sprintf("downloading %s — %.0f%%", ws.ModelID, ws.Progress*100)
		}
		return "preparing download…"
	case WizCloudProvider:
		return "type to filter  ·  " + ui.G.Up + ui.G.Down + " navigate  ·  enter select"
	case WizCloudModel:
		return "type a custom model id or accept the default  ·  enter continue"
	case WizCloudKeyMode:
		return ui.G.Up + ui.G.Down + " navigate  ·  enter select"
	case WizCloudKey:
		if ws.KeyValid {
			return "enter continue"
		}
		return "paste your api key and press enter"
	case WizConnectors:
		return ui.G.Up + ui.G.Down + " navigate · enter select · esc back"
	case WizConnectorPrompt:
		// F4: QR connectors show Y/n, token connectors show field input.
		def, ok := connectorDefs[strings.ToLower(ws.ConnectorSelected)]
		if !ok || len(def.Fields) == 0 || def.AuthKind == "qr" {
			return "y confirm · n skip"
		}
		return ui.AccentStyle.Render("Enter") + " submit field  ·  esc back"
	case WizTestIt:
		if ws.TestItRunning || anyCheckRunning(ws.HealthChecks) {
			return "running health checks…"
		}
		if ws.TestItSucceeded {
			return "enter to continue"
		}
		if ws.TestItError != "" {
			return "r retry · p change provider · m change model · s skip"
		}
		return "preparing…"
	case WizFinish:
		return "enter to start chatting"
	default:
		return ""
	}
}
