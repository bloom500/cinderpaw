package app

import (
	"encoding/json"
	"strings"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"cinderpaw-tui/api"
	"cinderpaw-tui/ui"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
)

// TestWizardWriteOrderCloudProvider verifies the "save before advance"
// contract on the cloud key screen (P1): saveCloudProvider() runs on a
// successful ProvidersTestMsg, KeyValid flips true, and the step advances
// to the model picker. The health checks used to auto-run from here, which
// is what kept WizCloudModel unreachable; they now start on Enter there.
func TestWizardWriteOrderCloudProvider(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime/byok/save":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "message": ""})
		case "/runtime/model/set":
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	a := newOrderTestApp(srv.URL)

	a.Wizard = WizardState{
		Show:     true,
		Step:     WizCloudKey,
		Choice:   WizChoiceCloud,
		Provider: "openai",
		APIKey:   "sk-test-key-12345",
		Path:     wizardPathFor(WizChoiceCloud),
	}
	// Align PathIndex to WizCloudKey.
	a.Wizard.PathIndex = pathIndexOf(&a.Wizard, WizCloudKey)

	msg := ProvidersTestMsg{Success: true, Msg: "ok"}
	result, _ := a.Update(msg)
	a = result.(*App)

	if a.Wizard.Step != WizCloudModel {
		t.Errorf("step = %v, want WizCloudModel (model picker follows the key)", a.Wizard.Step)
	}
	if !a.Wizard.KeyValid {
		t.Error("KeyValid should be true after successful provider test + save")
	}
}

// TestProviderWithStoredKeyOffersToKeepIt is the regression guard for two
// reported bugs at once. First (19 Sep): a provider whose key is already on
// the machine must not make the person paste it again. Second (20 Sep): the
// fix for the first skipped the key screen outright, and then nothing in the
// wizard let anyone CHANGE a key. So the screen stays, pre-filled with the
// fact that a key is stored: Enter keeps it and moves on to the model list
// the probe fetched; typing replaces it and Enter validates the new one.
func TestProviderWithStoredKeyOffersToKeepIt(t *testing.T) {
	a := newOrderTestApp("http://127.0.0.1:1")
	a.Wizard = WizardState{
		Show:     true,
		Step:     WizCloudKey,
		Choice:   WizChoiceCloud,
		Provider: "openai",
		ModelID:  "gpt-4o",
		Path:     wizardPathFor(WizChoiceCloud),
	}

	msg := ProvidersTestMsg{
		Success:   true,
		ProbeOnly: true,
		Models:    []string{"gpt-4o-mini", "gpt-4o", "o3"},
	}
	result, _ := a.Update(msg)
	a = result.(*App)

	if a.Wizard.Step != WizCloudKey {
		t.Errorf("step = %v, want WizCloudKey (the screen stays, pre-filled)", a.Wizard.Step)
	}
	if !a.Wizard.ProviderHasKey {
		t.Error("ProviderHasKey should be true after a successful probe")
	}
	// The screen says so, and says what Enter does.
	body := renderWizCloudKey(&a.Wizard, 80)
	for _, want := range []string{"saved on this machine", "keep the saved key", "replace it"} {
		if !strings.Contains(body, want) {
			t.Errorf("key screen should say %q; got:\n%s", want, body)
		}
	}

	// Enter on the empty field keeps the key and lands on the model list,
	// highlighted on the model already in use so a second Enter changes nothing.
	a.wizardHandleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if a.Wizard.Step != WizCloudModel {
		t.Errorf("after Enter: step = %v, want WizCloudModel", a.Wizard.Step)
	}
	if got := a.Wizard.ModelList[a.Wizard.ModelIdx]; got != "gpt-4o" {
		t.Errorf("highlighted model = %q, want the model already in use (gpt-4o)", got)
	}

	// Typing a new key un-proves it: Enter must validate, not keep.
	b := newOrderTestApp("http://127.0.0.1:1")
	b.Wizard = a.Wizard
	b.Wizard.Step = WizCloudKey
	b.Wizard.APIKey = ""
	b.wizardHandleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("s")})
	if b.Wizard.KeyValid {
		t.Error("a freshly typed key must not inherit the stored key's validation")
	}
	if got := b.Wizard.APIKey; got != "s" {
		t.Errorf("APIKey = %q, want the typed character", got)
	}
}

// TestFailedProbeKeepsKeyScreenSilent guards the other half: a provider with
// no stored key must fall through to the key field WITHOUT rendering a
// rejected-key error the user never caused.
func TestFailedProbeKeepsKeyScreenSilent(t *testing.T) {
	a := newOrderTestApp("http://127.0.0.1:1")
	a.Wizard = WizardState{
		Show:     true,
		Step:     WizCloudKey,
		Choice:   WizChoiceCloud,
		Provider: "mistral",
		Path:     wizardPathFor(WizChoiceCloud),
	}

	msg := ProvidersTestMsg{
		Success:   false,
		ProbeOnly: true,
		Msg:       "No API key stored for mistral.",
	}
	result, _ := a.Update(msg)
	a = result.(*App)

	if a.Wizard.Step != WizCloudKey {
		t.Errorf("step = %v, want WizCloudKey (ask for the key)", a.Wizard.Step)
	}
	if a.Wizard.KeyValidMsg != "" {
		t.Errorf("KeyValidMsg = %q, want empty — the probe is silent", a.Wizard.KeyValidMsg)
	}
	if a.Wizard.ProviderHasKey {
		t.Error("ProviderHasKey must stay false when the probe fails")
	}
}

// ── test scaffold ─────────────────────────────────────────────

func newOrderTestApp(baseURL string) *App {
	ti := textarea.New()
	ti.Placeholder = "type a message"
	ti.Prompt = ""
	ti.FocusedStyle.CursorLine = ti.FocusedStyle.CursorLine.UnsetBackground()
	ti.BlurredStyle.CursorLine = ti.BlurredStyle.CursorLine.UnsetBackground()
	ti.Focus()
	ti.SetWidth(78)
	ti.SetHeight(3)

	vp := viewport.New(80, 20)
	vp.KeyMap = viewport.DefaultKeyMap()

	sp := spinner.New()
	sp.Style = ui.SpinnerStyle
	sp.Spinner = spinner.MiniDot

	return &App{
		Width:     80,
		Height:    24,
		BaseURL:   baseURL,
		Token:     "test-token",
		Status:    &api.StatusSnapshot{Online: true},
		StartedAt: time.Now().Add(-1 * time.Minute),
		Input:     ti,
		ChatVP:    vp,
		Loader:    sp,
		State:     StateReady,
		Now:       time.Now(),
	}
}
