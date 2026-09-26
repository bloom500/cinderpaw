//! The built-in browser's downloads card, in a window of its own.
//!
//! The page in the built-in browser is a native child webview, and a native
//! view paints over anything the app's own page draws. So a downloads card
//! drawn in React could only sit in the flow and push the page down, leaving a
//! full-width band under the toolbar (24 Sep). Chrome solves the same problem
//! the same way: its downloads bubble is a small window of its own over the
//! page. This is that window. The page is the app's bundle at
//! `#downloads-card`; see `frontend-react/src/components/browser/DownloadsPopup.tsx`
//! for the events the two windows share.
//!
//! Built by the host for the reason the call pill is (see `call_pill.rs`): a
//! window built from JS under the `unstable` multiwebview feature does not
//! receive events and ignores `transparent`.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "downloads-card";
const WIDTH: f64 = 384.0;

/// Open the card with its top-left corner at (`x`, `y`) in the main window's
/// own CSS pixels, `height` tall. The main window knows where its Downloads
/// button is; the host turns that into a place on the screen.
#[tauri::command]
#[specta::specta]
pub async fn downloads_card_open(app: AppHandle, x: f64, y: f64, height: f64) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        downloads_card_close(app.clone()).await?;
    }
    let main = app.get_window("main").ok_or("downloads card: no main window")?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let origin = main.inner_position().map_err(|e| e.to_string())?;
    let left = origin.x as f64 / scale + x;
    let top = origin.y as f64 / scale + y;
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#downloads-card".into()))
        .title("Downloads")
        .inner_size(WIDTH, height)
        .position(left, top)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        // It closes itself when it loses focus, the way a menu does, so it has
        // to start with it.
        .focused(true)
        .always_on_top(true)
        .additional_browser_args(crate::call_pill::BROWSER_ARGS)
        .build()
        .map_err(|e| format!("downloads card: could not open ({e})"))?;
    if let Some(w) = app.get_webview_window(LABEL) {
        // Windows paints a transparent window's first frame opaque until it is
        // resized (tauri-apps/tauri#4881); see `call_pill::nudge`.
        let _ = w.set_size(tauri::LogicalSize::new(WIDTH, height + 1.0));
        let _ = w.set_size(tauri::LogicalSize::new(WIDTH, height));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn downloads_card_close(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.destroy().map_err(|e| e.to_string())?;
    }
    for _ in 0..40 {
        if app.get_webview_window(LABEL).is_none() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    Err("downloads card: the old window did not close".into())
}
