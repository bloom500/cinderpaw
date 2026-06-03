use anyhow::Result;
use std::path::PathBuf;

pub const FERAL_GATEWAY_PORT: u16 = 18790;

/// Check whether a local OpenClaw gateway is already listening on `port`.
/// Does a non-blocking TCP connect attempt with a short timeout.
pub fn probe_gateway_port(port: u16) -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_millis(200),
    ).is_ok()
}

pub fn config_path() -> PathBuf {
    crate::paths::feral_dir().join("openclaw-feral.json")
}

pub fn write_feral_config(token: &str) -> Result<()> {
    crate::paths::ensure_dirs()?;
    let content = build_config(token);
    std::fs::write(config_path(), content)?;
    Ok(())
}

fn build_config(token: &str) -> String {
    let v = serde_json::json!({
        "gateway": {
            "mode": "local",
            "port": FERAL_GATEWAY_PORT,
            "bind": "loopback",
            "auth": { "mode": "token", "token": token },
            // Enable the OpenAI-compatible HTTP API — Feral's runner POSTs to
            // /v1/chat/completions. Disabled by default in OpenClaw.
            "http": {
                "endpoints": {
                    "chatCompletions": { "enabled": true }
                }
            }
        },
        "models": {
            "providers": {
                "feral": {
                    "baseUrl": "http://localhost:11435/v1",
                    "api": "openai-completions",
                    // Local CPU inference can take minutes for the first token.
                    // OpenClaw's default LLM timeout (~12s) is far too short.
                    "timeoutSeconds": 600,
                    "models": [{ "id": "current", "name": "Feral Local Model" }]
                }
            }
        },
        "agents": {
            "defaults": {
                "model": { "primary": "feral/current" },
                // Agent-level timeout (separate from the provider timeout).
                // Local CPU inference is slow; default is far too short.
                "timeoutSeconds": 600
            }
        }
    });
    serde_json::to_string_pretty(&v).expect("config serialization never fails")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feral_gateway_port_is_18790() {
        assert_eq!(FERAL_GATEWAY_PORT, 18790);
    }

    #[test]
    fn build_config_contains_gateway_port() {
        let cfg = build_config("test-token-abc");
        assert!(cfg.contains("18790"), "expected port 18790, got:\n{cfg}");
    }

    #[test]
    fn build_config_contains_token() {
        let cfg = build_config("my-secret-token");
        assert!(cfg.contains("my-secret-token"), "token missing from config:\n{cfg}");
    }

    #[test]
    fn build_config_contains_feral_api_url() {
        let cfg = build_config("tok");
        assert!(cfg.contains("http://localhost:11435/v1"), "got:\n{cfg}");
    }

    #[test]
    fn build_config_contains_feral_current_model() {
        let cfg = build_config("tok");
        assert!(cfg.contains("feral/current"), "model ref missing:\n{cfg}");
    }

    #[test]
    fn build_config_enables_chat_completions_endpoint() {
        // Required: /v1/chat/completions returns 404 unless explicitly enabled.
        let cfg = build_config("tok");
        let v: serde_json::Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!(
            v["gateway"]["http"]["endpoints"]["chatCompletions"]["enabled"]
                .as_bool().unwrap(),
            true
        );
    }

    #[test]
    fn build_config_sets_gateway_mode_local() {
        // Required: OpenClaw refuses to start with "missing gateway.mode".
        let cfg = build_config("tok");
        let v: serde_json::Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!(v["gateway"]["mode"].as_str().unwrap(), "local");
    }

    #[test]
    fn build_config_contains_openai_completions_api() {
        // Required: without "api" OpenClaw throws "No API provider registered for api: undefined"
        let cfg = build_config("tok");
        let v: serde_json::Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!(
            v["models"]["providers"]["feral"]["api"].as_str().unwrap(),
            "openai-completions"
        );
    }

    #[test]
    fn build_config_is_valid_json() {
        let cfg = build_config("tok-xyz");
        serde_json::from_str::<serde_json::Value>(&cfg)
            .expect("config must be valid JSON");
    }

    #[test]
    fn build_config_escapes_special_chars_in_token() {
        let cfg = build_config(r#"tok"with"quotes"#);
        let v: serde_json::Value = serde_json::from_str(&cfg)
            .expect("must be valid JSON even with special chars");
        assert_eq!(
            v["gateway"]["auth"]["token"].as_str().unwrap(),
            r#"tok"with"quotes"#
        );
    }
}
