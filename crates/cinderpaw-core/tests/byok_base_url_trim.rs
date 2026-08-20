//! A pasted base URL carries whatever came with it.
//!
//! 2026-08-19: a Gemini endpoint was saved as
//! `" https://generativelanguage.googleapis.com/v1beta/openai"` — one leading
//! space, from a copy-paste. Bun's fetch happened to tolerate it, so the
//! request worked; the Rust host's client and every future caller are under no
//! obligation to be as forgiving, and "it depends which process sends it" is
//! not a property worth keeping.
//!
//! Trimming belongs in `update_provider` because that is the single door the
//! desktop command, the headless API and the CLI all go through.

use cinderpaw_core::byok::{ByokSettings, ProviderConfig};

fn cfg(base_url: Option<&str>, model: Option<&str>) -> ProviderConfig {
    ProviderConfig {
        enabled: true,
        api_key: String::new(),
        base_url: base_url.map(str::to_string),
        default_model: model.map(str::to_string),
    }
}

#[test]
fn a_pasted_base_url_loses_its_surrounding_whitespace() {
    let mut s = ByokSettings::default();
    s.update_provider(
        "google",
        cfg(Some("  https://generativelanguage.googleapis.com/v1beta/openai \n"), None),
    );
    assert_eq!(
        s.get_provider("google").unwrap().base_url.as_deref(),
        Some("https://generativelanguage.googleapis.com/v1beta/openai"),
    );
}

#[test]
fn clearing_the_field_falls_back_to_the_provider_default() {
    // An empty string is not a base URL; it is the user saying "use the
    // normal one". Storing "" instead of null makes every later reader
    // build requests against nothing.
    let mut s = ByokSettings::default();
    s.update_provider("google", cfg(Some("   "), None));
    assert_eq!(s.get_provider("google").unwrap().base_url, None);
}

#[test]
fn a_pasted_model_id_is_trimmed_too() {
    // Same paste, same trailing newline, and a model id with a space in it
    // fails as obscurely as a URL does.
    let mut s = ByokSettings::default();
    s.update_provider("google", cfg(None, Some(" gemini-3.7-flash\n")));
    assert_eq!(
        s.get_provider("google").unwrap().default_model.as_deref(),
        Some("gemini-3.7-flash"),
    );
}

#[test]
fn a_clean_value_is_stored_unchanged() {
    let mut s = ByokSettings::default();
    s.update_provider("openrouter", cfg(Some("https://openrouter.ai/api/v1"), Some("x/y")));
    let got = s.get_provider("openrouter").unwrap();
    assert_eq!(got.base_url.as_deref(), Some("https://openrouter.ai/api/v1"));
    assert_eq!(got.default_model.as_deref(), Some("x/y"));
}
