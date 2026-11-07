//! What the screen shows while the agent drives the computer (1 Nov, Darius's
//! pick from three mockups, docs/design/computer-use-overlay): an ember edge
//! round the screen it has taken, a glow on its own cursor, which glides
//! to what it is about to press, and a pill at the top saying what it is doing,
//! with Stop. Before this, desktop control showed nothing at all, and the
//! agent often works with Cinderpaw hidden behind the app it drives.
//!
//! Two windows on the app's own bundle, built in Rust like the call pill (see
//! call_pill.rs for why): `#agent-overlay` covers the monitor and lets every
//! click through; `#agent-pill` is small, at the top, and the one part that
//! takes a click. Neither takes the keyboard focus: the agent's next keystroke
//! must land in the app it is driving, not in its own overlay.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY: &str = "agent-overlay";
pub const PILL: &str = "agent-pill";

/// Logical size of the pill's window; the pill itself is drawn inside it.
const PILL_W: f64 = 680.0;
const PILL_H: f64 = 76.0;
/// How long the cursor takes to reach its target, and the pause before the
/// press, so a person can follow what is about to happen.
const AIM: Duration = Duration::from_millis(520);
/// The overlay stays this long after the last step, like the browser's bar:
/// the model thinking between two clicks must not make it come and go.
const LINGER: Duration = Duration::from_secs(6);

/// Bumped by every step; a hide only happens if no step came after it.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The monitor the overlay is on: physical x, y, width, height and scale.
static MONITOR: Mutex<Option<(i32, i32, u32, u32, f64)>> = Mutex::new(None);
/// The last step and target sent, for a page that loads after they went out:
/// both windows are built at the first step, and their script starts later.
static LAST: Mutex<(Value, Value)> = Mutex::new((Value::Null, Value::Null));

pub fn is_overlay(label: &str) -> bool {
    label == OVERLAY || label == PILL
}

/// Steps that change something on screen. Reading (listing windows, the
/// accessibility tree, a screenshot) keeps an open overlay alive but never
/// opens one: looking is not taking over.
fn acts(action: &str) -> bool {
    matches!(action, "click" | "type" | "perform_action" | "send_keys" | "launch")
}

/// Called before each desktop-control step. Opens the overlay on the monitor
/// where the step happens, says what it is, and glides the cursor to the
/// element, then waits a moment so the person sees where it will press.
pub async fn before(app: &AppHandle, action: &str, params: &Value) {
    if !acts(action) {
        if app.get_webview_window(OVERLAY).is_some() {
            linger(app);
        }
        return;
    }
    // A registered hotkey also swallows the keys the agent itself sends, so
    // Esc lets go for the length of each step and comes back in `after`.
    esc_hotkey(app, false);
    let target = match params["element_id"].as_str() {
        Some(id) => crate::desktop_control::element_box(id.to_string()).await.ok(),
        None => None,
    };
    let point = target
        .as_ref()
        .filter(|(r, _, _)| r.width > 0 && r.height > 0)
        .map(|(r, _, _)| (r.x as f64 + r.width as f64 / 2.0, r.y as f64 + r.height as f64 / 2.0))
        .or_else(|| app.cursor_position().ok().map(|p| (p.x, p.y)));
    let Some(monitor) = point
        .and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
    else {
        return;
    };
    // The work area, not the whole monitor: a window covering the whole monitor
    // reads to Windows as a full-screen app, and the taskbar steps out of the way.
    let wa = monitor.work_area();
    let m = (wa.position.x, wa.position.y, wa.size.width, wa.size.height, monitor.scale_factor());
    if let Err(e) = show_on(app, m).await {
        tracing::warn!("agent overlay: {e}");
        return;
    }

    let (name, process) = target.as_ref().map(|(_, n, p)| (n.as_str(), p.as_str())).unwrap_or(("", ""));
    let app_name = match action {
        "launch" => pretty_app(params["app"].as_str().unwrap_or_default()),
        _ => pretty_app(process),
    };
    let step = json!({ "app": app_name, "label": describe(action, params, name) });
    LAST.lock().unwrap().0 = step.clone();
    let _ = app.emit_to(PILL, "agent-overlay://step", step);

    if let Some((r, _, _)) = target.filter(|(r, _, _)| r.width > 0 && r.height > 0) {
        let (mx, my, _, _, scale) = m;
        let css = |v: i32, origin: i32| (v - origin) as f64 / scale;
        let aim = json!({ "x": css(r.x, mx), "y": css(r.y, my), "w": r.width as f64 / scale, "h": r.height as f64 / scale });
        LAST.lock().unwrap().1 = aim.clone();
        let _ = app.emit_to(OVERLAY, "agent-overlay://aim", aim);
        tokio::time::sleep(AIM).await;
    }
    linger(app);
}

/// Called after the step ran: the press shows as a ripple where the cursor is.
pub fn after(app: &AppHandle, action: &str, ok: bool) {
    if acts(action) && ok {
        let _ = app.emit_to(OVERLAY, "agent-overlay://act", json!({}));
    }
    if acts(action) && app.get_webview_window(OVERLAY).is_some() {
        esc_hotkey(app, true);
    }
}

/// Stop, from the pill: the same `stop` the app's own Stop button sends, then
/// the overlay goes at once.
#[tauri::command]
#[specta::specta]
pub async fn agent_overlay_stop(app: AppHandle) -> Result<(), String> {
    stop(app).await;
    Ok(())
}

/// The pill's Stop and the Esc key both end up here.
pub async fn stop(app: AppHandle) {
    let tx = app.state::<crate::AppState>().cinderpaw_agent_tx.lock().clone();
    if let Some(tx) = tx {
        let _ = tx.send(json!({ "type": "stop" }).to_string()).await;
    }
    close(&app);
}

/// Esc anywhere stops the agent while the overlay is up (lib.rs's shortcut
/// handler routes it to `stop`). Only then: the rest of the time Esc belongs
/// to whatever app the person is in.
#[cfg(desktop)]
fn esc_hotkey(app: &AppHandle, on: bool) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};
    let esc = Shortcut::new(None, Code::Escape);
    let gs = app.global_shortcut();
    let result = match (on, gs.is_registered(esc)) {
        (true, false) => gs.register(esc),
        (false, true) => gs.unregister(esc),
        _ => Ok(()),
    };
    if let Err(e) = result {
        tracing::warn!("agent overlay: Esc hotkey ({e})");
    }
}
#[cfg(not(desktop))]
fn esc_hotkey(_: &AppHandle, _: bool) {}

/// What a freshly loaded overlay page should show: the step and the target
/// that went out before its script was listening.
#[tauri::command]
#[specta::specta]
pub fn agent_overlay_state() -> Value {
    let last = LAST.lock().unwrap();
    json!({ "step": last.0, "aim": last.1 })
}

/// Hide the overlay LINGER after now, unless another step comes first.
fn linger(app: &AppHandle) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LINGER).await;
        if GENERATION.load(Ordering::SeqCst) == generation {
            close(&app);
        }
    });
}

fn close(app: &AppHandle) {
    esc_hotkey(app, false);
    for label in [OVERLAY, PILL] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
    *MONITOR.lock().unwrap() = None;
    *LAST.lock().unwrap() = (Value::Null, Value::Null);
}

/// Both windows on monitor `m`, built if missing, moved if the agent went to
/// another monitor.
async fn show_on(app: &AppHandle, m: (i32, i32, u32, u32, f64)) -> Result<(), String> {
    let same = *MONITOR.lock().unwrap() == Some(m);
    if same && app.get_webview_window(OVERLAY).is_some() && app.get_webview_window(PILL).is_some() {
        return Ok(());
    }
    let (x, y, w, h, scale) = m;
    let overlay = match app.get_webview_window(OVERLAY) {
        Some(win) => win,
        None => build(app, OVERLAY)?,
    };
    // Physical pixels, set after building: a logical position is converted with
    // one monitor's scale, and on two monitors with different scales it lands
    // on the wrong one.
    let _ = overlay.set_position(PhysicalPosition::new(x, y));
    let _ = overlay.set_size(PhysicalSize::new(w, h));
    // Clicks go through to the app underneath, always.
    overlay.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;

    let pill = match app.get_webview_window(PILL) {
        Some(win) => win,
        None => build(app, PILL)?,
    };
    let (pw, ph) = ((PILL_W * scale) as u32, (PILL_H * scale) as u32);
    let _ = pill.set_position(PhysicalPosition::new(x + (w as i32 - pw as i32) / 2, y + (8.0 * scale) as i32));
    let _ = pill.set_size(PhysicalSize::new(pw, ph));

    for win in [&overlay, &pill] {
        let _ = win.show();
        nudge(win);
    }
    *MONITOR.lock().unwrap() = Some(m);
    Ok(())
}

fn build(app: &AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(format!("index.html#{label}").into()))
        .title("Cinderpaw")
        .decorations(false)
        .visible(false);
    // ponytail: Windows only for now (element geometry comes from UIA). macOS
    // would need `macos-private-api` for transparency, as the call pill notes.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    builder
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .additional_browser_args(crate::call_pill::BROWSER_ARGS)
        .build()
        .map_err(|e| format!("could not open the {label} window ({e})"))
}

/// See call_pill::nudge: a transparent window's first frame paints only after
/// a resize (tauri-apps/tauri#4881).
fn nudge(w: &tauri::WebviewWindow) {
    if let Ok(size) = w.inner_size() {
        let _ = w.set_size(PhysicalSize::new(size.width, size.height + 1));
        let _ = w.set_size(size);
    }
}

/// "notepad.exe" or a full path reads as "Notepad".
fn pretty_app(raw: &str) -> String {
    let stem = raw.rsplit(['\\', '/']).next().unwrap_or(raw);
    let stem = stem.strip_suffix(".exe").or_else(|| stem.strip_suffix(".EXE")).unwrap_or(stem);
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// What the step is, in words a person reads at a glance. Typed text is never
/// shown: it can be anything the agent was given.
fn describe(action: &str, params: &Value, name: &str) -> String {
    let name: String = name.trim().chars().take(40).collect();
    let what = if name.is_empty() { String::new() } else { format!(" \u{201c}{name}\u{201d}") };
    match action {
        "click" => format!("Clicking{what}"),
        "type" => if what.is_empty() { "Typing".into() } else { format!("Typing into{what}") },
        "send_keys" => format!("Pressing {}", params["keys"].as_str().unwrap_or("keys").chars().take(24).collect::<String>()),
        "perform_action" => match params["action_name"].as_str().unwrap_or_default() {
            "expand" => format!("Opening{what}"),
            "collapse" => format!("Closing{what}"),
            "toggle" => format!("Switching{what}"),
            "focus" => format!("Going to{what}"),
            _ => format!("Clicking{what}"),
        },
        "launch" => format!("Opening {}", pretty_app(params["app"].as_str().unwrap_or("an app"))),
        _ => "Working".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_read_as_words_and_never_show_typed_text() {
        assert_eq!(describe("click", &json!({}), "Save"), "Clicking \u{201c}Save\u{201d}");
        assert_eq!(describe("type", &json!({ "text": "my secret" }), "Text editor"), "Typing into \u{201c}Text editor\u{201d}");
        assert_eq!(describe("send_keys", &json!({ "keys": "Ctrl+S" }), ""), "Pressing Ctrl+S");
        assert_eq!(describe("launch", &json!({ "app": "C:\\Windows\\notepad.exe" }), ""), "Opening Notepad");
        assert!(!describe("type", &json!({ "text": "my secret" }), "").contains("secret"));
    }

    #[test]
    fn app_names_read_like_names() {
        assert_eq!(pretty_app("notepad.exe"), "Notepad");
        assert_eq!(pretty_app("C:/Program Files/Mozilla Firefox/firefox.exe"), "Firefox");
        assert_eq!(pretty_app(""), "");
    }

    #[test]
    fn only_acting_opens_it() {
        assert!(acts("click") && acts("type") && acts("launch"));
        assert!(!acts("list_windows") && !acts("get_tree") && !acts("screenshot"));
    }
}
