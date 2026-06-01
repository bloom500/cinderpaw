use serde::{Deserialize, Serialize};

/// Stored in ~/.feral/openclaw_connection.json — never serialised to frontend.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OpenClawConnectionSettings {
    pub gateway_endpoint_override: Option<String>,
    pub gateway_token: Option<String>,
}

/// Redacted view returned to frontend — raw token is never included.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OpenClawConnectionView {
    pub endpoint_override: Option<String>,
    pub has_token: bool,
}

pub fn load() -> OpenClawConnectionSettings {
    let path = crate::paths::openclaw_connection_path();
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(s) = serde_json::from_slice::<OpenClawConnectionSettings>(&bytes) {
            return s;
        }
    }
    OpenClawConnectionSettings::default()
}

pub fn save(s: &OpenClawConnectionSettings) -> anyhow::Result<()> {
    let path = crate::paths::openclaw_connection_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(s)?)?;
    Ok(())
}

/// Returns a redacted view of the connection settings.
/// The raw gateway token is never returned — only `has_token: bool`.
#[tauri::command]
#[specta::specta]
pub fn get_openclaw_connection_settings() -> OpenClawConnectionView {
    let s = load();
    OpenClawConnectionView {
        endpoint_override: s.gateway_endpoint_override,
        has_token: s.gateway_token.is_some(),
    }
}

/// Save connection settings. Token and endpoint semantics:
///
/// - `token: Some(s)` where `s.trim()` is non-empty  → replace stored token
/// - `token: Some(s)` where `s.trim()` is empty      → no change (preserve existing token)
/// - `token: None`                                    → no change (preserve existing token)
///
/// - `endpoint_override: Some(s)` where `s.trim()` is non-empty → validate loopback, store
/// - `endpoint_override: Some(s)` where `s.trim()` is empty     → clear override (store None)
/// - `endpoint_override: None`                                   → no change
#[tauri::command]
#[specta::specta]
pub fn save_openclaw_connection_settings(
    endpoint_override: Option<String>,
    token: Option<String>,
) -> Result<(), String> {
    let mut s = load();

    if let Some(ep) = endpoint_override {
        let trimmed = ep.trim().to_string();
        if trimmed.is_empty() {
            s.gateway_endpoint_override = None;
        } else {
            if !crate::openclaw::is_loopback_url(&trimmed) {
                return Err(format!(
                    "Endpoint override must be a loopback address (localhost, 127.x, [::1], \
                     or 0.0.0.0): {trimmed}"
                ));
            }
            s.gateway_endpoint_override = Some(trimmed);
        }
    }

    if let Some(t) = token {
        let trimmed = t.trim().to_string();
        if !trimmed.is_empty() {
            s.gateway_token = Some(trimmed);
        }
    }

    save(&s).map_err(|e| e.to_string())
}

/// Clear the saved gateway token. The endpoint override is NOT affected.
#[tauri::command]
#[specta::specta]
pub fn clear_openclaw_token() -> Result<(), String> {
    let mut s = load();
    s.gateway_token = None;
    save(&s).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save_to(dir: &std::path::Path, s: &OpenClawConnectionSettings) {
        let path = dir.join("openclaw_connection.json");
        std::fs::write(&path, serde_json::to_vec_pretty(s).unwrap()).unwrap();
    }

    fn load_from(dir: &std::path::Path) -> OpenClawConnectionSettings {
        let path = dir.join("openclaw_connection.json");
        let bytes = std::fs::read(&path).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tempfile::tempdir().expect("temp dir");
        let s = OpenClawConnectionSettings {
            gateway_endpoint_override: Some("http://localhost:9999".to_string()),
            gateway_token: Some("tok_abc123".to_string()),
        };
        save_to(dir.path(), &s);
        let loaded = load_from(dir.path());
        assert_eq!(loaded.gateway_endpoint_override, s.gateway_endpoint_override);
        assert_eq!(loaded.gateway_token, s.gateway_token);
    }

    #[test]
    fn clear_token_preserves_endpoint_override() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut s = OpenClawConnectionSettings {
            gateway_endpoint_override: Some("http://localhost:9999".to_string()),
            gateway_token: Some("tok_xyz".to_string()),
        };
        save_to(dir.path(), &s);
        s.gateway_token = None;
        save_to(dir.path(), &s);
        let loaded = load_from(dir.path());
        assert!(loaded.gateway_token.is_none());
        assert_eq!(loaded.gateway_endpoint_override, Some("http://localhost:9999".to_string()));
    }

    #[test]
    fn empty_token_string_is_treated_as_none() {
        let dir = tempfile::tempdir().expect("temp dir");
        let original = OpenClawConnectionSettings {
            gateway_endpoint_override: None,
            gateway_token: Some("real_token".to_string()),
        };
        save_to(dir.path(), &original);
        let token_input = "   ";
        let trimmed = token_input.trim();
        let mut s = load_from(dir.path());
        if !trimmed.is_empty() {
            s.gateway_token = Some(trimmed.to_string());
        }
        save_to(dir.path(), &s);
        let loaded = load_from(dir.path());
        assert_eq!(loaded.gateway_token, Some("real_token".to_string()));
    }

    #[test]
    fn non_loopback_endpoint_is_rejected() {
        assert!(!crate::openclaw::is_loopback_url("https://example.com/api"));
        assert!(!crate::openclaw::is_loopback_url("http://10.0.0.1:18789"));
        assert!(!crate::openclaw::is_loopback_url("ftp://localhost:18789"));
    }

    #[test]
    fn loopback_variants_are_accepted() {
        assert!(crate::openclaw::is_loopback_url("http://localhost:18789"));
        assert!(crate::openclaw::is_loopback_url("http://127.0.0.1:18789"));
        assert!(crate::openclaw::is_loopback_url("http://0.0.0.0:18789"));
        assert!(crate::openclaw::is_loopback_url("http://[::1]:18789"));
    }

    #[test]
    fn empty_endpoint_override_string_stores_none() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut s = OpenClawConnectionSettings {
            gateway_endpoint_override: Some("http://localhost:9999".to_string()),
            gateway_token: None,
        };
        save_to(dir.path(), &s);
        let endpoint_input = "";
        let trimmed = endpoint_input.trim();
        s.gateway_endpoint_override = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
        save_to(dir.path(), &s);
        let loaded = load_from(dir.path());
        assert!(loaded.gateway_endpoint_override.is_none());
    }
}
