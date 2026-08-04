//! Reading the two source formats.
//!
//! Both collapse to `serde_json::Value` so the ledger and the importers only
//! ever learn one shape. Hermes's `.env` is kept apart: those keys are flat
//! secrets rather than configuration, and this increment reads their NAMES to
//! report on them and never their values.

use std::collections::BTreeMap;

use anyhow::{Context, Result};

use super::{Found, Source};

pub struct SourceData {
    pub config: serde_json::Value,
    /// Secret NAMES found in Hermes's `.env`. Values are carried but never
    /// printed, and nothing in this increment writes them anywhere.
    pub env: BTreeMap<String, String>,
}

pub fn parse_openclaw_config(text: &str) -> Result<serde_json::Value> {
    json5::from_str(text).context("OpenClaw config is not valid JSON5")
}

pub fn parse_hermes_config(text: &str) -> Result<serde_json::Value> {
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(text).context("Hermes config is not valid YAML")?;
    serde_json::to_value(yaml).context("Hermes YAML could not be normalised")
}

/// `KEY=VALUE` per line. Hand-rolled because that is the whole format — a
/// dependency for splitting on the first `=` would be worse than the code.
pub fn parse_dotenv(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue; // not a assignment; the ledger reports nothing for .env
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        out.insert(key.to_string(), value.to_string());
    }
    out
}

pub fn read_source(found: &Found) -> Result<SourceData> {
    let text = std::fs::read_to_string(&found.config)
        .with_context(|| format!("reading {}", found.config.display()))?;
    let config = match found.source {
        Source::OpenClaw => parse_openclaw_config(&text)?,
        Source::Hermes => parse_hermes_config(&text)?,
    };
    let env = match found.source {
        Source::Hermes => std::fs::read_to_string(found.root.join(".env"))
            .map(|t| parse_dotenv(&t))
            .unwrap_or_default(),
        Source::OpenClaw => BTreeMap::new(),
    };
    Ok(SourceData { config, env })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openclaw_json5_with_comments_and_trailing_commas_parses() {
        // Plain serde_json fails on this. A real user's file looks like this.
        let text = r#"{
            // the channel we care about
            channels: { discord: { enabled: true, allowFrom: ["u1"], }, },
        }"#;
        let v = parse_openclaw_config(text).unwrap();
        assert_eq!(v["channels"]["discord"]["enabled"], serde_json::json!(true));
    }

    #[test]
    fn hermes_yaml_parses_into_the_same_shape() {
        let text = "model: anthropic/claude-sonnet\napprovals:\n  mode: ask\n";
        let v = parse_hermes_config(text).unwrap();
        assert_eq!(v["model"], serde_json::json!("anthropic/claude-sonnet"));
        assert_eq!(v["approvals"]["mode"], serde_json::json!("ask"));
    }

    #[test]
    fn dotenv_keeps_names_and_ignores_comments_and_blanks() {
        let text = "# comment\n\nDISCORD_BOT_TOKEN=abc123\nexport SLACK_APP_TOKEN=xapp-1\nBAD LINE\n";
        let env = parse_dotenv(text);
        assert_eq!(env.get("DISCORD_BOT_TOKEN").map(String::as_str), Some("abc123"));
        // `export ` prefixes are common in a hand-edited .env.
        assert_eq!(env.get("SLACK_APP_TOKEN").map(String::as_str), Some("xapp-1"));
        assert_eq!(env.len(), 2);
    }

    #[test]
    fn dotenv_strips_surrounding_quotes() {
        let env = parse_dotenv("A=\"quoted\"\nB='single'\n");
        assert_eq!(env.get("A").map(String::as_str), Some("quoted"));
        assert_eq!(env.get("B").map(String::as_str), Some("single"));
    }

    #[test]
    fn an_unparseable_config_is_an_error_naming_the_file() {
        let err = parse_hermes_config("model: [unclosed\n").unwrap_err().to_string();
        assert!(err.contains("YAML"), "got {err}");
    }
}
