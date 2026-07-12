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

use serde::Serialize;

use crate::paths;

// R6: persisted config (ConnectorConfig, load/save, legacy-token migration)
// moved to `feral_core::connectors` so the headless gateway + CLI can read/
// write `~/.feral/connectors.json` without a Tauri command. Re-export the
// type so the rest of this file (and any external caller) keeps working
// unchanged.
pub use feral_core::connectors::ConnectorConfig;
use feral_core::connectors::{
    blank_connector_config, load_connector_configs, save_connector_configs,
};

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
    let connectors = load_connector_configs();
    let mut views: Vec<ConnectorView> = connectors.iter().map(view_of).collect();

    // Surface the Discord token the user already entered for the mcp-discord
    // extension even before they save a connector row, so the card shows
    // "saved" and can be turned on straight away.
    if !views.iter().any(|v| v.id == "discord") {
        if let Some(token) = discord_token_from_mcp() {
            let mut row = blank_connector_config("discord");
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

    let mut connectors = load_connector_configs();
    let mut row = connectors.iter().find(|c| c.id == id).cloned().unwrap_or_else(|| blank_connector_config(&id));

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

    connectors.retain(|c| c.id != id);
    connectors.push(row.clone());
    save_connector_configs(&connectors)?;
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
    let mut connectors = load_connector_configs();
    if !connectors.iter().any(|c| c.id == id) {
        let mut row = blank_connector_config(&id);
        seed_discord(&mut row);
        connectors.push(row);
    }

    let row = connectors
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| "Unknown connector.".to_string())?;
    seed_discord(row);

    if enabled && !is_ready(row) {
        return Err("Add the required tokens before turning this on.".to_string());
    }
    row.enabled = enabled;
    let snapshot = row.clone();
    save_connector_configs(&connectors)?;
    notify_sidecar(&state).await;
    Ok(view_of(&snapshot))
}

/// Pending WhatsApp pairing QR. The sidecar mirrors each fresh QR to
/// `~/.feral/whatsapp-qr.json` (and deletes it once linked) so GUI surfaces
/// can render it — a GUI user has no terminal window to scan from.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct WhatsappQr {
    /// Raw pairing payload (what the QR encodes).
    pub qr: String,
    /// Terminal-style half-block ASCII rendering of the QR, scannable when
    /// shown in a monospace block.
    pub ascii: String,
    /// When the sidecar wrote this code (Unix ms). Baileys rotates the QR
    /// every ~20s — the UI derives a countdown from this.
    pub ts: f64,
}

#[tauri::command]
#[specta::specta]
pub fn connectors_whatsapp_qr() -> Option<WhatsappQr> {
    #[derive(serde::Deserialize)]
    struct QrFile {
        ts: f64,
        qr: String,
        ascii: String,
    }
    let raw = std::fs::read_to_string(paths::feral_dir().join("whatsapp-qr.json")).ok()?;
    let f: QrFile = serde_json::from_str(&raw).ok()?;
    // Baileys rotates the QR every ~20s and the sidecar rewrites the file each
    // time; a stale timestamp means pairing is no longer in progress (e.g. the
    // sidecar died without cleaning up).
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as f64;
    if now_ms - f.ts > 120_000.0 {
        return None;
    }
    Some(WhatsappQr { qr: f.qr, ascii: f.ascii, ts: f.ts })
}

#[tauri::command]
#[specta::specta]
pub async fn connectors_remove(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    let mut connectors = load_connector_configs();
    connectors.retain(|c| c.id != id);
    save_connector_configs(&connectors)?;
    notify_sidecar(&state).await;
    Ok(())
}
