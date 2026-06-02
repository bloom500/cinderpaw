use anyhow::Result;
use std::path::PathBuf;

pub const FERAL_GATEWAY_PORT: u16 = 18790;

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
            "port": FERAL_GATEWAY_PORT,
            "bind": "loopback",
            "auth": { "mode": "token", "token": token }
        },
        "models": {
            "providers": {
                "feral": {
                    "baseUrl": "http://localhost:11435/v1",
                    "models": [{ "id": "current" }]
                }
            }
        },
        "agents": {
            "defaults": {
                "model": { "primary": "feral/current" }
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
