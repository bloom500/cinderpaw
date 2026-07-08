package app

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestSaveLoadWizardProgressRoundtrip verifies the version-prefixed progress
// file: save → load returns the same step. F1 introduced the v2 format;
// load must ignore older v1 (unprefixed) files and reset to WizWelcome.
func TestSaveLoadWizardProgressRoundtrip(t *testing.T) {
	// Redirect to a temp dir so we don't touch the real ~/.feral/.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	cases := []WizardStep{WizWelcome, WizSecurity, WizSetupMode, WizConfigHandling, WizHardware, WizModelChoice, WizFinish}
	for _, step := range cases {
		saveWizardProgress(step, SetupManual, WizChoiceLocal)
		got, _, _ := loadWizardProgress()
		if got != step {
			t.Fatalf("roundtrip step=%v: save→load = %v, want %v", step, got, step)
		}
	}
}

// TestLoadWizardProgressRejectsOldFormat simulates an existing user with a
// v1 (unprefixed) progress file. The loader must detect the version
// mismatch and reset to WizWelcome so the user doesn't resume on the wrong
// step (the F1 pre-flow steps didn't exist in v1).
func TestLoadWizardProgressRejectsOldFormat(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	dir := filepath.Join(tmp, ".feral")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	// Write a v1 (unprefixed) file.
	path := filepath.Join(dir, wizardProgressFile)
	if err := os.WriteFile(path, []byte(strconv.Itoa(int(WizFinish))), 0644); err != nil {
		t.Fatal(err)
	}
	got, _, _ := loadWizardProgress()
	if got != WizWelcome {
		t.Fatalf("v1 file not rejected: loadWizardProgress() = %v, want WizWelcome", got)
	}
}

// TestLoadWizardProgressRejectsWrongVersion simulates a future v3 file.
// The loader must reset to WizWelcome so an unknown future format doesn't
// resume the user on a step that no longer exists.
func TestLoadWizardProgressRejectsWrongVersion(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	dir := filepath.Join(tmp, ".feral")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, wizardProgressFile)
	if err := os.WriteFile(path, []byte("v999:5"), 0644); err != nil {
		t.Fatal(err)
	}
	got, _, _ := loadWizardProgress()
	if got != WizWelcome {
		t.Fatalf("v999 not rejected: loadWizardProgress() = %v, want WizWelcome", got)
	}
}

// TestLoadWizardProgressRejectsOutOfRange guards against file corruption
// or a stale format sneaking through the version check.
func TestLoadWizardProgressRejectsOutOfRange(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	dir := filepath.Join(tmp, ".feral")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, wizardProgressFile)
	prefix := "v" + strconv.Itoa(wizardProgressVersion) + ":"
	if err := os.WriteFile(path, []byte(prefix+strconv.Itoa(9999)), 0644); err != nil {
		t.Fatal(err)
	}
	got, _, _ := loadWizardProgress()
	if got != WizWelcome {
		t.Fatalf("out-of-range not rejected: loadWizardProgress() = %v, want WizWelcome", got)
	}
}

// TestHasExistingConfigFalseOnFreshDir verifies a brand-new install is
// detected as "no config" — the wizard skips the Keep/Review/Reset screen.
func TestHasExistingConfigFalseOnFreshDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)
	if hasExistingConfig() {
		t.Fatal("hasExistingConfig() = true on fresh dir, want false")
	}
}

// TestHasExistingConfigTrueOnWizardDone verifies the wizard-done marker
// from a prior successful run trips the config-handling screen.
func TestHasExistingConfigTrueOnWizardDone(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	dir := filepath.Join(tmp, ".feral")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".wizard-done"), []byte("done\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if !hasExistingConfig() {
		t.Fatal("hasExistingConfig() = false after .wizard-done, want true")
	}
}

// TestHasExistingConfigTrueOnByok verifies a configured cloud provider
// (byok.json present) also trips the config-handling screen.
func TestHasExistingConfigTrueOnByok(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	dir := filepath.Join(tmp, ".feral")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "byok.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if !hasExistingConfig() {
		t.Fatal("hasExistingConfig() = false after byok.json, want true")
	}
}

// TestClearWizardProgress verifies the progress file is removed on
// successful wizard completion.
func TestClearWizardProgress(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	saveWizardProgress(WizFinish, SetupManual, WizChoiceLocal)
	clearWizardProgress()
	got, _, _ := loadWizardProgress()
	if got != WizWelcome {
		t.Fatalf("after clear: loadWizardProgress() = %v, want WizWelcome", got)
	}
}

// TestSaveWizardProgressFormat pins the on-disk format: "v2:<step>". Any
// change here is a breaking change for users with progress files in the
// wild — bump wizardProgressVersion and update the v1 rejection test.
func TestSaveWizardProgressFormat(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	saveWizardProgress(WizTestIt, SetupManual, WizChoiceLocal)
	path, err := wizardProgressPath()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := strings.TrimSpace(string(data))
	want := "v" + strconv.Itoa(wizardProgressVersion) + ":" + strconv.Itoa(int(WizTestIt)) + ":" + strconv.Itoa(int(SetupManual)) + ":" + strconv.Itoa(int(WizChoiceLocal))
	if s != want {
		t.Fatalf("on-disk format = %q, want %q", s, want)
	}
}
