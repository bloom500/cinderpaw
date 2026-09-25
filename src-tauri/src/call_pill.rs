//! The call pill window: a small always-on-top strip at the top of the screen
//! that carries a voice call while the main window is hidden.
//!
//! Built here, not from JavaScript. With the `unstable` multiwebview feature
//! (which the built-in browser needs), a `WebviewWindow` created through the
//! JS API is not registered the way a host-built one is: every event sent to
//! it failed with "failed to acquire webview reference" and its `transparent`
//! flag was ignored, so the pill sat in an opaque rectangle and never heard
//! the call (21 Sep). The page is the app's own bundle at `#call-pill`; see
//! `frontend-react/src/lib/callPill.ts` for the events the two windows share.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "call-pill";
const WIDTH: f64 = 560.0;
const HEIGHT: f64 = 64.0;

/// Open the pill at the top-centre of the monitor the main window is on.
///
/// Built fresh every time. Hiding and re-showing the window was tried (21 Sep)
/// and a transparent window shown again after `hide` came back unpainted, or
/// not at all, one time in ten; a freshly built one always paints. `destroy`
/// is asynchronous, so a build that arrives while the old window is still
/// registered waits for it to go instead of seeing it as "already open".
#[tauri::command]
#[specta::specta]
pub async fn call_pill_open(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        call_pill_close(app.clone()).await?;
    }
    // Where the app is: the pill goes to the same screen, in logical pixels.
    let (x, y) = app
        .get_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .map(|m| {
            let scale = m.scale_factor();
            let width = m.size().width as f64 / scale;
            let left = m.position().x as f64 / scale;
            let top = m.position().y as f64 / scale;
            (left + (width - WIDTH) / 2.0, top + 8.0)
        })
        .unwrap_or((360.0, 8.0));
    let builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#call-pill".into()))
        .title("Cinderpaw call")
        .inner_size(WIDTH, HEIGHT)
        .position(x, y)
        .decorations(false);
    // On macOS a transparent window needs Tauri's `macos-private-api`, and
    // without it `transparent` does not exist: the macOS build failed here.
    // Turning that feature on would also make the main window's configured
    // transparency take effect, an untested change of look; the pill is
    // opaque there instead.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    builder
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .build()
        .map_err(|e| format!("call pill: could not open ({e})"))?;
    if let Some(w) = app.get_webview_window(LABEL) {
        nudge(&w);
    }
    Ok(())
}

/// Windows paints a transparent window's first frame opaque, or not at all,
/// until it is resized (tauri-apps/tauri#4881); the same after every `show`.
/// One pixel out and back, before anyone sees it. The pill's own page resizes
/// the window for a question, so the height is read, not assumed.
fn nudge(w: &tauri::WebviewWindow) {
    let scale = w.scale_factor().unwrap_or(1.0);
    let h = w.inner_size().map(|s| s.height as f64 / scale).unwrap_or(HEIGHT);
    let _ = w.set_size(tauri::LogicalSize::new(WIDTH, h + 1.0));
    let _ = w.set_size(tauri::LogicalSize::new(WIDTH, h));
}

/// True while a call is parked: the main window hidden behind the pill, or
/// minimised with the pill up. That is the point of the pill: the person is
/// using the rest of the computer, so the agent works there too, the way the
/// Jev call does. The built-in browser is the one thing off limits then: a
/// page opened in a hidden window is a page nobody sees (six tabs, 21 Sep).
/// `browser.open` goes to the system browser instead; desktop control is
/// untouched.
///
/// Minimised with no call is someone waiting on a task, not parking a call.
/// This used to count too, so asking the agent to research something and
/// minimising the app while it worked made every browser step fail with "the
/// Cinderpaw window is hidden". Its browsing goes on where it will be found.
pub fn main_out_of_sight(app: &AppHandle) -> bool {
    app.get_window("main").is_some_and(|w| {
        let hidden = !w.is_visible().unwrap_or(true);
        let minimised = w.is_minimized().unwrap_or(false);
        hidden || (minimised && app.get_webview_window(LABEL).is_some())
    })
}

/// True when the main window is the one in front: the OS foreground window,
/// or a window it owns. Where a Jev command acts follows what the person is
/// looking at. The window's own focus flag cannot say it: on Windows it turns
/// false whenever the focus goes into one of the window's webviews, which is
/// every click inside the app.
#[tauri::command]
#[specta::specta]
#[allow(unreachable_code)]
pub fn main_in_front(app: AppHandle) -> bool {
    let Some(main) = app.get_webview_window("main") else { return false };
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOTOWNER};
        let Ok(hwnd) = main.hwnd() else { return true };
        let front = unsafe { GetForegroundWindow() };
        if front.0.is_null() {
            return false;
        }
        let owner = unsafe { GetAncestor(front, GA_ROOTOWNER) };
        let ours = hwnd.0 as usize;
        return front.0 as usize == ours || owner.0 as usize == ours;
    }
    main.is_visible().unwrap_or(true) && !main.is_minimized().unwrap_or(false)
}

/// The reason, worded for the model.
pub const OUT_OF_SIGHT: &str = "the Cinderpaw window is hidden (parked behind the call pill or minimised), so its built-in browser is out of sight. Use browser.open, which opens the page in the user's own browser while the app is hidden, and computer_use to act on the window in front.";

#[tauri::command]
#[specta::specta]
pub async fn call_pill_close(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.destroy().map_err(|e| e.to_string())?;
    }
    // Destroyed for real, not just asked: the next open must not find it.
    for _ in 0..40 {
        if app.get_webview_window(LABEL).is_none() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    Err("call pill: the old window did not close".into())
}
