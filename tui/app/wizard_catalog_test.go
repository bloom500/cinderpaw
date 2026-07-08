package app

import (
	"testing"

	"feral-tui/api"
)

// Phase 1 (2026-07-07): tests for the wizard catalog cache behavior.
// These cover WizardState.ProviderCatalog() / ConnectorCatalog() helpers
// which read the fetched cache and fall back to bundled slices when empty.

// ── ProviderCatalog() ─────────────────────────────────────────

func TestProviderCatalogReturnsCachedWhenPopulated(t *testing.T) {
	var ws WizardState
	ws.providerCatalog = []api.ProviderCatalogEntry{
		{ID: "a", Name: "A"},
		{ID: "b", Name: "B"},
		{ID: "c", Name: "C"},
	}

	catalog := ws.ProviderCatalog()
	if len(catalog) != 3 {
		t.Fatalf("expected 3 cached entries, got %d", len(catalog))
	}
	if catalog[0].ID != "a" || catalog[1].ID != "b" || catalog[2].ID != "c" {
		t.Fatalf("cached entries do not match: %+v", catalog)
	}
}

func TestProviderCatalogFallsBackToBundledWhenEmpty(t *testing.T) {
	var ws WizardState
	// providerCatalog is nil — fallback path.

	catalog := ws.ProviderCatalog()
	if len(catalog) < len(CloudProviders) {
		t.Fatalf("fallback should have at least %d entries (CloudProviders), got %d",
			len(CloudProviders), len(catalog))
	}
	// Every bundled provider must appear in the fallback.
	ids := map[string]bool{}
	for _, e := range catalog {
		ids[e.ID] = true
	}
	for _, p := range CloudProviders {
		if !ids[p.ID] {
			t.Fatalf("bundled provider %q missing from fallback catalog", p.ID)
		}
	}
}

func TestProviderCatalogBundledShapeMatchesTypedContract(t *testing.T) {
	var ws WizardState
	catalog := ws.ProviderCatalog()
	for _, e := range catalog {
		if e.ID == "" {
			t.Fatalf("fallback entry has empty ID: %+v", e)
		}
		if e.Name == "" {
			t.Fatalf("fallback entry %q has empty Name", e.ID)
		}
		if e.Provider == "" {
			t.Fatalf("fallback entry %q has empty Provider", e.ID)
		}
		// AuthStyle must be one of the known values.
		if e.AuthStyle != "bearer" && e.AuthStyle != "x_api_key" {
			t.Fatalf("fallback entry %q has unknown auth_style %q", e.ID, e.AuthStyle)
		}
	}
}

// ── ConnectorCatalog() ────────────────────────────────────────

func TestConnectorCatalogFallsBackToBundledWhenEmpty(t *testing.T) {
	var ws WizardState
	// connectorCatalog is nil — fallback path.

	catalog := ws.ConnectorCatalog()
	if len(catalog) < 3 {
		t.Fatalf("fallback should have at least 3 entries (discord, slack, telegram), got %d", len(catalog))
	}
	// WhatsApp is qr with empty pairing_fields.
	for _, e := range catalog {
		if e.ID == "whatsapp" {
			if e.PairingMethod != "qr" {
				t.Fatalf("whatsapp pairing_method = %q, want qr", e.PairingMethod)
			}
			if len(e.PairingFields) != 0 {
				t.Fatalf("whatsapp pairing_fields should be empty, got %d", len(e.PairingFields))
			}
		}
		// Discord/Telegram: 1 field.
		if e.ID == "discord" || e.ID == "telegram" {
			if len(e.PairingFields) != 1 {
				t.Fatalf("%s pairing_fields = %d, want 1", e.ID, len(e.PairingFields))
			}
		}
		// Slack: 2 fields.
		if e.ID == "slack" {
			if len(e.PairingFields) != 2 {
				t.Fatalf("slack pairing_fields = %d, want 2", len(e.PairingFields))
			}
			if len(e.PairingFields) != 2 {
				t.Fatalf("slack pairing_fields = %d, want 2", len(e.PairingFields))
			}
		}
	}
}

// ── WizardCatalogsLoadedMsg handler ────────────────────────────

func TestWizardCatalogsLoadedHandlerPopulatesCache(t *testing.T) {
	a := newTestApp()
	a.startWizard()

	msg := WizardCatalogsLoadedMsg{
		Providers: []api.ProviderCatalogEntry{
			{ID: "test-provider", Name: "Test Provider"},
		},
		Connectors: []api.ConnectorCatalogEntry{
			{ID: "test-connector", Name: "Test Connector"},
		},
		Version: 1,
		Offline: false,
		Drift:   false,
	}

	updated, _ := a.Update(msg)
	a2 := updated.(*App)

	if len(a2.Wizard.providerCatalog) != 1 {
		t.Fatalf("expected 1 provider in cache, got %d", len(a2.Wizard.providerCatalog))
	}
	if a2.Wizard.providerCatalog[0].ID != "test-provider" {
		t.Fatalf("expected provider id=test-provider, got %q", a2.Wizard.providerCatalog[0].ID)
	}
	if len(a2.Wizard.connectorCatalog) != 1 {
		t.Fatalf("expected 1 connector in cache, got %d", len(a2.Wizard.connectorCatalog))
	}
	if a2.Wizard.catalogVersion != 1 {
		t.Fatalf("expected catalogVersion=1, got %d", a2.Wizard.catalogVersion)
	}
	if a2.Wizard.catalogOffline {
		t.Fatalf("expected catalogOffline=false")
	}
	if a2.Wizard.catalogDriftWarned {
		t.Fatalf("expected catalogDriftWarned=false for non-drift")
	}
}

func TestWizardCatalogsLoadedHandlerSetsOffline(t *testing.T) {
	a := newTestApp()
	a.startWizard()

	msg := WizardCatalogsLoadedMsg{
		Providers:  nil,
		Connectors: nil,
		Version:    0,
		Offline:    true,
		Drift:      false,
	}

	updated, _ := a.Update(msg)
	a2 := updated.(*App)

	if !a2.Wizard.catalogOffline {
		t.Fatalf("expected catalogOffline=true")
	}
	// Cache should be nil (no data), fallback is used at render time.
	if a2.Wizard.providerCatalog != nil {
		t.Fatalf("expected providerCatalog=nil on offline, got %+v", a2.Wizard.providerCatalog)
	}
}

func TestDriftFlagStickyWithoutRepeatedFlash(t *testing.T) {
	a := newTestApp()
	a.startWizard()

	// First drift message — should set the flag and trigger flash.
	msg1 := WizardCatalogsLoadedMsg{
		Providers: []api.ProviderCatalogEntry{{ID: "p1"}},
		Drift:     true,
		Version:   999,
	}
	updated, _ := a.Update(msg1)
	a2 := updated.(*App)

	if !a2.Wizard.catalogDriftWarned {
		t.Fatalf("expected catalogDriftWarned=true after first drift")
	}
	if a2.FlashText == "" {
		t.Fatalf("expected flash text to be set on first drift")
	}

	// Second drift message — flag should remain true, no new flash.
	flashBefore := a2.FlashText
	msg2 := WizardCatalogsLoadedMsg{
		Providers: []api.ProviderCatalogEntry{{ID: "p2"}},
		Drift:     true,
		Version:   999,
	}
	updated2, _ := a2.Update(msg2)
	a3 := updated2.(*App)

	if !a3.Wizard.catalogDriftWarned {
		t.Fatalf("expected catalogDriftWarned to remain true")
	}
	// Flash should still be the first message (no second flash).
	if a3.FlashText != flashBefore {
		t.Fatalf("flash text changed on second drift: was %q, now %q", flashBefore, a3.FlashText)
	}
}

func TestWizardResetClearsCatalogCache(t *testing.T) {
	var ws WizardState
	ws.providerCatalog = []api.ProviderCatalogEntry{{ID: "cached"}}
	ws.connectorCatalog = []api.ConnectorCatalogEntry{{ID: "cached"}}
	ws.catalogVersion = 42
	ws.catalogOffline = true
	ws.catalogDriftWarned = true

	ws.reset()

	if ws.providerCatalog != nil {
		t.Fatalf("expected providerCatalog=nil after reset, got %+v", ws.providerCatalog)
	}
	if ws.connectorCatalog != nil {
		t.Fatalf("expected connectorCatalog=nil after reset, got %+v", ws.connectorCatalog)
	}
	if ws.catalogVersion != 0 {
		t.Fatalf("expected catalogVersion=0 after reset, got %d", ws.catalogVersion)
	}
	if ws.catalogOffline {
		t.Fatalf("expected catalogOffline=false after reset")
	}
	if ws.catalogDriftWarned {
		t.Fatalf("expected catalogDriftWarned=false after reset")
	}
}
