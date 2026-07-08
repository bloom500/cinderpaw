package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"feral-tui/api"
	"feral-tui/ui"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
)

// TestWizardWriteOrderCloudProvider verifies the "save before advance"
// contract on the cloud key screen (P1): saveCloudProvider() runs on a
// successful ProvidersTestMsg, KeyValid flips true, and the step advances
// into the health checks (WizTestIt) — one screen (3) in the 4-screen flow.
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

	if a.Wizard.Step != WizTestIt {
		t.Errorf("step = %v, want WizTestIt (checks auto-run after key save)", a.Wizard.Step)
	}
	if !a.Wizard.KeyValid {
		t.Error("KeyValid should be true after successful provider test + save")
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
