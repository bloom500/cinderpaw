//! Canonical connector catalog (Phase 1, 2026-07-07).
//!
//! Mirrors `byok::provider_catalog()` for chat-platform connectors. The
//! headless gateway exposes this via `GET /runtime/connectors/catalog`,
//! and the Go TUI wizard + desktop React OnboardingWizard consume it
//! instead of maintaining their own parallel slices.
//!
//! Decision D (terminal-onboarding plan): connectors carry **richer**
//! metadata than providers because pairing differs qualitatively:
//! bot-token paste (Discord), two-token Socket Mode (Slack), QR scan
//! (WhatsApp), bot-token paste (Telegram). Forcing them into the same
//! shape as providers loses expressivity on a 2-sprint horizon. The
//! extra fields below capture that.
//!
//! This module is the **read-only catalog** half of the Connector
//! Surface. Shared persistence helpers also live here; the gateway and
//! `src-tauri/src/connectors.rs` provide their respective save/reload surfaces.

use serde::{Deserialize, Serialize};

/// Catalog version. Bumped when fields are added/removed/renamed in
/// `ConnectorCatalogEntry`. Currently `3`. Matches `byok::CATALOG_VERSION`
/// increment policy but each catalog tracks its own.
///
/// v2 (2026-07-07) - added the optional `qr_setup_endpoint` field. No
/// gateway QR setup route is implemented; shipped entries leave it unset.
/// v3 - added transport, instance-token and device-flow metadata.
/// v4..v6 - the 21 OpenClaw platforms landed in waves, one bump per wave.
/// No field was added or renamed by those three: entries only.
pub const CONNECTORS_CATALOG_VERSION: u32 = 6;

/// Pairing flow metadata for a connector:
///
///   * `"bot_token"` — user pastes a token (one or more `PairingFields`).
///   * `"oauth"` — reserved pasted OAuth-token shape. The gateway has no
///     generic connector token-validation route.
///   * `"qr"` — no secret fields. WhatsApp pairing starts in the sidecar
///     when enabled; it publishes `whatsapp-qr.json` for the TUI and
///     desktop to render. There is no gateway QR setup route.
///   * `"instance_token"` — the user names WHICH server they mean (a Matrix
///     homeserver, a Mattermost install) and supplies a credential for it.
///     The instance URL is a required field that is NOT a secret, which is
///     why `PairingFieldDef::secret` finally earns its existence.
///   * `"oauth_device"` — RFC 8628 device authorization grant: Cinderpaw shows a
///     code, the user types it on the provider's site, Cinderpaw polls. The only
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

/// Input fields for token and instance-token pairing. Empty for QR and
/// device flows; instance addresses are required but not secret.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PairingFieldDef {
    /// Stable key — the JSON-key the secret gets stored under in
    /// `~/.cinderpaw/connectors.json` and the env-var name the sidecar
    /// reads. Examples: `"DISCORD_TOKEN"`, `"SLACK_APP_TOKEN"`.
    pub key: String,
    /// Human label for the input, e.g. `"Discord bot token"`.
    pub label: String,
    /// Whether this field is a secret. Matrix homeserver and Mattermost
    /// server URLs are required non-secret fields.
    pub secret: bool,
}

/// Reserved metadata for an external OAuth client-id source. No shipped
/// catalog entry sets this, and the sidecar has no resolver for it.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OAuthClientIDSource {
    /// `"env"` or `"keychain"`.
    pub kind: String,
    /// Reference name — env var name (e.g. `"CINDERPAW_DISCORD_CLIENT_ID"`)
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
    /// Input fields the user must provide, including non-secret instance
    /// URLs. Empty for QR and device-flow connectors.
    pub pairing_fields: Vec<PairingFieldDef>,
    pub pairing_method: PairingMethod,
    /// Whether the connector is unavailable in this build. True when
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
    /// Provider token-probe URL metadata. The gateway does not implement
    /// a generic connector validation route or consume this field to
    /// validate credentials. Authentication occurs in each transport.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validate_endpoint: Option<String>,
    /// OAuth scope metadata. Current wizard cards do not render this list.
    /// Slack also declares scopes despite using `bot_token` pairing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub oauth_scopes: Vec<String>,
    /// For OAuth connectors, where the OAuth client id comes from.
    /// `None` for `bot_token` and `qr` connectors (those don't need
    /// OAuth flow input).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_client_id_source: Option<OAuthClientIDSource>,
    /// Reserved optional gateway QR setup endpoint. No such route is
    /// implemented, so every shipped entry leaves this unset. WhatsApp
    /// uses the sidecar QR file consumed by the TUI and desktop instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_setup_endpoint: Option<String>,
}

/// Canonical connector metadata consumed by the TUI and desktop. Adding
/// an operational connector also requires a registered sidecar transport
/// and client support for its pairing flow.
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
            // Provider probe metadata only; no channel-scope validation
            // is performed from this catalog entry.
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
            // Pairing is delivered through the sidecar QR file, not HTTP.
            qr_setup_endpoint: None,
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
            coming_soon: false,
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
            coming_soon: false,
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
            coming_soon: false,
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
            coming_soon: false,
            console_url: Some("https://dev.twitch.tv/console/apps".into()),
            free_tier_note: None,
            validate_endpoint: Some("https://id.twitch.tv/oauth2/validate".into()),
            oauth_scopes: vec!["chat:read".into(), "chat:edit".into()],
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        // ── The OpenClaw 21 (2026-09-12) ─────────────────────────────────
        // Extracted from their channel manifests; see
        // docs/openclaw-import.md and scripts/openclaw/. Every one is
        // `coming_soon` until its transport lands. We take their
        // `sensitive` marking as authoritative (they know their own
        // platform) but not their whole config surface: what belongs here
        // is the credential, not each of their nine knobs.
        ConnectorCatalogEntry {
            id: "signal".into(),
            transport: "signal".into(),
            device_flow: None,
            name: "Signal".into(),
            description: "Answer from your Signal number. Signal has no bot API, so this links a second device through signal-cli, which you install yourself.".into(),
            icon: "🔒".into(),
            logo_url: Some("https://cdn.simpleicons.org/signal".into()),
            pairing_fields: vec![
                PairingFieldDef {
                    key: "SIGNAL_NUMBER".into(),
                    label: "Your Signal number, with country code (e.g. +40712345678)".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "SIGNAL_BRIDGE_URL".into(),
                    label: "signal-cli REST bridge URL (e.g. http://127.0.0.1:8080)".into(),
                    secret: false,
                },
            ],
            pairing_method: InstanceToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: false,
            console_url: Some("https://github.com/AsamK/signal-cli".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "imessage".into(),
            transport: "imessage".into(),
            device_flow: None,
            name: "iMessage".into(),
            description: "Answer from iMessage on a Mac you own. Reads the local messages database through a bridge — it never leaves the machine.".into(),
            icon: "💬".into(),
            logo_url: None,
            pairing_fields: vec![
                PairingFieldDef {
                    key: "IMESSAGE_CLI_PATH".into(),
                    label: "Path to the imsg bridge binary".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "IMESSAGE_DB_PATH".into(),
                    label: "Path to chat.db (leave blank for the default)".into(),
                    secret: false,
                },
            ],
            pairing_method: InstanceToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: None,
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "irc".into(),
            transport: "irc".into(),
            device_flow: None,
            name: "IRC".into(),
            description: "Classic IRC. Any network, your own nick, the channels you name.".into(),
            icon: "#️⃣".into(),
            logo_url: None,
            pairing_fields: vec![
                PairingFieldDef {
                    key: "IRC_HOST".into(),
                    label: "Server (e.g. irc.libera.chat)".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "IRC_NICK".into(),
                    label: "Nickname".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "IRC_PASSWORD".into(),
                    label: "Server or NickServ password (leave blank if none)".into(),
                    secret: true,
                },
            ],
            pairing_method: InstanceToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: false,
            console_url: None,
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "line".into(),
            transport: "line".into(),
            device_flow: None,
            name: "LINE".into(),
            description: "A LINE Messaging API bot, big in Japan, Taiwan and Thailand. Needs a public web address you provide, because LINE delivers messages by calling you. See docs/decisions/2026-09-12-webhook-inbound.md.".into(),
            icon: "💚".into(),
            logo_url: Some("https://cdn.simpleicons.org/line".into()),
            pairing_fields: vec![
                PairingFieldDef {
                    key: "LINE_CHANNEL_ACCESS_TOKEN".into(),
                    label: "Channel access token".into(),
                    secret: true,
                },
                PairingFieldDef {
                    key: "LINE_CHANNEL_SECRET".into(),
                    label: "Channel secret".into(),
                    secret: true,
                },
            ],
            pairing_method: BotToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: Some("https://developers.line.biz/console/".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "feishu".into(),
            transport: "feishu".into(),
            device_flow: None,
            name: "Feishu / Lark".into(),
            description: "Feishu and Lark enterprise messaging, with their doc, wiki and drive tools.".into(),
            icon: "🐦".into(),
            logo_url: None,
            pairing_fields: Vec::new(),
            pairing_method: BotToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: Some("https://open.feishu.cn/app".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "googlechat".into(),
            transport: "googlechat".into(),
            device_flow: None,
            name: "Google Chat".into(),
            description: "A Google Workspace Chat app. Needs a public web address you provide, because Google delivers messages by calling you. See docs/decisions/2026-09-12-webhook-inbound.md.".into(),
            icon: "🔷".into(),
            logo_url: None,
            pairing_fields: vec![
                PairingFieldDef {
                    key: "GOOGLE_CHAT_SERVICE_ACCOUNT".into(),
                    label: "Service account JSON".into(),
                    secret: true,
                },
            ],
            pairing_method: BotToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: Some("https://console.cloud.google.com/apis/library/chat.googleapis.com".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "msteams".into(),
            transport: "msteams".into(),
            device_flow: None,
            name: "Microsoft Teams".into(),
            description: "Microsoft Teams, through the Teams SDK. Needs a public web address you provide, and an administrator who can install the app into your tenant. See docs/decisions/2026-09-12-webhook-inbound.md.".into(),
            icon: "🟦".into(),
            logo_url: None,
            pairing_fields: Vec::new(),
            pairing_method: BotToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: Some("https://dev.teams.microsoft.com/apps".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "nextcloud-talk".into(),
            transport: "nextcloud-talk".into(),
            device_flow: None,
            name: "Nextcloud Talk".into(),
            description: "Self-hosted chat on your own Nextcloud. Nothing goes through anyone else's server.".into(),
            icon: "☁️".into(),
            logo_url: Some("https://cdn.simpleicons.org/nextcloud".into()),
            pairing_fields: vec![
                PairingFieldDef {
                    key: "NEXTCLOUD_TALK_URL".into(),
                    label: "Nextcloud base URL (e.g. https://cloud.example.com)".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "NEXTCLOUD_TALK_USER".into(),
                    label: "Your Nextcloud username".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "NEXTCLOUD_TALK_APP_PASSWORD".into(),
                    label: "App password (Settings, Security, Devices & sessions — not your login password)".into(),
                    secret: true,
                },
            ],
            pairing_method: InstanceToken,
            // Ported 2026-09-12: src/transports/nextcloud-talk.ts. NOT as the
            // webhook bot OpenClaw uses: a bot needs Nextcloud to POST to a
            // URL Cinderpaw owns, and someone self-hosting at home has no
            // public address. This pairs as a user with an app password and
            // long-polls instead, so it works behind a router.
            coming_soon: false,
            console_url: Some("https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "nostr".into(),
            transport: "nostr".into(),
            device_flow: None,
            name: "Nostr".into(),
            description: "Decentralised messaging over Nostr relays, with encrypted direct messages.".into(),
            icon: "🟪".into(),
            logo_url: None,
            pairing_fields: vec![
                PairingFieldDef {
                    key: "NOSTR_PRIVATE_KEY".into(),
                    label: "Private key (nsec)".into(),
                    secret: true,
                },
                PairingFieldDef {
                    key: "NOSTR_RELAY_URLS".into(),
                    label: "Relay URLs, comma separated".into(),
                    secret: false,
                },
            ],
            pairing_method: InstanceToken,
            // Ported 2026-09-12: src/transports/nostr.ts. There is no account
            // and no operator here, so `console_url` points at the protocol's
            // own docs rather than at a dashboard that does not exist.
            coming_soon: false,
            console_url: Some("https://github.com/nostr-protocol/nips/blob/master/04.md".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "sms".into(),
            transport: "sms".into(),
            device_flow: None,
            name: "SMS".into(),
            description: "Plain SMS through Twilio, to any phone, with no app to install. Needs a public web address you provide, because Twilio delivers messages by calling you. See docs/decisions/2026-09-12-webhook-inbound.md.".into(),
            icon: "📱".into(),
            logo_url: None,
            pairing_fields: vec![
                PairingFieldDef {
                    key: "TWILIO_ACCOUNT_SID".into(),
                    label: "Twilio account SID".into(),
                    secret: true,
                },
                PairingFieldDef {
                    key: "TWILIO_AUTH_TOKEN".into(),
                    label: "Twilio auth token".into(),
                    secret: true,
                },
                PairingFieldDef {
                    key: "TWILIO_FROM_NUMBER".into(),
                    label: "Sending number (e.g. +15551234567)".into(),
                    secret: false,
                },
            ],
            pairing_method: BotToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: Some("https://console.twilio.com/".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "synology-chat".into(),
            transport: "synology-chat".into(),
            device_flow: None,
            name: "Synology Chat".into(),
            description: "Chat on your own Synology NAS, with the full agent behind it. Needs an address your NAS can reach Cinderpaw at, because Chat delivers messages by calling you. See docs/decisions/2026-09-12-webhook-inbound.md.".into(),
            icon: "🗄️".into(),
            logo_url: Some("https://cdn.simpleicons.org/synology".into()),
            pairing_fields: vec![
                PairingFieldDef {
                    key: "SYNOLOGY_CHAT_WEBHOOK_URL".into(),
                    label: "Incoming webhook URL".into(),
                    secret: true,
                },
                PairingFieldDef {
                    key: "SYNOLOGY_CHAT_TOKEN".into(),
                    label: "Outgoing webhook token".into(),
                    secret: true,
                },
            ],
            pairing_method: InstanceToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: None,
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "tlon".into(),
            transport: "tlon".into(),
            device_flow: None,
            name: "Tlon".into(),
            description: "Decentralised messaging on Urbit, through your own ship.".into(),
            icon: "🪐".into(),
            logo_url: None,
            pairing_fields: vec![
                PairingFieldDef {
                    key: "TLON_SHIP".into(),
                    label: "Ship name (e.g. ~sampel-palnet)".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "TLON_URL".into(),
                    label: "Ship URL".into(),
                    secret: false,
                },
                PairingFieldDef {
                    key: "TLON_CODE".into(),
                    label: "Access code".into(),
                    secret: true,
                },
            ],
            pairing_method: InstanceToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: None,
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "zalo".into(),
            transport: "zalo".into(),
            device_flow: None,
            name: "Zalo".into(),
            description: "Zalo Bot API. The default messenger in Vietnam.".into(),
            icon: "🔵".into(),
            logo_url: None,
            pairing_fields: vec![
                PairingFieldDef {
                    key: "ZALO_BOT_TOKEN".into(),
                    label: "Zalo bot token".into(),
                    secret: true,
                },
            ],
            pairing_method: BotToken,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: Some("https://bot.zapps.me/".into()),
            free_tier_note: None,
            validate_endpoint: None,
            oauth_scopes: Vec::new(),
            oauth_client_id_source: None,
            qr_setup_endpoint: None,
        },
        ConnectorCatalogEntry {
            id: "zalouser".into(),
            transport: "zalouser".into(),
            device_flow: None,
            name: "Zalo Personal".into(),
            description: "Your personal Zalo account, paired by scanning a QR code — like WhatsApp.".into(),
            icon: "🔵".into(),
            logo_url: None,
            pairing_fields: Vec::new(),
            pairing_method: Qr,
            // No sidecar transport yet. `coming_soon` is not decoration:
            // the card renders disabled, so it cannot promise a connection
            // the sidecar has no code to make. Flipped by the port, and
            // pinned by tests/connector-catalog-transports.test.ts.
            coming_soon: true,
            console_url: None,
            free_tier_note: None,
            validate_endpoint: None,
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
// so the headless gateway + CLI can read/write `~/.cinderpaw/connectors.json`
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
    /// Settings that are REQUIRED but not secret, and so belong in the config
    /// rather than the vault: a Matrix homeserver address, the Twitch login a
    /// granted token belongs to. Written by pairing as often as by the person.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConnectorConfigFile {
    connectors: Vec<ConnectorConfig>,
}

fn config_path() -> std::path::PathBuf {
    crate::paths::cinderpaw_dir().join("connectors.json")
}

pub fn blank_connector_config(id: &str) -> ConnectorConfig {
    ConnectorConfig {
        id: id.to_string(),
        enabled: false,
        metadata: HashMap::new(),
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
/// Field keys that exist without appearing in `pairing_fields`: a device-flow
/// connector has no form to fill in, but it still ends up with credentials.
const GRANTED_KEYS: [&str; 2] = ["OAUTH_ACCESS", "OAUTH_REFRESH"];

/// Configs with the vault's values folded back in, for handing to the sidecar.
///
/// This closes the hole the plaintext migration opened. The migration moves
/// every connector secret out of `connectors.json` and deletes it from the
/// file — which is the point — but the sidecar, which is the process that
/// actually holds the connections, only ever read that file. On the first
/// start after migrating, every connector on the machine would have come up
/// with an empty secret and stopped: a security improvement that silently
/// switched off the product.
///
/// The values ride the stdin pipe to the child process rather than sitting on
/// disk, which is where a credential a subprocess needs has to travel anyway.
/// A row's own plaintext value still wins when one is present, so a config
/// that has not been migrated yet behaves exactly as before.
pub fn resolved_connector_configs() -> Vec<ConnectorConfig> {
    let mut rows = load_connector_configs();
    resolve_secrets_into(&mut rows, &|reference| {
        crate::connector_secrets::read(reference)
    });
    rows
}

/// The folding itself, with the vault injected.
///
/// Split out because the vault is the OS keychain — process-global, shared
/// with whatever the developer has actually paired — so a test that called the
/// real one would pass or fail depending on whose machine it ran on. This is
/// the part with the rules in it, and it is testable.
pub fn resolve_secrets_into(
    rows: &mut [ConnectorConfig],
    read: &dyn Fn(&str) -> Option<String>,
) {
    for row in rows.iter_mut() {
        let mut keys: Vec<String> = connector_by_id(&row.id)
            .map(|entry| entry.pairing_fields.into_iter().map(|f| f.key).collect())
            .unwrap_or_default();
        keys.extend(GRANTED_KEYS.iter().map(|k| (*k).to_string()));
        for key in keys {
            // A value already in the file wins: an install that has not been
            // migrated yet must behave exactly as it did before.
            if row.secrets.get(&key).is_some_and(|v| !v.trim().is_empty()) {
                continue;
            }
            let reference = crate::connector_secrets::secret_ref(&row.id, &key);
            if let Some(value) = read(&reference) {
                // An empty vault entry is not a credential. Inserting "" would
                // turn "no token, here is which one you need" into "token
                // rejected", which sends the person looking in the wrong place.
                if !value.trim().is_empty() {
                    row.secrets.insert(key, value);
                }
            }
        }
    }
}

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
    // Temp-file + rename, and owner-only: this file holds the Discord, Slack,
    // Telegram and WhatsApp bot tokens in clear text, and it used to land at
    // whatever the umask gave — typically 0644, readable by every other account
    // on the machine. The atomicity was already here; the permission was not.
    crate::atomic_file::write_secret_atomic(&path, raw.as_bytes())
        .map_err(|e| format!("Couldn't save connector settings: {e}"))
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
    let path = crate::paths::cinderpaw_dir().join("connector-health.json");
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
        crate::rsi::test_support::with_temp_cinderpaw_home(|_dir| {
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
