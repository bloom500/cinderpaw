//! Artifact frames: a page the agent wrote (an `app`, a chart, an HTML
//! document) served from an origin of its own.
//!
//! The app used to draw these as `<iframe srcdoc>`. A srcdoc frame inherits
//! the window's Content-Security-Policy, and the window's `script-src 'self'`
//! blocks every inline script, so in an installed build every chart and every
//! slider was a dead page. Nobody saw it: `cargo tauri dev` loads vite's page,
//! which carries no CSP. A frame loaded from this scheme gets the CSP below
//! instead, from its own response.
//!
//! The frame is still sandboxed by the app (`allow-scripts`, never
//! `allow-same-origin`), so it runs with an opaque origin and cannot reach
//! `invoke()`. This CSP adds the second rule from
//! `CinderpawAgent/src/artifacts/app.ts`: nothing is fetched while it is open.
//!
//! The chart library is inlined here, as export does, because the agent writes
//! `<script src="cinderpaw:echarts">` and nothing else ever resolved it on
//! screen: charts were blank even in dev (2 Oct).

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;

use parking_lot::Mutex;
use sha2::{Digest, Sha256};

/// The same build the sidecar inlines on export.
const ECHARTS: &str = include_str!("../../CinderpawAgent/src/artifacts/vendor/echarts.min.js");

/// Inline script and style, pictures from anywhere, no requests of its own.
const FRAME_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; \
    style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; media-src data: blob:";

/// Pages kept for reloads and for the same chart drawn twice (card and panel).
/// ponytail: oldest-first eviction at 32; a chat with more live charts than
/// that on screen at once is not a thing yet.
const KEEP: usize = 32;

#[derive(Default)]
struct Pages {
    by_token: HashMap<String, String>,
    order: VecDeque<String>,
}

fn pages() -> &'static Mutex<Pages> {
    static PAGES: OnceLock<Mutex<Pages>> = OnceLock::new();
    PAGES.get_or_init(|| Mutex::new(Pages::default()))
}

/// Hands a page to the scheme and returns its token: the same page, the same token.
#[tauri::command]
#[specta::specta]
pub fn artifact_frame_put(html: String) -> String {
    let token: String = Sha256::digest(html.as_bytes())[..12].iter().map(|b| format!("{b:02x}")).collect();
    let mut p = pages().lock();
    if !p.by_token.contains_key(&token) {
        if p.order.len() >= KEEP {
            if let Some(old) = p.order.pop_front() {
                p.by_token.remove(&old);
            }
        }
        p.order.push_back(token.clone());
        p.by_token.insert(token.clone(), html);
    }
    token
}

pub fn frame_protocol<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let token = request.uri().path().trim_start_matches('/');
    let page = pages().lock().by_token.get(token).cloned();
    let body = match page {
        Some(html) => inline_charts(&html),
        None => "<!doctype html><meta charset=utf-8><p style=\"font:14px system-ui;color:#666\">\
                 This page is no longer loaded. Close it and open it again.</p>"
            .to_string(),
    };
    tauri::http::Response::builder()
        .header("content-type", "text/html; charset=utf-8")
        .header("content-security-policy", FRAME_CSP)
        .body(Cow::Owned(body.into_bytes()))
        .expect("frame response")
}

/// Every `<script src=...echarts...></script>`, ours or a CDN's, becomes the
/// library itself, like `inlineApp` in the sidecar. Other scripts are left alone.
fn inline_charts(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    while let Some(rel) = lower[at..].find("<script") {
        let start = at + rel;
        let Some(open_end) = lower[start..].find('>').map(|i| start + i + 1) else { break };
        let Some(close) = lower[open_end..].find("</script>").map(|i| open_end + i) else { break };
        let tag = &lower[start..open_end];
        let end = close + "</script>".len();
        out.push_str(&html[at..start]);
        if tag.contains("src") && tag.contains("echarts") && lower[open_end..close].trim().is_empty() {
            out.push_str("<script>\n");
            out.push_str(ECHARTS);
            out.push_str("\n</script>");
        } else {
            out.push_str(&html[start..end]);
        }
        at = end;
    }
    out.push_str(&html[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chart_library_is_inlined_and_other_scripts_are_kept() {
        let html = r#"<head><SCRIPT src="cinderpaw:echarts"></SCRIPT><script src='https://cdn.jsdelivr.net/npm/echarts@5'></script></head><body><script>draw()</script></body>"#;
        let out = inline_charts(html);
        assert!(!out.contains("cinderpaw:echarts") && !out.contains("cdn.jsdelivr"));
        assert_eq!(out.matches(ECHARTS).count(), 2);
        assert!(out.ends_with("<body><script>draw()</script></body>"));
        assert_eq!(inline_charts("<p>no scripts</p>"), "<p>no scripts</p>");
    }

    #[test]
    fn the_same_page_keeps_its_token_and_the_oldest_page_goes_first() {
        let first = artifact_frame_put("<p>first</p>".into());
        assert_eq!(first, artifact_frame_put("<p>first</p>".into()));
        for i in 0..KEEP {
            artifact_frame_put(format!("<p>{i}</p>"));
        }
        assert!(!pages().lock().by_token.contains_key(&first));
    }
}
