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
pub const CONNECTORS_CATALOG_VERSION: u32 = 3;

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
///   * `"instance_token"` — the user names WHICH server they mean (a Matrix
///     homeserver, a Mattermost install) and supplies a credential for it.
///     The instance URL is a required field that is NOT a secret, which is
///     why `PairingFieldDef::secret` finally earns its existence.
///   * `"oauth_device"` — RFC 8628 device authorization grant: Feral shows a
///     code, the user types it on the provider's site, Feral polls. The only
///     flow a client that cannot hold a secret may use on providers like
///     Twitch, and the only one that needs no local HTTP server — so it works
///     on the headless gateway too.
///
/// Stays a plain string on the wire. A struct variant would have serialised
/// `pairing_method` as an object and broken every client that decodes it as a
/// string — the Go TUI does exactly that, and said so loudly. The device
/// flow's endpoints ride in a sibling field instead (`device_flow`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PairingMethod {
    BotToken,
    Oauth,
    Qr,
    InstanceToken,
    OauthDevice,
}

/// Where an `OauthDevice` connector's flow lives. Absent for every other
/// pairing method, and omitted from the JSON entirely when absent, so the
/// shape older clients already parse is unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
pub struct DeviceFlowDef {
    /// Where the flow starts; returns the user code and verification URL.
    pub device_url: String,
    /// Polled for the token, and later used to refresh it.
    pub token_url: String,
    /// Public by definition — shipping it in the catalog leaks nothing.
    /// Empty until an application is registered with the provider, which is
    /// why such a connector must stay `coming_soon`.
    pub client_id: String,
    pub scopes: Vec<String>,
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
    /// Device-flow endpoints, when `pairing_method` is `oauth_device`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_flow: Option<DeviceFlowDef>,
    /// Which `LiveConnector` implementation runs this connector in the
    /// sidecar. Separate from `pairing_method` because the two vary
    /// independently: Matrix and Mattermost share a pairing shape and share
    /// no wire protocol at all.
    pub transport: String,
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
            transport: "discord".into(),
            device_flow: None,
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
            transport: "slack".into(),
            device_flow: None,
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
            transport: "whatsapp".into(),
            device_flow: None,
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
            transport: "telegram".into(),
            device_flow: None,
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
        // ── The three witnesses (Phase 3) ────────────────────────────────
        // Each forces something the engine has never had to handle. They
        // stay `coming_soon` until their transports land, so a card never
        // promises a connection the sidecar cannot make.
        ConnectorCatalogEntry {
            id: "matrix".into(),
            transport: "matrix".into(),
            device_flow: None,
            name: "Matrix".into(),
            description: "Talk to your assistant from any Matrix homeserver — yours, or one you already have an account on.".into(),
            icon: "🌐".into(),
            logo_url: Some("https://cdn.simpleicons.org/matrix".into()),
            pairing_fields: vec![
                // The reason Matrix is here: a homeserver URL is REQUIRED and
                // is not a credential. It belongs in the config file, not the
                // vault, and every field before this one was a secret.
                PairingFieldDef {
                    key: "MATRIX_HOMESERVER".into(),
                    label: "Homeserver URL (e.g. https://matrix.org)".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "MATRIX_ACCESS_TOKEN".into(),
                    label: "Access token".into(),
                    secret: true,
                },
            ],
            pairing_method: InstanceToken,
            coming_soon: true,
            console_url: Some("https://matrix.org/docs/guides/client-server-api".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "mattermost".into(),
            transport: "mattermost".into(),
            device_flow: None,
            name: "Mattermost".into(),
            description: "Connect a self-hosted Mattermost. Uses a personal access token, which does not expire.".into(),
            icon: "💬".into(),
            logo_url: Some("https://cdn.simpleicons.org/mattermost".into()),
            pairing_fields: vec![
                PairingFieldDef {
                    key: "MATTERMOST_URL".into(),
                    label: "Server URL (e.g. https://chat.example.com)".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "MATTERMOST_TOKEN".into(),
                    label: "Personal access token".into(),
                    secret: true,
                },
            ],
            // Same pairing shape as Matrix, entirely different wire protocol.
            // That is the pair that proves pairing and transport are two axes.
            pairing_method: InstanceToken,
            coming_soon: true,
            console_url: Some("https://developers.mattermost.com/integrate/reference/personal-access-token/".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "twitch".into(),
            transport: "twitch".into(),
            name: "Twitch".into(),
            description: "Let your assistant read and answer in your Twitch chat. You approve it with a code on twitch.tv — no password, no token to copy.".into(),
            icon: "🟣".into(),
            logo_url: Some("https://cdn.simpleicons.org/twitch".into()),
            // Nothing to paste: the device flow produces the credential.
            pairing_fields: Vec::new(),
            // Twitch public clients may use ONLY the device grant — no
            // loopback authorization code, no client secret. Their refresh
            // tokens are single-use and lapse after 30 idle days, which is
            // why an account can legitimately end up revoked with nobody at
            // fault.
            pairing_method: OauthDevice,
            device_flow: Some(DeviceFlowDef {
                device_url: "https://id.twitch.tv/oauth2/device".into(),
                token_url: "https://id.twitch.tv/oauth2/token".into(),
                // Registered Twitch application (public client), 2026-08-19.
                // A client id is public by design: it identifies the app on
                // the consent screen and ships in every client. A public
                // client has no secret at all, which is the point — a desktop
                // app cannot keep one.
                client_id: "d6y2kpxx5lphmk55t1989ddc9p4cqn".into(),
                scopes: vec!["chat:read".into(), "chat:edit".into()],
            }),
            coming_soon: true,
            console_url: Some("https://dev.twitch.tv/console/apps".into()),
            free_tier_note: None,
            validate_endpoint: Some("https://id.twitch.tv/oauth2/validate".into()),
            oauth_scopes: vec!["chat:read".into(), "chat:edit".into()],
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
    let path = config_path();
    // Temp-file + rename: `std::fs::write` truncates before writing, so a
    // crash mid-write would lose the whole file. The rename is atomic on
    // both Windows and Unix, so a killed process leaves either the old file
    // intact or the new one fully written — never a half-written one.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("Couldn't save connector settings: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Couldn't save connector settings: {e}"))
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
    /// Whether the connector actually connected, from the sidecar's
    /// `connector-health.json`. `None` = no report yet (the supervisor has not
    /// reconciled since boot), which is NOT the same as "off" — `enabled` alone
    /// only ever said what the config asks for, and an invalid Discord token
    /// used to leave a dead bot showing as on everywhere.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
    /// Why it isn't live. Present only alongside `live: false`.
    #[serde(rename = "liveError", skip_serializing_if = "Option::is_none")]
    pub live_error: Option<String>,
}

/// One connector's entry in `connector-health.json`.
#[derive(serde::Deserialize)]
struct HealthEntry {
    live: bool,
    #[serde(default)]
    error: Option<String>,
}

/// Read what the sidecar last published about real connector state.
///
/// Callers must only trust this while the runtime is up: the file outlives the
/// process that wrote it, so a stale "live: true" would claim a bot that died
/// with its gateway.
fn read_health() -> std::collections::HashMap<String, HealthEntry> {
    let path = crate::paths::feral_dir().join("connector-health.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Default::default();
    };
    #[derive(serde::Deserialize)]
    struct File {
        #[serde(default)]
        connectors: std::collections::HashMap<String, HealthEntry>,
    }
    serde_json::from_str::<File>(&raw).map(|f| f.connectors).unwrap_or_default()
}

pub fn redact_for_frontend(cfg: &ConnectorConfig) -> ConnectorRedactedView {
    let mut filled: Vec<String> = cfg
        .secrets
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, _)| k.clone())
        .collect();
    filled.sort();
    let health = read_health();
    let entry = health.get(&cfg.id);
    ConnectorRedactedView {
        id: cfg.id.clone(),
        enabled: cfg.enabled,
        filled,
        allowlist: cfg.allowlist.clone(),
        channels: cfg.channels.clone(),
        mode: cfg.mode.clone().unwrap_or_else(|| "owner".into()),
        knowledge_base: cfg.knowledge_base.clone().unwrap_or_default(),
        live: entry.map(|e| e.live),
        live_error: entry.and_then(|e| e.error.clone()),
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
