//! AI provider keys, so someone coming over does not have to make new ones.
//!
//! The hardest step of a first run is getting a key; a person coming from
//! OpenClaw or Hermes already has one on this computer. With their yes (the
//! Bring it over button, the key listed under "What exactly?") it moves into
//! Cinderpaw's own store (`byok::save_provider`, the OS keychain), never into
//! a file and never into the plan the UI sees (`Action::Key` is not serialised
//! and its Debug hides the secret).
//!
//! Where the keys are:
//! - Hermes: `~/.hermes/.env`, one variable per provider.
//! - OpenClaw: auth profiles, `{version, profiles: {"<provider>:<name>": {type,
//!   provider, key}}}`, in `agents/<id>/agent/openclaw-agent.sqlite` (table
//!   `auth_profile_store`, current) or `agents/<id>/agent/auth-profiles.json`
//!   (older); plus `~/.openclaw/.env` and the config's inline `env` block.
//!
//! Sign-ins (OAuth) are not keys: copying a refresh grant would leave two apps
//! fighting over one session, so those are listed as "sign in again".

use std::collections::BTreeMap;
use std::path::Path;

use super::{Action, Found, Plan, PlanItem, Source};

/// Environment variable → Cinderpaw provider id (`byok::provider_catalog`).
/// From OpenClaw's own Hermes importer (extensions/migrate-hermes/
/// secret-mappings.ts), narrowed to providers Cinderpaw has; China-only and
/// coding-plan variants are left out because their keys do not work on the
/// endpoint Cinderpaw's provider uses.
pub const ENV_KEYS: &[(&str, &str)] = &[
    ("OPENAI_API_KEY", "openai"),
    ("ANTHROPIC_API_KEY", "anthropic"),
    ("OPENROUTER_API_KEY", "openrouter"),
    ("GOOGLE_API_KEY", "google"),
    ("GEMINI_API_KEY", "google"),
    ("GROQ_API_KEY", "groq"),
    ("XAI_API_KEY", "xai"),
    ("MISTRAL_API_KEY", "mistral"),
    ("DEEPSEEK_API_KEY", "deepseek"),
    ("GLM_API_KEY", "glm"),
    ("ZAI_API_KEY", "glm"),
    ("Z_AI_API_KEY", "glm"),
    // Hermes sends `sk-kimi-` keys to Kimi Code and the rest to Moonshot
    // (hermes_cli/auth.py); `provider_for` does the same.
    ("KIMI_API_KEY", "moonshot"),
    ("KIMI_CODING_API_KEY", "moonshot"),
    ("MOONSHOT_API_KEY", "moonshot"),
    ("MINIMAX_API_KEY", "minimax"),
    ("DASHSCOPE_API_KEY", "qwen"),
    ("QWEN_API_KEY", "qwen"),
    ("MODELSTUDIO_API_KEY", "qwen"),
    ("ALIBABA_API_KEY", "qwen"),
    ("KILOCODE_API_KEY", "kilocode"),
    ("HF_TOKEN", "huggingface"),
    ("HUGGINGFACE_HUB_TOKEN", "huggingface"),
    ("TOGETHER_API_KEY", "together"),
    ("FIREWORKS_API_KEY", "fireworks"),
    ("DEEPINFRA_API_KEY", "deepinfra"),
    ("CEREBRAS_API_KEY", "cerebras"),
    ("NVIDIA_API_KEY", "nvidia"),
    ("VENICE_API_KEY", "venice"),
    ("XIAOMI_API_KEY", "xiaomi"),
    ("CHUTES_API_KEY", "chutes"),
    ("COHERE_API_KEY", "cohere"),
    ("NOVITA_API_KEY", "novita"),
];

/// OpenClaw provider ids that Cinderpaw spells differently.
const OPENCLAW_ALIASES: &[(&str, &str)] = &[("zai", "glm"), ("z-ai", "glm"), ("gemini", "google"), ("kimi-coding", "kimi")];

/// The Z.AI address Hermes and OpenClaw use. Cinderpaw's own `glm` default is
/// the coding-plan address, where a pay-as-you-go key is refused.
const ZAI_GENERAL: &str = "https://api.z.ai/api/paas/v4";

#[derive(Clone, PartialEq)]
pub struct Key {
    pub provider: String,
    pub secret: String,
    pub base_url: Option<String>,
    /// Where it was found, for the Brings list: ".env OPENAI_API_KEY".
    pub from: String,
}

fn usable(secret: &str) -> bool {
    let s = secret.trim();
    // `${VAR}` is a reference to another variable, not a key.
    !s.is_empty() && !s.starts_with("${")
}

fn provider_for(provider: &str, secret: &str) -> String {
    if provider == "moonshot" && secret.starts_with("sk-kimi-") {
        return "kimi".into();
    }
    provider.into()
}

fn base_url_for(provider: &str, env: &BTreeMap<String, String>) -> Option<String> {
    (provider == "glm").then(|| env.get("GLM_BASE_URL").filter(|u| usable(u)).cloned().unwrap_or_else(|| ZAI_GENERAL.into()))
}

/// Keys among environment variables (a `.env` file, OpenClaw's inline `env`).
pub fn from_env(env: &BTreeMap<String, String>, origin: &str, out: &mut Vec<Key>) {
    for (var, provider) in ENV_KEYS {
        let Some(secret) = env.get(*var).filter(|s| usable(s)) else { continue };
        let provider = provider_for(provider, secret);
        out.push(Key {
            base_url: base_url_for(&provider, env),
            provider,
            secret: secret.trim().to_string(),
            from: format!("{origin} {var}"),
        });
    }
}

/// Keys in one OpenClaw auth-profile store; sign-ins go to `skipped`.
pub fn from_profiles(store: &serde_json::Value, origin: &str, known: &dyn Fn(&str) -> bool, out: &mut Vec<Key>, skipped: &mut Vec<String>) {
    let Some(profiles) = store.get("profiles").and_then(|p| p.as_object()) else { return };
    for (name, p) in profiles {
        let kind = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let raw = p.get("provider").and_then(|t| t.as_str()).unwrap_or_else(|| name.split(':').next().unwrap_or(""));
        let provider = OPENCLAW_ALIASES.iter().find(|(a, _)| *a == raw).map(|(_, c)| *c).unwrap_or(raw);
        if kind != "api_key" {
            skipped.push(format!("{origin} {name} — a sign-in, not a key; sign in again in Cinderpaw"));
            continue;
        }
        let Some(secret) = p.get("key").or_else(|| p.get("apiKey")).and_then(|k| k.as_str()).filter(|s| usable(s)) else { continue };
        let provider = provider_for(provider, secret);
        if !known(&provider) {
            skipped.push(format!("{origin} {name} — Cinderpaw has no {raw} provider yet"));
            continue;
        }
        let base_url = (provider == "glm").then(|| ZAI_GENERAL.to_string());
        out.push(Key { provider, secret: secret.trim().to_string(), base_url, from: format!("{origin} {name}") });
    }
}

/// `store_json` rows of OpenClaw's agent database, opened read-only.
fn sqlite_stores(db: &Path) -> Vec<String> {
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = rusqlite::Connection::open_with_flags(db, flags) else { return vec![] };
    let Ok(mut stmt) = conn.prepare("SELECT store_json FROM auth_profile_store") else { return vec![] };
    let rows: Vec<String> = match stmt.query_map([], |r| r.get::<_, String>(0)) {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => vec![],
    };
    rows
}

fn openclaw_keys(found: &Found, config: &serde_json::Value, known: &dyn Fn(&str) -> bool) -> (Vec<Key>, Vec<String>) {
    let (mut keys, mut skipped) = (Vec::new(), Vec::new());
    let mut agents: Vec<_> = std::fs::read_dir(found.root.join("agents"))
        .map(|it| it.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    agents.sort();
    for agent in agents {
        let dir = agent.join("agent");
        let id = agent.file_name().and_then(|n| n.to_str()).unwrap_or("agent").to_string();
        for store in sqlite_stores(&dir.join("openclaw-agent.sqlite")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&store) {
                from_profiles(&v, &format!("agent {id}:"), known, &mut keys, &mut skipped);
            }
        }
        if let Some(v) = std::fs::read_to_string(dir.join("auth-profiles.json")).ok().and_then(|t| serde_json::from_str(&t).ok()) {
            from_profiles(&v, &format!("agent {id}:"), known, &mut keys, &mut skipped);
        }
    }
    if let Ok(text) = std::fs::read_to_string(found.root.join(".env")) {
        from_env(&super::source::parse_dotenv(&text), ".env", &mut keys);
    }
    // config `env.VAR` and `env.vars.VAR`
    let mut inline = BTreeMap::new();
    for obj in [config.get("env"), config.get("env").and_then(|e| e.get("vars"))].into_iter().flatten() {
        if let Some(map) = obj.as_object() {
            inline.extend(map.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))));
        }
    }
    from_env(&inline, "config env", &mut keys);
    (keys, skipped)
}

/// Every key the source holds, one per provider (the first found wins), and
/// the sign-ins that cannot come over.
pub fn find_keys(found: &Found, known: &dyn Fn(&str) -> bool) -> (Vec<Key>, Vec<String>) {
    let (mut keys, skipped) = match super::read_source(found) {
        Ok(data) => match found.source {
            Source::OpenClaw => openclaw_keys(found, &data.config, known),
            Source::Hermes => {
                let mut keys = Vec::new();
                from_env(&data.env, ".env", &mut keys);
                (keys, Vec::new())
            }
        },
        Err(_) => (Vec::new(), Vec::new()), // `leftovers` already says the config is unreadable
    };
    let mut seen = std::collections::BTreeSet::new();
    keys.retain(|k| seen.insert(k.provider.clone()));
    (keys, skipped)
}

/// Add the source's keys to `plan`. `has_key` says whether Cinderpaw already
/// holds one for a provider: that one is kept.
pub fn plan_keys_into(found: &Found, overwrite: bool, has_key: &dyn Fn(&str) -> bool, known: &dyn Fn(&str) -> bool, plan: &mut Plan) {
    let (keys, skipped) = find_keys(found, known);
    plan.not_imported.extend(skipped);
    for k in keys {
        if has_key(&k.provider) && !overwrite {
            plan.conflicts.push(format!("key for {}: Cinderpaw already has one, kept yours", k.provider));
            continue;
        }
        plan.will_import.push(PlanItem {
            what: format!("key: {} (from {})", k.provider, k.from),
            target: format!("keychain: {}", k.provider),
            note: has_key(&k.provider).then(|| "replaces the key Cinderpaw had".to_string()),
            source: found.root.clone(),
            action: Action::Key { provider: k.provider, secret: k.secret, base_url: k.base_url },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn known(id: &str) -> bool {
        crate::byok::provider_catalog().iter().any(|e| e.id == id)
    }
    fn empty_plan() -> Plan {
        Plan { will_import: vec![], not_imported: vec![], conflicts: vec![], backup_dir: std::path::PathBuf::from("b") }
    }

    #[test]
    fn every_mapped_variable_names_a_cinderpaw_provider() {
        for (var, id) in ENV_KEYS {
            assert!(known(id), "{var} maps to {id}, which is not in the provider catalog");
        }
        for (_, id) in OPENCLAW_ALIASES {
            assert!(known(id));
        }
        assert!(known("kimi"));
    }

    #[test]
    fn hermes_env_keys_come_over_and_kimi_code_keys_go_to_kimi() {
        let src = tempdir().unwrap();
        fs::write(src.path().join("config.yaml"), "model: x\n").unwrap();
        fs::write(
            src.path().join(".env"),
            "OPENROUTER_API_KEY=sk-or-1\nKIMI_API_KEY=sk-kimi-abc\nGLM_API_KEY=zz\nUNRELATED=1\nOPENAI_API_KEY=${OTHER}\n",
        )
        .unwrap();
        let found = Found { source: Source::Hermes, root: src.path().to_path_buf(), config: src.path().join("config.yaml"), version: None };
        let mut plan = empty_plan();
        plan_keys_into(&found, false, &|p| p == "openrouter", &known, &mut plan);
        let what: Vec<_> = plan.will_import.iter().map(|i| i.what.as_str()).collect();
        assert_eq!(what, ["key: glm (from .env GLM_API_KEY)", "key: kimi (from .env KIMI_API_KEY)"]);
        assert_eq!(plan.conflicts, ["key for openrouter: Cinderpaw already has one, kept yours"]);
        match &plan.will_import[0].action {
            Action::Key { base_url, .. } => assert_eq!(base_url.as_deref(), Some(ZAI_GENERAL)),
            _ => panic!("not a key"),
        }
        // The plan the UI sees carries no secret.
        let json = serde_json::to_string(&plan).unwrap();
        assert!(!json.contains("sk-kimi-abc") && !json.contains("zz\""), "{json}");
        assert!(!format!("{:?}", plan).contains("sk-kimi-abc"));
    }

    #[test]
    fn openclaw_profiles_from_sqlite_json_and_env_and_sign_ins_are_listed() {
        let src = tempdir().unwrap();
        let agent = src.path().join("agents/main/agent");
        fs::create_dir_all(&agent).unwrap();
        fs::write(src.path().join("openclaw.json"), r#"{ env: { vars: { GROQ_API_KEY: "gsk-1" } } }"#).unwrap();
        fs::write(src.path().join(".env"), "MISTRAL_API_KEY=m-1\n").unwrap();
        // The current store: Darius's real install has exactly this shape (an NVIDIA key).
        let conn = rusqlite::Connection::open(agent.join("openclaw-agent.sqlite")).unwrap();
        conn.execute_batch(
            r#"CREATE TABLE auth_profile_store (store_key TEXT, store_json TEXT, updated_at INTEGER);
               INSERT INTO auth_profile_store VALUES ('primary', '{"version":1,"profiles":{"nvidia:default":{"type":"api_key","provider":"nvidia","key":"nvapi-1"},"openai-codex:me":{"type":"oauth","provider":"openai-codex","access":"a"}}}', 0);"#,
        )
        .unwrap();
        drop(conn);
        fs::write(agent.join("auth-profiles.json"), r#"{"version":1,"profiles":{"zai:default":{"type":"api_key","provider":"zai","key":"z-1"},"acme:default":{"type":"api_key","provider":"acme","key":"q"}}}"#).unwrap();
        let found = Found { source: Source::OpenClaw, root: src.path().to_path_buf(), config: src.path().join("openclaw.json"), version: None };
        let mut plan = empty_plan();
        plan_keys_into(&found, false, &|_| false, &known, &mut plan);
        let what: Vec<_> = plan.will_import.iter().map(|i| i.what.as_str()).collect();
        assert_eq!(
            what,
            [
                "key: nvidia (from agent main: nvidia:default)",
                "key: glm (from agent main: zai:default)",
                "key: mistral (from .env MISTRAL_API_KEY)",
                "key: groq (from config env GROQ_API_KEY)",
            ]
        );
        assert!(plan.not_imported.iter().any(|l| l.contains("openai-codex:me — a sign-in")));
        assert!(plan.not_imported.iter().any(|l| l.contains("no acme provider")));
        // Read-only: the source database is untouched.
        assert!(agent.join("openclaw-agent.sqlite").is_file());
    }
}
