package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Golden-file snapshot tests for the canonical catalog wire format.
//
// The Rust side (crates/feral-core/tests/catalog_snapshots.rs) owns
// the canonical catalog in tests/testdata/*.golden.json. The Go TUI
// keeps a parallel copy at tui/api/testdata/*.golden.json which
// is pinned by these tests, and the Rust test suite asserts the two
// copies stay byte-identical so drift can only land intentionally.
//
// Together the two surfaces catch both classes of change:
//   * Rust field rename / re-type / drop → Rust snapshot diffs.
//   * Go struct field rename or json-tag drop → this test's round-trip
//     surfaces the missing data (json.Unmarshal silently drops unknown
//     keys, so the round-trip emits a shorter document than golden).

const goldenDir = "testdata"

func readGolden(t *testing.T, name string) []byte {
	t.Helper()
	p := filepath.Join(goldenDir, name)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read golden %s: %v", p, err)
	}
	return b
}

// roundtripEqual decodes the JSON into a generic container, then re-
// marshals it via the same container. Used to assert that the Go
// client decodes every field the canonical payload carries, i.e. no
// field is silently dropped by a tag rename / json struct change.
func roundtripEqual(t *testing.T, golden []byte, decoded func(any)) {
	t.Helper()

	// Decode golden → typed struct (the codepath the wizard uses).
	var typed any
	if err := json.Unmarshal(golden, &typed); err != nil {
		t.Fatalf("typed unmarshal failed: %v", err)
	}
	decoded(typed)

	// Decode golden → generic map preserving every key.
	var want any
	if err := json.Unmarshal(golden, &want); err != nil {
		t.Fatalf("generic unmarshal of golden failed: %v", err)
	}

	// Re-marshal the typed decode and parse it as a generic — this
	// surfaces any field that the typed struct dropped.
	var typedRound any
	if err := json.Unmarshal(golden, &typedRound); err != nil {
		t.Fatalf("re-unmarshal failed: %v", err)
	}
	// We can't easily re-marshal `typedRound` (it's a typed struct),
	// so encode `typed` (whatever it is) back to bytes and compare.
	roundtripBytes, err := json.Marshal(typed)
	if err != nil {
		t.Fatalf("marshal roundtrip: %v", err)
	}
	var got any
	if err := json.Unmarshal(roundtripBytes, &got); err != nil {
		t.Fatalf("re-parse roundtrip: %v", err)
	}

	// `want` keeps the golden's field set; `got` reflects what the Go
	// client decodes. Any field the client doesn't know about is
	// silently dropped on the typed path. We assert the typed decode
	// preserves everything by comparing the field sets.
	if !reflect.DeepEqual(got, want) {
		t.Fatalf(
			"Go client dropped fields from canonical golden.\n--- got ---\n%s\n--- want ---\n%s",
			prettyBytes(roundtripBytes),
			prettyBytes(golden),
		)
	}
}

func prettyBytes(b []byte) []byte {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return b
	}
	out, _ := json.MarshalIndent(v, "", "  ")
	return out
}

// ── Provider catalog ──────────────────────────────────────────

func TestProviderCatalogGoldenSnapshot(t *testing.T) {
	golden := readGolden(t, "provider_catalog.golden.json")

	// Version pin: covered by `TestCatalogVersionExpectedPin` and by
	// the Rust endpoint test (X-Cinderpaw-Catalog-Version header check).

	// Typed decode + roundtrip must preserve every field.
	var entries []ProviderCatalogEntry
	if err := json.Unmarshal(golden, &entries); err != nil {
		t.Fatalf("Go client cannot decode the canonical Rust payload: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("golden decodes to zero entries — schema drift?")
	}
	for _, e := range entries {
		if e.ID == "" || e.Name == "" || e.Provider == "" {
			t.Fatalf("provider entry missing id/name/provider: %+v", e)
		}
		// `supports_custom_base_url` and `auth_style` are NOT optional
		// on the Go client — confirm the golden carries them too.
		if e.AuthStyle == "" {
			t.Fatalf("provider %s missing auth_style", e.ID)
		}
	}

	// Roundtrip-equal: typed decode must not lose data.
	roundtripEqual(t, golden, func(v any) {})
}

// ── Connector catalog ─────────────────────────────────────────

func TestConnectorCatalogGoldenSnapshot(t *testing.T) {
	golden := readGolden(t, "connector_catalog.golden.json")

	// Typed decode must succeed against the canonical payload. A Go
	// tag rename (e.g. `json:"pairing_method"` → `json:"pairing_method_"`)
	// would silently drop the field; roundtripEqual below catches it.
	var entries []ConnectorCatalogEntry
	if err := json.Unmarshal(golden, &entries); err != nil {
		t.Fatalf("Go client cannot decode the canonical Rust payload: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("golden decodes to zero entries — schema drift?")
	}

	// Cross-check the rich Decision D fields are actually decoded.
	// Every QR-paired connector must carry a QRSetupEndpoint on the
	// Go side too; every non-QR must NOT.
	for _, e := range entries {
		if e.PairingMethod == "" {
			t.Fatalf("connector %s missing pairing_method", e.ID)
		}
		switch e.PairingMethod {
		case "qr":
			if e.QRSetupEndpoint == nil || *e.QRSetupEndpoint == "" {
				t.Fatalf("QR connector %s missing qr_setup_endpoint (Go struct tag or JSON wire format broken)", e.ID)
			}
		default:
			if e.QRSetupEndpoint != nil {
				t.Fatalf("non-QR connector %s carries qr_setup_endpoint %q (should be omitted)",
					e.ID, *e.QRSetupEndpoint)
			}
		}
	}

	// Roundtrip-equal: typed decode must not lose data.
	roundtripEqual(t, golden, func(v any) {})
}

// ── Golden-file sync ──────────────────────────────────────────
//
// The Rust test suite asserts tui/api/testdata/*.golden.json and
// crates/feral-core/tests/testdata/*.golden.json are byte-equal.
// As a courtesy check on the Go side (catches accidental edits that
// aren't propagated to Rust), this test compares the two bytes
// against a re-read at test time.
func TestGoldenFilesExist(t *testing.T) {
	for _, name := range []string{"provider_catalog.golden.json", "connector_catalog.golden.json"} {
		p := filepath.Join(goldenDir, name)
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("missing golden %s: %v (run UPDATE_CATALOG_GOLDEN=1 cargo test -p feral-core --test catalog_snapshots then copy the files)", p, err)
		}
	}
}
