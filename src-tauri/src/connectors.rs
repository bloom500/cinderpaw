//! Connectors — the "Connector Surface" backend.
//!
//! A connector is an *inbound* messaging surface over the LOCAL Feral agent:
//! you message the agent from Discord / Slack / WhatsApp and it replies there,
//! driven by the same local runtime, model and tools as the desktop app. This
//! module owns only the *configuration* (which connectors are enabled, their
//! secrets, allowlist, channels). The live connections run inside the Bun
//! sidecar (`FeralAgent/src/transports/connectors.ts`); on every change here we
//! poke the sidecar to reconcile via a `connectors_reload` stdin message.
//!
//! Auth differs per platform:
//!   - Discord: one bot token.
//!   - Slack:   two tokens (app-level `xapp-` for Socket Mode + bot `xoxb-`).
//!   - WhatsApp: no token — a QR code is scanned once; the session persists on
//!     disk under `~/.feral/whatsapp-auth/`.
//!
//! Non-technical-first discipline (like `mcp.rs`): secrets stay in the backend,
//! the frontend only learns WHICH fields are filled (`filled`), never values.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::paths;

// ---------------------------------------------------------------------------
// Persisted config
// ---------------------------------------------------------------------------

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
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConnectorConfigFile {
    connectors: Vec<ConnectorConfig>,
}

fn config_path() -> PathBuf {
    paths::feral_dir().join("connectors.json")
}

fn load_config() -> ConnectorConfigFile {
    let mut cfg: ConnectorConfigFile = match std::fs::read_to_string(config_path()) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => ConnectorConfigFile::default(),
    };
    // Migrate the old single `token` field into the per-field secrets map.
    for c in &mut cfg.connectors {
        if let Some(tok) = c.token.take() {
            if !tok.trim().is_empty() {
                if let Some(primary) = primary_field_key(&c.id) {
                    c.secrets.entry(primary.to_string()).or_insert(tok);
                }
            }
        }
    }
    cfg
}

fn save_config(cfg: &ConnectorConfigFile) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), raw)
        .map_err(|e| format!("Couldn't save connector settings: {e}"))
}

/// First secret field key for a connector (used for legacy-token migration).
fn primary_field_key(id: &str) -> Option<&'static str> {
    catalog_def().into_iter().find(|c| c.id == id).and_then(|c| c.fields.first().map(|f| f.key))
}

/// Pull the Discord bot token the user already entered for the `mcp-discord`
/// extension (`~/.feral/mcp.json` → server `discord` → env `DISCORD_TOKEN`), so
/// enabling the Discord *connector* reuses it instead of asking again.
fn discord_token_from_mcp() -> Option<String> {
    let raw = std::fs::read_to_string(paths::feral_dir().join("mcp.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let servers = json.get("servers")?.as_array()?;
    let discord = servers.iter().find(|s| s.get("id").and_then(|v| v.as_str()) == Some("discord"))?;
    let token = discord.get("env")?.get("DISCORD_TOKEN")?.as_str()?;
    let token = token.trim();
    if token.is_empty() { None } else { Some(token.to_string()) }
}

/// True once WhatsApp has been linked (Baileys persisted its session).
fn whatsapp_linked() -> bool {
    paths::feral_dir().join("whatsapp-auth").join("creds.json").exists()
}

// ---------------------------------------------------------------------------
// Curated catalog
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ConnectorField {
    pub key: String,
    pub label: String,
    pub secret: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ConnectorCatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    /// Secret fields the user must provide (empty for QR-auth connectors).
    pub fields: Vec<ConnectorField>,
    /// "token" → fill the fields; "qr" → scan a QR code to link.
    pub auth_kind: String,
    /// True for platforms not yet wired — the card renders disabled.
    pub coming_soon: bool,
}

/// Internal catalog with field keys as &'static str (cheap for lookups).
struct CatalogDef {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    icon: &'static str,
    logo: Option<&'static str>,
    fields: Vec<FieldDef>,
    auth_kind: &'static str,
    coming_soon: bool,
}

struct FieldDef {
    key: &'static str,
    label: &'static str,
    secret: bool,
}

fn catalog_def() -> Vec<CatalogDef> {
    let f = |key, label, secret| FieldDef { key, label, secret };
    vec![
        CatalogDef {
            id: "discord",
            name: "Discord",
            description: "Chat with your assistant from Discord — DMs, @mentions, or a dedicated channel. Only people you allow can reach it.",
            icon: "🎮",
            logo: Some("https://cdn.simpleicons.org/discord"),
            fields: vec![f("DISCORD_TOKEN", "Discord bot token", true)],
            auth_kind: "token",
            coming_soon: false,
        },
        CatalogDef {
            id: "slack",
            name: "Slack",
            description: "Talk to your assistant from a Slack workspace via Socket Mode. Needs an app-level token and a bot token.",
            icon: "💬",
            logo: Some("https://a.slack-edge.com/80588/marketing/img/meta/slack_hash_128.png"),
            fields: vec![
                f("SLACK_APP_TOKEN", "App-level token (xapp-…)", true),
                f("SLACK_BOT_TOKEN", "Bot token (xoxb-…)", true),
            ],
            auth_kind: "token",
            coming_soon: false,
        },
        CatalogDef {
            id: "whatsapp",
            name: "WhatsApp",
            description: "Reach your assistant on WhatsApp. Turn it on, then scan the QR code with WhatsApp → Linked devices. Use a SECONDARY number — automation can get a number banned.",
            icon: "💚",
            logo: Some("https://cdn.simpleicons.org/whatsapp"),
            fields: vec![],
            auth_kind: "qr",
            coming_soon: false,
        },
        CatalogDef {
            id: "telegram",
            name: "Telegram",
            description: "Message your assistant from Telegram.",
            icon: "✈️",
            logo: Some("https://cdn.simpleicons.org/telegram"),
            fields: vec![f("TELEGRAM_BOT_TOKEN", "Telegram bot token", true)],
            auth_kind: "token",
            coming_soon: true,
        },
    ]
}

fn catalog() -> Vec<ConnectorCatalogEntry> {
    catalog_def()
        .into_iter()
        .map(|d| ConnectorCatalogEntry {
            id: d.id.into(),
            name: d.name.into(),
            description: d.description.into(),
            icon: d.icon.into(),
            logo_url: d.logo.map(Into::into),
            fields: d
                .fields
                .iter()
                .map(|f| ConnectorField { key: f.key.into(), label: f.label.into(), secret: f.secret })
                .collect(),
            auth_kind: d.auth_kind.into(),
            coming_soon: d.coming_soon,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Display-safe view (secret values never cross the boundary)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ConnectorView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub fields: Vec<ConnectorField>,
    pub auth_kind: String,
    pub coming_soon: bool,
    pub enabled: bool,
    /// Field keys that currently hold a (non-empty) value — never the values.
    pub filled: Vec<String>,
    /// QR connectors only: whether a session has been linked.
    pub linked: bool,
    pub allowlist: Vec<String>,
    pub channels: Vec<String>,
    /// "owner" (default) or "public". WhatsApp only; harmless for others.
    pub mode: String,
    /// Inline knowledge-base text for public mode (returned so the UI textarea
    /// can be pre-filled). Empty when unset.
    #[serde(rename = "knowledgeBase")]
    pub knowledge_base: String,
}

fn view_of(cfg: &ConnectorConfig) -> ConnectorView {
    let meta = catalog().into_iter().find(|c| c.id == cfg.id);
    let entry = meta.unwrap_or(ConnectorCatalogEntry {
        id: cfg.id.clone(),
        name: cfg.id.clone(),
        description: String::new(),
        icon: "🔌".into(),
        logo_url: None,
        fields: Vec::new(),
        auth_kind: "token".into(),
        coming_soon: false,
    });
    let filled = entry
        .fields
        .iter()
        .filter(|f| cfg.secrets.get(&f.key).map(|v| !v.trim().is_empty()).unwrap_or(false))
        .map(|f| f.key.clone())
        .collect();
    ConnectorView {
        id: cfg.id.clone(),
        name: entry.name,
        description: entry.description,
        icon: entry.icon,
        logo_url: entry.logo_url,
        fields: entry.fields,
        auth_kind: entry.auth_kind.clone(),
        coming_soon: entry.coming_soon,
        enabled: cfg.enabled,
        filled,
        linked: cfg.id == "whatsapp" && whatsapp_linked(),
        allowlist: cfg.allowlist.clone(),
        channels: cfg.channels.clone(),
        mode: cfg.mode.clone().unwrap_or_else(|| "owner".into()),
        knowledge_base: cfg.knowledge_base.clone().unwrap_or_default(),
    }
}

/// Trim, drop blanks, dedupe (order-preserving) a list of IDs from the UI.
fn clean_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    ids.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}

/// Whether a connector has everything it needs to be turned on.
fn is_ready(cfg: &ConnectorConfig) -> bool {
    let entry = match catalog().into_iter().find(|c| c.id == cfg.id) {
        Some(e) => e,
        None => return false,
    };
    if entry.auth_kind == "qr" {
        return true; // QR connectors link on first connect — nothing to pre-fill.
    }
    // token auth: every secret field must be present.
    entry
        .fields
        .iter()
        .all(|f| cfg.secrets.get(&f.key).map(|v| !v.trim().is_empty()).unwrap_or(false))
}

/// Seed Discord's token from the mcp-discord extension if it's missing.
fn seed_discord(cfg: &mut ConnectorConfig) {
    if cfg.id != "discord" {
        return;
    }
    let has = cfg.secrets.get("DISCORD_TOKEN").map(|v| !v.trim().is_empty()).unwrap_or(false);
    if !has {
        if let Some(tok) = discord_token_from_mcp() {
            cfg.secrets.insert("DISCORD_TOKEN".into(), tok);
        }
    }
}

fn blank_config(id: &str) -> ConnectorConfig {
    ConnectorConfig {
        id: id.to_string(),
        enabled: false,
        secrets: HashMap::new(),
        allowlist: Vec::new(),
        channels: Vec::new(),
        token: None,
        mode: None,
        knowledge_base: None,
    }
}

/// Tell the sidecar to reconcile its live connectors after a config change.
async fn notify_sidecar(state: &crate::AppState) {
    let tx = { state.feral_agent_tx.lock().clone() };
    if let Some(tx) = tx {
        let _ = tx.send("{\"type\":\"connectors_reload\"}".to_string()).await;
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub fn connectors_catalog() -> Vec<ConnectorCatalogEntry> {
    catalog()
}

#[tauri::command]
#[specta::specta]
pub fn connectors_list() -> Vec<ConnectorView> {
    let cfg = load_config();
    let mut views: Vec<ConnectorView> = cfg.connectors.iter().map(view_of).collect();

    // Surface the Discord token the user already entered for the mcp-discord
    // extension even before they save a connector row, so the card shows
    // "saved" and can be turned on straight away.
    if !views.iter().any(|v| v.id == "discord") {
        if let Some(token) = discord_token_from_mcp() {
            let mut row = blank_config("discord");
            row.secrets.insert("DISCORD_TOKEN".into(), token);
            views.push(view_of(&row));
        }
    }
    views
}

/// Save a connector's secrets (only non-empty values override), allowlist and
/// channels. A connector row is created on first save.
#[tauri::command]
#[specta::specta]
pub async fn connectors_save(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    secrets: HashMap<String, String>,
    allowlist: Vec<String>,
    channels: Vec<String>,
    mode: Option<String>,
    knowledge_base: Option<String>,
) -> Result<ConnectorView, String> {
    let entry = catalog()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "Unknown connector.".to_string())?;
    if entry.coming_soon {
        return Err("This connector isn't available yet.".to_string());
    }

    let allowlist = clean_ids(allowlist);
    let channels = clean_ids(channels);

    let mut cfg = load_config();
    let mut row = cfg.connectors.iter().find(|c| c.id == id).cloned().unwrap_or_else(|| blank_config(&id));

    // Merge: only overwrite a secret when the user typed a new non-empty value.
    for field in &entry.fields {
        if let Some(v) = secrets.get(&field.key) {
            let v = v.trim();
            if !v.is_empty() {
                row.secrets.insert(field.key.clone(), v.to_string());
            }
        }
    }
    seed_discord(&mut row);
    row.allowlist = allowlist;
    row.channels = channels;
    // Mode + knowledge base (WhatsApp public persona). Normalize mode to the
    // two known values; treat anything else as the safe default ("owner").
    if let Some(m) = mode {
        row.mode = Some(if m == "public" { "public".into() } else { "owner".into() });
    }
    if let Some(kb) = knowledge_base {
        let kb = kb.trim();
        row.knowledge_base = if kb.is_empty() { None } else { Some(kb.to_string()) };
    }

    cfg.connectors.retain(|c| c.id != id);
    cfg.connectors.push(row.clone());
    save_config(&cfg)?;
    notify_sidecar(&state).await;
    Ok(view_of(&row))
}

/// Turn a connector on or off. Enabling requires it to be ready (tokens filled,
/// or QR-auth which links on connect).
#[tauri::command]
#[specta::specta]
pub async fn connectors_set_enabled(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    enabled: bool,
) -> Result<ConnectorView, String> {
    let mut cfg = load_config();
    if !cfg.connectors.iter().any(|c| c.id == id) {
        let mut row = blank_config(&id);
        seed_discord(&mut row);
        cfg.connectors.push(row);
    }

    let row = cfg
        .connectors
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| "Unknown connector.".to_string())?;
    seed_discord(row);

    if enabled && !is_ready(row) {
        return Err("Add the required tokens before turning this on.".to_string());
    }
    row.enabled = enabled;
    let snapshot = row.clone();
    save_config(&cfg)?;
    notify_sidecar(&state).await;
    Ok(view_of(&snapshot))
}

#[tauri::command]
#[specta::specta]
pub async fn connectors_remove(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.connectors.retain(|c| c.id != id);
    save_config(&cfg)?;
    notify_sidecar(&state).await;
    Ok(())
}
