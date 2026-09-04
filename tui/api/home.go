package api

import (
	"fmt"
	"os"
	"path/filepath"
)

// The profile directory names. Mirrors crates/cinderpaw-core/src/brand.rs and
// CinderpawAgent/src/config.ts — three implementations of the same rule is
// already one too many, but they must at least agree.
const (
	appHomeDirName    = ".cinderpaw"
	legacyHomeDirName = ".feral"
)

// Home returns the agent's profile directory.
//
// This exists because the TUI never followed the rename. The Rust host
// migrates ~/.feral to ~/.cinderpaw on boot and reads the new one; the TUI
// went on reading ~/.feral/settings.json, ~/.feral/api-token and
// ~/.feral/connectors.json. So since the day a machine migrated, the TUI has
// been looking at a directory the rest of the app stopped writing to: the
// person's API token and connectors simply were not there any more, with no
// error to explain it.
//
// Worse, the wizard's helper called MkdirAll on ~/.feral, so merely running
// the TUI (or its tests) RECREATED the legacy directory. On a machine where
// the old directory had been cleaned up after migrating, that is not a stale
// read — it recreates an unmarked ~/.feral, and the Rust host then refuses to
// boot at all ("both exist, and the older one is not marked as migrated").
// Creating a directory nothing owns is how a cleanup turns into a crash.
//
// Resolution order, identical to the other two implementations:
//  1. CINDERPAW_HOME, then FERAL_HOME — an operator's explicit choice wins.
//  2. ~/.cinderpaw when it exists: the post-rename home.
//  3. ~/.feral when only that exists: a pre-migration install. Reading it is
//     correct — that is where the machine's data actually is.
//  4. ~/.cinderpaw on a fresh machine.
func Home() (string, error) {
	if v := os.Getenv("CINDERPAW_HOME"); v != "" {
		return v, nil
	}
	if v := os.Getenv("FERAL_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot find home directory: %w", err)
	}
	modern := filepath.Join(home, appHomeDirName)
	legacy := filepath.Join(home, legacyHomeDirName)
	if dirExists(modern) {
		return modern, nil
	}
	if dirExists(legacy) {
		return legacy, nil
	}
	return modern, nil
}

// HomeEnsure is Home plus MkdirAll, for the callers that are about to write.
// Readers must use Home: creating the directory as a side effect of reading is
// what let the TUI resurrect ~/.feral.
func HomeEnsure() (string, error) {
	dir, err := Home()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("cannot create %s: %w", dir, err)
	}
	return dir, nil
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
