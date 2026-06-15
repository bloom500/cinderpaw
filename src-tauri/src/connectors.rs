//! Connectors — the "Connector Surface" backend.
//!
//! A connector is an *inbound* messaging surface over the LOCAL Feral agent:
//! you message the agent from Discord (and later Telegram/WhatsApp/Slack) and
//! it replies there, driven by the same local runtime, model and tools as the
//! desktop app. This module owns only the *configuration* (which connectors are
//! enabled, their bot token, their allowlist). The live gateway connection runs
//! inside the Bun sidecar (`FeralAgent/src/transports/discord.ts`); on every
//! change here we poke the sidecar to reconcile via a `connectors_reload`
//! message on its stdin.
//!
//! Same non-technical-first discipline as `mcp.rs`:
//!   - The frontend NEVER receives the bot token — only a `has_token` flag.
//!   - Errors are humanized before crossing the IPC boundary.
//!   - Config persists at `~/.feral/connectors.json`.

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
    /// Bot token (Discord). Stays in the backend; never sent to the frontend.
    #[serde(default)]
    pub token: String,
    /// Allowed sender IDs (exact Discord user IDs). Empty = nobody but whoever
    /// the owner explicitly adds. Senders not on the list are ignored.
    #[serde(default)]
    pub allowlist: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConnectorConfigFile {
    connectors: Vec<ConnectorConfig>,
}

fn config_path() -> PathBuf {
    paths::feral_dir().join("connectors.json")
}

fn load_config() -> ConnectorConfigFile {
    match std::fs::read_to_string(config_path()) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => ConnectorConfigFile::default(),
    }
}

fn save_config(cfg: &ConnectorConfigFile) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), raw)
        .map_err(|e| format!("Couldn't save connector settings: {e}"))
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
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

// ---------------------------------------------------------------------------
// Curated catalog
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ConnectorCatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    /// Label for the bot-token field, e.g. "Discord bot token".
    pub token_label: String,
    /// True for platforms not yet wired — the card renders disabled.
    pub coming_soon: bool,
}

fn catalog() -> Vec<ConnectorCatalogEntry> {
    let e = |id: &str, name: &str, description: &str, icon: &str, logo: Option<&str>, token_label: &str, coming_soon: bool| {
        ConnectorCatalogEntry {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            icon: icon.into(),
            logo_url: logo.map(Into::into),
            token_label: token_label.into(),
            coming_soon,
        }
    };
    vec![
        e(
            "discord",
            "Discord",
            "Chat with your assistant from Discord — DMs and @mentions. Only people you allow can reach it.",
            "🎮",
            Some("https://discord.com/assets/favicon.ico"),
            "Discord bot token",
            false,
        ),
        e(
            "telegram",
            "Telegram",
            "Message your assistant from Telegram.",
            "✈️",
            Some("https://telegram.org/img/t_logo.png"),
            "Telegram bot token",
            true,
        ),
        e(
            "whatsapp",
            "WhatsApp",
            "Reach your assistant on WhatsApp.",
            "💚",
            None,
            "WhatsApp session",
            true,
        ),
        e(
            "slack",
            "Slack",
            "Talk to your assistant from a Slack workspace.",
            "💬",
            Some("https://a.slack-edge.com/80588/marketing/img/meta/slack_hash_128.png"),
            "Slack bot token",
            true,
        ),
    ]
}

// ---------------------------------------------------------------------------
// Display-safe view (token never crosses the boundary)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ConnectorView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub token_label: String,
    pub coming_soon: bool,
    pub enabled: bool,
    /// Whether a bot token is stored — the token itself is never sent.
    pub has_token: bool,
    pub allowlist: Vec<String>,
}

fn view_of(cfg: &ConnectorConfig) -> ConnectorView {
    // Decorate the saved config with its catalog metadata. Unknown ids (should
    // not happen) fall back to neutral display values.
    let meta = catalog().into_iter().find(|c| c.id == cfg.id);
    let (name, description, icon, logo_url, token_label, coming_soon) = match meta {
        Some(m) => (m.name, m.description, m.icon, m.logo_url, m.token_label, m.coming_soon),
        None => (cfg.id.clone(), String::new(), "🔌".into(), None, "Token".into(), false),
    };
    ConnectorView {
        id: cfg.id.clone(),
        name,
        description,
        icon,
        logo_url,
        token_label,
        coming_soon,
        enabled: cfg.enabled,
        has_token: !cfg.token.trim().is_empty(),
        allowlist: cfg.allowlist.clone(),
    }
}

/// Tell the sidecar to reconcile its live connectors after a config change.
/// Best-effort: if the sidecar isn't running the next startup picks up the
/// saved config anyway.
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
    cfg.connectors.iter().map(view_of).collect()
}

/// Save a connector's token (when provided) and allowlist. A connector row is
/// created on first save. The Discord token is seeded from the existing MCP
/// extension config when the user hasn't typed a new one.
#[tauri::command]
#[specta::specta]
pub async fn connectors_save(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    token: Option<String>,
    allowlist: Vec<String>,
) -> Result<ConnectorView, String> {
    if catalog().iter().find(|c| c.id == id).map(|c| c.coming_soon).unwrap_or(true) {
        return Err("This connector isn't available yet.".to_string());
    }

    // Normalise the allowlist: trim, drop blanks, dedupe, keep order.
    let mut seen = std::collections::HashSet::new();
    let allowlist: Vec<String> = allowlist
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect();

    let mut cfg = load_config();
    let existing = cfg.connectors.iter().find(|c| c.id == id).cloned();
    let mut row = existing.unwrap_or(ConnectorConfig {
        id: id.clone(),
        enabled: false,
        token: String::new(),
        allowlist: Vec::new(),
    });

    // Token: keep the existing one unless the user typed a new non-empty value.
    if let Some(t) = token {
        let t = t.trim();
        if !t.is_empty() {
            row.token = t.to_string();
        }
    }
    // Seed from the MCP extension if we still have nothing (Discord only).
    if row.token.trim().is_empty() && id == "discord" {
        if let Some(t) = discord_token_from_mcp() {
            row.token = t;
        }
    }
    row.allowlist = allowlist;

    cfg.connectors.retain(|c| c.id != id);
    cfg.connectors.push(row.clone());
    save_config(&cfg)?;
    notify_sidecar(&state).await;
    Ok(view_of(&row))
}

/// Turn a connector on or off. Enabling requires a token to exist.
#[tauri::command]
#[specta::specta]
pub async fn connectors_set_enabled(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    enabled: bool,
) -> Result<ConnectorView, String> {
    let mut cfg = load_config();

    // Create the row on first toggle so Discord can be enabled straight from
    // the card once its token has been seeded from the MCP extension.
    if !cfg.connectors.iter().any(|c| c.id == id) {
        let mut token = String::new();
        if id == "discord" {
            token = discord_token_from_mcp().unwrap_or_default();
        }
        cfg.connectors.push(ConnectorConfig { id: id.clone(), enabled: false, token, allowlist: Vec::new() });
    }

    let row = cfg
        .connectors
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| "Unknown connector.".to_string())?;

    if enabled && row.token.trim().is_empty() {
        return Err("Add a bot token before turning this on.".to_string());
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
