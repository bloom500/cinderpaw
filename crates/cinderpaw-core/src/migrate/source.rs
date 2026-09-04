//! Reading the two source formats.
//!
//! Both collapse to `serde_json::Value` so the ledger and the importers only
//! ever learn one shape. Hermes's `.env` is kept apart: those keys are flat
//! secrets rather than configuration, and this increment reads their NAMES to
//! report on them and never their values.

use std::collections::BTreeMap;

use anyhow::{Context, Result};

use super::{Found, Source};

#[derive(Debug)]
pub struct SourceData {
    pub config: serde_json::Value,
    /// Secret NAMES found in Hermes's `.env`. Values are carried but never
    /// printed, and nothing in this increment writes them anywhere.
    pub env: BTreeMap<String, String>,
    /// Set when Hermes's `.env` exists but could not be read (permissions,
    /// IO error, symlink problem...). A *missing* `.env` is the normal case
    /// and leaves this `None` with `env` empty; this field is how a caller
    /// tells "no secrets" apart from "secrets we couldn't read". Never
    /// carries a secret value — only an IO error message and the path.
    pub env_error: Option<String>,
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
        // Quoted values keep their comment-stripping quirks as-is (out of
        // scope here); only bare, unquoted values get inline `#` comments
        // stripped, since a quoted value visually owns everything inside it.
        let value = if value.starts_with('"') || value.starts_with('\'') {
            value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value)
        } else {
            strip_unquoted_comment(value)
        };
        out.insert(key.to_string(), value.to_string());
    }
    out
}

/// A ` #` (whitespace then `#`) starts a trailing comment on an unquoted
/// value. A bare `#` with no preceding whitespace stays part of the value —
/// tokens and passwords legitimately contain `#`, and stripping those would
/// be a worse bug than the one this exists to fix.
fn strip_unquoted_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    for i in 1..bytes.len() {
        if bytes[i] == b'#' && bytes[i - 1].is_ascii_whitespace() {
            return value[..i].trim_end();
        }
    }
    value
}

pub fn read_source(found: &Found) -> Result<SourceData> {
    let text = std::fs::read_to_string(&found.config)
        .with_context(|| format!("reading {}", found.config.display()))?;
    let config = match found.source {
        Source::OpenClaw => parse_openclaw_config(&text),
        Source::Hermes => parse_hermes_config(&text),
    }
    .with_context(|| format!("parsing {}", found.config.display()))?;
    let (env, env_error) = match found.source {
        Source::Hermes => {
            let env_path = found.root.join(".env");
            match std::fs::read_to_string(&env_path) {
                Ok(t) => (parse_dotenv(&t), None),
                // No `.env` at all is the normal, silent case.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (BTreeMap::new(), None),
                // Exists but couldn't be read: say so, don't report zero secrets.
                Err(e) => (BTreeMap::new(), Some(format!("reading {}: {e}", env_path.display()))),
            }
        }
        Source::OpenClaw => (BTreeMap::new(), None),
    };
    Ok(SourceData { config, env, env_error })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

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
    fn dotenv_strips_whitespace_preceded_inline_comment() {
        let env = parse_dotenv("PORT=3000 # the app port\n");
        assert_eq!(env.get("PORT").map(String::as_str), Some("3000"));
    }

    #[test]
    fn dotenv_keeps_bare_hash_with_no_preceding_whitespace() {
        // Tokens and passwords legitimately contain `#`.
        let env = parse_dotenv("TOKEN=abc#123\n");
        assert_eq!(env.get("TOKEN").map(String::as_str), Some("abc#123"));
    }

    #[test]
    fn hermes_config_parse_error_mentions_the_format() {
        // This is the pure parser: it has no file path to report, only the
        // format. `read_source_error_names_the_config_file` below covers the
        // filename, which only `read_source` has enough context to attach.
        let err = parse_hermes_config("model: [unclosed\n").unwrap_err().to_string();
        assert!(err.contains("YAML"), "got {err}");
    }

    #[test]
    fn read_source_error_names_the_config_file() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hermes");
        fs::create_dir_all(&root).unwrap();
        let config = root.join("config.yaml");
        fs::write(&config, "model: [unclosed\n").unwrap();
        let found = Found { source: Source::Hermes, root, config: config.clone(), version: None };

        let err = read_source(&found).unwrap_err().to_string();
        assert!(err.contains(&config.display().to_string()), "got {err}");
    }

    #[test]
    fn read_source_dispatches_openclaw_by_source() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join(".openclaw");
        fs::create_dir_all(&root).unwrap();
        let config = root.join("openclaw.json");
        fs::write(&config, r#"{ channels: { discord: { enabled: true } } }"#).unwrap();
        let found = Found { source: Source::OpenClaw, root, config, version: None };

        let data = read_source(&found).unwrap();
        assert_eq!(data.config["channels"]["discord"]["enabled"], serde_json::json!(true));
        assert!(data.env.is_empty());
        assert!(data.env_error.is_none());
    }

    #[test]
    fn read_source_reads_hermes_env_alongside_config() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hermes");
        fs::create_dir_all(&root).unwrap();
        let config = root.join("config.yaml");
        fs::write(&config, "model: anthropic/claude-sonnet\n").unwrap();
        fs::write(root.join(".env"), "DISCORD_BOT_TOKEN=abc123\n").unwrap();
        let found = Found { source: Source::Hermes, root, config, version: None };

        let data = read_source(&found).unwrap();
        assert_eq!(data.config["model"], serde_json::json!("anthropic/claude-sonnet"));
        assert_eq!(data.env.get("DISCORD_BOT_TOKEN").map(String::as_str), Some("abc123"));
        assert!(data.env_error.is_none());
    }

    #[test]
    fn hermes_missing_env_is_silently_empty() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hermes");
        fs::create_dir_all(&root).unwrap();
        let config = root.join("config.yaml");
        fs::write(&config, "model: x\n").unwrap();
        let found = Found { source: Source::Hermes, root, config, version: None };

        let data = read_source(&found).unwrap();
        assert!(data.env.is_empty());
        assert!(data.env_error.is_none());
    }

    #[test]
    fn hermes_env_unreadable_is_reported_not_silently_empty() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hermes");
        fs::create_dir_all(&root).unwrap();
        let config = root.join("config.yaml");
        fs::write(&config, "model: x\n").unwrap();
        // A directory named `.env` exists but is not readable as text — this
        // is NOT the NotFound case, so it must not collapse to silent-empty.
        fs::create_dir_all(root.join(".env")).unwrap();
        let found = Found { source: Source::Hermes, root, config, version: None };

        let data = read_source(&found).unwrap();
        assert!(data.env.is_empty());
        assert!(data.env_error.is_some(), "expected env_error to be set");
    }
}
