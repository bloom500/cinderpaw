package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Phase 1 (2026-07-07): tests for FetchProviderCatalog / FetchConnectorCatalog.
// These are the two GET-with-version-header catalog endpoints that deliver
// the canonical provider + connector metadata to the TUI wizard.

// ── Provider catalog ──────────────────────────────────────────

func TestFetchProviderCatalog_200(t *testing.T) {
	payload := `[{"id":"anthropic","name":"Anthropic","provider":"anthropic","default_base_url":"https://api.anthropic.com/v1","default_model":"claude-sonnet-4-20250514","supports_custom_base_url":false,"auth_style":"x_api_key"}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/runtime/providers/catalog" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("X-Feral-Catalog-Version", "1")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, payload)
	}))
	defer srv.Close()

	res, err := FetchProviderCatalog(srv.URL, "test-token")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK=true, error=%q", res.Error)
	}
	if !res.VersionMatchesExpected {
		t.Fatalf("expected version match, got version=%d expected=%d", res.Version, ProviderCatalogVersionExpected)
	}

	var entries []ProviderCatalogEntry
	if err := json.Unmarshal(res.Body, &entries); err != nil {
		t.Fatalf("body unmarshal failed: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].ID != "anthropic" {
		t.Fatalf("expected id=anthropic, got %q", entries[0].ID)
	}
	if entries[0].AuthStyle != "x_api_key" {
		t.Fatalf("expected auth_style=x_api_key, got %q", entries[0].AuthStyle)
	}
}

func TestFetchProviderCatalog_VersionMismatch(t *testing.T) {
	payload := `[{"id":"openai","name":"OpenAI","provider":"openai","default_base_url":"","default_model":"gpt-4o","supports_custom_base_url":false,"auth_style":"bearer"}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Feral-Catalog-Version", "999")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, payload)
	}))
	defer srv.Close()

	res, err := FetchProviderCatalog(srv.URL, "tok")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK=true for version mismatch (drift, not error)")
	}
	if res.VersionMatchesExpected {
		t.Fatalf("expected drift detection, got match=true")
	}
	if res.Version != 999 {
		t.Fatalf("expected version=999, got %d", res.Version)
	}
}

func TestFetchProviderCatalog_5xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "internal: gateway overloaded")
	}))
	defer srv.Close()

	res, err := FetchProviderCatalog(srv.URL, "tok")
	if err != nil {
		t.Fatalf("5xx must surface as res, not err: %v", err)
	}
	if res.OK {
		t.Fatalf("expected OK=false for 5xx")
	}
	if !strings.HasPrefix(res.Error, "http_") {
		t.Fatalf("expected error prefixed with http_, got %q", res.Error)
	}
	if !strings.Contains(res.HTTPBodyHint, "gateway overloaded") {
		t.Fatalf("expected body hint in HTTPBodyHint, got %q", res.HTTPBodyHint)
	}
}

// ── Connector catalog ─────────────────────────────────────────

func TestFetchConnectorCatalog_200(t *testing.T) {
	payload := `[
		{"id":"discord","name":"Discord","description":"","icon":"","pairing_fields":[{"key":"DISCORD_TOKEN","label":"Discord bot token","secret":true}],"pairing_method":"bot_token","coming_soon":false,"qr_setup_endpoint":null},
		{"id":"slack","name":"Slack","description":"","icon":"","pairing_fields":[{"key":"SLACK_APP_TOKEN","label":"App-level token","secret":true},{"key":"SLACK_BOT_TOKEN","label":"Bot token","secret":true}],"pairing_method":"bot_token","coming_soon":false,"qr_setup_endpoint":null},
		{"id":"whatsapp","name":"WhatsApp","description":"","icon":"","pairing_fields":[],"pairing_method":"qr","coming_soon":false,"qr_setup_endpoint":"/runtime/connectors/whatsapp/pair/start"},
		{"id":"telegram","name":"Telegram","description":"","icon":"","pairing_fields":[{"key":"TELEGRAM_BOT_TOKEN","label":"Telegram bot token","secret":true}],"pairing_method":"bot_token","coming_soon":false,"qr_setup_endpoint":null}
	]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Header version must match ConnectorCatalogVersionExpected (today: 3)
		// — the same constant the wizard bundle-side path asserts.
		w.Header().Set("X-Feral-Catalog-Version", "3")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, payload)
	}))
	defer srv.Close()

	res, err := FetchConnectorCatalog(srv.URL, "test-token")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK=true, error=%q", res.Error)
	}
	if !res.VersionMatchesExpected {
		t.Fatalf("expected version match, got version=%d expected=%d", res.Version, ConnectorCatalogVersionExpected)
	}

	var entries []ConnectorCatalogEntry
	if err := json.Unmarshal(res.Body, &entries); err != nil {
		t.Fatalf("body unmarshal failed: %v", err)
	}
	if len(entries) != 4 {
		t.Fatalf("expected 4 entries, got %d", len(entries))
	}

	// WhatsApp: pairing_method=qr, no pairing_fields.
	for _, e := range entries {
		if e.ID == "whatsapp" {
			if e.PairingMethod != "qr" {
				t.Fatalf("whatsapp pairing_method = %q, want qr", e.PairingMethod)
			}
			if len(e.PairingFields) != 0 {
				t.Fatalf("whatsapp pairing_fields should be empty, got %d", len(e.PairingFields))
			}
		}
		// Discord/Telegram: bot_token, 1 field.
		if e.ID == "discord" || e.ID == "telegram" {
			if e.PairingMethod != "bot_token" {
				t.Fatalf("%s pairing_method = %q, want bot_token", e.ID, e.PairingMethod)
			}
			if len(e.PairingFields) != 1 {
				t.Fatalf("%s pairing_fields = %d, want 1", e.ID, len(e.PairingFields))
			}
		}
		// Slack: bot_token, 2 fields.
		if e.ID == "slack" {
			if len(e.PairingFields) != 2 {
				t.Fatalf("slack pairing_fields = %d, want 2", len(e.PairingFields))
			}
		}
	}
}

func TestFetchConnectorCatalog_Offline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Close() // immediately close — connection refused

	_, err := FetchConnectorCatalog(srv.URL, "tok")
	if err == nil {
		t.Fatalf("expected transport error for closed server")
	}
	if !strings.Contains(err.Error(), "connection refused") && !strings.Contains(err.Error(), "connect") {
		t.Fatalf("expected connection refused error, got: %v", err)
	}
}

// ── Version pin ───────────────────────────────────────────────

func TestCatalogVersionExpectedPin(t *testing.T) {
	// Pinned 2026-07-07: the two catalogs track independent schema
	// versions, so the test enforces BOTH constants. Bump in lockstep
	// with the Rust side and refresh the goldens via
	// `UPDATE_CATALOG_GOLDEN=1 cargo test` then `cp` to the Go side.
	if ProviderCatalogVersionExpected != 1 {
		t.Fatalf("ProviderCatalogVersionExpected = %d, want 1 (bump in lockstep with byok::CATALOG_VERSION)", ProviderCatalogVersionExpected)
	}
	if ConnectorCatalogVersionExpected != 3 {
		t.Fatalf("ConnectorCatalogVersionExpected = %d, want 3 (bump in lockstep with connectors::CONNECTORS_CATALOG_VERSION)", ConnectorCatalogVersionExpected)
	}
}
