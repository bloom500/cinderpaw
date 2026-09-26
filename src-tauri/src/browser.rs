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
    /// Where the webview was last put, so `place_all` skips the ones that do
    /// not move. Every set_bounds is a native resize the page lays itself out
    /// for; doing it for parked tabs too, twice each, was the lag when the
    /// sidebar or the chat drawer opened over a wide browser (17 Sep).
    placed: Option<(f64, f64, f64, f64)>,
    /// Restored with its address but not loaded yet: the webview sits on
    /// `about:blank` until the tab is first shown, and loads then, visible.
    /// What every real browser does with a restored session (Firefox calls it
    /// lazy restore): a page loaded hidden defers its work and does not
    /// always resume, so YouTube's home came back as a grey skeleton and
    /// OpenRouter as its landing page (20 Sep), and a webview per tab at boot
    /// is memory nobody asked for.
    dormant: bool,
    /// When this tab was last the active one, for discarding.
    last_active: std::time::Instant,
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

/// The open tabs, kept across restarts: a person's tabs are theirs until they
/// close them, the same as in any browser. Only what is needed to bring a tab
/// back (its address and title); the page itself is loaded again.
fn tabs_file() -> std::path::PathBuf {
    cinderpaw_core::paths::cinderpaw_dir().join("browser-tabs.json")
}

fn save_tabs() {
    let t = tabs().lock();
    let saved = json!({
        "active": t.active.and_then(|id| t.list.iter().position(|tab| tab.id == id)),
        "tabs": t.list.iter().map(|tab| json!({
            "url": tab.history.get(tab.cursor).cloned().unwrap_or_else(|| HOME.into()),
            "title": tab.title,
        })).collect::<Vec<_>>(),
    });
    drop(t);
    if let Ok(text) = serde_json::to_string(&saved) {
        let _ = std::fs::write(tabs_file(), text);
    }
}

/// Bring back the saved tabs, once, the first time the browser is touched
/// after a start. Not at boot: a webview per tab is memory nobody asked for
/// until the browser is opened.
fn restore_once(app: &AppHandle) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) || !tabs().lock().list.is_empty() {
        return;
    }
    let Ok(text) = std::fs::read_to_string(tabs_file()) else { return };
    let saved: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let Some(list) = saved["tabs"].as_array() else { return };
    let mut ids = Vec::new();
    let Ok(blank) = Url::parse(HOME) else { return };
    for entry in list {
        let url = entry["url"].as_str().unwrap_or(HOME);
        let Ok(url) = Url::parse(url) else { continue };
        if !allowed(&url) { continue; }
        // Every restored tab starts blank and remembers where it was; the
        // page itself loads on first showing (see `Tab::dormant`).
        let Ok(wv) = new_tab(app, blank.clone()) else { continue };
        let mut t = tabs().lock();
        if let Some(tab) = t.list.iter_mut().find(|x| x.label == wv.label()) {
            tab.title = entry["title"].as_str().unwrap_or("").to_string();
            tab.history = vec![url.to_string()];
            tab.cursor = 0;
            tab.expecting = Some(HOME.into());
            tab.loading = false;
            tab.dormant = url.as_str() != HOME;
            ids.push(tab.id);
        }
    }
    let active = saved["active"].as_u64().and_then(|i| ids.get(i as usize).copied()).or_else(|| ids.last().copied());
    tabs().lock().active = active;
    let _ = place_all(app);
    emit_state(app);
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
            "blocked": crate::adblock::blocked_on(&tab.label),
        })).collect::<Vec<_>>(),
    })
}

fn emit_state(app: &AppHandle) {
    let _ = app.emit("browser://state", tabs_json());
    save_tabs();
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

/// Runs in every page before anything else: notes the last moment a real
/// person clicked or typed in it. The agent's own clicks are `el.click()` and
/// dispatched events, which are never trusted, so only the person moves this.
const TOUCH_SCRIPT: &str = "(() => { const mark = (e) => { if (e.isTrusted) window.__cpTouched = Date.now(); };     addEventListener('pointerdown', mark, true); addEventListener('keydown', mark, true); })()";

/// Pages have no second window here, so everything that asks for one goes to
/// this tab instead: `window.open(url)` and `<a target=\"_blank\">`. Without
/// it the request died in silence, which is what \"Add another account\" at
/// Google looked like (20 Sep): a click, and nothing. The platform hook
/// (`on_new_window`) never fired for it; the page's own API always does.
///
/// The TOP window, not the frame: the script runs in every frame, Google's
/// account menu is an iframe, and navigating the iframe put AddSession inside
/// a box Google refuses to be framed in (a bare 403). A click carries the user
/// activation a cross-origin frame needs to navigate the top.
const NEW_WINDOW_SCRIPT: &str = "(() => {   const here = (u) => { try { const url = new URL(String(u), location.href); if (!/^https?:$/.test(url.protocol)) return; let w = window; try { w = window.top || window; } catch {} w.location.href = url.href; } catch {} };   window.open = (u) => { if (u) here(u); return null; };   addEventListener('click', (e) => {     const a = e.target && e.target.closest ? e.target.closest('a[target=\"_blank\"]') : null;     if (a && a.href && !e.defaultPrevented) { e.preventDefault(); here(a.href); }   }, true); })()";

/// Browser shortcuts pressed while the PAGE has the focus. Its key events
/// never reach the panel (a native view), and a page cannot call the host, so
/// the key rides the one channel a page has: its own address fragment, which
/// `watch_active_url` reads and puts back. Only the listed keys, so a page
/// cannot forge anything worse than "close me".
const KEY_SCRIPT: &str = "(() => { addEventListener('keydown', (e) => { if (!e.isTrusted || !(e.ctrlKey || e.metaKey) || e.altKey) return; const k = e.key.toLowerCase(); if (!['=', '+', '-', '0', 't', 'w', 'l', 'f', 'd', 'h', 'j', 'tab', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(k)) return; e.preventDefault(); e.stopPropagation(); try { history.replaceState(history.state, '', location.pathname + location.search + '#cp-key=' + encodeURIComponent(k) + '&s=' + (e.shiftKey ? 1 : 0) + '&h=' + encodeURIComponent(location.hash.slice(1))); } catch {} }, true); })()";

/// When the agent last acted in the page (ms since the epoch, the page's clock
/// too). A person's touch after this hands the page to them.
static AGENT_LAST_MS: parking_lot::Mutex<f64> = parking_lot::Mutex::new(0.0);

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// Slice 4 of the browser plan: a click by the person pauses the agent. Before
/// an action that changes the page, ask the page whether a person touched it
/// since the agent's last action within the last two minutes; if so, refuse
/// once (the agent is told to ask) and let the next attempt through.
async fn person_took_over(app: &AppHandle) -> bool {
    let last = *AGENT_LAST_MS.lock();
    if last == 0.0 || now_ms() - last > 120_000.0 { return false; }
    let Some(wv) = page(app) else { return false };
    let touched = run(&wv, "window.__cpTouched || 0").await.ok().and_then(|v| v.as_f64()).unwrap_or(0.0);
    // A touch the person made before their latest request is not a take-over:
    // the request itself is them handing the page back.
    let asked = cinderpaw_core::api::LAST_PERSON_REQUEST_MS.load(Ordering::SeqCst) as f64;
    touched > last && touched > asked
}

/// Unpacked Chrome extensions, one folder each. WebView2 loads them for every
/// tab (Windows only; the other platforms have no extension API in WebView).
pub fn extensions_dir() -> std::path::PathBuf {
    cinderpaw_core::paths::cinderpaw_dir().join("browser-extensions")
}

/// A manifest name like `__MSG_extName__` is a key into the extension's own
/// `_locales/<default_locale>/messages.json`; shown raw, uBlock Origin Lite
/// read "__MSG_extName__" in the settings (23 Sep). Keys are case-insensitive
/// in Chrome. Anything unresolved shows the raw text.
fn localized(dir: &std::path::Path, manifest: &Value, raw: &str) -> String {
    let Some(key) = raw.strip_prefix("__MSG_").and_then(|k| k.strip_suffix("__")) else { return raw.to_string() };
    let locale = manifest.get("default_locale").and_then(|v| v.as_str()).unwrap_or("en");
    std::fs::read_to_string(dir.join("_locales").join(locale).join("messages.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|msgs| {
            msgs.as_object()?.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .and_then(|(_, v)| v.get("message")?.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| raw.to_string())
}

/// The extensions present: each subfolder with a manifest.json.
fn extensions_json() -> Value {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(extensions_dir()) {
        for e in entries.flatten() {
            let manifest = e.path().join("manifest.json");
            let Ok(text) = std::fs::read_to_string(&manifest) else { continue };
            let m: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("extension");
            out.push(json!({
                "folder": e.file_name().to_string_lossy(),
                "name": localized(&e.path(), &m, name),
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

/// Downloads since the agent last heard about them. A click that starts a
/// download changes nothing on the page, so without this the agent saw "click
/// done", took a snapshot of the same page and concluded the link was dead
/// (17 Sep, the RAR form).
fn pending_downloads() -> &'static Mutex<Vec<String>> {
    static P: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(Vec::new()))
}

fn take_downloads() -> Vec<String> {
    std::mem::take(&mut *pending_downloads().lock())
}

/// Where downloads land first. Under the profile dir: never a place the
/// person picked, so nothing arrives on their desktop without them.
fn downloads_dir() -> std::path::PathBuf {
    cinderpaw_core::paths::cinderpaw_dir().join("browser-downloads")
}

/// The largest file the panel opens, in bytes. The sidecar refuses anything
/// bigger (`PDF_MAX_BYTES` in `CinderpawAgent/src/dispatch.ts`); a test there
/// reads this number so the two cannot drift. Checked here BEFORE the import
/// is attempted, because a refusal after the download was deleted lost the
/// file (Astra, 19 Sep 2026, P1).
pub const ARTIFACT_IMPORT_MAX_BYTES: usize = 20 * 1024 * 1024;

/// How long the sidecar gets to say whether an import worked before the file
/// is treated as not imported and offered to the person instead.
const ARTIFACT_IMPORT_CONFIRM: Duration = Duration::from_secs(60);

/// A downloaded file: a PDF or a Word document goes to Artifacts, where the
/// agent can read and fill it; anything else is offered to the person in the
/// save dialog. Either way the panel is told.
///
/// The downloaded copy is deleted only once the sidecar has CONFIRMED the
/// import. It used to go the moment the message was on the channel, so a
/// file the sidecar then refused (too big, not a real PDF, sidecar down) was
/// gone from disk while the panel said "now in Artifacts".
/// The person's Downloads folder, with a name no file there has yet:
/// "clip.mp4", then "clip (2).mp4". The download itself waits in our own
/// folder under a uuid prefix; this is where it goes to live.
fn deliver(from: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let dir = dirs::download_dir().or_else(dirs::home_dir).ok_or("no Downloads folder on this system")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = from.file_name().and_then(|n| n.to_str()).unwrap_or("download");
    // Strip the uuid prefix we added when the download was requested.
    let name = raw.split_once('-').filter(|(p, _)| p.len() == 32).map(|(_, n)| n).unwrap_or(raw);
    let (stem, ext) = match name.rsplit_once('.') { Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")), _ => (name.to_string(), String::new()) };
    let mut to = dir.join(name);
    let mut n = 2;
    while to.exists() { to = dir.join(format!("{stem} ({n}){ext}")); n += 1; }
    if std::fs::rename(from, &to).is_err() {
        std::fs::copy(from, &to).map_err(|e| format!("could not save the file ({e})"))?;
        let _ = std::fs::remove_file(from);
    }
    Ok(to)
}

/// The file goes to Downloads and the panel hears where; the reason, when
/// there is one, says why it did not go to Artifacts.
fn deliver_and_tell(app: &AppHandle, name: &str, path: &std::path::Path, reason: Option<String>) {
    match deliver(path) {
        Ok(dest) => {
            pending_downloads().lock().push(format!("{name} (saved to {})", dest.to_string_lossy()));
            let _ = app.emit("browser://download", json!({ "name": name, "dest": dest.to_string_lossy(), "reason": reason }));
        }
        Err(e) => {
            let _ = app.emit("browser://download", json!({ "name": name, "error": e }));
        }
    }
}

fn on_downloaded(app: &AppHandle, url: &Url, path: &std::path::Path) {
    use std::io::Read as _;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("download").to_string();
    // The first bytes say what it is; a 2 GB video is not read to find out.
    let mut head = [0u8; 8];
    let (head_len, size) = match std::fs::File::open(path).and_then(|mut f| { let n = f.read(&mut head)?; Ok((n, f.metadata()?.len() as usize)) }) {
        Ok(v) => v,
        Err(e) => {
            let _ = app.emit("browser://download", json!({ "name": name, "error": e.to_string() }));
            return;
        }
    };
    let head = &head[..head_len];
    let is_pdf = head.starts_with(b"%PDF");
    let is_docx = head.starts_with(b"PK") && name.to_lowercase().ends_with(".docx");
    if (is_pdf || is_docx) && size > ARTIFACT_IMPORT_MAX_BYTES {
        // Known in advance: do not even try, hand it to the person with the reason.
        let reason = format!(
            "{} MB is more than the {} MB Artifacts opens, so it was saved as a file",
            size.div_ceil(1024 * 1024),
            ARTIFACT_IMPORT_MAX_BYTES / 1024 / 1024
        );
        deliver_and_tell(app, &name, path, Some(reason));
        return;
    }
    if is_pdf || is_docx {
        use base64::Engine as _;
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => { let _ = app.emit("browser://download", json!({ "name": name, "error": e.to_string() })); return; }
        };
        let content = json!({ "name": name, "data": base64::engine::general_purpose::STANDARD.encode(&bytes) }).to_string();
        let msg = json!({
            "type": "artifact_op",
            "id": format!("browser-download-{}", uuid::Uuid::new_v4().simple()),
            "artifactAction": "import",
            "content": content,
        });
        let id = msg["id"].as_str().unwrap_or_default().to_string();
        let state = app.state::<crate::AppState>();
        let tx = state.cinderpaw_agent_tx.lock().clone();
        if let Some(tx) = tx {
            // Subscribed BEFORE the send, or a fast answer is missed.
            let events = state.runtime.events_tx.subscribe();
            let app = app.clone();
            let name2 = name.clone();
            let url2 = url.as_str().to_string();
            let path2 = path.to_path_buf();
            let what = if is_pdf { "PDF" } else { "Word document" };
            pending_downloads().lock().push(format!("{name} (a {what}, sent to Artifacts; artifact_list shows it once imported)"));
            tauri::async_runtime::spawn(async move {
                let outcome = if tx.send(msg.to_string()).await.is_err() {
                    Err("Cinderpaw's agent is not running".to_string())
                } else {
                    await_import(events, &id).await
                };
                match outcome {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&path2);
                        let _ = app.emit("browser://download", json!({ "name": name2, "artifact": true }));
                    }
                    Err(reason) => {
                        // Not in Artifacts, so in Downloads, with the reason on screen.
                        let _ = url2;
                        deliver_and_tell(&app, &name2, &path2, Some(format!("not imported into Artifacts: {reason}")));
                    }
                }
            });
            return;
        }
    }
    let _ = url;
    deliver_and_tell(app, &name, path, None);
}

/// Wait for the sidecar's `artifact_result` for one import.
///
/// `Ok` when it says the artifact exists, `Err(reason)` when it refused, when
/// the bus closed, or when nothing came back in time. Silence is a failure
/// here on purpose: the only thing that may delete the download is a
/// confirmed import.
async fn await_import(
    mut events: tokio::sync::broadcast::Receiver<cinderpaw_core::host::HostEvent>,
    id: &str,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + ARTIFACT_IMPORT_CONFIRM;
    loop {
        let ev = match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(ev)) => ev,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => return Err("the agent stopped before confirming the import".into()),
            Err(_) => return Err("the agent did not confirm the import in time".into()),
        };
        if let Some(verdict) = import_verdict(&ev, id) {
            return verdict;
        }
    }
}

/// The verdict a host event carries for import `id`, if it is about it.
fn import_verdict(ev: &cinderpaw_core::host::HostEvent, id: &str) -> Option<Result<(), String>> {
    if ev.event != "cinderpaw://agent-output" {
        return None;
    }
    let line: Value = serde_json::from_str(ev.payload.get("data")?.as_str()?).ok()?;
    if line["type"] != "artifact_result" || line["id"] != id {
        return None;
    }
    Some(if line["ok"].as_bool().unwrap_or(false) {
        Ok(())
    } else {
        Err(line["error"].as_str().unwrap_or("the agent refused the file").to_string())
    })
}

/// Attach the downloads the agent has not seen to a result.
fn with_downloads(mut out: Value) -> Value {
    let d = take_downloads();
    if !d.is_empty() {
        if let Some(obj) = out.as_object_mut() {
            obj.insert("downloads".into(), json!(d));
        }
    }
    out
}

/// Only the web. `file:` would read the disk, `javascript:` would run in the
/// page, and the app's own schemes would load the app inside itself.
pub fn allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank" || is_reader_url(url.as_str())
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

/// The page the person is looking at right now, when the browser panel is
/// showing one: `(url, title)`. Read on every send so the agent knows the
/// browser is open without being told — see `cinderpaw_send_message`.
pub fn visible_page() -> Option<(String, String)> {
    if !bounds().lock().visible {
        return None;
    }
    let t = tabs().lock();
    let id = t.active?;
    let tab = t.list.iter().find(|x| x.id == id)?;
    let url = tab.history.get(tab.cursor)?.clone();
    if url == HOME {
        return None;
    }
    Some((url, tab.title.clone()))
}

/// The active tab's webview.
/// Follow the active tab through navigations the engine never reports as a
/// page load: `history.pushState` on a single-page app (YouTube's videos,
/// OpenRouter's panels). Without this the saved tab kept the address the page
/// FIRST loaded at, and a restart brought back the home page instead of where
/// the person was (20 Sep). `Webview::url` reflects same-document changes, so
/// a poll of the active tab is enough; two seconds is well under a person's
/// time between reading one panel and the next.
/// A background tab untouched this long is discarded: its page goes back to
/// `about:blank` and it becomes dormant, exactly like a restored tab, with its
/// title and address kept in the strip and a reload on the next click. What
/// Chrome's Memory Saver does (2 to 6 hours by setting); two here, since the
/// engine's memory is shared with a model that may be running next to it.
const DISCARD_AFTER: std::time::Duration = std::time::Duration::from_secs(2 * 3600);

fn discard_stale(app: &AppHandle) {
    let stale: Vec<String> = {
        let mut t = tabs().lock();
        let active = t.active;
        t.list.iter_mut()
            .filter(|tab| Some(tab.id) != active && !tab.dormant && !tab.loading
                && tab.history.get(tab.cursor).map(|u| u != HOME).unwrap_or(false)
                && tab.last_active.elapsed() > DISCARD_AFTER)
            .map(|tab| { tab.dormant = true; tab.expecting = Some(HOME.into()); tab.label.clone() })
            .collect()
    };
    for label in stale {
        if let (Some(wv), Ok(blank)) = (app.get_webview(&label), Url::parse(HOME)) {
            let _ = wv.navigate(blank);
        }
    }
}

fn watch_active_url(app: &AppHandle) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticks: u64 = 0;
        loop {
            // 250 ms: fast enough for a shortcut to feel like one. Reading the
            // address is a property read on the platform view, not a script.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            ticks += 1;
            if ticks % 240 == 0 { discard_stale(&app); }
            let Some(wv) = page(&app) else { continue };
            let Ok(now) = wv.url() else { continue };
            if now.fragment().is_some_and(|f| f.starts_with("cp-key=")) {
                let mut key = String::new();
                let mut shift = false;
                let mut hash = String::new();
                for (k, v) in url::form_urlencoded::parse(now.fragment().unwrap_or("").as_bytes()) {
                    match &*k { "cp-key" => key = v.into_owned(), "s" => shift = v == "1", "h" => hash = v.into_owned(), _ => {} }
                }
                // The page's own fragment goes back (a "#/route" app must keep its route).
                let back = serde_json::to_string(&hash).unwrap_or_else(|_| "\"\"".into());
                let _ = wv.eval(&format!("try {{ const h = {back}; history.replaceState(history.state, '', location.pathname + location.search + (h ? '#' + h : '')); }} catch (e) {{}}"));
                let _ = app.emit("browser://key", json!({ "key": key, "shift": shift }));
                continue;
            }
            let now = now.to_string();
            if now == HOME || now == "about:blank" || now.contains("#cp-") { continue; }
            let changed = {
                let mut t = tabs().lock();
                let Some(tab) = t.active.and_then(|id| t.list.iter_mut().find(|x| x.id == id)) else { continue };
                if tab.loading || tab.history.get(tab.cursor).map(|u| u == &now).unwrap_or(false) {
                    false
                } else {
                    tab.history.truncate(tab.cursor + 1);
                    tab.history.push(now);
                    tab.cursor = tab.history.len() - 1;
                    true
                }
            };
            if changed { emit_state(&app); }
        }
    });
}

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
    let (active, labels): (Option<u32>, Vec<(u32, String, bool, Option<(f64, f64, f64, f64)>, Option<String>)>) = {
        let t = tabs().lock();
        (t.active, t.list.iter().map(|tab| (
            tab.id, tab.label.clone(),
            tab.history.get(tab.cursor).map(|u| u == HOME).unwrap_or(true),
            tab.placed,
            if tab.dormant { tab.history.get(tab.cursor).cloned() } else { None },
        )).collect())
    };
    for (id, label, at_home, placed, wake) in labels {
        let Some(wv) = app.get_webview(&label) else { continue };
        // A page in its own fullscreen owns the screen until it leaves it; the
        // panel's resize reports as the window grows would shrink it back.
        if FULLSCREEN_TAB.lock().map(|f| f.as_deref() == Some(label.as_str())).unwrap_or(false) { continue; }
        let show = b.visible && active == Some(id) && !at_home;
        // A parked tab keeps whatever size it had; it is sized when it is shown.
        let want = if show { (b.x, b.y, b.w.max(1.0), b.h.max(1.0)) } else {
            let (w, h) = placed.map(|p| (p.2, p.3)).unwrap_or((b.w.max(1.0), b.h.max(1.0)));
            (PARKED.0, PARKED.1, w, h)
        };
        // Shown and hidden explicitly, not only moved. Parking by position alone
        // left WebView2 to notice on its own that the page had gone off-screen,
        // and it suspends rendering when it does; brought back at the SAME size
        // it sometimes never resumed, and the panel showed a white page that a
        // reload painted into the same dead surface (20 Sep, intermittent).
        // `hide`/`show` is the signal the engine actually listens to. Best
        // effort: a platform without them still gets the move.
        if !show { let _ = wv.hide(); }
        if placed != Some(want) {
            // One call: position and size together are one native resize, not two.
            wv.set_bounds(tauri::Rect {
                position: LogicalPosition::new(want.0, want.1).into(),
                size: LogicalSize::new(want.2, want.3).into(),
            }).map_err(|e| e.to_string())?;
            if let Some(tab) = tabs().lock().list.iter_mut().find(|x| x.id == id) { tab.placed = Some(want); }
        }
        if show {
            let _ = wv.show();
            // First showing of a restored tab: load it now, visible. After
            // `show`, never before, or the page defers its work again.
            if let Some(url) = wake.as_deref().and_then(|u| Url::parse(u).ok()) {
                {
                    let mut t = tabs().lock();
                    if let Some(tab) = t.list.iter_mut().find(|x| x.id == id) {
                        tab.dormant = false;
                        tab.expecting = Some(url.to_string());
                        tab.loading = true;
                    }
                }
                LOADING.store(true, Ordering::SeqCst);
                let _ = wv.navigate(url);
            }
        }
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

/// The tab whose page is in element fullscreen (a video's fullscreen button),
/// if any. See `page_fullscreen`.
static FULLSCREEN_TAB: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// The window was maximised when the page went fullscreen, to restore after.
static WAS_MAXIMIZED: AtomicBool = AtomicBool::new(false);

/// A page asked for fullscreen, or left it. A child webview's fullscreen only
/// fills the webview, so a YouTube video went "fullscreen" inside the panel
/// (23 Sep). Every browser answers by giving the page the whole screen: the
/// window goes fullscreen and the page covers it; on the way out both return
/// and the panel places the page again. Esc, the video's own button and F11
/// all arrive here the same way.
fn page_fullscreen(app: &AppHandle, label: String, on: bool) {
    let app = app.clone();
    // Off the WebView2 callback: window calls from inside it can wait on the
    // same thread that is running it.
    tauri::async_runtime::spawn(async move {
        let (Some(window), Some(wv)) = (app.get_window("main"), app.get_webview(&label)) else { return };
        if on {
            if let Ok(mut f) = FULLSCREEN_TAB.lock() { *f = Some(label.clone()); }
            // A maximised undecorated window keeps its client area clipped to
            // the work area, and fullscreen inherited the clip: the page ended
            // 49 px short, exactly where the taskbar sat over it (23 Sep, his
            // window was maximised). Leave maximised first; put it back after.
            let was_max = window.is_maximized().unwrap_or(false);
            WAS_MAXIMIZED.store(was_max, Ordering::SeqCst);
            if was_max { let _ = window.unmaximize(); }
            let _ = window.set_fullscreen(true);
            // A transparent window in fullscreen stays under the Windows 11
            // taskbar (tauri#7328); he saw the bar over the video. Topmost for
            // as long as the page is fullscreen puts it above.
            // ponytail: stays topmost if he Alt-Tabs away mid-video; drop it on
            // focus loss if that bothers anyone.
            let _ = window.set_always_on_top(true);
            // The window's size once it has become fullscreen, not the monitor's
            // read at the call: sized that early the page stopped 49 px short of
            // the bottom (23 Sep). Read until two reads agree.
            let mut last = (0.0, 0.0);
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_millis(60)).await;
                let (Ok(px), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { break };
                let size = px.to_logical::<f64>(scale);
                if (size.width, size.height) == last { break; }
                last = (size.width, size.height);
            }
            let _ = wv.set_bounds(tauri::Rect {
                position: LogicalPosition::new(0.0, 0.0).into(),
                size: LogicalSize::new(last.0, last.1).into(),
            });
            tracing::info!(%label, w = last.0, h = last.1, "browser: page fullscreen");
            let _ = wv.set_focus();
        } else {
            if let Ok(mut f) = FULLSCREEN_TAB.lock() { *f = None; }
            tracing::info!(%label, "browser: page left fullscreen");
            let _ = window.set_always_on_top(false);
            let _ = window.set_fullscreen(false);
            if WAS_MAXIMIZED.swap(false, Ordering::SeqCst) { let _ = window.maximize(); }
            if let Some(tab) = tabs().lock().list.iter_mut().find(|t| t.label == label) { tab.placed = None; }
            let _ = place_all(&app);
        }
    });
}

/// ponytail: Windows only. WKWebView (macOS) needs `elementFullscreenEnabled`
/// and its own window handling; there a video's fullscreen stays in the panel.
#[cfg(windows)]
fn hook_fullscreen(wv: &Webview, app: AppHandle, label: String) {
    use webview2_com::ContainsFullScreenElementChangedEventHandler;
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
            let mut on = windows_core::BOOL::default();
            if let Some(s) = sender { s.ContainsFullScreenElement(&mut on)?; }
            page_fullscreen(&app, label.clone(), on.as_bool());
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ContainsFullScreenElementChanged(&handler, &mut token);
    });
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
        t.list.push(Tab { id, label: label.clone(), title: String::new(), history: Vec::new(), cursor: 0, expecting: None, loading: true, placed: None, dormant: false, last_active: std::time::Instant::now() });
        t.active = Some(id);
        (id, label)
    };
    LOADING.store(true, Ordering::SeqCst);
    let events = app.clone();
    let _ = std::fs::create_dir_all(extensions_dir());
    let at_home = url.as_str() == HOME;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .initialization_script(TOUCH_SCRIPT)
        .initialization_script(NEW_WINDOW_SCRIPT)
        .initialization_script(KEY_SCRIPT)
        .data_directory(cinderpaw_core::paths::cinderpaw_dir().join("browser-profile"));
    // Extensions ride the WebView2 environment, which is created with the first
    // tab and shared by the rest, so one installed later shows up after a restart.
    #[cfg(windows)]
    let builder = builder.browser_extensions_enabled(true).extensions_path(extensions_dir());
    let popup_app = app.clone();
    let builder = builder
        .on_navigation(|url| allowed(url))
        // `window.open` and `target="_blank"`: without a handler the page's
        // request went nowhere, silently, which is what "add another Google
        // account" (a popup) and every new-window link looked like (20 Sep).
        // Every such request becomes a tab of ours, in the same profile, so
        // the login it carries lands where the person is.
        .on_new_window(move |url, _features| {
            if allowed(&url) {
                let app = popup_app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = new_tab(&app, url) {
                        tracing::warn!(error = %e, "browser: popup could not open as a tab");
                    }
                });
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(|wv, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    // Keep the server's file name, in our own folder.
                    let name = destination.file_name().map(|n| n.to_os_string())
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("download").into());
                    let dir = downloads_dir();
                    let _ = std::fs::create_dir_all(&dir);
                    // Said now, not only when it lands: a large file took
                    // minutes with nothing on screen after the click.
                    let _ = wv.app_handle().emit("browser://download", json!({ "name": name.to_string_lossy(), "started": true }));
                    *destination = dir.join(format!("{}-{}", uuid::Uuid::new_v4().simple(), name.to_string_lossy()));
                }
                DownloadEvent::Finished { url, path, success } => {
                    if success {
                        if let Some(path) = path {
                            on_downloaded(wv.app_handle(), &url, &path);
                        }
                    } else {
                        // The file's name, not the whole address: that one can
                        // carry a signed query string a screen should not show.
                        let name = url.path_segments().and_then(|mut s| s.next_back()).filter(|n| !n.is_empty()).unwrap_or("the file");
                        let _ = wv.app_handle().emit("browser://download", json!({ "name": name, "error": "the download failed" }));
                    }
                }
                // The enum is non-exhaustive: a kind Tauri adds later is allowed through.
                _ => {}
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
                        // A new page: the "Blocked N" count starts over with it.
                        crate::adblock::reset(&tab.label);
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
            // Leaving the start page is decided HERE, when the new address lands
            // in history: nothing placed the page after a search from the new-tab
            // page, so the panel hid its own page and showed the white body
            // behind a webview still parked off-screen, until a resize. A no-op
            // when nothing moved: place_all skips tabs already where they belong.
            let _ = place_all(&events);
            emit_state(&events);
            if finished {
                // What the lists say to hide on this page (ad slots, cookie
                // walls): one stylesheet, appended once the document exists.
                if let Some(css) = crate::adblock::cosmetic_css(&url) {
                    let _ = wv.eval(format!(
                        "(()=>{{const s=document.createElement('style');s.textContent={};document.documentElement.appendChild(s)}})()",
                        serde_json::to_string(&css).unwrap_or_default()
                    ));
                }
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
    // Ads and trackers are answered before they leave the machine (Windows).
    crate::adblock::hook_requests(&wv, label.clone());
    #[cfg(windows)]
    hook_fullscreen(&wv, app.clone(), label.clone());
    place_all(app)?;
    watch_active_url(app);
    if at_home {
        // A new tab is for typing into. The child takes the keyboard focus the
        // moment it is created, parked or not, and the panel's search box kept
        // losing it (20 Sep); the main webview gets it back here, and the
        // document's focused element comes back with it.
        if let Some(main) = window.webviews().into_iter().find(|w| w.label() == "main") {
            let _ = main.set_focus();
        }
    }
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
///
/// The address is put back on EVERY path, which it was not: the restore used to
/// sit on the success path only, so a page that never answered — the timeout,
/// which is the common case on a slow load, exactly when a snapshot is retried —
/// kept `#cp-<uuid>=<json>` in its address for as long as it stayed open. That
/// address is what the address bar shows and what a later search re-submits,
/// which is how `%23cp-…` ended up inside DuckDuckGo's own `q=`: the marker was
/// never a leak out of the browser, it was one we left behind in the page.
async fn run(wv: &Webview, expression: &str) -> Result<Value, String> {
    let before = wv.url().map_err(|e| e.to_string())?;
    let marker = format!("cp-{}=", uuid::Uuid::new_v4().simple());
    let script = format!(
        "(() => {{ let r; try {{ r = ({expression}); }} catch (e) {{ r = {{ ok: false, error: String((e && e.message) || e) }}; }} \
         try {{ history.replaceState(history.state, '', location.pathname + location.search + '#{marker}' + encodeURIComponent(JSON.stringify(r))); }} catch (e) {{}} }})()"
    );
    wv.eval(&script).map_err(|e| e.to_string())?;

    // Put the address back exactly as it was, and only if OUR marker is still
    // the one on it: a page the user navigated in the meantime must not be
    // yanked back to where it started.
    let restore = |wv: &Webview| {
        let to = serde_json::to_string(before.as_str()).unwrap_or_else(|_| "location.href".into());
        let _ = wv.eval(&format!(
            "try {{ if (location.hash.indexOf('#{marker}') === 0) history.replaceState(history.state, '', {to}); }} catch (e) {{}}"
        ));
    };

    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let now = wv.url().map_err(|e| e.to_string())?;
        let Some(encoded) = now.fragment().and_then(|f| f.strip_prefix(marker.as_str())) else { continue };
        let text = urlencoding::decode(encoded).map_err(|e| e.to_string())?.into_owned();
        restore(wv);
        return serde_json::from_str(&text).map_err(|e| format!("browser: the page's answer was unreadable ({e})"));
    }
    // The answer never came. Clean up anyway: the script may have landed after
    // the last poll, and a fragment nobody reads is still an address the user
    // sees and searches with.
    restore(wv);
    Err("browser: the page did not answer. It may still be loading; take a snapshot again.".into())
}

/// The page as the agent reads it: text, and every visible control numbered.
/// A password field's value is never included.
/// What a person can actually see. Everything else is where a page hides
/// instructions for an agent: white-on-white text, a 0px font, a div parked
/// off-screen, an `aria-hidden` block, a comment, a `<template>`. Neither
/// the snapshot nor the reader text ever contains them, so the model cannot
/// be reached through them. Injected as functions; both readers call them.
const VISIBLE_TEXT: &str = r#"
  const cpHidden = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true;
    if (parseFloat(s.opacity) < 0.1) return true;
    if (parseFloat(s.fontSize) <= 4) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return true;
    if (r.right < -200 || r.bottom < -200 || r.left > innerWidth + 4000 || r.top > document.documentElement.scrollHeight + 4000) return true;
    if (s.color && s.backgroundColor && s.color === s.backgroundColor) return true;
    return false;
  };
  const cpVisibleText = (root) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
      const p = n.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName; if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'TITLE') return NodeFilter.FILTER_REJECT;
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
      for (let e = p; e && e !== root; e = e.parentElement) { if (cpHidden(e)) return NodeFilter.FILTER_REJECT; }
      return NodeFilter.FILTER_ACCEPT; } });
    let node; while ((node = walker.nextNode())) {
      const t = node.nodeValue.replace(/\s+/g, ' ');
      const p = node.parentElement; const block = /^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|BR|TD|TH|PRE|BLOCKQUOTE)$/.test(p.tagName);
      out.push(block ? '\n' + t : t);
    }
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  // A clone of the document with every hidden element gone. Styles are only
  // computable on the live tree, so the live tree is marked, the clone is
  // pruned by the marks, and the marks are removed again: the page is left
  // exactly as it was.
  const cpVisibleClone = () => {
    const marked = [];
    for (const el of document.querySelectorAll('body *')) { if (cpHidden(el)) { el.setAttribute('data-cp-hidden', '1'); marked.push(el); } }
    // Parsed, not cloned: a DOMParser document has no CSP, so Readability's
    // own innerHTML writes work on sites that require TrustedHTML (GitHub,
    // Google). A cloneNode of the document kept the site's policy.
    const clone = new DOMParser().parseFromString('<!doctype html>' + document.documentElement.outerHTML, 'text/html');
    for (const el of marked) el.removeAttribute('data-cp-hidden');
    clone.querySelectorAll('[data-cp-hidden], script, style, noscript, template').forEach((el) => el.remove());
    return clone;
  };
"#;

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
  const text = (document.body ? cpVisibleText(document.body) : '').slice(0, 6000);
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

/// Mozilla's Readability, unmodified. See vendor/readability/README.md.
const READABILITY: &str = include_str!("../vendor/readability/Readability.js");

/// The article, extracted in the page and handed to the host as data.
const READER_EXTRACT: &str = r#"
  const a = new Readability(cpVisibleClone()).parse();
  return a ? { title: a.title, byline: a.byline || a.siteName || '', content: a.content, length: a.length } : null;
"#;

// ── Reader view ───────────────────────────────────────────────────────────
//
// The article is shown on a page of OUR OWN (the `cinderpaw-reader` scheme),
// not written into the site's document. It used to be `document.write` in
// place, which died on every site with a strict CSP: "This document requires
// 'TrustedHTML' assignment" on GitHub and Google, and a style-src that would
// have stripped our stylesheet anyway. A navigation also makes it a real
// toggle: Back is the original page, and the address bar knows which is which.

/// Reader pages waiting to be served, by id. Kept for the app's lifetime so
/// Back/Forward can land on one again; an article is a few hundred KB at
/// most. ponytail: evict by tab if someone reads a thousand articles a day.
fn reader_pages() -> &'static Mutex<std::collections::HashMap<String, String>> {
    static PAGES: OnceLock<Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    PAGES.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Where a custom scheme lives on this platform.
fn reader_url(id: &str, original: &str) -> Url {
    let q = urlencoding::encode(original);
    #[cfg(windows)]
    let s = format!("http://cinderpaw-reader.localhost/{id}?u={q}");
    #[cfg(not(windows))]
    let s = format!("cinderpaw-reader://localhost/{id}?u={q}");
    Url::parse(&s).expect("reader url")
}

pub fn is_reader_url(u: &str) -> bool {
    u.starts_with("http://cinderpaw-reader.localhost/") || u.starts_with("cinderpaw-reader://localhost/")
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Our reader page. The CSP meta means no script can ever run in it: the
/// article body is the site's markup, and this origin is ours.
fn reader_html(title: &str, byline: &str, content: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{t}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline'; font-src *">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {{ color-scheme: light dark; }}
  body {{ margin: 0; background: #faf7f2; color: #1d1a16; font: 19px/1.6 Georgia, "Times New Roman", serif; }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #1c1a17; color: #ece6dc; }} a {{ color: #f0a868; }} }}
  main {{ max-width: 42rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }}
  h1 {{ font-size: 2rem; line-height: 1.2; margin: 0 0 .5rem; }}
  .byline {{ opacity: .65; font-size: .9rem; margin-bottom: 2rem; }}
  img, video {{ max-width: 100%; height: auto; }}
  pre {{ overflow: auto; font-size: .85rem; }}
  a {{ color: #925e22; }}
</style></head><body><main>
<h1>{t}</h1>
<div class="byline">{b}</div>
{c}
</main></body></html>"#,
        t = esc(title),
        b = esc(byline),
        c = content,
    )
}

/// Serves `cinderpaw-reader://localhost/<id>`. Registered in lib.rs.
pub fn reader_protocol<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    let id = request.uri().path().trim_start_matches('/');
    let body = reader_pages()
        .lock()
        .get(id)
        .cloned()
        .unwrap_or_else(|| reader_html("This reader page is gone", "", "<p>Go back, and open the reader again.</p>"));
    tauri::http::Response::builder()
        .header("content-type", "text/html; charset=utf-8")
        .body(std::borrow::Cow::Owned(body.into_bytes()))
        .expect("reader response")
}

fn find_script(query_json: &str, direction_json: &str) -> String {
    format!(r#"(() => {{
  const q = {query_json}; const dir = {direction_json};
  const S = (window.__cpFind ||= {{ ranges: [], i: -1, q: '' }});
  const clear = () => {{ try {{ CSS.highlights.delete('cp-find'); CSS.highlights.delete('cp-find-current'); }} catch {{}} S.ranges = []; S.i = -1; S.q = ''; }};
  if (!q) {{ clear(); return {{ index: 0, total: 0 }}; }}
  if (!('highlights' in CSS)) return {{ index: 0, total: 0, error: 'no highlight api' }};
  if (S.q !== q || dir === 'first') {{
    clear(); S.q = q;
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {{ acceptNode: (n) => {{
      const p = n.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName; if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return n.nodeValue && n.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; }} }});
    let node; while ((node = walker.nextNode()) && S.ranges.length < 2000) {{
      const text = node.nodeValue.toLowerCase(); let at = text.indexOf(needle);
      while (at !== -1) {{ const r = new Range(); r.setStart(node, at); r.setEnd(node, at + needle.length); S.ranges.push(r); at = text.indexOf(needle, at + needle.length); }}
    }}
    try {{ CSS.highlights.set('cp-find', new Highlight(...S.ranges)); }} catch {{}}
    if (!document.getElementById('cp-find-style')) {{ const st = document.createElement('style'); st.id = 'cp-find-style'; st.textContent = '::highlight(cp-find){{background:#ffe27a;color:#000}} ::highlight(cp-find-current){{background:#ff9632;color:#000}}'; document.documentElement.appendChild(st); }}
    S.i = S.ranges.length ? 0 : -1;
  }} else if (S.ranges.length) {{
    S.i = (S.i + (dir === 'prev' ? -1 : 1) + S.ranges.length) % S.ranges.length;
  }}
  if (S.i >= 0) {{
    const r = S.ranges[S.i];
    try {{ CSS.highlights.set('cp-find-current', new Highlight(r)); }} catch {{}}
    const el = r.startContainer.parentElement; if (el && el.scrollIntoView) el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
  }}
  return {{ index: Math.max(0, S.i), total: S.ranges.length }};
}})()"#)
}

fn click_script(reference: &str) -> String {
    element_script(reference, "el.focus(); el.click(); return { ok: true };")
}

fn type_script(reference: &str, text: &str, submit: bool) -> String {
    let t = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    element_script(
        reference,
        &format!(
            "const sensitive = (el.type === 'password') \
               || /^(cc-|new-password|current-password|one-time-code)/.test(el.getAttribute('autocomplete') || '') \
               || /pass(word|wd)?|passcode|\\bpin\\b|cvc|cvv|card.?num|credit|iban|\\bssn\\b|social.?sec|routing|\\botp\\b|2fa|secret|token/i.test([el.name, el.id, el.getAttribute('aria-label'), el.placeholder].join(' ')); \
             if (sensitive) return {{ ok: false, error: 'This is a password, card or secret field. The person types those; ask them to.' }}; \
             el.focus(); const text = {t}; \
             if (el.isContentEditable) {{ document.execCommand('selectAll'); document.execCommand('insertText', false, text); }} \
             else {{ const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype \
                       : el.tagName === 'SELECT' ? HTMLSelectElement.prototype \
                       : el.tagName === 'INPUT' ? HTMLInputElement.prototype : null; \
                     const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value'); \
                     if (setter && setter.set) setter.set.call(el, text); else el.value = text; \
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

/// The agent's door. Same code as the panel's, plus a word to the panel about
/// what the agent is doing, so "Cinderpaw can use this browser too" is
/// something the person sees happen rather than reads about.
pub async fn handle_from_agent(app: AppHandle, op: &str, params: &Value) -> Result<Value, String> {
    let acts = !matches!(op, "snapshot" | "tabs" | "state");
    // Includes `snapshot`: reading a hidden page is pointless, and reaching
    // `handle` at all restores last session's tabs into the hidden window.
    if !matches!(op, "tabs" | "state") && crate::call_pill::main_out_of_sight(&app) {
        if matches!(op, "open" | "navigate") {
            // The person's own browser, in front of them, like the Jev call does.
            use tauri_plugin_shell::ShellExt;
            let url = parse_address(param_str(params, "url")?)?;
            #[allow(deprecated)]
            app.shell().open(url.as_str(), None).map_err(|e| format!("browser: could not open the system browser: {e}"))?;
            return Ok(json!({
                "opened_in": "the user's own browser (Cinderpaw is hidden behind the call pill)",
                "url": url.as_str(),
                "note": "browser.* cannot see that page; use computer_use on the window in front to read or act on it.",
            }));
        }
        let _ = app.emit("browser://agent", json!({ "op": "paused", "busy": false, "ok": false }));
        return Err(format!("browser: {}", crate::call_pill::OUT_OF_SIGHT));
    }
    if acts && person_took_over(&app).await {
        *AGENT_LAST_MS.lock() = now_ms();
        let _ = app.emit("browser://agent", json!({ "op": "paused", "busy": false, "ok": false }));
        return Err("browser: the user took over this page since your last action (they clicked or typed in it). Do not continue on your own: take a snapshot to see where they are, and ask them before acting again.".into());
    }
    let _ = app.emit("browser://agent", json!({ "op": op, "url": params.get("url"), "ref": params.get("ref"), "busy": true }));
    let out = handle(app.clone(), op, params).await;
    if acts { *AGENT_LAST_MS.lock() = now_ms(); }
    let _ = app.emit("browser://agent", json!({ "op": op, "busy": false, "ok": out.is_ok() }));
    out
}

/// One entry point for the agent (`browser.<op>` over desktop control) and the
/// panel (`browser_ui`). The two must never drift, so they share it.
pub async fn handle(app: AppHandle, op: &str, params: &Value) -> Result<Value, String> {
    restore_once(&app);
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
            run(&wv, &format!("(() => {{ {VISIBLE_TEXT} return ({SNAPSHOT}); }})()")).await.map(with_downloads)
        }
        "click" => {
            let wv = open_page(&app)?;
            let out = run(&wv, &click_script(param_str(params, "ref")?)).await?;
            // A click often navigates; let the next snapshot see the new page.
            // A download needs a moment longer to start and be filed.
            tokio::time::sleep(Duration::from_millis(600)).await;
            settle(Duration::from_secs(15)).await;
            Ok(with_downloads(out))
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
        // Stop a page that is still loading: the Reload button turns into
        // this while it spins, as in every browser. A stopped load may never
        // report Finished, so the tab stops saying it is loading here.
        "stop" => {
            let wv = open_page(&app)?;
            wv.eval("window.stop()").map_err(|e| e.to_string())?;
            {
                let mut t = tabs().lock();
                let active = t.active;
                if let Some(tab) = t.list.iter_mut().find(|x| Some(x.id) == active) {
                    tab.loading = false;
                }
            }
            LOADING.store(tabs().lock().list.iter().any(|t| t.loading), Ordering::SeqCst);
            emit_state(&app);
            Ok(json!({ "ok": true }))
        }
        // Find in page. The matches are painted with the CSS Custom Highlight
        // API (Chromium has it), so nothing in the page's DOM is touched and
        // the page cannot tell; the current one is scrolled into view. An
        // empty query clears everything.
        // Reader view: the article alone, in our own readable page. Mozilla's
        // Readability (vendored, Apache-2.0) does the extraction, the same
        // code Firefox uses; Back or Reload brings the original page back.
        "reader" => {
            let wv = open_page(&app)?;
            let now = wv.url().map_err(|e| e.to_string())?;
            if is_reader_url(now.as_str()) {
                // Already reading: the original is the entry behind this one.
                return Box::pin(handle(app, "back", params)).await.map(|_| json!({ "ok": true, "reader": false }));
            }
            let a = run(&wv, &format!("(() => {{ {READABILITY}; {VISIBLE_TEXT} {READER_EXTRACT} }})()")).await?;
            if a.is_null() {
                return Ok(json!({ "ok": false, "error": "No article on this page to read." }));
            }
            let s = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let id = uuid::Uuid::new_v4().simple().to_string();
            reader_pages().lock().insert(id.clone(), reader_html(&s("title"), &s("byline"), &s("content")));
            let target = reader_url(&id, now.as_str());
            go_to(&app, target.as_str())?;
            settle(Duration::from_secs(10)).await;
            Ok(json!({ "ok": true, "reader": true, "title": s("title"), "length": a.get("length").cloned().unwrap_or(Value::Null) }))
        }
        // Page zoom, for the whole browser (Firefox remembers it per site; one
        // level is enough for a component). WebView2 also takes Ctrl+/- and
        // Ctrl+wheel natively while the page has focus; those change the page
        // and not this number, which is why the answer is the level WE set.
        "zoom" => {
            let wv = open_page(&app)?;
            let factor = params.get("factor").and_then(|v| v.as_f64()).unwrap_or(1.0).clamp(0.3, 5.0);
            wv.set_zoom(factor).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "factor": factor }))
        }
        // Cookies, cache, storage: everything the sites kept, gone. Every
        // tab shares the profile, so one call clears them all.
        "clear_data" => {
            let wv = open_page(&app)?;
            wv.clear_all_browsing_data().map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "devtools" => {
            let wv = open_page(&app)?;
            wv.open_devtools();
            Ok(json!({ "ok": true }))
        }
        // The same extraction for the agent: title and clean text, no
        // navigation, no markup, so a page is read the way a person reads it.
        "extract" => {
            let wv = open_page(&app)?;
            run(&wv, &format!("(() => {{ {READABILITY}; {VISIBLE_TEXT} const a = new Readability(cpVisibleClone()).parse(); return a ? {{ title: a.title, byline: a.byline, text: a.textContent, excerpt: a.excerpt, length: a.length }} : {{ title: document.title, text: document.body ? cpVisibleText(document.body) : '', excerpt: '', length: 0 }}; }})()")).await
        }
        "find" => {
            let wv = open_page(&app)?;
            let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let direction = params.get("direction").and_then(|v| v.as_str()).unwrap_or("first");
            let q = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".into());
            let d = serde_json::to_string(direction).unwrap_or_else(|_| "\"first\"".into());
            run(&wv, &find_script(&q, &d)).await
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
        // The built-in blocker (Brave's engine): its state, and the on/off switch.
        "adblock" => Ok(crate::adblock::status_json()),
        "adblock_set" => {
            let on = params.get("on").and_then(|v| v.as_bool()).unwrap_or(true);
            crate::adblock::set_enabled(&app, on);
            Ok(crate::adblock::status_json())
        }
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
                if let Some(tab) = t.list.iter_mut().find(|x| x.id == id) { tab.last_active = std::time::Instant::now(); }
            }
            place_all(&app)?;
            emit_state(&app);
            Ok(tabs_json())
        }
        // The tab strip was dragged into a new order; `ids` is all of it, left
        // to right. Ids it does not name keep their place at the end.
        "order_tabs" => {
            let ids: Vec<u64> = params.get("ids").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
                .unwrap_or_default();
            tabs().lock().list.sort_by_key(|tab| ids.iter().position(|&i| i == u64::from(tab.id)).unwrap_or(usize::MAX));
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
    fn a_manifest_message_name_reads_from_its_locale() {
        let dir = std::env::temp_dir().join(format!("cp-ext-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("_locales/en")).unwrap();
        std::fs::write(dir.join("_locales/en/messages.json"), r#"{"extName":{"message":"uBlock Origin Lite"}}"#).unwrap();
        let m = json!({ "default_locale": "en" });
        assert_eq!(localized(&dir, &m, "__MSG_EXTNAME__"), "uBlock Origin Lite");
        assert_eq!(localized(&dir, &m, "__MSG_missing__"), "__MSG_missing__");
        assert_eq!(localized(&dir, &m, "Plain"), "Plain");
        let _ = std::fs::remove_dir_all(dir);
    }

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

    /// Only a confirmed import may delete the download (Astra, 19 Sep 2026).
    #[test]
    fn an_import_is_confirmed_only_by_its_own_ok_result() {
        let ev = |data: &str| cinderpaw_core::host::HostEvent {
            event: "cinderpaw://agent-output".into(),
            payload: json!({ "data": data }),
        };
        assert_eq!(import_verdict(&ev(r#"{"type":"artifact_result","id":"dl-1","ok":true}"#), "dl-1"), Some(Ok(())));
        assert_eq!(
            import_verdict(&ev(r#"{"type":"artifact_result","id":"dl-1","ok":false,"error":"That file is 21 MB"}"#), "dl-1"),
            Some(Err("That file is 21 MB".into()))
        );
        // Somebody else's result, another kind of line, another channel: not a verdict.
        assert_eq!(import_verdict(&ev(r#"{"type":"artifact_result","id":"dl-2","ok":true}"#), "dl-1"), None);
        assert_eq!(import_verdict(&ev(r#"{"type":"done","id":"dl-1"}"#), "dl-1"), None);
        let other = cinderpaw_core::host::HostEvent { event: "cinderpaw://livekit-event".into(), payload: json!({ "data": "x" }) };
        assert_eq!(import_verdict(&other, "dl-1"), None);
    }

    /// Silence is not a confirmation either.
    #[tokio::test]
    async fn an_unanswered_import_keeps_the_file() {
        let (tx, rx) = tokio::sync::broadcast::channel(4);
        let waited = tokio::time::timeout(Duration::from_millis(200), async {
            drop(tx); // the bus closes without a word
            await_import(rx, "dl-1").await
        })
        .await
        .expect("returns when the bus closes");
        assert!(waited.is_err());
    }

    #[test]
    fn a_reference_cannot_break_out_of_its_string() {
        let s = click_script("1\"]'); alert(1); ('");
        assert!(s.contains(r#"("1\"]'); alert(1); ('")"#));
    }
}
