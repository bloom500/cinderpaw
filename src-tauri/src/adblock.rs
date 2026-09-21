//! Ad and tracker blocking for the built-in browser, with Brave's engine.
//!
//! `adblock` (brave/adblock-rust, MPL-2.0) is the same engine Brave ships; the
//! lists are EasyList, EasyPrivacy, uBlock's own filters and Brave's unbreak
//! list, all downloaded on first use into `~/.cinderpaw/browser-adblock/`
//! (a fresh install has none) and refreshed weekly. The built engine is
//! cached in its binary form so a restart does not re-parse 200k rules.
//!
//! Requests are intercepted per platform: on Windows through WebView2's
//! `WebResourceRequested` (see `browser::hook_requests`). On macOS and Linux
//! nothing is intercepted yet; the engine's `content-blocking` feature can
//! export WebKit content-blocker rules for those, which is the next step, and
//! the Settings row says so on those systems instead of pretending.
//!
//! Everything here is safe to call before `start` ran: no engine means
//! nothing is blocked, never a panic.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use adblock::lists::ParseOptions;
use adblock::request::Request;
use adblock::{Engine, FilterSet};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const LISTS: &[(&str, &str)] = &[
    ("easylist.txt", "https://easylist.to/easylist/easylist.txt"),
    ("easyprivacy.txt", "https://easylist.to/easylist/easyprivacy.txt"),
    ("ublock-filters.txt", "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt"),
    ("ublock-privacy.txt", "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt"),
    ("brave-unbreak.txt", "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt"),
];
const REFRESH_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);

#[derive(Clone)]
pub enum Status {
    Off,
    Loading(&'static str),
    On { rules: usize, updated: SystemTime },
    Failed(String),
}

fn engine() -> &'static RwLock<Option<Engine>> {
    static E: OnceLock<RwLock<Option<Engine>>> = OnceLock::new();
    E.get_or_init(|| RwLock::new(None))
}

fn status() -> &'static Mutex<Status> {
    static S: OnceLock<Mutex<Status>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Status::Off))
}

/// Requests blocked per tab (by webview label) on the page it is showing now.
fn counts() -> &'static Mutex<HashMap<String, u32>> {
    static C: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dir() -> PathBuf {
    cinderpaw_core::paths::cinderpaw_dir().join("browser-adblock")
}

/// On by default: the default IS the product. Off is a file, so it survives
/// a restart and needs no settings schema.
pub fn enabled() -> bool {
    !dir().join("off").exists()
}

pub fn set_enabled(app: &AppHandle, on: bool) {
    let flag = dir().join("off");
    let _ = std::fs::create_dir_all(dir());
    if on {
        let _ = std::fs::remove_file(&flag);
        start(app);
    } else {
        let _ = std::fs::write(&flag, b"");
        *engine().write() = None;
        set_status(app, Status::Off);
    }
}

fn set_status(app: &AppHandle, s: Status) {
    *status().lock() = s;
    let _ = app.emit("browser://adblock", status_json());
}

pub fn status_json() -> Value {
    match &*status().lock() {
        Status::Off => json!({ "state": "off", "supported": cfg!(windows) }),
        Status::Loading(what) => json!({ "state": "loading", "what": what, "supported": cfg!(windows) }),
        Status::On { rules, updated } => json!({
            "state": "on",
            "rules": rules,
            "updatedMs": updated.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            "supported": cfg!(windows),
        }),
        Status::Failed(e) => json!({ "state": "failed", "error": e, "supported": cfg!(windows) }),
    }
}

/// Load the engine: from the cache when it is fresh, otherwise by downloading
/// the lists. Runs off the UI thread; the Settings row follows the status.
pub fn start(app: &AppHandle) {
    if !enabled() {
        set_status(app, Status::Off);
        return;
    }
    if engine().read().is_some() {
        return;
    }
    set_status(app, Status::Loading("loading the block lists"));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match load_or_build(&app).await {
            Ok((e, rules, updated)) => {
                *engine().write() = Some(e);
                set_status(&app, Status::On { rules, updated });
            }
            Err(err) => {
                tracing::warn!(error = %err, "adblock: could not load the block lists");
                set_status(&app, Status::Failed(err));
            }
        }
    });
}

async fn load_or_build(app: &AppHandle) -> Result<(Engine, usize, SystemTime), String> {
    let dir = dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cache = dir.join("engine.bin");
    let stamp = dir.join("rules.count");
    let fresh = std::fs::metadata(&cache)
        .and_then(|m| m.modified())
        .map(|t| SystemTime::now().duration_since(t).unwrap_or(REFRESH_AFTER) < REFRESH_AFTER)
        .unwrap_or(false);
    if fresh {
        if let Ok(bytes) = std::fs::read(&cache) {
            let mut e = Engine::default();
            if e.deserialize(&bytes).is_ok() {
                let rules = std::fs::read_to_string(&stamp).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                let updated = std::fs::metadata(&cache).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
                return Ok((e, rules, updated));
            }
        }
    }
    set_status(app, Status::Loading("downloading the block lists"));
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let mut texts = Vec::new();
    for (name, url) in LISTS {
        let path = dir.join(name);
        match client.get(*url).send().await.and_then(|r| r.error_for_status()) {
            Ok(r) => {
                let text = r.text().await.map_err(|e| e.to_string())?;
                let _ = std::fs::write(&path, &text);
                texts.push(text);
            }
            Err(e) => {
                // Offline, or one host down: the last copy of that list is
                // better than no blocking at all.
                match std::fs::read_to_string(&path) {
                    Ok(old) => texts.push(old),
                    Err(_) => return Err(format!("could not download {name} ({e}) and there is no earlier copy")),
                }
            }
        }
    }
    set_status(app, Status::Loading("building the blocker"));
    let built = tauri::async_runtime::spawn_blocking(move || {
        let mut set = FilterSet::new(false);
        let mut rules = 0usize;
        for t in &texts {
            rules += t.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('!') && !l.starts_with('[')).count();
            set.add_filter_list(t.clone(), ParseOptions::default());
        }
        (Engine::new_with_filter_set(set), rules)
    })
    .await
    .map_err(|e| e.to_string())?;
    let (e, rules) = built;
    let _ = std::fs::write(&cache, e.serialize());
    let _ = std::fs::write(&stamp, rules.to_string());
    Ok((e, rules, SystemTime::now()))
}

/// Should this request be blocked? `kind` is one of the adblock request types
/// ("script", "image", "stylesheet", "xmlhttprequest", "sub_frame", "font",
/// "media", "ping", "websocket", "other"). The main document is never blocked
/// here: a navigation the person asked for is theirs.
pub fn should_block(url: &str, source: &str, kind: &str) -> bool {
    let guard = engine().read();
    let Some(e) = guard.as_ref() else { return false };
    let Ok(req) = Request::new(url, source, kind, "GET") else { return false };
    e.check_network_request(&req).should_block()
}

/// The CSS that hides what the lists say to hide on this page, or None.
pub fn cosmetic_css(url: &str) -> Option<String> {
    let guard = engine().read();
    let e = guard.as_ref()?;
    let r = e.url_cosmetic_resources(url);
    if r.hide_selectors.is_empty() {
        return None;
    }
    let mut selectors: Vec<&String> = r.hide_selectors.iter().collect();
    selectors.sort();
    Some(format!("{}{{display:none!important}}", selectors.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",")))
}

pub fn count(label: &str) {
    *counts().lock().entry(label.to_string()).or_insert(0) += 1;
}

pub fn reset(label: &str) {
    counts().lock().insert(label.to_string(), 0);
}

pub fn blocked_on(label: &str) -> u32 {
    counts().lock().get(label).copied().unwrap_or(0)
}

/// Intercept every request of this tab through WebView2 and answer the ones
/// the lists reject with a 403 before they leave the machine. Document
/// requests (the page itself and its iframes) are never blocked here: a
/// navigation the person or the agent asked for is theirs, and what a blocked
/// iframe would have shown is hidden by the cosmetic rules instead.
#[cfg(windows)]
pub fn hook_requests(wv: &tauri::Webview, label: String) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
    use windows_core::{w, Interface, PWSTR};

    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else {
            tracing::warn!(%label, "adblock: no CoreWebView2 on this tab, nothing intercepted");
            return;
        };
        // `Environment` lives on the second revision of the interface.
        let env = match core.cast::<ICoreWebView2_2>().and_then(|c| c.Environment()) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(%label, error = %e, "adblock: no WebView2 environment, nothing intercepted");
                return;
            }
        };
        if let Err(e) = core.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL) {
            tracing::warn!(%label, error = %e, "adblock: could not add the request filter");
            return;
        }
        tracing::info!(%label, "adblock: intercepting this tab's requests");
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut ctx = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
            args.ResourceContext(&mut ctx)?;
            if ctx == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT {
                return Ok(());
            }
            let req = args.Request()?;
            let mut uri = PWSTR::null();
            req.Uri(&mut uri)?;
            let url = take_pwstr(uri);
            // The page making the request, for the first/third-party test.
            let mut src = PWSTR::null();
            let source = match sender.as_ref().map(|s| s.Source(&mut src)) {
                Some(Ok(())) => take_pwstr(src),
                _ => String::new(),
            };
            if should_block(&url, &source, kind(ctx)) {
                // Headers must be a string, even an empty one: null is refused.
                match env.CreateWebResourceResponse(None, 403, w!("Blocked by Cinderpaw"), w!("")).and_then(|r| args.SetResponse(&r)) {
                    Ok(()) => count(&label),
                    Err(e) => tracing::warn!(error = %e, %url, "adblock: matched but could not answer the request"),
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_WebResourceRequested(&handler, &mut token);
    });
}

/// WebView2's resource context, in the words the lists use.
#[cfg(windows)]
fn kind(ctx: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match ctx {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "xmlhttprequest",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT => "ping",
        _ => "other",
    }
}

/// macOS and Linux: nothing is intercepted yet (see the module doc).
#[cfg(not(windows))]
pub fn hook_requests(_wv: &tauri::Webview, _label: String) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_rule_blocks_a_third_party_script_and_hides_a_selector() {
        let mut set = FilterSet::new(false);
        set.add_filter_list("||tracker.example^$third-party\nnews.example###ad-banner\n".to_string(), ParseOptions::default());
        let e = Engine::new_with_filter_set(set);
        *engine().write() = Some(e);
        assert!(should_block("https://tracker.example/t.js", "https://news.example/", "script"));
        assert!(!should_block("https://cdn.news.example/app.js", "https://news.example/", "script"));
        assert!(!should_block("https://tracker.example/t.js", "https://tracker.example/", "script"));
        assert_eq!(cosmetic_css("https://news.example/story").as_deref(), Some("#ad-banner{display:none!important}"));
        assert!(cosmetic_css("https://other.example/").is_none());
        assert!(!should_block("not a url", "https://news.example/", "script"));
    }

    #[test]
    fn counts_are_per_tab_and_reset_on_navigation() {
        count("t1");
        count("t1");
        assert_eq!(blocked_on("t1"), 2);
        assert_eq!(blocked_on("t2"), 0);
        reset("t1");
        assert_eq!(blocked_on("t1"), 0);
    }
}
