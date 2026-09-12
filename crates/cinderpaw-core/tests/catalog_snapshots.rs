//! Snapshot tests for the canonical provider + connector catalog wire format.
//!
//! Pins the JSON shape that the headless gateway emits to clients (TUI
//! + desktop). The guarantees:
//!
//!   * **Rust-side**: any field add/remove/rename on
//!     [`ProviderCatalogEntry`](cinderpaw_core::byok::ProviderCatalogEntry) or
//!     [`ConnectorCatalogEntry`](cinderpaw_core::connectors::ConnectorCatalogEntry)
//!     is caught by diffing the serialised output against the golden
//!     file. Run `UPDATE_CATALOG_GOLDEN=1 cargo test` to refresh after
//!     an intentional bump.
//!   * **Go-side**: the same golden file is reused in
//!     `tui/api/catalog_snapshot_test.go`, which decodes it into the Go
//!     `ProviderCatalogEntry` / `ConnectorCatalogEntry` structs and
//!     asserts a round-trip preserves every field. A Rust field rename
//!     without updating the Go `json:"…"` tag (or vice versa) shows up
//!     as a missing field on the Go side.
//!
//! These complement the per-endpoint header/contract tests in
//! `catalog_endpoints.rs` (which check `X-Cinderpaw-Catalog-Version` and
//! HTTP status codes). Versioning pins declared schema changes;
//! this file pins the entire payload so *undeclared* changes (a
//! developer adding/renaming a field without bumping the version)
//! get rejected at CI time.
//!
//! The golden files live next to this test in `tests/testdata/*.json`
//! and are committed.

use cinderpaw_core::byok;
use cinderpaw_core::connectors;
use serde_json::Value;

/// Path to the golden fixture directory. `include_str!` below uses
/// the same path at compile time so updates have to be deliberate
/// (re-run tests with `UPDATE_CATALOG_GOLDEN=1`).
const GOLDEN_DIR: &str = "tests/testdata";

fn refresh_golden_if_requested(name: &str, json: &str) -> bool {
    if std::env::var("UPDATE_CATALOG_GOLDEN").is_ok() {
        let path = format!("{GOLDEN_DIR}/{name}");
        std::fs::write(&path, json).expect("write golden");
        eprintln!("updated golden: {path}");
        return true;
    }
    false
}

#[test]
fn provider_catalog_matches_golden_snapshot() {
    let entries = byok::provider_catalog();
    let actual = serde_json::to_string_pretty(&entries).expect("serialise");

    if refresh_golden_if_requested("provider_catalog.golden.json", &actual) {
        return;
    }

    let expected = include_str!("testdata/provider_catalog.golden.json");
    let actual_v: Value = serde_json::from_str(&actual).expect("actual parses");
    let expected_v: Value = serde_json::from_str(expected).expect("golden parses");

    assert_eq!(
        actual_v, expected_v,
        "Rust provider catalog drifted from canonical snapshot.\n\
         If the change is intentional (a field was added/removed/renamed), run:\n\
         \n  UPDATE_CATALOG_GOLDEN=1 cargo test -p cinderpaw-core --test catalog_snapshots\n\
         \nand commit the regenerated golden file. Then bump byok::CATALOG_VERSION\n\
         (and Go `CatalogVersionExpected` if you want drift detection to fire)"
    );
}

#[test]
fn connector_catalog_matches_golden_snapshot() {
    let entries = connectors::connectors_catalog();
    let actual = serde_json::to_string_pretty(&entries).expect("serialise");

    if refresh_golden_if_requested("connector_catalog.golden.json", &actual) {
        return;
    }

    let expected = include_str!("testdata/connector_catalog.golden.json");
    let actual_v: Value = serde_json::from_str(&actual).expect("actual parses");
    let expected_v: Value = serde_json::from_str(expected).expect("golden parses");

    assert_eq!(
        actual_v, expected_v,
        "Rust connector catalog drifted from canonical snapshot.\n\
         If the change is intentional, run:\n\
         \n  UPDATE_CATALOG_GOLDEN=1 cargo test -p cinderpaw-core --test catalog_snapshots\n\
         \nand commit the regenerated golden. Bump\n\
         connectors::CONNECTORS_CATALOG_VERSION (and Go CatalogVersionExpected)\n\
         to surface drift on clients running an older build."
    );
}

/// Every connector in the canonical catalog must carry at least the
/// field set the TUI client decodes (`id`, `name`, `description`,
/// `icon`, `logo_url`, `pairing_fields`, `pairing_method`,
/// `coming_soon`). Combined with the snapshot above, this catches
/// the case where someone removes a field that the wizard or the Go
/// client still reads.
#[test]
fn connector_catalog_required_fields_present() {
    for entry in connectors::connectors_catalog() {
        let json: Value = serde_json::to_value(&entry).expect("serialise");
        for required in [
            "id",
            "name",
            "description",
            "icon",
            "pairing_fields",
            "pairing_method",
            "coming_soon",
        ] {
            assert!(
                json.get(required).is_some(),
                "connector {} missing required field `{required}`",
                entry.id
            );
        }
        // No gateway QR setup route exists. Do not advertise one even for
        // WhatsApp, whose pairing code is delivered through the sidecar file.
        //
        // The OpenClaw import carried a softer rule: a `qr` connector that is
        // live MUST name an endpoint, `coming_soon` ones need not. That rule
        // cannot be satisfied honestly today, because WhatsApp is live and the
        // gateway still serves no such route, so the only way to pass it was to
        // invent a path. Restore it the day a real route ships, not before.
        assert!(
            entry.qr_setup_endpoint.is_none(),
            "connector {} advertises an unimplemented QR setup endpoint",
            entry.id
        );
        assert!(json.get("qr_setup_endpoint").is_none());
    }
}

/// Every provider in the canonical catalog must carry the field set
/// the TUI client decodes. Same rationale as the connector test
/// above.
#[test]
fn provider_catalog_required_fields_present() {
    for entry in byok::provider_catalog() {
        let json: Value = serde_json::to_value(&entry).expect("serialise");
        for required in [
            "id",
            "name",
            "provider",
            "default_base_url",
            "default_model",
            "supports_custom_base_url",
            "auth_style",
        ] {
            assert!(
                json.get(required).is_some(),
                "provider {} missing required field `{required}`",
                entry.id
            );
        }
    }
}

/// The Go TUI keeps a mirror copy of each golden file at
/// `tui/api/testdata/*.golden.json` so its `go test ./api/...` suite
/// can pin shape locally without a Rust build. This test asserts the
/// two copies stay byte-equal — if a developer refreshes the Rust
/// golden via `UPDATE_CATALOG_GOLDEN=1` without copying the file to
/// the Go side, the next CI run will fail here with the exact diff.
///
/// Synced via `scripts/sync-catalog-goldens.sh` (manual today; can
/// become a pre-commit hook).
#[test]
fn golden_files_in_sync_with_go_copy() {
    // Read from disk, NOT `include_str!`. The macro embeds the file at COMPILE
    // time, so on the very run that regenerates the golden
    // (`UPDATE_CATALOG_GOLDEN=1`) this compared the pre-regeneration Rust copy
    // against the untouched Go copy, found them equal, and reported the pair
    // in sync while they had just diverged. The guard fired one run late —
    // green for the developer who caused the drift, red for whoever ran next.
    let rust_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("testdata");

    // Relative path from `crates/cinderpaw-core/tests/` up to the repo root
    // and into `tui/api/testdata/`. `..` twice gets us to the workspace root.
    let go_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tui")
        .join("api")
        .join("testdata");

    for name in ["provider_catalog.golden.json", "connector_catalog.golden.json"] {
        let rust_path = rust_dir.join(name);
        let rust_payload = std::fs::read_to_string(&rust_path)
            .unwrap_or_else(|e| panic!("missing Rust golden at {rust_path:?}: {e}"));
        let go_path = go_dir.join(name);
        let go_payload = std::fs::read_to_string(&go_path).unwrap_or_else(|e| {
            panic!(
                "missing Go-side golden copy at {go_path:?}. \
                 Run `cp crates/cinderpaw-core/tests/testdata/{name} tui/api/testdata/{name}` \
                 to sync. Underlying error: {e}"
            )
        });
        assert_eq!(
            rust_payload.trim(),
            go_payload.trim(),
            "Go-side golden {name} drifted from Rust canonical. \
             Run `cp crates/cinderpaw-core/tests/testdata/{name} tui/api/testdata/{name}` \
             and re-run tests."
        );
    }
}
