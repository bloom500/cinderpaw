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

// TestConnectorsAddQRStartsPairing — WhatsApp uses QR pairing (no secret
// fields); /connectors add whatsapp must return an async pairing cmd (enable
// + reload + poll for the QR file) instead of a rejection flash. The old
// behavior pointed users at a wizard flow that no longer exists.
func TestConnectorsAddQRStartsPairing(t *testing.T) {
	a := newTestApp()
	cmd := a.handleConnectors([]string{"add", "whatsapp"})
	if cmd == nil {
		t.Fatalf("expected an async pairing cmd for whatsapp, got nil (flash %q)", a.FlashText)
	}
	if a.FlashText != "" {
		t.Fatalf("expected no rejection flash, got %q", a.FlashText)
	}
}

// TestConnectorsQRShowsStatus — /connectors qr always answers in the
// transcript: linked, a fresh code, or "turn it on first".
func TestConnectorsQRShowsStatus(t *testing.T) {
	a := newTestApp()
	before := len(a.Turns)
	a.handleConnectors([]string{"qr"})
	if len(a.Turns) <= before {
		t.Fatal("expected /connectors qr to append transcript lines")
	}
	body := a.Turns[len(a.Turns)-1].Text
	lower := strings.ToLower(body)
	if !strings.Contains(lower, "linked") && !strings.Contains(lower, "scan") && !strings.Contains(lower, "pairing code") {
		t.Fatalf("expected a QR status block, got %q", body)
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
