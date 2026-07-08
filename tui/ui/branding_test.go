package ui

import "testing"

func TestAppName(t *testing.T) {
	if AppName != "FERAL" {
		t.Fatalf("AppName = %q, want FERAL", AppName)
	}
}

func TestAppVersion(t *testing.T) {
	if AppVersion == "" {
		t.Fatal("AppVersion is empty")
	}
}

func TestFeralLogo(t *testing.T) {
	if FeralLogo == "" {
		t.Fatal("FeralLogo is empty")
	}
	// Should contain box-drawing characters from oh-my-logo/ANSI Shadow.
	for _, want := range []string{"█", "╗", "╝"} {
		if !contains(FeralLogo, want) {
			t.Fatalf("FeralLogo missing %q", want)
		}
	}
}

func TestBearLogo(t *testing.T) {
	if BearLogo == "" {
		t.Fatal("BearLogo is empty")
	}
	if !contains(BearLogo, AppName) {
		t.Fatalf("BearLogo does not mention %s", AppName)
	}
	if !contains(BearLogo, AppVersion) {
		t.Fatalf("BearLogo does not mention version %s", AppVersion)
	}
}

func TestBearCompact(t *testing.T) {
	if BearCompact == "" {
		t.Fatal("BearCompact is empty")
	}
	if !contains(BearCompact, AppName) {
		t.Fatalf("BearCompact does not mention %s", AppName)
	}
}

func TestTaglines(t *testing.T) {
	if len(Taglines) < 3 {
		t.Fatalf("need at least 3 taglines, got %d", len(Taglines))
	}
}

func TestRandomTagline(t *testing.T) {
	got := RandomTagline()
	found := false
	for _, want := range Taglines {
		if got == want {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("RandomTagline() returned %q which is not in Taglines", got)
	}
	// Call again — should still return a valid tagline (randomness).
	for i := 0; i < 10; i++ {
		if RandomTagline() == "" {
			t.Fatal("RandomTagline returned empty string")
		}
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
