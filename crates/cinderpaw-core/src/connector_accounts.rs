//! What a connector account *is*, on disk and to the UI.
//!
//! Before this, "connected" meant `enabled: true` in `connectors.json` — a
//! flag the user set, not a fact about a credential. A revoked Twitch token or
//! an expired OAuth grant left the flag exactly where it was, so a fresh
//! machine and a broken one looked identical on screen: enabled, silent, no
//! reason given. Status is now a *value* derived from the credential, and the
//! one function that decides it is [`effective_status`].
//!
//! Two things this record deliberately does NOT hold:
//!
//! - **A secret value.** There is no field for one. Credentials live in the
//!   vault ([`crate::connector_secrets`]); the account carries `secret_ref`,
//!   which is a name, not a value, and is safe to serialise and to show.
//! - **A pairing form.** Which fields exist is the catalog's job
//!   ([`crate::connectors::connectors_catalog`]).
//!
//! `metadata` is the home for connector settings that are **required but not
//! secret** — `MATRIX_HOMESERVER` being the case that forced it. Those were
//! previously stuffed into the `secrets` map for lack of anywhere else, which
//! put a public URL into the OS keychain and made it invisible to the user.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    /// No credential, or the user disconnected. The first-run state.
    Disconnected,
    /// A pairing is in flight (device code shown, waiting on the user).
    Pairing,
    Connected,
    /// The credential was valid and its lifetime ran out — reconnect, not a bug.
    Expired,
    /// The provider invalidated it. Reconnecting is the only cure.
    Revoked,
    /// Something failed in a way the user needs the words for.
    Error(String),
}

impl Default for AccountStatus {
    fn default() -> Self {
        AccountStatus::Disconnected
    }
}

/// What a pairing in flight is waiting on.
///
/// Internally tagged (`{"kind":"waiting_for_user", ...}`) so the frontend can
/// switch on `kind` and so a future second flow adds a variant rather than a
/// parallel set of nullable fields. Safe to do here where it was NOT safe for
/// `pairing_method`: that one ships in the catalog the Go TUI decodes as a
/// string, this file is new in this phase and nothing else reads it yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthState {
    /// The code is on screen and we are polling. `expires_at` is unix seconds:
    /// past it, the person starts again — nobody refused anything.
    WaitingForUser {
        user_code: String,
        verification_uri: String,
        expires_at: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, specta::Type)]
pub struct ConnectorAccount {
    pub connector_id: String,
    /// What the provider calls this account (`feral_bot`), for the user to
    /// recognise which login they are looking at. Absent until pairing says.
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub status: AccountStatus,
    /// Required-but-not-secret connector settings (e.g. `MATRIX_HOMESERVER`).
    #[serde(default)]
    pub metadata: HashMap<String, String>,
    /// In-flight pairing. Public values only — what the person must type and
    /// where — never the device code, which is a credential.
    #[serde(default)]
    pub auth_state: Option<AuthState>,
    /// Vault address of the credential, e.g. `connector:twitch:TWITCH_ACCESS`.
    #[serde(default)]
    pub secret_ref: Option<String>,
    /// Unix seconds. `None` means "does not expire on its own".
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// The single place that decides what the user is told.
///
/// Order matters and is the whole point: a dead credential outranks a stored
/// `Connected`, and an expiry in the future does not resurrect one the
/// provider already killed.
pub fn effective_status(account: &ConnectorAccount, now: i64) -> AccountStatus {
    match &account.status {
        // Terminal facts from the provider win over anything time-based.
        AccountStatus::Revoked => AccountStatus::Revoked,
        AccountStatus::Error(msg) => AccountStatus::Error(msg.clone()),
        AccountStatus::Connected => match account.expires_at {
            Some(exp) if exp <= now => AccountStatus::Expired,
            _ => AccountStatus::Connected,
        },
        other => other.clone(),
    }
}

/// Status of one connector by id. A machine that has never paired anything
/// has no file at all, and every connector answers `Disconnected` — the
/// honest first-run answer, not an error.
pub fn status_for(connector_id: &str, now: i64) -> AccountStatus {
    load_accounts()
        .iter()
        .find(|a| a.connector_id == connector_id)
        .map(|a| effective_status(a, now))
        .unwrap_or(AccountStatus::Disconnected)
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AccountsFile {
    #[serde(default)]
    accounts: Vec<ConnectorAccount>,
}

fn accounts_path() -> std::path::PathBuf {
    crate::paths::feral_dir().join("connector-accounts.json")
}

/// Missing file, unreadable file, or garbage in it all mean the same thing to
/// a user: nothing is paired yet. Never a startup failure.
pub fn load_accounts() -> Vec<ConnectorAccount> {
    match std::fs::read_to_string(accounts_path()) {
        Ok(raw) => serde_json::from_str::<AccountsFile>(&raw)
            .unwrap_or_default()
            .accounts,
        Err(_) => Vec::new(),
    }
}

/// Upsert by `connector_id`. Temp-file + rename, same as
/// `connectors::save_connector_configs`: a process killed mid-write leaves
/// either the old file intact or the new one whole, never a truncated one
/// that would read back as "nothing is paired".
pub fn save_account(account: &ConnectorAccount) -> Result<(), String> {
    let mut accounts = load_accounts();
    accounts.retain(|a| a.connector_id != account.connector_id);
    accounts.push(account.clone());
    save_accounts(&accounts)
}

pub fn save_accounts(accounts: &[ConnectorAccount]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(&AccountsFile {
        accounts: accounts.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    let path = accounts_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't save connector accounts: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("Couldn't save connector accounts: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Couldn't save connector accounts: {e}"))
}

/// Forget one account. The credential itself is the vault's to remove
/// ([`crate::connector_secrets::forget`]) — this drops the record.
pub fn remove_account(connector_id: &str) -> Result<(), String> {
    let mut accounts = load_accounts();
    accounts.retain(|a| a.connector_id != connector_id);
    save_accounts(&accounts)
}
