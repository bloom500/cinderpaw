package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Preflight tests pin the off-disk sanity sweep that fires at the top
// of startWizard (Phase 1 of the OpenClaw-parity wizard work). The
// sweep must:
//   - return zero notices on a fresh install (no ~/.feral state)
//   - return a notice on a malformed byok.json (fail-severity)
//   - return a notice on an empty byok.json (warn-severity)
//   - return a notice on a byok.json whose provider id is unknown
//   - return a notice on a progress file whose version stamp differs
//     from the current wizard version (stale or future)
//   - tolerate a missing home directory without panicking
//   - render multi-line details with consistent indentation

func TestPreflightFreshInstall(t *testing.T) {
	// Fresh /tmp dir; nothing under it.
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	// feralHome() is called via feralHomeDir() in checkByokFile /
	// checkProgressVersion. Both should return zero notices.
	if notes := checkByokFile(); notes != nil {
		t.Errorf("fresh install should have no byok notice; got %+v", notes)
	}
	if notes := checkProgressVersion(); notes != nil {
		t.Errorf("fresh install should have no progress notice; got %+v", notes)
	}
}

func TestPreflightByokFileEmpty(t *testing.T) {
	dir := t.TempDir()
	mustMkdir(t, filepath.Join(dir, ".feral"))
	mustWrite(t, filepath.Join(dir, ".feral", "byok.json"), "")
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	n := checkByokFile()
	if n == nil {
		t.Fatal("expected notice for empty byok.json, got nil")
	}
	if n.Severity != "warn" {
		t.Errorf("empty byok.json severity = %q, want warn", n.Severity)
	}
	if !strings.Contains(n.Label, "empty") {
		t.Errorf("label %q should mention empty", n.Label)
	}
}

func TestPreflightByokFileInvalidJSON(t *testing.T) {
	dir := t.TempDir()
	mustMkdir(t, filepath.Join(dir, ".feral"))
	mustWrite(t, filepath.Join(dir, ".feral", "byok.json"), `{ not json `)
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	n := checkByokFile()
	if n == nil {
		t.Fatal("expected notice for invalid byok.json, got nil")
	}
	if n.Severity != "fail" {
		t.Errorf("invalid byok.json severity = %q, want fail", n.Severity)
	}
	// The label carries the human summary; the detail carries the parser
	// error (which varies by Go version, so we don't pin its wording)
	// plus the recovery hint.
	if !strings.Contains(n.Label, "is not valid JSON") {
		t.Errorf("label should mention invalid JSON; got %q", n.Label)
	}
	if !strings.Contains(n.Detail, "Reset from the Config handling screen") {
		t.Errorf("detail should include the recovery hint; got %q", n.Detail)
	}
}

func TestPreflightByokFileUnknownProvider(t *testing.T) {
	dir := t.TempDir()
	mustMkdir(t, filepath.Join(dir, ".feral"))
	// `nonesuch` is not in CloudProviders today; this matches the
	// contract that Phase 1 catalog sync catches when byok::CATALOG_VERSION
	// bumps and a removed provider surfaces here.
	byok := `{"providers":{"nonesuch":{"api_key":"abc","enabled":true}}}`
	mustWrite(t, filepath.Join(dir, ".feral", "byok.json"), byok)
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	n := checkByokFile()
	if n == nil {
		t.Fatal("expected notice for unknown provider id, got nil")
	}
	if !strings.Contains(n.Label, "Unknown provider") {
		t.Errorf("label should mention unknown provider; got %q", n.Label)
	}
	if !strings.Contains(n.Detail, "nonesuch") {
		t.Errorf("detail should reference the unknown id; got %q", n.Detail)
	}
}

func TestPreflightByokFileKnownProvider(t *testing.T) {
	// Sanity: a well-formed byok.json with a known provider id must NOT
	// surface a notice. The catalog surface (`hasExistingConfig`) is
	// what gates the WizConfigHandling screen, not the preflight.
	dir := t.TempDir()
	mustMkdir(t, filepath.Join(dir, ".feral"))
	byok := `{"providers":{"openai":{"api_key":"abc","enabled":true}}}`
	mustWrite(t, filepath.Join(dir, ".feral", "byok.json"), byok)
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	if n := checkByokFile(); n != nil {
		t.Errorf("known-provider byok.json should not surface a notice; got %+v", n)
	}
}

func TestPreflightProgressVersionStale(t *testing.T) {
	dir := t.TempDir()
	mustMkdir(t, filepath.Join(dir, ".feral"))
	// wizardProgressVersion is currently 3; write v2 — older, must
	// surface as warn so the user knows why their progress reset.
	mustWrite(t, filepath.Join(dir, ".feral", wizardProgressFile), "v2:1")
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	n := checkProgressVersion()
	if n == nil {
		t.Fatal("expected notice for stale progress file, got nil")
	}
	if n.Severity != "warn" {
		t.Errorf("stale severity = %q, want warn", n.Severity)
	}
	if !strings.Contains(n.Detail, "v2") || !strings.Contains(n.Detail, "v"+intToStr(wizardProgressVersion)) {
		t.Errorf("detail should mention both versions; got %q", n.Detail)
	}
}

func TestPreflightProgressVersionFuture(t *testing.T) {
	dir := t.TempDir()
	mustMkdir(t, filepath.Join(dir, ".feral"))
	mustWrite(t, filepath.Join(dir, ".feral", wizardProgressFile), "v999:7")
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	n := checkProgressVersion()
	if n == nil {
		t.Fatal("expected notice for future progress file, got nil")
	}
	if n.Severity != "warn" {
		t.Errorf("future severity = %q, want warn", n.Severity)
	}
	if !strings.Contains(n.Detail, "999") {
		t.Errorf("detail should mention 999; got %q", n.Detail)
	}
}

func TestPreflightProgressVersionMatch(t *testing.T) {
	dir := t.TempDir()
	mustMkdir(t, filepath.Join(dir, ".feral"))
	// Match the current version; no notice expected.
	mustWrite(t, filepath.Join(dir, ".feral", wizardProgressFile), "v"+intToStr(wizardProgressVersion)+":1")
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	if n := checkProgressVersion(); n != nil {
		t.Errorf("matching-version progress should not surface a notice; got %+v", n)
	}
}

func TestRenderPreflightNotesEmpty(t *testing.T) {
	if got := renderPreflightNotes(nil); got != "" {
		t.Errorf("empty notes should render empty string; got %q", got)
	}
	if got := renderPreflightNotes([]preflightNotice{}); got != "" {
		t.Errorf("zero-length slice should render empty string; got %q", got)
	}
}

func TestRenderPreflightNotesFailFirst(t *testing.T) {
	notes := []preflightNotice{
		{Label: "byok.json is not valid JSON", Detail: "unexpected EOF\n  -> Reset from the Config handling screen", Severity: "fail"},
		{Label: "Stale progress file", Detail: "Got v2, this build is v3.", Severity: "warn"},
	}
	out := renderPreflightNotes(notes)

	// Header label is present.
	if !strings.Contains(out, "Preflight:") {
		t.Errorf("missing header label; got:\n%s", out)
	}
	// Severity glyphs render as expected — fail = `!`, warn = `*`.
	if !strings.Contains(out, "[!]") {
		t.Errorf("missing fail glyph; got:\n%s", out)
	}
	if !strings.Contains(out, "[*]") {
		t.Errorf("missing warn glyph; got:\n%s", out)
	}
	// Each label renders, in order.
	if !strings.Contains(out, "byok.json is not valid JSON") {
		t.Errorf("first label missing; got:\n%s", out)
	}
	if !strings.Contains(out, "Stale progress file") {
		t.Errorf("second label missing; got:\n%s", out)
	}
	// Multi-line detail is indented consistently.
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "unexpected EOF") || strings.Contains(line, "Reset from") {
			if !strings.HasPrefix(line, "      ") {
				t.Errorf("detail line %q is not indented consistently", line)
			}
		}
	}
}

// ── helpers ───────────────────────────────────────────────────

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func intToStr(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}