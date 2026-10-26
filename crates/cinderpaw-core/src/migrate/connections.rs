//! Chat connections: the bots someone already set up on Discord, Telegram,
//! Slack and the rest, with who may talk to them.
//!
//! They land in `~/.cinderpaw/connectors.json` (`connectors::save_connector_configs`;
//! the startup migration then moves the tokens into the vault) **switched off**,
//! and the Brings list says why: while OpenClaw or Hermes still runs the same
//! bot, two programs answering one bot fight over it (Telegram refuses the
//! second poller outright, Discord answers twice). Turning it on is one click
//! in Connectors once the old gateway is stopped.
//!
//! Field names: OpenClaw's from its channel manifests
//! (scripts/openclaw/openclaw-channels.json, `channels.<id>.<field>`), Hermes'
//! from the variables its gateway reads (`gateway/`, `<PLATFORM>_BOT_TOKEN`,
//! `<PLATFORM>_ALLOWED_USERS`). Who may talk: OpenClaw `allowFrom` (top level,
//! `dm.`, `accounts.default.`) plus the senders approved by pairing
//! (`state/openclaw.sqlite`, `channel_pairing_allow_entries`, read-only);
//! Hermes `<PLATFORM>_ALLOWED_USERS`.

use std::collections::{BTreeMap, BTreeSet};

use super::{Action, Found, Plan, PlanItem, Source};

struct Platform {
    /// Cinderpaw connector id; OpenClaw uses the same ids.
    id: &'static str,
    /// (OpenClaw `channels.<id>` field, Cinderpaw field key)
    openclaw: &'static [(&'static str, &'static str)],
    /// (environment variable, Cinderpaw field key); OpenClaw's `useEnv` names
    /// the same variables, so both sources read them.
    env: &'static [(&'static str, &'static str)],
    /// Hermes' allowlist variable, comma separated.
    allow_env: &'static str,
}

const PLATFORMS: &[Platform] = &[
    Platform {
        id: "discord",
        openclaw: &[("token", "DISCORD_TOKEN"), ("botToken", "DISCORD_TOKEN")],
        env: &[("DISCORD_BOT_TOKEN", "DISCORD_TOKEN")],
        allow_env: "DISCORD_ALLOWED_USERS",
    },
    Platform {
        id: "telegram",
        openclaw: &[("token", "TELEGRAM_BOT_TOKEN"), ("botToken", "TELEGRAM_BOT_TOKEN")],
        env: &[("TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN")],
        allow_env: "TELEGRAM_ALLOWED_USERS",
    },
    Platform {
        id: "slack",
        openclaw: &[("botToken", "SLACK_BOT_TOKEN"), ("appToken", "SLACK_APP_TOKEN")],
        env: &[("SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN"), ("SLACK_APP_TOKEN", "SLACK_APP_TOKEN")],
        allow_env: "SLACK_ALLOWED_USERS",
    },
    Platform {
        id: "matrix",
        openclaw: &[("homeserver", "MATRIX_HOMESERVER"), ("accessToken", "MATRIX_ACCESS_TOKEN")],
        env: &[("MATRIX_HOMESERVER", "MATRIX_HOMESERVER"), ("MATRIX_ACCESS_TOKEN", "MATRIX_ACCESS_TOKEN")],
        allow_env: "MATRIX_ALLOWED_USERS",
    },
    Platform {
        id: "mattermost",
        openclaw: &[("httpUrl", "MATTERMOST_URL"), ("botToken", "MATTERMOST_TOKEN"), ("token", "MATTERMOST_TOKEN")],
        env: &[("MATTERMOST_URL", "MATTERMOST_URL"), ("MATTERMOST_TOKEN", "MATTERMOST_TOKEN"), ("MATTERMOST_BOT_TOKEN", "MATTERMOST_TOKEN")],
        allow_env: "MATTERMOST_ALLOWED_USERS",
    },
    Platform {
        id: "signal",
        openclaw: &[("signalNumber", "SIGNAL_NUMBER"), ("httpUrl", "SIGNAL_BRIDGE_URL")],
        env: &[("SIGNAL_ACCOUNT", "SIGNAL_NUMBER"), ("SIGNAL_HTTP_URL", "SIGNAL_BRIDGE_URL")],
        allow_env: "SIGNAL_ALLOWED_USERS",
    },
    Platform { id: "zalo", openclaw: &[("token", "ZALO_BOT_TOKEN"), ("botToken", "ZALO_BOT_TOKEN")], env: &[("ZALO_BOT_TOKEN", "ZALO_BOT_TOKEN")], allow_env: "" },
    Platform {
        id: "line",
        openclaw: &[("channelAccessToken", "LINE_CHANNEL_ACCESS_TOKEN"), ("channelSecret", "LINE_CHANNEL_SECRET")],
        env: &[],
        allow_env: "",
    },
    Platform {
        id: "nostr",
        openclaw: &[("privateKey", "NOSTR_PRIVATE_KEY"), ("relayUrls", "NOSTR_RELAY_URLS")],
        env: &[("NOSTR_PRIVATE_KEY", "NOSTR_PRIVATE_KEY")],
        allow_env: "",
    },
    Platform { id: "irc", openclaw: &[("host", "IRC_HOST"), ("nick", "IRC_NICK"), ("password", "IRC_PASSWORD")], env: &[], allow_env: "" },
    Platform {
        id: "synology-chat",
        openclaw: &[("token", "SYNOLOGY_CHAT_TOKEN"), ("webhookUrl", "SYNOLOGY_CHAT_WEBHOOK_URL"), ("url", "SYNOLOGY_CHAT_WEBHOOK_URL")],
        env: &[("SYNOLOGY_CHAT_TOKEN", "SYNOLOGY_CHAT_TOKEN")],
        allow_env: "",
    },
    Platform {
        id: "sms",
        openclaw: &[("accountSid", "TWILIO_ACCOUNT_SID"), ("authToken", "TWILIO_AUTH_TOKEN"), ("fromNumber", "TWILIO_FROM_NUMBER")],
        env: &[],
        allow_env: "",
    },
];

/// Channel ids this module brings over (or reports), so their config is not
/// also listed as left behind.
pub fn handled() -> impl Iterator<Item = &'static str> {
    PLATFORMS.iter().map(|p| p.id)
}

/// `.env` variables this module brings over (tokens and allowlists), so they
/// are not also listed as left behind.
pub fn env_vars() -> impl Iterator<Item = &'static str> {
    PLATFORMS
        .iter()
        .flat_map(|p| p.env.iter().map(|(v, _)| *v).chain((!p.allow_env.is_empty()).then_some(p.allow_env)))
}

/// A string setting, with `${VAR}` resolved from `env`; anything else (a
/// number, an array of relays) as text.
fn value(v: &serde_json::Value, env: &BTreeMap<String, String>) -> Option<String> {
    let s = match v {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Array(a) => a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(","),
        _ => return None, // a secret reference object: nothing we can resolve here
    };
    let s = match s.strip_prefix("${").and_then(|r| r.strip_suffix('}')) {
        Some(var) => env.get(var)?.trim().to_string(),
        None => s,
    };
    (!s.is_empty()).then_some(s)
}

fn ids(v: Option<&serde_json::Value>) -> Vec<String> {
    v.and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string).or_else(|| x.as_i64().map(|n| n.to_string()))).collect())
        .unwrap_or_default()
}

/// Senders approved through OpenClaw's DM pairing, per channel.
fn paired(found: &Found) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = rusqlite::Connection::open_with_flags(found.root.join("state/openclaw.sqlite"), flags) else { return out };
    let Ok(mut stmt) = conn.prepare("SELECT channel_key, entry FROM channel_pairing_allow_entries ORDER BY sort_order") else { return out };
    let rows: Vec<(String, String)> = match stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => vec![],
    };
    for (channel, entry) in rows {
        out.entry(channel).or_default().push(entry);
    }
    out
}

pub struct Connection {
    pub id: &'static str,
    pub secrets: BTreeMap<String, String>,
    pub allowlist: Vec<String>,
    /// What could not come over with it, for the Brings line.
    pub notes: Vec<String>,
}

/// The connections `found` holds, read-only.
pub fn find_connections(found: &Found, config: &serde_json::Value, env: &BTreeMap<String, String>) -> Vec<Connection> {
    let pairs = if found.source == Source::OpenClaw { paired(found) } else { BTreeMap::new() };
    let mut out = Vec::new();
    for p in PLATFORMS {
        let mut secrets = BTreeMap::new();
        let mut allow: Vec<String> = Vec::new();
        let mut notes = Vec::new();
        if found.source == Source::OpenClaw {
            if let Some(ch) = config.get("channels").and_then(|c| c.get(p.id)) {
                // The top level, or the default account of a multi-account channel.
                let account = ch.get("accounts").and_then(|a| a.get("default"));
                for (field, key) in p.openclaw {
                    if let Some(v) = ch.get(*field).or_else(|| account.and_then(|a| a.get(*field))).and_then(|v| value(v, env)) {
                        secrets.entry(key.to_string()).or_insert(v);
                    }
                }
                for list in [ch.get("allowFrom"), ch.get("dm").and_then(|d| d.get("allowFrom")), account.and_then(|a| a.get("allowFrom"))] {
                    allow.extend(ids(list));
                }
            }
            allow.extend(pairs.get(p.id).cloned().unwrap_or_default());
        }
        for (var, key) in p.env {
            if let Some(v) = env.get(*var).map(|v| v.trim()).filter(|v| !v.is_empty() && !v.starts_with("${")) {
                secrets.entry(key.to_string()).or_insert_with(|| v.to_string());
            }
        }
        if found.source == Source::Hermes && !p.allow_env.is_empty() {
            if let Some(list) = env.get(p.allow_env) {
                allow.extend(list.split(',').map(|s| s.trim().to_string()));
            }
        }
        if secrets.is_empty() {
            continue;
        }
        if allow.iter().any(|a| a == "*") {
            notes.push("it answered everyone; Cinderpaw answers only the people you list".to_string());
        }
        let mut seen = BTreeSet::new();
        allow.retain(|a| !a.is_empty() && a != "*" && seen.insert(a.clone()));
        out.push(Connection { id: p.id, secrets, allowlist: allow, notes });
    }
    out
}

/// Add the source's chat connections to `plan`. `has_connector` says whether
/// Cinderpaw already has that connector set up: that one is kept.
pub fn plan_connections_into(found: &Found, overwrite: bool, has_connector: &dyn Fn(&str) -> bool, plan: &mut Plan) {
    let Ok(data) = super::read_source(found) else { return };
    let mut env = data.env.clone();
    if found.source == Source::OpenClaw {
        if let Ok(text) = std::fs::read_to_string(found.root.join(".env")) {
            env.extend(super::source::parse_dotenv(&text));
        }
        for obj in [data.config.get("env"), data.config.get("env").and_then(|e| e.get("vars"))].into_iter().flatten() {
            if let Some(map) = obj.as_object() {
                env.extend(map.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))));
            }
        }
    }
    for c in find_connections(found, &data.config, &env) {
        let Some(entry) = crate::connectors::connector_by_id(c.id) else { continue };
        if entry.coming_soon {
            plan.not_imported.push(format!("{} — Cinderpaw cannot connect to it yet", entry.name));
            continue;
        }
        if has_connector(c.id) && !overwrite {
            plan.conflicts.push(format!("{}: already set up in Cinderpaw, kept yours", entry.name));
            continue;
        }
        let missing: Vec<String> = entry
            .pairing_fields
            .iter()
            .filter(|f| !c.secrets.contains_key(&f.key))
            .map(|f| f.label.clone())
            .collect();
        let mut note = vec!["off until you turn it on in Connectors; stop the old gateway first so they do not fight over the bot".to_string()];
        if c.allowlist.is_empty() {
            note.push("nobody may talk to it yet: add your user ID".to_string());
        }
        if !missing.is_empty() {
            note.push(format!("still needs: {}", missing.join(", ")));
        }
        note.extend(c.notes);
        plan.will_import.push(PlanItem {
            what: format!("chat: {}", entry.name),
            target: crate::paths::cinderpaw_dir().join("connectors.json").display().to_string(),
            note: Some(note.join("; ")),
            source: found.config.clone(),
            action: Action::Connector { id: c.id.to_string(), secrets: c.secrets, allowlist: c.allowlist },
        });
    }
}

/// Write one imported connection, switched off.
pub fn save(id: &str, secrets: &BTreeMap<String, String>, allowlist: &[String]) -> anyhow::Result<()> {
    let mut rows = crate::connectors::load_connector_configs();
    rows.retain(|r| r.id != id);
    let mut row = crate::connectors::blank_connector_config(id);
    row.secrets = secrets.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    row.allowlist = allowlist.to_vec();
    row.enabled = false;
    rows.push(row);
    crate::connectors::save_connector_configs(&rows).map_err(anyhow::Error::msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn empty_plan() -> Plan {
        Plan { will_import: vec![], not_imported: vec![], conflicts: vec![], backup_dir: std::path::PathBuf::from("b") }
    }

    #[test]
    fn every_platform_names_a_real_connector_and_its_fields() {
        for p in PLATFORMS {
            let entry = crate::connectors::connector_by_id(p.id).unwrap_or_else(|| panic!("no connector {}", p.id));
            let keys: Vec<_> = entry.pairing_fields.iter().map(|f| f.key.as_str()).collect();
            for (_, key) in p.openclaw.iter().chain(p.env) {
                assert!(keys.contains(key), "{}: {key} is not one of {keys:?}", p.id);
            }
        }
    }

    #[test]
    fn openclaw_channels_with_allowlists_pairings_and_env_tokens() {
        let src = tempdir().unwrap();
        fs::write(
            src.path().join("openclaw.json"),
            r#"{ channels: {
                 telegram: { token: "${TG}", allowFrom: [123, "*"] },
                 discord: { accounts: { default: { token: "d-1", allowFrom: ["555"] } } },
                 slack: { botToken: "xoxb-1" } },
               env: { TG: "t-1" } }"#,
        )
        .unwrap();
        fs::create_dir_all(src.path().join("state")).unwrap();
        let conn = rusqlite::Connection::open(src.path().join("state/openclaw.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE channel_pairing_allow_entries (channel_key TEXT, account_id TEXT, entry TEXT, sort_order INTEGER, updated_at INTEGER);
             INSERT INTO channel_pairing_allow_entries VALUES ('telegram', 'default', '777', 0, 0);",
        )
        .unwrap();
        drop(conn);
        let found = Found { source: Source::OpenClaw, root: src.path().to_path_buf(), config: src.path().join("openclaw.json"), version: None };
        let mut plan = empty_plan();
        plan_connections_into(&found, false, &|id| id == "slack", &mut plan);

        let what: Vec<_> = plan.will_import.iter().map(|i| i.what.as_str()).collect();
        assert_eq!(what, ["chat: Discord", "chat: Telegram"]);
        assert_eq!(plan.conflicts, ["Slack: already set up in Cinderpaw, kept yours"]);
        match &plan.will_import[1].action {
            Action::Connector { secrets, allowlist, .. } => {
                assert_eq!(secrets.get("TELEGRAM_BOT_TOKEN").map(String::as_str), Some("t-1"));
                assert_eq!(allowlist, &["123", "777"]);
            }
            _ => panic!("not a connector"),
        }
        let note = plan.will_import[1].note.as_deref().unwrap();
        assert!(note.starts_with("off until you turn it on"), "{note}");
        assert!(note.contains("answered everyone"), "{note}");
        assert!(!serde_json::to_string(&plan).unwrap().contains("t-1"));
    }

    #[test]
    fn hermes_env_tokens_and_allowed_users_and_an_empty_allowlist_is_said() {
        let src = tempdir().unwrap();
        fs::write(src.path().join("config.yaml"), "model: x\n").unwrap();
        fs::write(src.path().join(".env"), "TELEGRAM_BOT_TOKEN=t-2\nTELEGRAM_ALLOWED_USERS=11, 22\nDISCORD_BOT_TOKEN=d-2\n").unwrap();
        let found = Found { source: Source::Hermes, root: src.path().to_path_buf(), config: src.path().join("config.yaml"), version: None };
        let mut plan = empty_plan();
        plan_connections_into(&found, false, &|_| false, &mut plan);
        let what: Vec<_> = plan.will_import.iter().map(|i| i.what.as_str()).collect();
        assert_eq!(what, ["chat: Discord", "chat: Telegram"]);
        assert!(plan.will_import[0].note.as_deref().unwrap().contains("nobody may talk to it yet"));
        match &plan.will_import[1].action {
            Action::Connector { allowlist, .. } => assert_eq!(allowlist, &["11", "22"]),
            _ => panic!(),
        }
    }
}
