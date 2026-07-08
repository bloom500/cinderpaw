package app

import (
	"strings"
	"testing"
)

// TestConnectorsAddRejectsTelegramComingSoon — task #4 explicit
// requirement: Telegram has no live connector backend yet (see
// crates/feral-core/src/connectors.rs coming_soon:true). /connectors add
// must refuse to take the token so the user doesn't paste credentials
// that would be silently dropped.
func TestConnectorsAddRejectsTelegramComingSoon(t *testing.T) {
	a := newTestApp()

	a.handleConnectors([]string{"add", "telegram", "TELEGRAM_BOT_TOKEN=999999:secret"})

	if !strings.Contains(strings.ToLower(a.FlashText), "coming soon") &&
		!strings.Contains(strings.ToLower(a.FlashText), "not available") {
		t.Fatalf("expected FlashText to reject telegram as coming-soon, got %q", a.FlashText)
	}
	if a.FlashText == "" {
		t.Fatal("expected a flash rejection, got empty")
	}
}

// TestConnectorsAddRejectsUnknownID — fail loud on an id that's not in
// the catalog so the user gets a typo hint, not a silent write.
func TestConnectorsAddRejectsUnknownID(t *testing.T) {
	a := newTestApp()
	a.handleConnectors([]string{"add", "myspace", "TOKEN=x"})
	if !strings.Contains(strings.ToLower(a.FlashText), "unknown") {
		t.Fatalf("expected unknown-connector flash, got %q", a.FlashText)
	}
}

// TestConnectorsAddRejectsQR — WhatsApp uses QR pairing (no secret
// fields); /connectors add shouldn't accept a positional arg and pretend
// to save it. The user must run the wizard flow instead.
func TestConnectorsAddRejectsQR(t *testing.T) {
	a := newTestApp()
	a.handleConnectors([]string{"add", "whatsapp"})
	if !strings.Contains(strings.ToLower(a.FlashText), "qr") {
		t.Fatalf("expected QR-rejection flash, got %q", a.FlashText)
	}
}

// TestConnectorsAddUsageWhenMissingID — /connectors add with no id prints
// the usage hint.
func TestConnectorsAddUsageWhenMissingID(t *testing.T) {
	a := newTestApp()
	a.handleConnectors([]string{"add"})
	if !strings.Contains(strings.ToLower(a.FlashText), "usage") {
		t.Fatalf("expected usage flash, got %q", a.FlashText)
	}
}
