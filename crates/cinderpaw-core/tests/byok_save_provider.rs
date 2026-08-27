//! Persistence contract tests for `byok::save_provider` (Phase 0b,
//! 2026-07-07). Live as a separate integration test crate so they
//! don't share compilation with `api.rs`'s inline test module
//! (which currently fails to compile because its `parse_agent_output`
//! test cases reference a 3-tuple that the function hasn't returned
//! for several versions; out of scope for Phase 0).
//!
//! These tests exercise the persistence contract that closes the
//! "silent key-drop" bug (the Go TUI wizard validated a cloud API key
//! against `/providers/test` but never persisted it to the keychain).
//! Without a live keychain backend on the dev machine (no Windows
//! Credential Manager / macOS Keychain / Linux Secret Service available
//! to this Linux runner), the test focuses on the metadata path. The
//! keychain write happens only when the supplied `api_key` is
//! non-empty; passing the empty string skips that branch and verifies
//! the on-disk metadata shape end-to-end.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use cinderpaw_core::byok::{self, ByokSettings, ProviderConfig};

/// Process-global serialisation for tests that mutate `CINDERPAW_HOME`.
/// A panicking test inside the closure is fine: the drop guard restores
/// the prior value before another test acquires the lock.
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    prev: Option<std::ffi::OsString>,
    _lock: MutexGuard<'static, ()>,
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.prev.take() {
            Some(v) => std::env::set_var("CINDERPAW_HOME", v),
            None => std::env::remove_var("CINDERPAW_HOME"),
        }
    }
}

fn with_temp_feral_home<R>(f: impl FnOnce(&Path) -> R) -> R {
    let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::Builder::new()
        .prefix("feral-byok-test-")
        .tempdir()
        .expect("tempdir");
    let prev = std::env::var_os("CINDERPAW_HOME");
    std::env::set_var("CINDERPAW_HOME", tmp.path());
    let _guard = EnvGuard {
        prev,
        _lock: lock,
    };
    f(tmp.path())
}

#[test]
fn save_provider_with_empty_key_writes_metadata_only() {
    with_temp_feral_home(|tmp| {
        let config = ProviderConfig {
            enabled: true,
            api_key: String::new(), // empty → no keychain write
            base_url: Some("https://api.example.test/v1".into()),
            default_model: Some("claude-test".into()),
        };
        byok::save_provider("test_provider_meta_only", config).expect("empty key save");

        // byok.json on disk reflects the metadata.
        let path = tmp.join("byok.json");
        let raw = std::fs::read_to_string(&path).expect("byok.json read");
        let parsed: ByokSettings = serde_json::from_str(&raw).expect("byok.json parses");

        assert!(parsed.providers.contains_key("test_provider_meta_only"));
        let stored = &parsed.providers["test_provider_meta_only"];
        assert!(stored.enabled);
        assert_eq!(
            stored.base_url.as_deref(),
            Some("https://api.example.test/v1")
        );
        assert_eq!(stored.default_model.as_deref(), Some("claude-test"));
        // `api_key` is `skip_serializing` — even a non-empty value never
        // reaches the on-disk shape. With an empty input, the absence is
        // doubly enforced.
        assert_eq!(stored.api_key, "");
        // No `api_key` field at all in the on-disk JSON (skip_serializing).
        assert!(!raw.contains("api_key"));
    });
}

#[test]
fn save_provider_persists_metadata_consistently_across_calls() {
    with_temp_feral_home(|tmp| {
        byok::save_provider(
            "p1",
            ProviderConfig {
                enabled: true,
                api_key: String::new(),
                base_url: Some("https://a.test/v1".into()),
                default_model: Some("model-a".into()),
            },
        )
        .expect("first save");
        byok::save_provider(
            "p1",
            ProviderConfig {
                enabled: false,
                api_key: String::new(),
                base_url: Some("https://b.test/v2".into()),
                default_model: Some("model-b".into()),
            },
        )
        .expect("second save");

        let raw = std::fs::read_to_string(tmp.join("byok.json")).expect("read");
        let parsed: ByokSettings = serde_json::from_str(&raw).expect("parse");
        let p1 = &parsed.providers["p1"];
        assert!(!p1.enabled);
        assert_eq!(p1.base_url.as_deref(), Some("https://b.test/v2"));
        assert_eq!(p1.default_model.as_deref(), Some("model-b"));
        assert_eq!(p1.api_key, "");
    });
}

#[test]
fn save_provider_does_not_touch_existing_providers_on_metadata_update() {
    // Phase 0b invariant: a single-provider save must not disturb
    // unrelated providers already in the metadata.
    with_temp_feral_home(|tmp| {
        byok::save_provider(
            "anthropic",
            ProviderConfig {
                enabled: true,
                api_key: String::new(),
                base_url: Some("https://api.anthropic.com".into()),
                default_model: Some("claude-sonnet-4-20250514".into()),
            },
        )
        .expect("save anthropic");
        byok::save_provider(
            "openai",
            ProviderConfig {
                enabled: true,
                api_key: String::new(),
                base_url: None,
                default_model: Some("gpt-4o".into()),
            },
        )
        .expect("save openai");

        byok::save_provider(
            "anthropic",
            ProviderConfig {
                enabled: false,
                api_key: String::new(),
                base_url: Some("https://api.anthropic.com/v1".into()),
                default_model: Some("claude-3-opus".into()),
            },
        )
        .expect("resave anthropic");

        let raw = std::fs::read_to_string(tmp.join("byok.json")).expect("read");
        let parsed: ByokSettings = serde_json::from_str(&raw).expect("parse");

        let ant = &parsed.providers["anthropic"];
        assert!(!ant.enabled);
        assert_eq!(ant.default_model.as_deref(), Some("claude-3-opus"));
        assert_eq!(ant.base_url.as_deref(), Some("https://api.anthropic.com/v1"));

        let oai = &parsed.providers["openai"];
        assert!(oai.enabled);
        assert_eq!(oai.default_model.as_deref(), Some("gpt-4o"));
        assert_eq!(oai.base_url, None);
    });
}
