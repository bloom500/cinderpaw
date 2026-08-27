// Package app — wizard preflight checks.
//
// Phase 1 (2026-07-07) of the OpenClaw-parity wizard work: a single
// off-disk sanity sweep runs at wizard start so the user sees existing
// state (a malformed byok.json, a stale progress file, a future-version
// downgrade) before the first frame renders. Equivalent to OpenClaw's
// `buildPluginCompatibilitySnapshotNotices` + `readSetupConfigFileSnapshot`
// which fire at the top of `setup.ts:122` BEFORE any input.
//
// This mirrors their intent without copying code: read local state
// synchronously, surface what would otherwise break a later step, and
// let the user act before any input is taken. Notices render inside
// the first frame the user sees (Welcome) so they don't add a new
// step that disrupts the flow.
//
// All checks are local (no network, no async). Each is independent —
// any number of notices can stack. The shape of each notice is a
// short label + an actionable hint, both ASCII (no Unicode glyphs);
// the renderer is responsible for styling.
package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"cinderpaw-tui/api"
)

// preflightNotice is a single off-disk anomaly the wizard should
// surface before the user takes their first action.
type preflightNotice struct {
	// Label is the short title rendered in the preflight block (e.g.
	// "Config invalid", "Unknown provider"). ASCII only.
	Label string
	// Detail is the human-readable explanation + suggested next step.
	// Plain text, line-broken on its own.
	Detail string
	// Severity drives the colour in the renderer: "warn" = yellow,
	// "fail" = red. Anything else renders dim.
	Severity string
}

// existingConfigSummary returns a one-line description of what prior state
// was found on disk (active provider or provider ids from byok.json when
// parseable), for the Welcome "Use existing config" option (P1).
func existingConfigSummary() string {
	home, err := api.Home()
	if err != nil {
		return "reuse the configuration on disk"
	}
	data, err := os.ReadFile(filepath.Join(home, "byok.json"))
	if err != nil {
		return "reuse the configuration on disk"
	}
	var probe struct {
		Active    string                     `json:"active"`
		Providers map[string]json.RawMessage `json:"providers"`
	}
	if json.Unmarshal(data, &probe) != nil || len(probe.Providers) == 0 {
		return "reuse the configuration on disk"
	}
	if probe.Active != "" {
		return "found: " + probe.Active
	}
	ids := make([]string, 0, len(probe.Providers))
	for id := range probe.Providers {
		ids = append(ids, id)
	}
	return "found: " + strings.Join(ids, ", ")
}

// preflightNotices runs the local-state sanity sweep. Returns the
// notices (possibly empty) the renderer should display before the
// first wizard step. The function is best-effort: every check must
// tolerate missing files (fresh install) — none of them must panic
// or block the wizard from starting.
//
// Order of checks matters for the rendered output: more severe
// (malformed) before less severe (stale). The renderer preserves
// the slice order.
func preflightNotices() []preflightNotice {
	var notes []preflightNotice
	if n := checkByokFile(); n != nil {
		notes = append(notes, *n)
	}
	if n := checkProgressVersion(); n != nil {
		notes = append(notes, *n)
	}
	return notes
}

// checkByokFile inspects ~/.feral/byok.json. Returns a notice if the
// file exists but cannot be read as the ByokSettings struct the
// wizard expects. This catches:
//   - corrupt JSON (manual edits that broke the file)
//   - provider id that the catalog no longer recognises (Phase 1
//     catalog sync — when byok::CATALOG_VERSION bumps, an entry
//     removed upstream surfaces here)
//
// A fresh install (no file) is not a notice. A correctly-formed
// byok.json is not a notice — `hasExistingConfig` already surfaces it
// via the WizConfigHandling gate.
func checkByokFile() *preflightNotice {
	home := feralHomeDir()
	if home == "" {
		return nil
	}
	path := filepath.Join(home, "byok.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil // file absent — fresh install, no notice
	}
	// Empty file is a notice: it tripped `hasExistingConfig` (file
	// exists) but cannot drive any wizard step that reads it.
	if len(raw) == 0 {
		return &preflightNotice{
			Label:    "byok.json is empty",
			Detail:   "The file exists but contains no providers. Wizard will overwrite it on save.",
			Severity: "warn",
		}
	}
	var probe struct {
		Providers map[string]json.RawMessage `json:"providers"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return &preflightNotice{
			Label:    "byok.json is not valid JSON",
			Detail:   err.Error() + "\n  -> Reset from the Config handling screen to recreate the file, or paste a new key on the API key step.",
			Severity: "fail",
		}
	}
	// Empty providers map is fine — the user simply hasn't saved
	// anything yet. A present-but-unknown provider id is the signal
	// we want.
	for id := range probe.Providers {
		if _, known := providerByID(id); !known {
			return &preflightNotice{
				Label: "Unknown provider in byok.json",
				Detail: "'" + id + "' is not in the current catalog.\n" +
					"  -> Wizard will offer Reset on the Config handling screen.",
				Severity: "fail",
			}
		}
	}
	return nil
}

// checkProgressVersion inspects ~/.feral/.wizard-progress for a
// version stamp that does not match wizardProgressVersion. A stale
// file (older version) is reset automatically by loadWizardProgress so
// the user sees WizWelcome next session — but surfacing the notice
// helps the user understand why their previous progress disappeared.
//
// A future-version file (newer than wizardProgressVersion) suggests
// the user downgraded the binary — loadWizardProgress refuses to
// resume on a future file. The notice tells them so and offers the
// recovery path (delete the file).
func checkProgressVersion() *preflightNotice {
	home := feralHomeDir()
	if home == "" {
		return nil
	}
	path := filepath.Join(home, wizardProgressFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	stamp := strings.TrimSpace(string(raw))
	if stamp == "" {
		return nil
	}
	parts := strings.SplitN(stamp, ":", 2)
	if len(parts) != 2 || !strings.HasPrefix(parts[0], "v") {
		// Malformed stamp — loadWizardProgress treats this as a fresh
		// start. Not worth a notice; the user already sees WizWelcome.
		return nil
	}
	got, err := strconv.Atoi(strings.TrimPrefix(parts[0], "v"))
	if err != nil {
		return nil
	}
	if got == wizardProgressVersion {
		return nil
	}
	if got > wizardProgressVersion {
		return &preflightNotice{
			Label:    "Wizard progress file is from a newer build",
			Detail:   "Got v" + strconv.Itoa(got) + ", this build understands v" + strconv.Itoa(wizardProgressVersion) + ". Wizard will ignore the older step counter and start fresh.",
			Severity: "warn",
		}
	}
	return &preflightNotice{
		Label:    "Wizard progress file is from an older build",
		Detail:   "Got v" + strconv.Itoa(got) + ", this build is v" + strconv.Itoa(wizardProgressVersion) + ". Old progress is reset to a fresh start.",
		Severity: "warn",
	}
}

// renderPreflightNotes renders the notices into a small framed block
// suitable for inclusion inside the first wizard frame (Welcome).
// Returns an empty string when no notices are present so the caller
// can compose unconditionally.
//
// The block is plain text + Lip Gloss; no Unicode glyphs (intentional,
// matches the rest of the wizard frame).
func renderPreflightNotes(notes []preflightNotice) string {
	if len(notes) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("Preflight:")
	b.WriteByte('\n')
	for _, n := range notes {
		b.WriteString("  [")
		switch n.Severity {
		case "fail":
			b.WriteString("!")
		case "warn":
			b.WriteString("*")
		default:
			b.WriteString("-")
		}
		b.WriteString("] ")
		b.WriteString(n.Label)
		b.WriteByte('\n')
		if n.Detail != "" {
			for _, line := range strings.Split(n.Detail, "\n") {
				b.WriteString("      ")
				b.WriteString(line)
				b.WriteByte('\n')
			}
		}
		b.WriteByte('\n')
	}
	return b.String()
}