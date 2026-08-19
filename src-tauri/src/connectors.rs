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

/// The desktop catalog is a PROJECTION of the one in `feral-core`, not a
/// second list.
///
/// It used to be a hand-written copy: the same four connectors, entered twice,
/// in two shapes, with the code itself admitting they were "unrelated" and
/// kept "their own shape for the existing UI". Adding a connector meant
/// remembering both, and only one of them is what the user sees. With ~120
/// connectors as the target, that is the whole budget.
///
/// The view types below stay exactly as they were, because the frontend
/// already renders them — this changes where the data comes from, not what
/// crosses the boundary.
fn catalog() -> Vec<ConnectorCatalogEntry> {
    feral_core::connectors::connectors_catalog()
        .into_iter()
        .map(|c| ConnectorCatalogEntry {
            id: c.id,
            name: c.name,
            description: c.description,
            icon: c.icon,
            logo_url: c.logo_url,
            fields: c
                .pairing_fields
                .into_iter()
                .map(|f| ConnectorField { key: f.key, label: f.label, secret: f.secret })
                .collect(),
            auth_kind: auth_kind_of(c.pairing_method),
            coming_soon: c.coming_soon,
        })
        .collect()
}

/// What the card has to DO, which is coarser than how the connector pairs.
///
/// The UI branches on this string; today it asks one question — "is this a QR
/// card or a form?" — so every pairing method that ends in the user supplying
/// values is "token". `oauth_device` is neither: nothing is typed here, the
/// code is typed on the provider's site. It gets its own kind rather than
/// being mislabelled as a form the user would then look for and not find.
fn auth_kind_of(method: feral_core::connectors::PairingMethod) -> String {
    use feral_core::connectors::PairingMethod as P;
    match method {
        P::Qr => "qr",
        P::OauthDevice => "device",
        P::BotToken | P::Oauth | P::InstanceToken => "token",
    }
    .to_string()
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
    if entry.auth_kind == "device" {
        // A device-flow connector has NO fields, and "every field is filled"
        // is vacuously true of an empty list — which would report a connector
        // with no credential whatsoever as ready to run. Readiness here means
        // "an account finished pairing", which is the account model's answer,
        // not this function's. Until it is wired, the honest answer is no.
        return false;
    }
    // Every declared field must be present. Not just the secret ones: a Matrix
    // homeserver URL is required to connect at all, and a connector missing it
    // is no more ready than one missing its token.
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
        // The rows travel WITH their secrets, resolved from the vault. The
        // sidecar used to read connectors.json itself, which stopped working
        // the moment the migration emptied that file of credentials — every
        // connector on the machine would have come up blank. The pipe is
        // where a credential a subprocess needs belongs; the disk is not.
        let rows = feral_core::connectors::resolved_connector_configs();
        let payload = serde_json::json!({ "type": "connectors_reload", "connectors": rows });
        let _ = tx.send(payload.to_string()).await;
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

// ---------------------------------------------------------------------------
// Device pairing (RFC 8628) — the desktop half.
//
// The state machine lives in `feral_core::oauth_device` and is pure. This is
// the part that has a network, a clock and a disk: it runs the machine, keeps
// the credentials in the vault, and writes down what the person should see.
// ---------------------------------------------------------------------------

/// The device code is OUR half of the handshake — a credential. It lives in
/// the vault while a pairing is in flight, never in the account record, which
/// is a file the UI reads.
const PAIRING_DEVICE_CODE: &str = "PAIRING_DEVICE_CODE";
/// Where the granted credentials land.
const ACCESS_KEY: &str = "OAUTH_ACCESS";
const REFRESH_KEY: &str = "OAUTH_REFRESH";

/// `TokenHttp` over reqwest.
///
/// The state machine is synchronous on purpose (that is what makes it testable
/// with no runtime), so the whole run happens on a blocking thread and each
/// request is driven through a captured runtime handle. `spawn_blocking`
/// rather than `block_in_place` because the latter panics on a current-thread
/// runtime, and which flavour Tauri hands us is not this module's business.
struct ReqwestHttp {
    handle: tokio::runtime::Handle,
}

impl feral_core::oauth_device::TokenHttp for ReqwestHttp {
    fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<(u16, String), String> {
        let url = url.to_string();
        let form: Vec<(String, String)> = form
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        self.handle.block_on(async move {
            let client = reqwest::Client::new();
            let resp = client
                .post(&url)
                .form(&form)
                .send()
                .await
                .map_err(|e| format!("could not reach the provider: {e}"))?;
            let status = resp.status().as_u16();
            let body = resp.text().await.map_err(|e| e.to_string())?;
            Ok((status, body))
        })
    }
}

/// The login name a granted Twitch token belongs to. `None` on any failure —
/// pairing has already succeeded at this point, and losing a display name is
/// not a reason to tell someone their connection failed.
async fn twitch_login_for(client_id: &str, access: &str) -> Option<String> {
    let resp = reqwest::Client::new()
        .get("https://api.twitch.tv/helix/users")
        .header("Client-Id", client_id)
        .bearer_auth(access)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("data")?
        .as_array()?
        .first()?
        .get("login")?
        .as_str()
        .map(str::to_string)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn device_flow_for(id: &str) -> Result<feral_core::connectors::DeviceFlowDef, String> {
    feral_core::connectors::connector_by_id(id)
        .ok_or_else(|| format!("no connector called {id}"))?
        .device_flow
        .ok_or_else(|| "this connector is not paired with a code".to_string())
}

/// Every account the machine knows about, with the status the UI should show.
/// A machine that has never paired anything returns an empty list — the honest
/// first-run answer rather than an error.
#[tauri::command]
#[specta::specta]
pub fn connector_accounts_list() -> Vec<feral_core::connector_accounts::ConnectorAccount> {
    let now = now_secs();
    feral_core::connector_accounts::load_accounts()
        .into_iter()
        .map(|mut a| {
            a.status = feral_core::connector_accounts::effective_status(&a, now);
            a
        })
        .collect()
}

/// Begin pairing: ask the provider for a code, write down what the person has
/// to type and where, and hand back the account so the card can render it.
#[tauri::command]
#[specta::specta]
pub async fn connector_pair_start(
    id: String,
) -> Result<feral_core::connector_accounts::ConnectorAccount, String> {
    use feral_core::connector_accounts::{AccountStatus, AuthState, ConnectorAccount};

    let def = device_flow_for(&id)?;
    let handle = tokio::runtime::Handle::current();
    let label = id.clone();
    let started = tokio::task::spawn_blocking(move || {
        let http = ReqwestHttp { handle };
        feral_core::oauth_device::start_device_flow(&http, &def, now_secs())
            .map_err(|e| format!("{label}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;

    // The device code is a credential: vault, not the account file.
    feral_core::connector_secrets::put(&id, PAIRING_DEVICE_CODE, &started.device_code)
        .map_err(|e| e.to_string())?;

    let mut account = feral_core::connector_accounts::load_accounts()
        .into_iter()
        .find(|a| a.connector_id == id)
        .unwrap_or_else(|| ConnectorAccount {
            connector_id: id.clone(),
            ..Default::default()
        });
    account.status = AccountStatus::Pairing;
    account.auth_state = Some(AuthState::WaitingForUser {
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        expires_at: started.expires_at,
    });
    feral_core::connector_accounts::save_account(&account)?;
    Ok(account)
}

/// Ask once whether the person has finished. Called on the interval the
/// provider asked for; every answer is a state the card can render, including
/// the ones that are not failures.
#[tauri::command]
#[specta::specta]
pub async fn connector_pair_poll(
    id: String,
) -> Result<feral_core::connector_accounts::ConnectorAccount, String> {
    use feral_core::connector_accounts::{AccountStatus, AuthState, ConnectorAccount};
    use feral_core::oauth_device::{DeviceCode, PollOutcome};

    let def = device_flow_for(&id)?;
    let mut account = feral_core::connector_accounts::load_accounts()
        .into_iter()
        .find(|a| a.connector_id == id)
        .unwrap_or_else(|| ConnectorAccount {
            connector_id: id.clone(),
            ..Default::default()
        });

    let Some(AuthState::WaitingForUser {
        user_code,
        verification_uri,
        expires_at,
    }) = account.auth_state.clone()
    else {
        // Nothing in flight. Not an error — the caller polled a card that had
        // already finished, and the state it is in IS the answer.
        return Ok(account);
    };

    let device_code = feral_core::connector_secrets::read(
        &feral_core::connector_secrets::secret_ref(&id, PAIRING_DEVICE_CODE),
    )
    .unwrap_or_default();
    if device_code.is_empty() {
        // The vault lost it, or another machine started the flow. Say so, and
        // leave the card in a state that has a way forward.
        account.status = AccountStatus::Error("pairing was interrupted — start again".into());
        account.auth_state = None;
        feral_core::connector_accounts::save_account(&account)?;
        return Ok(account);
    }

    let code = DeviceCode {
        user_code,
        verification_uri,
        device_code,
        interval_secs: 5,
        expires_at,
    };
    let handle = tokio::runtime::Handle::current();
    let client_id = def.client_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let http = ReqwestHttp { handle };
        feral_core::oauth_device::poll_once(&http, &def, &code, now_secs())
    })
    .await
    .map_err(|e| e.to_string())?;

    match outcome {
        // Still waiting. The card keeps showing the code it already has.
        PollOutcome::Pending | PollOutcome::SlowDown => return Ok(account),
        PollOutcome::Granted(tokens) => {
            feral_core::connector_secrets::put(&id, ACCESS_KEY, &tokens.access)
                .map_err(|e| e.to_string())?;
            if let Some(refresh) = tokens.refresh.as_deref() {
                // Single-use on Twitch: the NEW one replaces the old, always.
                feral_core::connector_secrets::put(&id, REFRESH_KEY, refresh)
                    .map_err(|e| e.to_string())?;
            }
            account.status = AccountStatus::Connected;
            account.secret_ref = Some(feral_core::connector_secrets::secret_ref(&id, ACCESS_KEY));
            account.expires_at = Some(tokens.expires_at);
            account.auth_state = None;
            // Which account did they just connect? Two reasons it matters, and
            // neither is cosmetic: the card says "as <name>" so somebody with
            // two accounts can tell which one this is, and the Twitch
            // transport cannot log in to IRC without the login name matching
            // the token. Learned once, here, where the client id lives —
            // asking the person to type their own username again would be
            // asking them for something we already know.
            if let Some(login) = twitch_login_for(&client_id, &tokens.access).await {
                account.display_name = Some(login.clone());
                account.metadata.insert("TWITCH_LOGIN".into(), login.clone());
                let mut rows = feral_core::connectors::load_connector_configs();
                if let Some(row) = rows.iter_mut().find(|r| r.id == id) {
                    row.metadata.insert("TWITCH_LOGIN".into(), login);
                    let _ = feral_core::connectors::save_connector_configs(&rows);
                }
            }
        }
        PollOutcome::Denied => {
            account.status = AccountStatus::Revoked;
            account.auth_state = None;
        }
        PollOutcome::Expired => {
            // Nobody refused anything — the code simply ran out of time.
            account.status = AccountStatus::Disconnected;
            account.auth_state = None;
        }
        PollOutcome::Error(e) => {
            account.status = AccountStatus::Error(e);
            account.auth_state = None;
        }
    }

    // The pairing code has done its job either way; it is not a credential
    // worth leaving lying around.
    let _ = feral_core::connector_secrets::forget(&id, PAIRING_DEVICE_CODE);
    feral_core::connector_accounts::save_account(&account)?;
    Ok(account)
}

#[cfg(test)]
mod catalog_projection {
    /// The failure this guards against: someone adds a connector to
    /// `feral-core` and the desktop never shows it, because the desktop kept
    /// its own hand-written list. That is how the two drifted before.
    #[test]
    fn the_desktop_catalog_is_a_projection_of_the_core_one() {
        let core: Vec<String> = feral_core::connectors::connectors_catalog()
            .into_iter()
            .map(|c| c.id)
            .collect();
        let desktop: Vec<String> = super::catalog().into_iter().map(|c| c.id).collect();
        assert_eq!(core, desktop, "two catalogs have drifted — there must be one list");
    }

    /// The frontend branches on `auth_kind`, so the mapping is a contract.
    #[test]
    fn auth_kind_says_what_the_card_must_do() {
        let by_id = |id: &str| {
            super::catalog()
                .into_iter()
                .find(|c| c.id == id)
                .unwrap_or_else(|| panic!("{id} missing from the desktop catalog"))
        };
        assert_eq!(by_id("discord").auth_kind, "token", "a bot token is typed into a form");
        assert_eq!(by_id("whatsapp").auth_kind, "qr", "WhatsApp is scanned, not typed");
        assert_eq!(
            by_id("matrix").auth_kind,
            "token",
            "an instance URL plus a credential is still a form"
        );
        assert_eq!(
            by_id("twitch").auth_kind,
            "device",
            "nothing is typed here — the code goes on the provider's site"
        );
    }

    /// A connector that pairs by device code has no fields at all, and
    /// "all of nothing is filled" must not read as "ready".
    #[test]
    fn a_device_flow_connector_is_not_ready_just_because_it_has_no_fields() {
        let cfg = feral_core::connectors::blank_connector_config("twitch");
        assert!(!super::is_ready(&cfg), "twitch reported ready with no credential at all");
    }

    /// A field that is required but not secret is the case the desktop view
    /// had never carried, and the one Matrix exists to prove.
    #[test]
    fn a_non_secret_field_survives_the_projection() {
        let matrix = super::catalog().into_iter().find(|c| c.id == "matrix").unwrap();
        let url = matrix
            .fields
            .iter()
            .find(|f| f.key == "MATRIX_HOMESERVER")
            .expect("the homeserver field reaches the desktop");
        assert!(!url.secret);
    }
}
