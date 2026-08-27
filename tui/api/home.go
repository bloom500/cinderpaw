package api

import (
	"os"
	"path/filepath"
)

// HomeDirName is the profile directory Cinderpaw uses. LegacyHomeDirName is
// what it was called before the rename.
//
// The rename shipped in halves, and the halves disagreed for a while: the
// desktop host moved to the new name and kept writing conversations, keys and
// the API token there, while this TUI went on reading the old one. The visible
// result was not a cosmetic mismatch — the TUI minted a SECOND API token in a
// folder the gateway no longer read, so it could not authenticate against the
// app running next to it, and it re-ran the setup wizard for somebody who had
// finished it days earlier.
const (
	HomeDirName       = ".cinderpaw"
	LegacyHomeDirName = ".feral"
)

// Home returns the Cinderpaw profile directory, WITHOUT creating it.
//
// The new name wins. The old one is used only when it is the only one present,
// which is the case on a machine that has never run a build new enough to
// migrate — a TUI-only or headless install, where the old name is not a
// leftover but the live home. Returns "" when the home directory is unknown,
// and every caller has to handle that anyway.
func Home() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	current := filepath.Join(home, HomeDirName)
	if _, err := os.Stat(current); err == nil {
		return current
	}
	legacy := filepath.Join(home, LegacyHomeDirName)
	if _, err := os.Stat(legacy); err == nil {
		return legacy
	}
	// Neither exists yet: a fresh install gets the current name, never the old.
	return current
}

// HomePath joins path elements onto the profile directory. Returns "" when the
// home directory is unknown, so a caller that ignores the error still gets a
// path it cannot accidentally write to the filesystem root.
func HomePath(parts ...string) string {
	base := Home()
	if base == "" {
		return ""
	}
	return filepath.Join(append([]string{base}, parts...)...)
}
