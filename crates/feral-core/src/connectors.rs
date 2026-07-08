//! Canonical connector catalog (Phase 1, 2026-07-07).
//!
//! Mirrors `byok::provider_catalog()` for chat-platform connectors. The
//! headless gateway exposes this via `GET /runtime/connectors/catalog`,
//! and the Go TUI wizard + desktop React OnboardingWizard consume it
//! instead of maintaining their own parallel slices.
//!
//! Decision D (terminal-onboarding plan): connectors carry **richer**
//! metadata than providers because pairing differs qualitatively:
//! bot-token paste (Discord), multi-field OAuth (Slack), QR scan
//! (WhatsApp), bot-token paste (Telegram). Forcing them into the same
//! shape as providers loses expressivity on a 2-sprint horizon. The
//! extra fields below capture that.
//!
//! This module is the **read-only catalog** half of the Connector
//! Surface. The persistence half (loading/saving `~/.feral/connectors.json`,
//! the live reload handshake, the secret-value handling policy) remains
//! in `src-tauri/src/connectors.rs` and re-uses the catalog from here.

use serde::{Deserialize, Serialize};

/// Catalog version. Bumped when fields are added/removed/renamed in
/// `ConnectorCatalogEntry`. Currently `2`. Matches `byok::CATALOG_VERSION`
/// increment policy but each catalog tracks its own.
///
/// v2 (2026-07-07) — added `qr_setup_endpoint`. QR-paired connectors only;
/// returns the gateway endpoint the wizard POSTs to in order to obtain a
/// fresh QR payload to render on screen.
pub const CONNECTORS_CATALOG_VERSION: u32 = 2;

/// Pairing flow for a connector. Decision D settles three distinct flows:
///
///   * `"bot_token"` — user pastes a token (one or more `PairingFields`).
///   * `"oauth"` — user pastes one field (the OAuth access token) which
///     the gateway validates against the provider's
///     `validate_endpoint`. No browser redirect — pasted-token UX.
///   * `"qr"` — no secret fields. The gateway generates a QR payload
///     on demand (`GET /runtime/connectors/:id/pair/start` returns
///     `qr_payload`) which the user scans to complete pairing on their
///     phone.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PairingMethod {
    BotToken,
    Oauth,
    Qr,
}

/// Secret fields a connector requires when `PairingMethod::BotToken` or
/// `PairingMethod::Oauth`. Empty for `PairingMethod::Qr`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PairingFieldDef {
    /// Stable key — the JSON-key the secret gets stored under in
    /// `~/.feral/connectors.json` and the env-var name the sidecar
    /// reads. Examples: `"DISCORD_TOKEN"`, `"SLACK_APP_TOKEN"`.
    pub key: String,
    /// Human label for the input, e.g. `"Discord bot token"`.
    pub label: String,
    /// Whether this field is a secret. Always true for the connectors
    /// we ship today, but the field is retained for future
    /// non-secret-but-still-required fields (e.g. workspace URL).
    pub secret: bool,
}

/// A connector field that the sidecar reads from an external secret
/// store (env var or keychain entry) rather than the user entering
/// inline. Decision F (terminal-onboarding plan) prevents inline
/// plaintext in non-interactive YAML configurations — same constraint
/// applies to OAuth client ids.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OAuthClientIDSource {
    /// `"env"` or `"keychain"`.
    pub kind: String,
    /// Reference name — env var name (e.g. `"FERAL_DISCORD_CLIENT_ID"`)
    /// or keychain account (e.g. `"discord_client_id"`). Serialised to
    /// JSON as `"ref"` for human readability on the wire; the trailing
    /// underscore is the Rust convention for reserved-keyword field
    /// names.
    #[serde(rename = "ref")]
    pub ref_name: String,
}

/// One row of the public connector catalog.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ConnectorCatalogEntry {
    /// Stable id stored on disk in `connectors.json`.
    pub id: String,
    /// Display name shown in the picker card.
    pub name: String,
    /// Long-form description shown beneath the card name. Drives wizard
    /// UI; not functional.
    pub description: String,
    /// Emoji glyph used as the card icon. One per connector, fallback
    /// when no `logo_url` is reachable.
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    /// Secret fields the user must provide. Empty for QR-paired
    /// connectors.
    pub pairing_fields: Vec<PairingFieldDef>,
    pub pairing_method: PairingMethod,
    /// Whether the connector is wireable from this build. False when
    /// the sidecar doesn't yet have a live transport; renders disabled
    /// on the wizard card.
    pub coming_soon: bool,
    /// URL of the provider's API-key management page (e.g.
    /// `https://discord.com/developers/applications`). Powers the
    /// wizard's "open the console" affordance next to the token entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub console_url: Option<String>,
    /// Free-tier note, e.g. "Free tier: 100 messages/day." Drives
    /// wizard UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_tier_note: Option<String>,
    /// URL the gateway probes to validate an OAuth or bot token.
    /// `/runtime/connectors/:id/validate` POSTs to this URL with the
    /// supplied credentials. The response code maps to a typed
    /// `ConnTestStatus` (Phase 2): 200 → ok, 401 → invalid_token,
    /// 402 → no_credit, 4xx → permission_denied, network failure →
    /// network_error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validate_endpoint: Option<String>,
    /// OAuth scopes required for the connector. Displayed on the card
    /// so the user knows what they'll be granting before pasting a
    /// token. Empty for `bot_token` and `qr`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub oauth_scopes: Vec<String>,
    /// For OAuth connectors, where the OAuth client id comes from.
    /// `None` for `bot_token` and `qr` connectors (those don't need
    /// OAuth flow input).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_client_id_source: Option<OAuthClientIDSource>,
    /// For `qr` pairing only. The gateway endpoint the wizard calls
    /// (`POST /runtime/connectors/:id/pair/start`) to obtain a fresh QR
    /// payload to render on screen. The pairing refresh cycle (default 60s)
    /// re-hits the same endpoint until the user scans and `linked` flips
    /// to true. `None` for `bot_token` and `oauth` connectors (their
    /// pairing step is "user pastes a secret", no endpoint involvement).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_setup_endpoint: Option<String>,
}

/// Canonical, deduplicated connector catalog. Adding a connector =
/// one new entry here + rebuild gateway; TUI + desktop pick it up
/// automatically.
pub fn connectors_catalog() -> Vec<ConnectorCatalogEntry> {
    use PairingMethod::*;
    vec![
        ConnectorCatalogEntry {
            id: "discord".into(),
            name: "Discord".into(),
            description: "Chat with your assistant from Discord — DMs, @mentions, or a dedicated channel. Only people you allow can reach it.".into(),
            icon: "🎮".into(),
            logo_url: Some("https://cdn.simpleicons.org/discord".into()),
            pairing_fields: vec![PairingFieldDef {
                key: "DISCORD_TOKEN".into(),
                label: "Discord bot token".into(),
                secret: true,
            }],
            pairing_method: BotToken,
            coming_soon: false,
            console_url: Some("https://discord.com/developers/applications".into()),
            free_tier_note: None,
            validate_endpoint: Some("https://discord.com/api/users/@me".into()),
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "slack".into(),
            name: "Slack".into(),
            description: "Talk to your assistant from a Slack workspace via Socket Mode. Needs an app-level token and a bot token.".into(),
            icon: "💬".into(),
            logo_url: Some("https://a.slack-edge.com/80588/marketing/img/meta/slack_hash_128.png".into()),
            pairing_fields: vec![
                PairingFieldDef {
                    key: "SLACK_APP_TOKEN".into(),
                    label: "App-level token (xapp-…)".into(),
                    secret: true,
                },
                PairingFieldDef {
                    key: "SLACK_BOT_TOKEN".into(),
                    label: "Bot token (xoxb-…)".into(),
                    secret: true,
                },
            ],
            pairing_method: BotToken,
            coming_soon: false,
            console_url: Some("https://api.slack.com/apps".into()),
            free_tier_note: None,
            // Slack's `auth.test` endpoint accepts the user-level token;
            // we resolve against a known channel-scoped probe so a
            // token without `chat:write` doesn't show as "ok".
            validate_endpoint: Some("https://slack.com/api/auth.test".into()),
            oauth_scopes: vec![
                "app_mentions:read".into(),
                "chat:write".into(),
                "im:history".into(),
                "im:read".into(),
                "im:write".into(),
            ],
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "whatsapp".into(),
            name: "WhatsApp".into(),
            description: "Reach your assistant on WhatsApp. Turn it on, then scan the QR code with WhatsApp → Linked devices. Use a SECONDARY number — automation can get a number banned.".into(),
            icon: "💚".into(),
            logo_url: Some("https://cdn.simpleicons.org/whatsapp".into()),
            pairing_fields: Vec::new(),
            pairing_method: Qr,
            coming_soon: false,
            console_url: None,
            free_tier_note: None,
            // No validate endpoint — QR pairing is the validation step.
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            // Wizard hits this to obtain a fresh QR payload + refresh
            // window. Pairing completes when the user scans it with
            // WhatsApp → Linked devices.
            qr_setup_endpoint: Some("/runtime/connectors/whatsapp/pair/start".into()),
        },
        ConnectorCatalogEntry {
            id: "telegram".into(),
            name: "Telegram".into(),
            description: "Message your assistant from Telegram.".into(),
            icon: "✈️".into(),
            logo_url: Some("https://cdn.simpleicons.org/telegram".into()),
            pairing_fields: vec![PairingFieldDef {
                key: "TELEGRAM_BOT_TOKEN".into(),
                label: "Telegram bot token".into(),
                secret: true,
            }],
            pairing_method: BotToken,
            // Sidecar transport for Telegram isn't wired in this build —
            // the card renders as a "Coming soon" placeholder; the token
            // entry is disabled.
            coming_soon: true,
            console_url: Some("https://t.me/BotFather".into()),
            free_tier_note: None,
            // Telegram's `getMe` endpoint is the canonical probe.
            validate_endpoint: Some("https://api.telegram.org/bot{TOKEN}/getMe".into()),
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
    ]
}

// Allow callers (axum handlers, sidecar) to find one entry by id without
// pulling a hashing dependency. The catalog is short (<= 10 entries in
// production) so the linear scan is fine.
pub fn connector_by_id(id: &str) -> Option<ConnectorCatalogEntry> {
    connectors_catalog().into_iter().find(|c| c.id == id)
}
