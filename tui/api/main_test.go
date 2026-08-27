package api

import (
	"os"
	"testing"
)

// TestMain gives this package's tests their own home directory.
//
// `go test ./...` was writing into the developer's real profile dir: a run on
// 2026-08-26 created .wizard-done and .wizard-progress under ~/.cinderpaw on a
// machine where that directory had just been cleaned up after migrating. That
// left an unmarked legacy home behind, and the Rust host then refused to boot
// ("both exist, and the older one is not marked as migrated"). A test run must
// not be able to touch a person's install.
//
// It redirects HOME/USERPROFILE rather than setting CINDERPAW_HOME, on
// purpose: several tests here already redirect HOME themselves via t.Setenv,
// and CINDERPAW_HOME outranks it in api.Home — setting the stronger variable
// would have overridden those tests and made them assert against this shared
// directory instead of their own. Four of them failed exactly that way on the
// first attempt.
func TestMain(m *testing.M) {
	if os.Getenv("CINDERPAW_HOME") == "" && os.Getenv("CINDERPAW_HOME") == "" {
		dir, err := os.MkdirTemp("", "cinderpaw-tui-test-home-")
		if err != nil {
			panic("cannot create a temp home for tests: " + err.Error())
		}
		os.Setenv("HOME", dir)
		os.Setenv("USERPROFILE", dir)
		defer os.RemoveAll(dir)
	}
	os.Exit(m.Run())
}

// testHomeDir resolves the profile dir the code under test will actually use.
// Fixtures used to hardcode "<tmp>/.cinderpaw", which silently stopped matching
// once the resolver started preferring .cinderpaw — a fixture that names a
// directory the code no longer picks tests nothing.
func testHomeDir(t *testing.T) string {
	t.Helper()
	dir, err := Home()
	if err != nil {
		t.Fatal(err)
	}
	return dir
}
