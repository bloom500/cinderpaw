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
use tauri::webview::{DownloadEvent, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

/// Where a page waits while it is not the one on screen (the panel is closed,
/// or another tab is in front). Off screen rather than closed, so a login or
/// a half-filled form survives.
const PARKED: (f64, f64) = (-20_000.0, -20_000.0);

/// One tab: a child webview and the history Cinderpaw keeps for it.
///
/// Our own history, not the page's: `history.back()` run inside the page did
/// nothing a person could rely on (a first page has no entry, a redirect
/// leaves two), and the agent needs "back" to mean the page it saw before.
struct Tab {
    id: u32,
    label: String,
    title: String,
    history: Vec<String>,
    cursor: usize,
    /// A URL this module asked for (back, forward, home), so the page-load
    /// that reports it is not appended to the history a second time.
    expecting: Option<String>,
    loading: bool,
}

#[derive(Default)]
struct Tabs {
    list: Vec<Tab>,
    active: Option<u32>,
    next_id: u32,
}

fn tabs() -> &'static Mutex<Tabs> {
    static T: OnceLock<Mutex<Tabs>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Tabs::default()))
}

/// The start page. Shown by the panel as its own new-tab page; the webview
/// underneath is parked so the page shows through.
const HOME: &str = "about:blank";

fn tabs_json() -> Value {
    let t = tabs().lock();
    json!({
        "active": t.active,
        "tabs": t.list.iter().map(|tab| json!({
            "id": tab.id,
            "title": tab.title,
            "url": tab.history.get(tab.cursor).cloned().unwrap_or_else(|| HOME.into()),
            "loading": tab.loading,
            "canBack": tab.cursor > 0,
            "canForward": tab.cursor + 1 < tab.history.len(),
        })).collect::<Vec<_>>(),
    })
}

fn emit_state(app: &AppHandle) {
    let _ = app.emit("browser://state", tabs_json());
}

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

/// Unpacked Chrome extensions, one folder each. WebView2 loads them for every
/// tab (Windows only; the other platforms have no extension API in WebView).
pub fn extensions_dir() -> std::path::PathBuf {
    cinderpaw_core::paths::cinderpaw_dir().join("browser-extensions")
}

/// The extensions present: each subfolder with a manifest.json.
fn extensions_json() -> Value {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(extensions_dir()) {
        for e in entries.flatten() {
            let manifest = e.path().join("manifest.json");
            let Ok(text) = std::fs::read_to_string(&manifest) else { continue };
            let m: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            out.push(json!({
                "folder": e.file_name().to_string_lossy(),
                "name": m.get("name").and_then(|v| v.as_str()).unwrap_or("extension"),
                "version": m.get("version").and_then(|v| v.as_str()).unwrap_or(""),
            }));
        }
    }
    json!({ "ok": true, "path": extensions_dir().to_string_lossy(), "extensions": out })
}

/// uBlock Origin Lite, from its own GitHub releases, into the extensions
/// folder. Fetched on the person's press, never bundled: it is GPLv3 and this
/// app is Apache-2.0, and a download they asked for is not a distribution.
async fn install_adblock() -> Result<Value, String> {
    let client = reqwest::Client::builder().user_agent("cinderpaw").build().map_err(|e| e.to_string())?;
    let release: Value = client
        .get("https://api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest")
        .send().await.map_err(|e| format!("could not reach GitHub ({e})"))?
        .json().await.map_err(|e| e.to_string())?;
    let asset = release["assets"].as_array().and_then(|a| a.iter().find(|x| {
        x["name"].as_str().is_some_and(|n| n.ends_with(".chromium.zip"))
    })).ok_or_else(|| "the uBlock Origin Lite release has no Chromium build".to_string())?;
    let url = asset["browser_download_url"].as_str().ok_or_else(|| "no download link".to_string())?;
    let bytes = client.get(url).send().await.map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
    let dir = extensions_dir().join("ublock-origin-lite");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).map_err(|e| format!("not a zip: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // Only paths inside the folder; a zip may carry "../" entries.
        let Some(rel) = entry.enclosed_name() else { continue };
        let target = dir.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(json!({ "ok": true, "version": release["tag_name"].as_str().unwrap_or("") }))
}

/// Where downloads land first. Under the profile dir: never a place the
/// person picked, so nothing arrives on their desktop without them.
fn downloads_dir() -> std::path::PathBuf {
    cinderpaw_core::paths::cinderpaw_dir().join("browser-downloads")
}

/// A downloaded file: a PDF or a Word document goes to Artifacts, where the
/// agent can read and fill it; anything else is offered to the person in the
/// save dialog. Either way the panel is told.
fn on_downloaded(app: &AppHandle, url: &Url, path: &std::path::Path) {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("download").to_string();
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            let _ = app.emit("browser://download", json!({ "name": name, "error": e.to_string() }));
            return;
        }
    };
    let is_pdf = bytes.starts_with(b"%PDF");
    let is_docx = bytes.starts_with(b"PK") && name.to_lowercase().ends_with(".docx");
    if is_pdf || is_docx {
        use base64::Engine as _;
        let content = json!({ "name": name, "data": base64::engine::general_purpose::STANDARD.encode(&bytes) }).to_string();
        let msg = json!({
            "type": "artifact_op",
            "id": format!("browser-download-{}", uuid::Uuid::new_v4().simple()),
            "artifactAction": "import",
            "content": content,
        })
        .to_string();
        let tx = app.state::<crate::AppState>().cinderpaw_agent_tx.lock().clone();
        if let Some(tx) = tx {
            let app = app.clone();
            let name2 = name.clone();
            tauri::async_runtime::spawn(async move {
                let ok = tx.send(msg).await.is_ok();
                let _ = app.emit("browser://download", json!({ "name": name2, "artifact": ok }));
            });
            let _ = std::fs::remove_file(path);
            return;
        }
    }
    let _ = app.emit("browser://download", json!({ "name": name, "path": path.to_string_lossy(), "url": url.as_str() }));
}

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

/// The active tab's webview.
fn page(app: &AppHandle) -> Option<Webview> {
    let label = {
        let t = tabs().lock();
        let id = t.active?;
        t.list.iter().find(|tab| tab.id == id)?.label.clone()
    };
    app.get_webview(&label)
}

/// Put every tab where it belongs: the active one over the panel body when the
/// panel is showing and not on the home page, every other one parked.
fn place_all(app: &AppHandle) -> Result<(), String> {
    let b = *bounds().lock();
    let (active, labels): (Option<u32>, Vec<(u32, String, bool)>) = {
        let t = tabs().lock();
        (t.active, t.list.iter().map(|tab| (tab.id, tab.label.clone(), tab.history.get(tab.cursor).map(|u| u == HOME).unwrap_or(true))).collect())
    };
    for (id, label, at_home) in labels {
        let Some(wv) = app.get_webview(&label) else { continue };
        let show = b.visible && active == Some(id) && !at_home;
        let (x, y) = if show { (b.x, b.y) } else { PARKED };
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(b.w.max(1.0), b.h.max(1.0))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open `url` in the active tab, or in a new one when there is none.
fn open_or_navigate(app: &AppHandle, url: Url) -> Result<Webview, String> {
    if let Some(wv) = page(app) {
        {
            let mut t = tabs().lock();
            if let Some(tab) = t.active.and_then(|id| t.list.iter_mut().find(|x| x.id == id)) {
                tab.loading = true;
                tab.expecting = None;
            }
        }
        LOADING.store(true, Ordering::SeqCst);
        wv.navigate(url).map_err(|e| format!("browser: could not open the page ({e})"))?;
        return Ok(wv);
    }
    new_tab(app, url)
}

/// A new tab, in front, loading `url`.
fn new_tab(app: &AppHandle, url: Url) -> Result<Webview, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "browser: the main window is not open".to_string())?;
    let (id, label) = {
        let mut t = tabs().lock();
        t.next_id += 1;
        let id = t.next_id;
        let label = format!("browser-tab-{id}");
        t.list.push(Tab { id, label: label.clone(), title: String::new(), history: Vec::new(), cursor: 0, expecting: None, loading: true });
        t.active = Some(id);
        (id, label)
    };
    LOADING.store(true, Ordering::SeqCst);
    let events = app.clone();
    let _ = std::fs::create_dir_all(extensions_dir());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .data_directory(cinderpaw_core::paths::cinderpaw_dir().join("browser-profile"));
    // Extensions ride the WebView2 environment, which is created with the first
    // tab and shared by the rest, so one installed later shows up after a restart.
    #[cfg(windows)]
    let builder = builder.browser_extensions_enabled(true).extensions_path(extensions_dir());
    let builder = builder
        .on_navigation(|url| allowed(url))
        .on_download(|wv, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    // Keep the server's file name, in our own folder.
                    let name = destination.file_name().map(|n| n.to_os_string())
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("download").into());
                    let dir = downloads_dir();
                    let _ = std::fs::create_dir_all(&dir);
                    *destination = dir.join(format!("{}-{}", uuid::Uuid::new_v4().simple(), name.to_string_lossy()));
                }
                DownloadEvent::Finished { url, path, success } => {
                    if success {
                        if let Some(path) = path {
                            on_downloaded(wv.app_handle(), &url, &path);
                        }
                    } else {
                        let _ = wv.app_handle().emit("browser://download", json!({ "name": url.as_str(), "error": "the download failed" }));
                    }
                }
            }
            true
        })
        .on_page_load(move |wv, payload| {
            let finished = matches!(payload.event(), PageLoadEvent::Finished);
            let url = payload.url().to_string();
            {
                let mut t = tabs().lock();
                if let Some(tab) = t.list.iter_mut().find(|x| x.id == id) {
                    tab.loading = !finished;
                    if !finished {
                        // Started: this is where the tab is now. Our own
                        // request (back, forward, home) is already in place.
                        let expected = tab.expecting.take().is_some_and(|e| e == url);
                        let current = tab.history.get(tab.cursor).cloned();
                        if !expected && current.as_deref() != Some(url.as_str()) {
                            tab.history.truncate(tab.cursor + 1);
                            tab.history.push(url.clone());
                            tab.cursor = tab.history.len() - 1;
                        }
                        tab.title = url.clone();
                    }
                }
            }
            LOADING.store(tabs().lock().list.iter().any(|t| t.loading), Ordering::SeqCst);
            emit_state(&events);
            if finished {
                // The title arrives from the page itself, once it is there.
                let events = events.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(Value::String(title)) = run(&wv, "document.title").await {
                        let mut t = tabs().lock();
                        if let Some(tab) = t.list.iter_mut().find(|x| x.id == id) {
                            if !title.trim().is_empty() { tab.title = title; }
                        }
                        drop(t);
                        emit_state(&events);
                    }
                });
            }
        });
    let b = *bounds().lock();
    let wv = window
        .add_child(builder, LogicalPosition::new(PARKED.0, PARKED.1), LogicalSize::new(b.w.max(1.0), b.h.max(1.0)))
        .map_err(|e| format!("browser: could not open the page ({e})"))?;
    place_all(app)?;
    emit_state(app);
    Ok(wv)
}

/// Navigate the active tab to a URL from its own history (back/forward/home).
fn go_to(app: &AppHandle, url: &str) -> Result<(), String> {
    {
        let mut t = tabs().lock();
        if let Some(tab) = t.active.and_then(|id| t.list.iter_mut().find(|x| x.id == id)) {
            tab.expecting = Some(url.to_string());
            tab.loading = url != HOME;
        }
    }
    let wv = open_page(app)?;
    LOADING.store(true, Ordering::SeqCst);
    wv.navigate(Url::parse(url).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    place_all(app)?;
    emit_state(app);
    Ok(())
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
            let new = params.get("newTab").and_then(|v| v.as_bool()).unwrap_or(false);
            let wv = if new { new_tab(&app, url)? } else { open_or_navigate(&app, url)? };
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
        "back" | "forward" => {
            let target = {
                let mut t = tabs().lock();
                let tab = t.active.and_then(|id| t.list.iter_mut().find(|x| x.id == id))
                    .ok_or_else(|| "browser: no tab is open".to_string())?;
                if op == "back" {
                    if tab.cursor == 0 { return Ok(json!({ "ok": true, "note": "already at the first page" })); }
                    tab.cursor -= 1;
                } else {
                    if tab.cursor + 1 >= tab.history.len() { return Ok(json!({ "ok": true, "note": "already at the last page" })); }
                    tab.cursor += 1;
                }
                tab.history[tab.cursor].clone()
            };
            go_to(&app, &target)?;
            settle(Duration::from_secs(15)).await;
            Ok(json!({ "ok": true, "url": target }))
        }
        "reload" => {
            let wv = open_page(&app)?;
            wv.eval("location.reload()").map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        // The start page: the tab keeps its history, its page is parked, and
        // the panel shows its own new-tab page.
        "home" => {
            {
                let mut t = tabs().lock();
                if let Some(tab) = t.active.and_then(|id| t.list.iter_mut().find(|x| x.id == id)) {
                    if tab.history.get(tab.cursor).map(|u| u != HOME).unwrap_or(false) {
                        tab.history.truncate(tab.cursor + 1);
                        tab.history.push(HOME.into());
                        tab.cursor = tab.history.len() - 1;
                    }
                    tab.expecting = Some(HOME.into());
                    tab.title = String::new();
                }
            }
            if page(&app).is_some() {
                go_to(&app, HOME)?;
            }
            Ok(json!({ "ok": true }))
        }
        "tabs" | "state" => Ok(tabs_json()),
        "extensions" => Ok(extensions_json()),
        "install_adblock" => install_adblock().await,
        "new_tab" => {
            // Empty: the panel shows its new-tab page over a parked, blank webview.
            new_tab(&app, Url::parse(HOME).map_err(|e| e.to_string())?)?;
            {
                let mut t = tabs().lock();
                if let Some(tab) = t.active.and_then(|id| t.list.iter_mut().find(|x| x.id == id)) {
                    tab.history = vec![HOME.into()];
                    tab.cursor = 0;
                    tab.expecting = Some(HOME.into());
                    tab.loading = false;
                }
            }
            place_all(&app)?;
            emit_state(&app);
            Ok(tabs_json())
        }
        "switch_tab" => {
            let id = params.get("id").and_then(|v| v.as_u64()).ok_or_else(|| "browser: \"id\" is required".to_string())? as u32;
            {
                let mut t = tabs().lock();
                if !t.list.iter().any(|x| x.id == id) { return Err("browser: no such tab".into()); }
                t.active = Some(id);
            }
            place_all(&app)?;
            emit_state(&app);
            Ok(tabs_json())
        }
        "close_tab" => {
            let id = params.get("id").and_then(|v| v.as_u64()).ok_or_else(|| "browser: \"id\" is required".to_string())? as u32;
            let label = {
                let mut t = tabs().lock();
                let Some(pos) = t.list.iter().position(|x| x.id == id) else { return Err("browser: no such tab".into()) };
                let label = t.list.remove(pos).label;
                if t.active == Some(id) {
                    t.active = t.list.get(pos.saturating_sub(1)).or(t.list.first()).map(|x| x.id);
                }
                label
            };
            if let Some(wv) = app.get_webview(&label) {
                let _ = wv.close();
            }
            place_all(&app)?;
            emit_state(&app);
            Ok(tabs_json())
        }
        // The person chose where a download goes, in the save dialog.
        "save_download" => {
            let from = std::path::PathBuf::from(param_str(params, "path")?);
            let to = std::path::PathBuf::from(param_str(params, "dest")?);
            // Only files this browser downloaded, and never into our own data dir.
            if !from.starts_with(downloads_dir()) {
                return Err("browser: that is not a downloaded file".into());
            }
            if to.starts_with(cinderpaw_core::paths::cinderpaw_dir()) {
                return Err("browser: pick a place outside Cinderpaw's data folder".into());
            }
            if std::fs::rename(&from, &to).is_err() {
                std::fs::copy(&from, &to).map_err(|e| format!("browser: could not save the file ({e})"))?;
                let _ = std::fs::remove_file(&from);
            }
            Ok(json!({ "ok": true, "path": to.to_string_lossy() }))
        }
        "discard_download" => {
            let from = std::path::PathBuf::from(param_str(params, "path")?);
            if from.starts_with(downloads_dir()) {
                let _ = std::fs::remove_file(&from);
            }
            Ok(json!({ "ok": true }))
        }
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
            place_all(&app)?;
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
