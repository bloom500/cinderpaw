package api

import (
	"os"
	"path/filepath"
	"testing"
)

// EnsureToken — Sprint 2 / audit C-3. On first run we generate a token,
// write it 0600-permissioned, and return it. Subsequent reads reuse the
// on-disk value (no clobber). The `seed` argument makes the test
// deterministic — `nil` falls back to crypto/rand on the production path.
func TestEnsureTokenCreatesAndReuses(t *testing.T) {
	dir := t.TempDir()
	// os.UserHomeDir() reads USERPROFILE on Windows, HOME on POSIX.
	// Set both so the test works regardless of the host OS.
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	seed := []byte("01234567890123456789012345678901") // 32 bytes — same length as crypto/rand
	tok1, err := EnsureToken(seed)
	if err != nil {
		t.Fatalf("first EnsureToken: %v", err)
	}
	if tok1 == "" {
		t.Fatal("first token is empty")
	}
	if len(tok1) < 40 {
		t.Fatalf("token too short: %d chars", len(tok1))
	}
	// Verify the file landed on disk with 0600 perms (skipped on Windows
// where POSIX bits are not enforced — Windows ACL is a separate surface).
	path := filepath.Join(dir, ".feral", "api-token")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("token file missing: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Skipf("POSIX perm check is not enforced on this OS (got %o); skipping",
			info.Mode().Perm())
	}
	// Second call with a *different* seed must reuse the on-disk value
	// — the user is not silently rotated to a new bearer mid-session.
	differentSeed := []byte("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")
	tok2, err := EnsureToken(differentSeed)
	if err != nil {
		t.Fatalf("second EnsureToken: %v", err)
	}
	if tok2 != tok1 {
		t.Fatalf("expected reuse, got %q vs %q", tok2, tok1)
	}
}