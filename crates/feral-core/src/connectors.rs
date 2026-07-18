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

// ---------------------------------------------------------------------------
// R6: persisted connector configuration (moved from src-tauri/src/connectors.rs
// so the headless gateway + CLI can read/write `~/.feral/connectors.json`
// without going through a Tauri command. The desktop app's own catalog/view
// types (src-tauri/src/connectors.rs) are unrelated to this file's richer
// Decision-D catalog above and keep their own shape for the existing UI —
// this section only owns the on-disk record and generic secret redaction.
// ---------------------------------------------------------------------------

use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorConfig {
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    /// Secret values keyed by catalog field key (e.g. DISCORD_TOKEN,
    /// SLACK_APP_TOKEN). Stays backend-side; never sent to the frontend.
    #[serde(default)]
    pub secrets: HashMap<String, String>,
    /// Allowed sender IDs (exact platform user IDs / phone numbers). Empty =
    /// nobody. Senders not on the list are ignored.
    #[serde(default)]
    pub allowlist: Vec<String>,
    /// Channel/chat IDs where the agent answers EVERY allowlisted message
    /// without needing an @mention — e.g. a dedicated #bot channel.
    #[serde(default)]
    pub channels: Vec<String>,
    /// Legacy single-token field (pre-multi-secret configs). Migrated into
    /// `secrets` on load, then dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// WhatsApp operating mode: "owner" (default) = allowlist + full agent;
    /// "public" = answer strangers (leads) via the restricted sales persona.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Inline knowledge-base text (products/prices/FAQ) the public persona
    /// answers from. Stored inline so non-technical users never touch a file.
    #[serde(
        default,
        rename = "knowledgeBase",
        skip_serializing_if = "Option::is_none"
    )]
    pub knowledge_base: Option<String>,
    /// Multi-agent routing: per-connector persona (full system prompt) —
    /// sessions from this connector run as a different agent than the
    /// desktop owner session. Consumed by the sidecar's ConnectorManager.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    /// Optional tool whitelist for the persona. Absent = full owner toolset.
    #[serde(default, rename = "personaTools", skip_serializing_if = "Option::is_none")]
    pub persona_tools: Option<Vec<String>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConnectorConfigFile {
    connectors: Vec<ConnectorConfig>,
}

fn config_path() -> std::path::PathBuf {
    crate::paths::feral_dir().join("connectors.json")
}

pub fn blank_connector_config(id: &str) -> ConnectorConfig {
    ConnectorConfig {
        id: id.to_string(),
        enabled: false,
        secrets: HashMap::new(),
        allowlist: Vec::new(),
        channels: Vec::new(),
        token: None,
        mode: None,
        knowledge_base: None,
        persona: None,
        persona_tools: None,
    }
}

/// Load every persisted connector config, migrating the legacy single-`token`
/// field into `secrets` under the connector's primary field key.
pub fn load_connector_configs() -> Vec<ConnectorConfig> {
    let mut cfg: ConnectorConfigFile = match std::fs::read_to_string(config_path()) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => ConnectorConfigFile::default(),
    };
    for c in &mut cfg.connectors {
        if let Some(tok) = c.token.take() {
            if !tok.trim().is_empty() {
                if let Some(primary) = connector_by_id(&c.id)
                    .and_then(|entry| entry.pairing_fields.first().map(|f| f.key.clone()))
                {
                    c.secrets.entry(primary).or_insert(tok);
                }
            }
        }
    }
    cfg.connectors
}

pub fn save_connector_configs(connectors: &[ConnectorConfig]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(&ConnectorConfigFile { connectors: connectors.to_vec() })
        .map_err(|e| e.to_string())?;
    std::fs::write(config_path(), raw).map_err(|e| format!("Couldn't save connector settings: {e}"))
}

pub fn load_connector_config(id: &str) -> Option<ConnectorConfig> {
    load_connector_configs().into_iter().find(|c| c.id == id)
}

/// Upsert one connector's config into the persisted file.
pub fn save_connector_config(cfg: &ConnectorConfig) -> Result<(), String> {
    let mut connectors = load_connector_configs();
    connectors.retain(|c| c.id != cfg.id);
    connectors.push(cfg.clone());
    save_connector_configs(&connectors)
}

/// Frontend-safe view of a persisted connector config — secret values never
/// cross this boundary, only which field keys are currently filled.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ConnectorRedactedView {
    pub id: String,
    pub enabled: bool,
    /// Field keys with a non-empty secret value. Never the values themselves.
    pub filled: Vec<String>,
    pub allowlist: Vec<String>,
    pub channels: Vec<String>,
    /// "owner" (default) or "public". WhatsApp only; harmless for others.
    pub mode: String,
    #[serde(rename = "knowledgeBase")]
    pub knowledge_base: String,
}

pub fn redact_for_frontend(cfg: &ConnectorConfig) -> ConnectorRedactedView {
    let mut filled: Vec<String> = cfg
        .secrets
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, _)| k.clone())
        .collect();
    filled.sort();
    ConnectorRedactedView {
        id: cfg.id.clone(),
        enabled: cfg.enabled,
        filled,
        allowlist: cfg.allowlist.clone(),
        channels: cfg.channels.clone(),
        mode: cfg.mode.clone().unwrap_or_else(|| "owner".into()),
        knowledge_base: cfg.knowledge_base.clone().unwrap_or_default(),
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    #[test]
    fn save_then_load_round_trips_and_redacts_secrets_on_read_view() {
        crate::rsi::test_support::with_temp_feral_home(|_dir| {
            let mut cfg = blank_connector_config("discord");
            cfg.enabled = true;
            cfg.secrets.insert("DISCORD_TOKEN".to_string(), "sekret".to_string());

            save_connector_config(&cfg).unwrap();
            let loaded = load_connector_config("discord").unwrap();
            assert_eq!(loaded.secrets.get("DISCORD_TOKEN"), Some(&"sekret".to_string()));

            let view = redact_for_frontend(&loaded);
            assert!(view.filled.contains(&"DISCORD_TOKEN".to_string()));
            assert!(!format!("{view:?}").contains("sekret"));
        });
    }
}
