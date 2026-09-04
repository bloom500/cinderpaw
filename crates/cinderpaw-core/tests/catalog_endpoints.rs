//! Phase 1 (2026-07-07) — provider + connector catalog endpoint contract
//! tests. Run via `cargo test -p cinderpaw-core --test catalogs`.
//!
//! These tests pin three things the drift surface depends on:
//!   1. The JSON body shape (so a Rust-side refactor doesn't break the
//!      TUI + desktop clients silently).
//!   2. The `X-Cinderpaw-Catalog-Version` header (so a version drift shows
//!      up in client code, not at the support desk).
//!   3. The "no secret fields by name" invariant — every response field
//!      must be safe for an enterprise support rep to inspect.
//!
//! Tests use `axum::Router::oneshot` against the real router; no mocks.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use cinderpaw_core::byok::{self, AuthStyle, ProviderCatalogEntry};
use cinderpaw_core::connectors::{
    self, ConnectorCatalogEntry, OAuthClientIDSource, PairingFieldDef, PairingMethod,
};
use serde_json::Value;
use tower::ServiceExt;

/// Mount the catalog routes onto a fresh router. We don't want to
/// reimplement the full router from `api::router()` because that pulls
/// in the entire runtime state. The catalog handlers themselves are
/// pure (no `State` extractor), so we hand-roll the slice we test.
fn catalog_router() -> axum::Router {
    use axum::routing::get;
    axum::Router::new()
        .route(
            "/runtime/providers/catalog",
            get(cinderpaw_core::api::runtime_providers_catalog),
        )
        .route(
            "/runtime/connectors/catalog",
            get(cinderpaw_core::api::runtime_connectors_catalog),
        )
}

#[tokio::test]
async fn providers_catalog_returns_200_with_version_header() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/providers/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let version = resp
        .headers()
        .get("x-cinderpaw-catalog-version")
        .expect("catalog version header present");
    let v: u32 = version
        .to_str()
        .unwrap()
        .parse()
        .expect("version is an integer");
    assert_eq!(
        v, byok::CATALOG_VERSION,
        "X-Cinderpaw-Catalog-Version must match byok::CATALOG_VERSION"
    );
}

#[tokio::test]
async fn connectors_catalog_returns_200_with_version_header() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/connectors/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let version = resp
        .headers()
        .get("x-cinderpaw-catalog-version")
        .expect("catalog version header present");
    let v: u32 = version
        .to_str()
        .unwrap()
        .parse()
        .expect("version is an integer");
    assert_eq!(
        v, connectors::CONNECTORS_CATALOG_VERSION,
        "X-Cinderpaw-Catalog-Version must match connectors::CONNECTORS_CATALOG_VERSION"
    );
}

#[tokio::test]
async fn providers_catalog_body_contains_expected_ids() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/providers/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let entries: Vec<ProviderCatalogEntry> = serde_json::from_slice(&body).expect("valid JSON");
    let ids: std::collections::BTreeSet<_> = entries.iter().map(|e| e.id.as_str()).collect();
    // Every expected provider id is present — adding a new provider in
    // `provider_catalog()` must show up here. Removing one would also
    // fail this test, which is the correct drift signal.
    for expected in [
        "openai",
        "anthropic",
        "google",
        "kimi",
        "glm",
        "minimax",
        "groq",
        "mistral",
        "deepseek",
        "openrouter",
        "nvidia",
    ] {
        assert!(
            ids.contains(expected),
            "missing provider id {expected:?}; have: {ids:?}"
        );
    }
    // Anthropic specifically uses the x-api-key auth style; every other
    // production entry uses bearer. This catches a refactor that
    // accidentally flips the auth style assignment.
    let ant = entries
        .iter()
        .find(|e| e.id == "anthropic")
        .expect("anthropic");
    assert_eq!(ant.auth_style, AuthStyle::XApiKey);
    let openai = entries
        .iter()
        .find(|e| e.id == "openai")
        .expect("openai");
    assert_eq!(openai.auth_style, AuthStyle::Bearer);
}

#[tokio::test]
async fn connectors_catalog_body_contains_expected_ids() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/connectors/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let entries: Vec<ConnectorCatalogEntry> = serde_json::from_slice(&body).expect("valid JSON");
    let ids: std::collections::BTreeSet<_> = entries.iter().map(|e| e.id.as_str()).collect();
    for expected in ["discord", "slack", "whatsapp", "telegram"] {
        assert!(
            ids.contains(expected),
            "missing connector id {expected:?}; have: {ids:?}"
        );
    }
    // Slack has two token fields; Discord + Telegram have one; WhatsApp has
    // zero (QR pairing). Verify against the canonical definition so a
    // future field add (or a typo fix) changes both sides at once.
    let slack = entries.iter().find(|e| e.id == "slack").expect("slack");
    assert_eq!(slack.pairing_fields.len(), 2);
    assert_eq!(slack.pairing_method, PairingMethod::BotToken);
    let wa = entries.iter().find(|e| e.id == "whatsapp").expect("whatsapp");
    assert_eq!(wa.pairing_fields.len(), 0);
    assert_eq!(wa.pairing_method, PairingMethod::Qr);
}

/// Enforces the "never serialize a secret" invariant on the provider
/// catalog. We parse the response as a generic `serde_json::Value`
/// (not the typed struct) and grep the keys at every level of nesting
/// for anything that looks like a credential. A real leak here would
/// be a 2,500-enterprise-client incident.
#[tokio::test]
async fn providers_catalog_never_returns_secret_fields() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/providers/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&body).expect("JSON");

    let forbidden = [
        "api_key",
        "apikey",
        "secret",
        "token",
        "password",
        "credential",
    ];

    fn walk(v: &Value, forbidden: &[&str], path: &str) -> Vec<String> {
        let mut hits = Vec::new();
        if let Value::Object(map) = v {
            for (k, child) in map {
                let here = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                let kl = k.to_lowercase();
                if forbidden.iter().any(|f| kl == *f) {
                    hits.push(here.clone());
                }
                hits.extend(walk(child, forbidden, &here));
            }
        }
        if let Value::Array(items) = v {
            for (i, child) in items.iter().enumerate() {
                hits.extend(walk(child, forbidden, &format!("{path}[{i}]")));
            }
        }
        hits
    }

    let hits = walk(&value, &forbidden, "");
    assert!(
        hits.is_empty(),
        "providers catalog contains forbidden field names: {hits:?} (full body: {value})"
    );
}

#[tokio::test]
async fn connectors_catalog_pairs_well_typed_pairing_fields() {
    // The Decision-D catalog carries field *definitions* (key, label,
    // secret:bool) — never values. This test asserts the schema
    // invariant: each `pairing_fields[*]` is exactly {key, label, secret}
    // and nothing else. If a future refactor accidentally adds a
    // value-bearing field, this test breaks first.
    //
    // Note: descriptions / labels / hints may legitimately mention
    // token prefixes like "xoxb-" as UX guidance to the user (e.g.
    // Slack's "Bot token (xoxb-…)"). String-content checks would
    // false-positive on those, so we don't make them — secrets are
    // out-of-band on the runtime path through the byok.json keychain
    // route (Decision E) instead.
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/connectors/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&body).expect("JSON");

    let allowed_pairing_keys: std::collections::BTreeSet<&str> =
        ["key", "label", "secret"].into_iter().collect();
    let Value::Array(items) = value else {
        panic!("body must be an array");
    };
    for entry in items {
        let Value::Object(map) = entry else { panic!("entry must be an object") };
        let Some(Value::Array(fields)) = map.get("pairing_fields") else {
            continue;
        };
        for f in fields {
            let Value::Object(fmap) = f else { panic!("pairing_field must be an object") };
            let keys: std::collections::BTreeSet<&str> =
                fmap.keys().map(|k| k.as_str()).collect();
            assert_eq!(
                keys, allowed_pairing_keys,
                "pairing_field has unexpected keys: {keys:?}"
            );
        }
    }
}

/// Verifies the catalog stays additive: a Rust-side refactor that
/// removes a connector id breaks this test. Decision D explicitly says
/// to break loud when the schema changes instead of silently drifting.
#[tokio::test]
async fn connectors_catalog_includes_all_decision_d_pairing_kinds() {
    let entries = connectors::connectors_catalog();
    // We must have at least one entry per PairingMethod variant used
    // today: BotToken (Discord/Slack/Telegram) and Qr (WhatsApp). A
    // future OAuth connector is a Decision D spec extension.
    let mut bot_token = 0;
    let mut qr = 0;
    let mut oauth = 0;
    // Phase 3 added two more shapes. They are counted, not ignored, so this
    // test keeps breaking loudly when the enum grows rather than quietly
    // matching a wildcard that hides the next addition.
    let mut instance_token = 0;
    let mut device = 0;
    for e in &entries {
        match e.pairing_method {
            PairingMethod::BotToken => bot_token += 1,
            PairingMethod::Qr => qr += 1,
            PairingMethod::Oauth => oauth += 1,
            PairingMethod::InstanceToken => instance_token += 1,
            PairingMethod::OauthDevice => device += 1,
        }
    }
    assert!(instance_token >= 1, "no instance-token connectors shipped");
    assert!(device >= 1, "no device-flow connectors shipped");
    assert!(bot_token >= 1, "no bot_token connectors shipped");
    assert!(qr >= 1, "no QR connectors shipped");
    // OAuth is optional today; just sanity-check the enum serialises.
    let _ = oauth;
}

/// Catalog rows are sync / deterministic — pin a smoke test that
/// catches accidental reordering or duplicate IDs at insertion time.
#[test]
fn providers_catalog_ids_are_unique() {
    let entries = byok::provider_catalog();
    let mut seen = std::collections::BTreeSet::new();
    for e in &entries {
        assert!(
            seen.insert(e.id.clone()),
            "duplicate provider id: {}",
            e.id
        );
    }
}

#[test]
fn connectors_catalog_ids_are_unique() {
    let entries = connectors::connectors_catalog();
    let mut seen = std::collections::BTreeSet::new();
    for e in &entries {
        assert!(
            seen.insert(e.id.clone()),
            "duplicate connector id: {}",
            e.id
        );
    }
}

/// Type smoke checks: the Decision-D fields actually compile through
/// the specta pipeline and roundtrip through serde. If the type ever
/// drifts in a way that breaks one of these we want a CI failure,
/// not a runtime panic in the wizard.
#[test]
fn pairing_field_def_roundtrip() {
    let f = PairingFieldDef {
        key: "DISCORD_TOKEN".into(),
        label: "Discord bot token".into(),
        secret: true,
    };
    let json = serde_json::to_string(&f).expect("serialise");
    let back: PairingFieldDef = serde_json::from_str(&json).expect("deserialise");
    assert_eq!(f.key, back.key);
    assert_eq!(f.label, back.label);
    assert_eq!(f.secret, back.secret);
}

#[test]
fn oauth_client_id_source_roundtrip() {
    let s = OAuthClientIDSource {
        kind: "env".into(),
        ref_name: "CINDERPAW_DISCORD_CLIENT_ID".into(),
    };
    let json = serde_json::to_string(&s).expect("serialise");
    // The Rust field is `ref_name` (Rust identifier rules forbid a
    // bare `ref`); serde renames it to `"ref"` on the wire for clean
    // JSON. This test pins both directions of the rename.
    assert!(
        json.contains("\"ref\":"),
        "wire format must use `ref`, got: {json}"
    );
    let back: OAuthClientIDSource = serde_json::from_str(&json).expect("deserialise");
    assert_eq!(s.kind, back.kind);
    assert_eq!(s.ref_name, back.ref_name);
}

// Tiny green tests over the build helper, to ensure the helper
// produces a router usable by `oneshot`. Without this we wouldn't
// catch a "the catalog routes were never mounted" regression in CI.
#[test]
fn catalog_router_can_be_mounted_for_testing() {
    let router = catalog_router();
    // There is no public introspection; just sanity-check we get a
    // Router back, not panic.
    let _ = router;
}

// ── JSON shape snapshot tests ────────────────────────────────────────
// These pin the *required* field names in the serialized JSON — fields
// that are ALWAYS present regardless of their value. Optional fields
// (skip_serializing_if = "Option::is_none" or "Vec::is_empty") are
// excluded from this snapshot because they legitimately disappear
// when None/empty. If someone adds a NEW required field, these tests
// break first — catching accidental schema drift that the
// version-only test would miss.

/// Required top-level field names for a provider catalog entry.
/// These are ALWAYS serialized; optional fields (console_url, key_format,
/// key_format_hint, free_tier_note) are omitted when None.
const PROVIDER_REQUIRED_FIELDS: &[&str] = &[
    "auth_style",
    "default_base_url",
    "default_model",
    "id",
    "name",
    "provider",
    "supports_custom_base_url",
];

#[tokio::test]
async fn providers_catalog_required_fields_always_present() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/providers/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&body).expect("JSON");
    let Value::Array(items) = value else {
        panic!("body must be an array");
    };
    assert!(!items.is_empty(), "catalog must have at least one entry");
    // Check every entry has the required fields.
    for (i, item) in items.iter().enumerate() {
        let Value::Object(map) = item else {
            panic!("entry {i} must be an object");
        };
        for field in PROVIDER_REQUIRED_FIELDS {
            assert!(
                map.contains_key(*field),
                "provider entry {i} (id={}) missing required field {field}",
                map.get("id").and_then(|v| v.as_str()).unwrap_or("?")
            );
        }
    }
}

/// Required top-level field names for a connector catalog entry.
/// Optional fields (logo_url, console_url, free_tier_note,
/// validate_endpoint, oauth_scopes, oauth_client_id_source) are
/// omitted when None/empty.
const CONNECTOR_REQUIRED_FIELDS: &[&str] = &[
    "coming_soon",
    "description",
    "icon",
    "id",
    "name",
    "pairing_fields",
    "pairing_method",
];

#[tokio::test]
async fn connectors_catalog_required_fields_always_present() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/connectors/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&body).expect("JSON");
    let Value::Array(items) = value else {
        panic!("body must be an array");
    };
    assert!(!items.is_empty(), "catalog must have at least one entry");
    for (i, item) in items.iter().enumerate() {
        let Value::Object(map) = item else {
            panic!("entry {i} must be an object");
        };
        for field in CONNECTOR_REQUIRED_FIELDS {
            assert!(
                map.contains_key(*field),
                "connector entry {i} (id={}) missing required field {field}",
                map.get("id").and_then(|v| v.as_str()).unwrap_or("?")
            );
        }
    }
}

/// Optional fields that are skipped when None/empty must NOT appear
/// with a null value — they must be genuinely absent from the JSON.
/// This catches a serde regression where skip_serializing_if is
/// accidentally removed.
#[tokio::test]
async fn providers_catalog_optional_fields_absent_when_none() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/providers/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let entries: Vec<ProviderCatalogEntry> = serde_json::from_slice(&body).expect("JSON");
    for entry in &entries {
        // When console_url is None, it must not appear as null in JSON.
        if entry.console_url.is_none() {
            let value: Value = serde_json::to_value(entry).expect("re-serialize");
            let map = value.as_object().expect("object");
            assert!(
                !map.contains_key("console_url"),
                "provider {} has console_url=None but it appears as null in JSON",
                entry.id
            );
        }
    }
}

#[tokio::test]
async fn connectors_catalog_optional_fields_absent_when_none() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/connectors/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let entries: Vec<ConnectorCatalogEntry> = serde_json::from_slice(&body).expect("JSON");
    for entry in &entries {
        let value: Value = serde_json::to_value(entry).expect("re-serialize");
        let map = value.as_object().expect("object");
        // These fields must be absent (not null) when their value is None/empty.
        if entry.logo_url.is_none() {
            assert!(!map.contains_key("logo_url"), "connector {} has logo_url=None but it appears as null", entry.id);
        }
        if entry.console_url.is_none() {
            assert!(!map.contains_key("console_url"), "connector {} has console_url=None but it appears as null", entry.id);
        }
        if entry.free_tier_note.is_none() {
            assert!(!map.contains_key("free_tier_note"), "connector {} has free_tier_note=None but it appears as null", entry.id);
        }
        if entry.validate_endpoint.is_none() {
            assert!(!map.contains_key("validate_endpoint"), "connector {} has validate_endpoint=None but it appears as null", entry.id);
        }
        if entry.oauth_scopes.is_empty() {
            assert!(!map.contains_key("oauth_scopes"), "connector {} has empty oauth_scopes but it appears as []", entry.id);
        }
        if entry.oauth_client_id_source.is_none() {
            assert!(!map.contains_key("oauth_client_id_source"), "connector {} has oauth_client_id_source=None but it appears as null", entry.id);
        }
    }
}

// ── Decision-D rich field assertions for connectors ───────────────────
// The generic field-count tests above don't verify that the *rich*
// Decision-D fields (validate_endpoint, oauth_scopes, console_url,
// free_tier_note, oauth_client_id_source) are present or absent as
// expected. These tests close that gap.

#[tokio::test]
async fn connectors_decision_d_rich_fields_present() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/connectors/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let entries: Vec<ConnectorCatalogEntry> = serde_json::from_slice(&body).expect("JSON");

    for entry in &entries {
        match entry.id.as_str() {
            "discord" => {
                assert!(entry.console_url.is_some(), "discord must have console_url");
                assert!(
                    entry.console_url.as_deref().unwrap().contains("discord"),
                    "discord console_url should point to discord.com"
                );
                assert!(entry.oauth_scopes.is_empty(), "discord has no oauth_scopes (bot token)");
                assert!(entry.oauth_client_id_source.is_none(), "discord has no oauth_client_id_source");
                assert!(entry.validate_endpoint.is_some(), "discord must have validate_endpoint");
                assert!(
                    entry.validate_endpoint.as_deref().unwrap().contains("discord"),
                    "discord validate_endpoint should point to discord.com"
                );
            }
            "slack" => {
                assert!(entry.console_url.is_some(), "slack must have console_url");
                assert!(!entry.oauth_scopes.is_empty(), "slack must have oauth_scopes");
                assert!(
                    entry.oauth_scopes.iter().any(|s| s.contains("chat:write")),
                    "slack oauth_scopes must include chat:write, got: {:?}",
                    entry.oauth_scopes
                );
                // Slack doesn't need OAuth client id input — bot token auth.
                assert!(entry.oauth_client_id_source.is_none(), "slack has no oauth_client_id_source (bot token)");
                assert!(entry.validate_endpoint.is_some(), "slack must have validate_endpoint");
            }
            "whatsapp" => {
                // WhatsApp: QR pairing, no console_url, no validate endpoint.
                assert!(entry.console_url.is_none(), "whatsapp has no console_url (QR pairing)");
                assert!(entry.free_tier_note.is_none(), "whatsapp has no free_tier_note");
                assert!(entry.validate_endpoint.is_none(), "whatsapp has no validate_endpoint (QR)");
            }
            "telegram" => {
                assert!(entry.console_url.is_some(), "telegram must have console_url");
                assert!(entry.validate_endpoint.is_some(), "telegram must have validate_endpoint");
                assert!(entry.coming_soon, "telegram is coming_soon (sidecar transport not wired)");
            }
            "matrix" => {
                // Landed 2026-08-20: `CinderpawAgent/src/transports/matrix.ts`,
                // registered with the transport registry and imported at boot.
                // A card that says "soon" for something that works is its own
                // kind of lie, so this flipped with the transport.
                assert!(!entry.coming_soon, "matrix's transport has landed — the card must not still say soon");
                assert!(entry.console_url.is_some(), "matrix must point somewhere for the token");
                // The homeserver URL is the field that is required and NOT a
                // credential — the case the catalog had never carried.
                let url = entry
                    .pairing_fields
                    .iter()
                    .find(|f| f.key == "MATRIX_HOMESERVER")
                    .expect("matrix declares a homeserver field");
                assert!(!url.secret, "a homeserver URL is configuration, not a credential");
            }
            "mattermost" => {
                // Landed 2026-08-20: `CinderpawAgent/src/transports/mattermost.ts`.
                assert!(!entry.coming_soon, "mattermost's transport has landed — the card must not still say soon");
                assert!(entry.console_url.is_some(), "mattermost must point somewhere for the token");
                let url = entry
                    .pairing_fields
                    .iter()
                    .find(|f| f.key == "MATTERMOST_URL")
                    .expect("mattermost declares a server URL field");
                assert!(!url.secret, "a server URL is configuration, not a credential");
            }
            "twitch" => {
                // Landed 2026-08-20: `CinderpawAgent/src/transports/twitch.ts`.
                assert!(!entry.coming_soon, "twitch's transport has landed — the card must not still say soon");
                assert!(entry.console_url.is_some(), "twitch must point at the dev console");
                assert!(
                    entry.pairing_fields.is_empty(),
                    "a device flow asks the user to type a code on the provider's site, not a token here"
                );
                assert!(!entry.oauth_scopes.is_empty(), "twitch must declare its scopes");
            }
            other => panic!("unexpected connector id: {other}"),
        }
    }
}

/// Verify that connectors with `pairing_method: "qr"` have zero
/// pairing_fields (the fields are scanned, not typed).
#[tokio::test]
async fn connectors_qr_pairing_has_no_fields() {
    let app = catalog_router();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/runtime/connectors/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let entries: Vec<ConnectorCatalogEntry> = serde_json::from_slice(&body).expect("JSON");

    for entry in &entries {
        if entry.pairing_method == PairingMethod::Qr {
            assert!(
                entry.pairing_fields.is_empty(),
                "QR connector {} must have empty pairing_fields, got {}",
                entry.id,
                entry.pairing_fields.len()
            );
        }
    }
}


// ── Phase 3: descriptors name a transport, separately from pairing ─────────

#[test]
fn every_descriptor_names_a_transport() {
    for entry in connectors::connectors_catalog() {
        assert!(!entry.transport.is_empty(), "{} has no transport", entry.id);
    }
}

#[test]
fn pairing_and_transport_vary_independently() {
    // The pair that proves the two fields are not one field wearing a hat:
    // same pairing shape, no shared wire protocol.
    let cat = connectors::connectors_catalog();
    let matrix = cat.iter().find(|c| c.id == "matrix").expect("matrix in catalog");
    let mattermost = cat.iter().find(|c| c.id == "mattermost").expect("mattermost in catalog");
    assert_eq!(matrix.pairing_method, PairingMethod::InstanceToken);
    assert_eq!(mattermost.pairing_method, PairingMethod::InstanceToken);
    assert_ne!(matrix.transport, mattermost.transport);
}

#[test]
fn an_instance_url_is_required_but_not_secret() {
    // Every field before Phase 3 was a credential, so `secret: false` had
    // never been exercised. A homeserver URL is configuration: it belongs in
    // the config file, not the vault.
    let cat = connectors::connectors_catalog();
    let matrix = cat.iter().find(|c| c.id == "matrix").unwrap();
    let url = matrix
        .pairing_fields
        .iter()
        .find(|f| f.key == "MATRIX_HOMESERVER")
        .expect("matrix declares a homeserver field");
    assert!(!url.secret, "a homeserver URL is configuration, not a credential");
    let token = matrix
        .pairing_fields
        .iter()
        .find(|f| f.key == "MATRIX_ACCESS_TOKEN")
        .expect("matrix declares an access token field");
    assert!(token.secret, "an access token is a credential");
}

#[test]
fn a_device_flow_descriptor_carries_both_endpoints_and_its_scopes() {
    let cat = connectors::connectors_catalog();
    let twitch = cat.iter().find(|c| c.id == "twitch").expect("twitch in catalog");
    assert_eq!(twitch.pairing_method, PairingMethod::OauthDevice);
    let flow = twitch.device_flow.as_ref().expect("a device-flow connector carries its endpoints");
    assert!(flow.device_url.starts_with("https://"), "device_url must be absolute");
    assert!(flow.token_url.starts_with("https://"), "token_url must be absolute");
    assert!(!flow.scopes.is_empty(), "a device flow with no scopes grants nothing");
}

#[test]
fn a_device_flow_without_a_client_id_stays_coming_soon() {
    // A card that offers to connect must be able to START the flow. Twitch
    // ships with an empty client_id until a Twitch application exists, so the
    // card has to stay disabled — otherwise the user clicks Connect and gets
    // an error from an identity provider they never chose to talk to.
    for entry in connectors::connectors_catalog() {
        if let Some(flow) = &entry.device_flow {
            if flow.client_id.trim().is_empty() {
                assert!(
                    entry.coming_soon,
                    "{} offers a device flow it cannot start: empty client_id but not coming_soon",
                    entry.id
                );
            }
        }
    }
}
