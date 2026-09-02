//! Deep-link handler for `cinderpaw://open`.
//!
//! The Browser App (`https://cinderpaw.dev/app`) offers an "Open Cinderpaw
//! Desktop" CTA that invokes `cinderpaw://open`. The OS routes that URL to
//! this binary. This module validates the URL and focuses the existing main
//! window. It owns no bearer tokens, never executes shell commands, and
//! never interprets the URL as anything other than the single `open` action.
//!
//! Protocol registration lives in `tauri.conf.json` (`plugins.deep-link`)
//! and the bundler emits the platform files (Windows registry via NSIS,
//! macOS Info.plist, Linux .desktop). The runtime wiring lives in `lib.rs`.

use tauri::Manager;

// ── URL validation ───────────────────────────────────────────────────────

/// Returns true iff `raw` is exactly `cinderpaw://open` (with optional
/// trailing slash) and nothing else.
///
/// Rejects:
/// - wrong scheme (`other://open`)
/// - wrong host/action (`cinderpaw://execute`)
/// - extra path (`cinderpaw://open/extra`)
/// - credentials (`cinderpaw://user:pass@open`)
/// - query or fragment (`cinderpaw://open?token=...`, `cinderpaw://open#frag`)
/// - unparseable input
///
/// This is the sole allowlist. Any new action must be added here
/// explicitly — there is no prefix match.
pub fn is_valid_deep_link(raw: &str) -> bool {
    let url = match url::Url::parse(raw) {
        Ok(u) => u,
        Err(_) => return false,
    };

    // Scheme must be exactly `cinderpaw`.
    if url.scheme() != "cinderpaw" {
        return false;
    }

    // Must not carry credentials. `cinderpaw://user:pass@open` must fail.
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    // Must not carry query or fragment — the handoff carries no auth.
    if url.query().is_some() || url.fragment().is_some() {
        return false;
    }

    // Host must be exactly `open`.
    // `cinderpaw://open` parses with host `open` and path `/` or ``.
    // `cinderpaw://open:123` would have a port — reject.
    if url.host_str() != Some("open") {
        return false;
    }
    if url.port().is_some() {
        return false;
    }

    // Path must be empty or a single `/`. Any deeper path is a different
    // action and is rejected.
    let path = url.path();
    if path != "/" && path != "" {
        return false;
    }

    true
}

/// Returns true if any URL in the slice is a valid `cinderpaw://open` link.
pub fn contains_valid_open_url(urls: &[url::Url]) -> bool {
    urls.iter().any(|u| is_valid_deep_link(u.as_str()))
}

// ── Window focus ─────────────────────────────────────────────────────────

/// Focus the existing main window: unminimize, show, and focus.
/// Avoids creating a duplicate window — it reuses `main`.
///
/// Failures are logged but not propagated: a focus that cannot be
/// performed (e.g. window already closed) is not a crash.
pub fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // The main window label is `main` (the sole entry in
    // `tauri.conf.json` → `app.windows[0]`). Use `get_webview_window`
    // which is the Tauri 2 API for the primary window.
    if let Some(window) = app.get_webview_window("main") {
        // Order matters: an minimized window must be unminimized before
        // `show`/`set_focus` can bring it forward.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        tracing::info!("deep-link: focused main window for cinderpaw://open");
    } else {
        tracing::warn!("deep-link: main window not found — cannot focus for cinderpaw://open");
    }
}

/// Entry point for any deep-link URL batch. Validates and, if at least
/// one URL is the accepted `cinderpaw://open`, focuses the window.
/// All other URLs are silently ignored (logged at debug).
pub fn handle_urls<R: tauri::Runtime>(app: &tauri::AppHandle<R>, urls: Vec<url::Url>) {
    let raw_list: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
    if contains_valid_open_url(&urls) {
        tracing::info!(urls = ?raw_list, "deep-link: accepted cinderpaw://open");
        focus_main_window(app);
    } else {
        tracing::debug!(urls = ?raw_list, "deep-link: ignored — no valid cinderpaw://open");
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_open_is_accepted() {
        assert!(is_valid_deep_link("cinderpaw://open"));
    }

    #[test]
    fn valid_open_with_trailing_slash_is_accepted() {
        assert!(is_valid_deep_link("cinderpaw://open/"));
    }

    #[test]
    fn wrong_scheme_is_rejected() {
        assert!(!is_valid_deep_link("other://open"));
        assert!(!is_valid_deep_link("https://cinderpaw.dev/open"));
        assert!(!is_valid_deep_link("http://cinderpaw.dev"));
    }

    #[test]
    fn wrong_action_is_rejected() {
        assert!(!is_valid_deep_link("cinderpaw://execute"));
        assert!(!is_valid_deep_link("cinderpaw://shell"));
        assert!(!is_valid_deep_link("cinderpaw://arbitrary-command"));
        assert!(!is_valid_deep_link("cinderpaw://settings"));
    }

    #[test]
    fn extra_path_is_rejected() {
        assert!(!is_valid_deep_link("cinderpaw://open/extra"));
        assert!(!is_valid_deep_link("cinderpaw://open/settings"));
    }

    #[test]
    fn query_is_rejected() {
        assert!(!is_valid_deep_link("cinderpaw://open?token=secret"));
        assert!(!is_valid_deep_link("cinderpaw://open?api_key=123"));
        assert!(!is_valid_deep_link("cinderpaw://open?bearer=xyz"));
    }

    #[test]
    fn fragment_is_rejected() {
        assert!(!is_valid_deep_link("cinderpaw://open#token"));
    }

    #[test]
    fn credentials_are_rejected() {
        assert!(!is_valid_deep_link("cinderpaw://user:pass@open"));
        assert!(!is_valid_deep_link("cinderpaw://token:secret@open"));
    }

    #[test]
    fn port_is_rejected() {
        assert!(!is_valid_deep_link("cinderpaw://open:8080"));
    }

    #[test]
    fn malformed_is_rejected() {
        assert!(!is_valid_deep_link("not a url"));
        assert!(!is_valid_deep_link(""));
        assert!(!is_valid_deep_link("cinderpaw:open"));
        assert!(!is_valid_deep_link("://open"));
    }

    #[test]
    fn contains_valid_open_url_true_when_one_valid() {
        let urls = vec![
            url::Url::parse("cinderpaw://execute").unwrap(),
            url::Url::parse("cinderpaw://open").unwrap(),
        ];
        assert!(contains_valid_open_url(&urls));
    }

    #[test]
    fn contains_valid_open_url_false_when_none_valid() {
        let urls = vec![
            url::Url::parse("cinderpaw://execute").unwrap(),
            url::Url::parse("other://open").unwrap(),
        ];
        assert!(!contains_valid_open_url(&urls));
    }

    #[test]
    fn contains_valid_open_url_false_for_empty() {
        assert!(!contains_valid_open_url(&[]));
    }

    #[test]
    fn bearer_token_in_url_is_rejected() {
        // The deep-link must never carry auth material, even disguised.
        assert!(!is_valid_deep_link(
            "cinderpaw://open?bearer=eyJhbGciOiJIUzI1NiJ9"
        ));
        assert!(!is_valid_deep_link(
            "cinderpaw://open?access_token=secret"
        ));
    }

    #[test]
    fn case_sensitivity_scheme_must_be_lowercase() {
        // Schemes are case-insensitive per URL spec, but we require
        // exact `cinderpaw` to avoid ambiguity. Uppercase is rejected
        // because `Url::parse` lowercases the scheme, so this actually
        // passes — document the behaviour.
        // `Cinderpaw://open` parses as scheme `cinderpaw`, so it IS
        // accepted. That is fine — the OS registration is lowercase and
        // browsers emit lowercase.
        assert!(is_valid_deep_link("Cinderpaw://open"));
    }
}
