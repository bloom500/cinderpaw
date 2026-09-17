//! The built-in browser: a real web page in a panel beside the chat, driven by
//! the person and by the agent. Design and trade-offs:
//! `docs/decisions/2026-09-17-builtin-browser.md`.
//!
//! The page is a child webview of the main window, placed over the panel body
//! the React side measures. It has its own profile directory, so logins last
//! across restarts and never mix with the app's own webview storage.
//!
//! Web pages get no IPC: the capability file grants commands to local content
//! only. Everything here reaches INTO the page (eval) and reads the answer back
//! out of its URL fragment; nothing lets the page reach out.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

const LABEL: &str = "browser-page";
/// Where the page waits while the panel is closed. Off screen rather than
/// closed, so a login or a half-filled form survives closing the panel.
const PARKED: (f64, f64) = (-20_000.0, -20_000.0);

#[derive(Clone, Copy)]
struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
}

fn bounds() -> &'static Mutex<Bounds> {
    static B: OnceLock<Mutex<Bounds>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(Bounds { x: 0.0, y: 0.0, w: 800.0, h: 600.0, visible: false }))
}

/// True between a navigation starting and its page finishing.
static LOADING: AtomicBool = AtomicBool::new(false);

/// Only the web. `file:` would read the disk, `javascript:` would run in the
/// page, and the app's own schemes would load the app inside itself.
pub fn allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank"
}

/// What a person types into an address bar, as a URL: a full address, a bare
/// domain, or words to search for.
pub fn parse_address(raw: &str) -> Result<Url, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("browser: no address given".into());
    }
    // "javascript:…", "file:…", "mailto:…" name a scheme even without "://".
    // They go to the same check as any URL and are refused there, instead of
    // being quietly searched for. "localhost:3000" is not a scheme: a port
    // follows the colon.
    let names_scheme = t.split_once(':').is_some_and(|(scheme, rest)| {
        !scheme.is_empty()
            && scheme.chars().all(|c| c.is_ascii_alphabetic())
            && !rest.starts_with(|c: char| c.is_ascii_digit())
    });
    let candidate = if t.contains("://") || names_scheme {
        t.to_string()
    } else if t.contains('.') && !t.contains(char::is_whitespace) {
        format!("https://{t}")
    } else {
        format!("https://duckduckgo.com/?q={}", urlencoding::encode(t))
    };
    let url = Url::parse(&candidate).map_err(|e| format!("browser: that is not an address ({e})"))?;
    if !allowed(&url) {
        return Err(format!("browser: {}: links are not opened in the browser", url.scheme()));
    }
    Ok(url)
}

fn page(app: &AppHandle) -> Option<Webview> {
    app.get_webview(LABEL)
}

fn place(wv: &Webview) -> Result<(), String> {
    let b = *bounds().lock();
    let (x, y, w, h) = if b.visible {
        (b.x, b.y, b.w.max(1.0), b.h.max(1.0))
    } else {
        (PARKED.0, PARKED.1, b.w.max(1.0), b.h.max(1.0))
    };
    wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    Ok(())
}

fn open_or_navigate(app: &AppHandle, url: Url) -> Result<Webview, String> {
    LOADING.store(true, Ordering::SeqCst);
    if let Some(wv) = page(app) {
        wv.navigate(url).map_err(|e| format!("browser: could not open the page ({e})"))?;
        return Ok(wv);
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "browser: the main window is not open".to_string())?;
    let events = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .data_directory(cinderpaw_core::paths::cinderpaw_dir().join("browser-profile"))
        .on_navigation(|url| allowed(url))
        .on_page_load(move |_wv, payload| {
            let finished = matches!(payload.event(), PageLoadEvent::Finished);
            LOADING.store(!finished, Ordering::SeqCst);
            let _ = events.emit(
                "browser://state",
                json!({ "url": payload.url().as_str(), "loading": !finished }),
            );
        });
    let b = *bounds().lock();
    let wv = window
        .add_child(builder, LogicalPosition::new(PARKED.0, PARKED.1), LogicalSize::new(b.w.max(1.0), b.h.max(1.0)))
        .map_err(|e| format!("browser: could not open the page ({e})"))?;
    place(&wv)?;
    Ok(wv)
}

/// Wait for the current page to finish loading, up to `limit`.
async fn settle(limit: Duration) {
    let step = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    while LOADING.load(Ordering::SeqCst) && waited < limit {
        tokio::time::sleep(step).await;
        waited += step;
    }
}

/// Run a JavaScript expression in the page and return its JSON value.
///
/// `eval` returns nothing, so the script writes its result into the URL
/// fragment with `history.replaceState` (no navigation, no reload), tagged
/// with a nonce; this reads it back through `url()` and restores the address.
async fn run(wv: &Webview, expression: &str) -> Result<Value, String> {
    let before = wv.url().map_err(|e| e.to_string())?;
    let marker = format!("cp-{}=", uuid::Uuid::new_v4().simple());
    let script = format!(
        "(() => {{ let r; try {{ r = ({expression}); }} catch (e) {{ r = {{ ok: false, error: String((e && e.message) || e) }}; }} \
         try {{ history.replaceState(history.state, '', location.pathname + location.search + '#{marker}' + encodeURIComponent(JSON.stringify(r))); }} catch (e) {{}} }})()"
    );
    wv.eval(&script).map_err(|e| e.to_string())?;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let now = wv.url().map_err(|e| e.to_string())?;
        let Some(encoded) = now.fragment().and_then(|f| f.strip_prefix(marker.as_str())) else { continue };
        let text = urlencoding::decode(encoded).map_err(|e| e.to_string())?.into_owned();
        let restore = serde_json::to_string(before.as_str()).unwrap_or_else(|_| "location.href".into());
        let _ = wv.eval(&format!("try {{ history.replaceState(history.state, '', {restore}); }} catch (e) {{}}"));
        return serde_json::from_str(&text).map_err(|e| format!("browser: the page's answer was unreadable ({e})"));
    }
    Err("browser: the page did not answer. It may still be loading; take a snapshot again.".into())
}

/// The page as the agent reads it: text, and every visible control numbered.
/// A password field's value is never included.
const SNAPSHOT: &str = r#"(() => {
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[contenteditable=""],[contenteditable=true]';
  document.querySelectorAll('[data-cp-ref]').forEach((e) => e.removeAttribute('data-cp-ref'));
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= 300) break;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const ref = String(++n);
    el.setAttribute('data-cp-ref', ref);
    const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const secret = el.type === 'password';
    elements.push({
      ref, tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      role: el.getAttribute('role') || undefined,
      name,
      value: ('value' in el && !secret && el.tagName !== 'BUTTON') ? String(el.value).slice(0, 80) : undefined,
      checked: ('checked' in el && (el.type === 'checkbox' || el.type === 'radio')) ? el.checked : undefined,
      inView: r.bottom > 0 && r.top < innerHeight,
    });
  }
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 6000);
  return { ok: true, url: location.href, title: document.title, elements, text };
})()"#;

fn element_script(reference: &str, body: &str) -> String {
    let r = serde_json::to_string(reference).unwrap_or_else(|_| "\"\"".into());
    format!(
        "((ref) => {{ const el = document.querySelector('[data-cp-ref=\"' + ref + '\"]'); \
         if (!el) return {{ ok: false, error: 'No element ' + ref + ' on the page any more. Take a new snapshot.' }}; \
         el.scrollIntoView({{ block: 'center' }}); {body} }})({r})"
    )
}

fn click_script(reference: &str) -> String {
    element_script(reference, "el.focus(); el.click(); return { ok: true };")
}

fn type_script(reference: &str, text: &str, submit: bool) -> String {
    let t = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    element_script(
        reference,
        &format!(
            "el.focus(); const text = {t}; \
             if (el.isContentEditable) {{ document.execCommand('selectAll'); document.execCommand('insertText', false, text); }} \
             else {{ const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; \
                     const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, text); \
                     el.dispatchEvent(new Event('input', {{ bubbles: true }})); el.dispatchEvent(new Event('change', {{ bubbles: true }})); }} \
             if ({submit}) {{ if (el.form && el.form.requestSubmit) el.form.requestSubmit(); \
                     else el.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', bubbles: true }})); }} \
             return {{ ok: true }};"
        ),
    )
}

fn param_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("browser: \"{key}\" is required"))
}

fn open_page(app: &AppHandle) -> Result<Webview, String> {
    page(app).ok_or_else(|| "browser: no page is open. Use action \"open\" with a url first.".to_string())
}

/// One entry point for the agent (`browser.<op>` over desktop control) and the
/// panel (`browser_ui`). The two must never drift, so they share it.
pub async fn handle(app: AppHandle, op: &str, params: &Value) -> Result<Value, String> {
    match op {
        "open" | "navigate" => {
            let url = parse_address(param_str(params, "url")?)?;
            // Ask the panel to show itself: the person should see what the agent opens.
            let _ = app.emit("browser://open", json!({ "url": url.as_str() }));
            let wv = open_or_navigate(&app, url)?;
            settle(Duration::from_secs(20)).await;
            let now = wv.url().map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "url": now.as_str(), "loading": LOADING.load(Ordering::SeqCst) }))
        }
        "snapshot" => {
            let wv = open_page(&app)?;
            settle(Duration::from_secs(10)).await;
            run(&wv, SNAPSHOT).await
        }
        "click" => {
            let wv = open_page(&app)?;
            let out = run(&wv, &click_script(param_str(params, "ref")?)).await?;
            // A click often navigates; let the next snapshot see the new page.
            tokio::time::sleep(Duration::from_millis(300)).await;
            settle(Duration::from_secs(15)).await;
            Ok(out)
        }
        "type" => {
            let wv = open_page(&app)?;
            let submit = params.get("submit").and_then(|v| v.as_bool()).unwrap_or(false);
            let out = run(&wv, &type_script(param_str(params, "ref")?, param_str(params, "text")?, submit)).await?;
            if submit {
                tokio::time::sleep(Duration::from_millis(300)).await;
                settle(Duration::from_secs(15)).await;
            }
            Ok(out)
        }
        "scroll" => {
            let wv = open_page(&app)?;
            let dy = params.get("dy").and_then(|v| v.as_f64()).unwrap_or(600.0);
            wv.eval(&format!("window.scrollBy(0, {dy})")).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "back" | "forward" | "reload" => {
            let wv = open_page(&app)?;
            let js = match op {
                "back" => "history.back()",
                "forward" => "history.forward()",
                _ => "location.reload()",
            };
            wv.eval(js).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "state" => Ok(match page(&app) {
            Some(wv) => json!({ "open": true, "url": wv.url().map(|u| u.to_string()).unwrap_or_default(), "loading": LOADING.load(Ordering::SeqCst) }),
            None => json!({ "open": false }),
        }),
        // The panel reports where the page belongs; closing the panel parks it.
        "set_bounds" => {
            {
                let mut b = bounds().lock();
                b.x = params.get("x").and_then(|v| v.as_f64()).unwrap_or(b.x);
                b.y = params.get("y").and_then(|v| v.as_f64()).unwrap_or(b.y);
                b.w = params.get("width").and_then(|v| v.as_f64()).unwrap_or(b.w);
                b.h = params.get("height").and_then(|v| v.as_f64()).unwrap_or(b.h);
                b.visible = params.get("visible").and_then(|v| v.as_bool()).unwrap_or(b.visible);
            }
            if let Some(wv) = page(&app) {
                place(&wv)?;
            }
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("browser: unknown action \"{other}\"")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_bar_takes_urls_domains_and_words() {
        assert_eq!(parse_address("https://example.com/a").unwrap().as_str(), "https://example.com/a");
        assert_eq!(parse_address("example.com").unwrap().as_str(), "https://example.com/");
        assert!(parse_address("formular rev 3").unwrap().as_str().starts_with("https://duckduckgo.com/?q=formular%20rev%203"));
    }

    #[test]
    fn nothing_but_the_web_is_opened() {
        assert!(parse_address("file:///C:/Windows/win.ini").is_err());
        assert!(parse_address("javascript:alert(1)").is_err());
        assert!(parse_address("tauri://localhost").is_err());
        assert!(parse_address("   ").is_err());
        assert!(parse_address("mailto:someone@example.com").is_err());
    }

    #[test]
    fn a_reference_cannot_break_out_of_its_string() {
        let s = click_script("1\"]'); alert(1); ('");
        assert!(s.contains(r#"("1\"]'); alert(1); ('")"#));
    }
}
