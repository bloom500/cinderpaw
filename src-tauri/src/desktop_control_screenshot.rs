//! Screenshots for the agent (`computer_use` action "screenshot"): a picture of
//! one app's window, or of the whole screen, shrunk and sent back as a JPEG data
//! URL, so a vision model sees what is there and the chat shows the person what
//! the agent saw (Darius, 27 Oct: "agentul trebuie sa poata face poze oriunde").
//!
//! Windows and macOS capture through xcap. Linux runs the screenshot tool the
//! desktop already ships (see Cargo.toml for why xcap is not linked there).

use base64::Engine as _;
use image::{DynamicImage, ImageFormat};
use std::io::Cursor;

/// Longest side of the picture sent on. Models scale larger ones down to about
/// this anyway, and the chat keeps every picture it is shown.
const MAX_SIDE: u32 = 1568;

/// What was captured, before it is encoded.
pub struct Shot {
    pub image: DynamicImage,
    /// "window" or "screen".
    pub scope: &'static str,
    pub title: Option<String>,
    /// Said to the model with the picture, e.g. that Linux took the whole screen.
    pub note: Option<String>,
}

/// `img` as a JPEG data URL no larger than `MAX_SIDE` on its longest side, with
/// the size it was sent at.
pub fn to_data_url(img: DynamicImage) -> Result<(String, u32, u32), String> {
    let img = if img.width().max(img.height()) > MAX_SIDE {
        img.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    // JPEG has no alpha; a window's transparent corners turn black, which reads fine.
    let rgb = DynamicImage::ImageRgb8(img.to_rgb8());
    let mut buf = Cursor::new(Vec::new());
    rgb.write_to(&mut buf, ImageFormat::Jpeg)
        .map_err(|e| format!("screenshot: could not encode the picture: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Ok((format!("data:image/jpeg;base64,{b64}"), rgb.width(), rgb.height()))
}

/// A picture of `pid`'s main window, or of the main screen when `pid` is None.
/// `denied` names an app that must never be photographed (a password manager):
/// the whole screen is refused while one is open on it.
#[cfg(any(windows, target_os = "macos"))]
pub fn capture(pid: Option<u32>, denied: &dyn Fn(&str) -> bool) -> Result<Shot, String> {
    #[cfg(target_os = "macos")]
    mac::ensure_permission()?;

    let windows = xcap::Window::all().map_err(|e| format!("screenshot: could not list the windows: {e}"))?;
    if let Some(pid) = pid {
        // The app's main window: its largest one that is on screen.
        let win = windows
            .iter()
            .filter(|w| w.pid().ok() == Some(pid) && !w.is_minimized().unwrap_or(false))
            .max_by_key(|w| u64::from(w.width().unwrap_or(0)) * u64::from(w.height().unwrap_or(0)))
            .ok_or_else(|| {
                format!(
                    "screenshot: the app with pid {pid} has no window on screen (it may be minimized). \
                     Restore it first, or take a picture of the whole screen."
                )
            })?;
        let image = win
            .capture_image()
            .map_err(|e| format!("screenshot: could not capture that window: {e}"))?;
        let title = win.title().ok().filter(|t| !t.trim().is_empty());
        return Ok(Shot { image: DynamicImage::ImageRgba8(image), scope: "window", title, note: None });
    }

    for w in &windows {
        if w.is_minimized().unwrap_or(false) {
            continue;
        }
        if let Ok(app) = w.app_name() {
            if denied(&app) {
                return Err(format!(
                    "screenshot: {app} is open on the screen, and a password manager or sign-in window is never photographed. \
                     Minimize it, or take a picture of one app's window instead."
                ));
            }
        }
    }
    let monitors = xcap::Monitor::all().map_err(|e| format!("screenshot: could not find the screen: {e}"))?;
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or_else(|| "screenshot: no screen was found".to_string())?;
    let image = monitor
        .capture_image()
        .map_err(|e| format!("screenshot: could not capture the screen: {e}"))?;
    Ok(Shot { image: DynamicImage::ImageRgba8(image), scope: "screen", title: None, note: None })
}

/// Linux: the screenshot tool the desktop has, first one that works. Always the
/// whole screen; one window would need a different tool per desktop.
/// ponytail: no password-manager check here (no portable window list without
/// xcap); add one through AT-SPI if Linux users drive password managers.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn capture(pid: Option<u32>, _denied: &dyn Fn(&str) -> bool) -> Result<Shot, String> {
    use std::process::{Command, Stdio};

    let path = std::env::temp_dir().join(format!("cinderpaw-shot-{}.png", std::process::id()));
    let p = path.to_string_lossy().to_string();
    let tools: [(&str, Vec<&str>); 5] = [
        ("grim", vec![p.as_str()]),
        ("gnome-screenshot", vec!["-f", p.as_str()]),
        ("spectacle", vec!["-b", "-n", "-o", p.as_str()]),
        ("scrot", vec![p.as_str()]),
        ("import", vec!["-window", "root", p.as_str()]),
    ];
    for (bin, args) in tools {
        let _ = std::fs::remove_file(&path);
        let ran = Command::new(bin)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ran && path.exists() {
            let image = image::open(&path).map_err(|e| format!("screenshot: {bin} saved a picture that could not be read: {e}"));
            let _ = std::fs::remove_file(&path);
            return Ok(Shot {
                image: image?,
                scope: "screen",
                title: None,
                note: pid.map(|_| "On Linux the whole screen is captured, not one window.".to_string()),
            });
        }
    }
    Err("screenshot: this computer has no screenshot tool Cinderpaw can use. Install one and try again: \
         gnome-screenshot (GNOME), spectacle (KDE), grim (Sway) or scrot, for example \
         `sudo apt install gnome-screenshot`."
        .into())
}

#[cfg(target_os = "macos")]
mod mac {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// macOS shows the windows of other apps only after the person allows Screen
    /// Recording; until then a capture comes back as the bare desktop. Ask once
    /// (the system shows its own prompt) and say where the switch is.
    pub fn ensure_permission() -> Result<(), String> {
        // SAFETY: both take no arguments; they read the grant or ask for it.
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return Ok(());
        }
        unsafe { CGRequestScreenCaptureAccess() };
        Err("screenshot: macOS has not let Cinderpaw see the screen yet. Open System Settings > Privacy & \
             Security > Screen & System Audio Recording, turn on Cinderpaw, then quit and reopen Cinderpaw."
            .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shrinks_a_big_picture_and_sends_jpeg() {
        let big = DynamicImage::ImageRgba8(image::RgbaImage::new(3000, 1500));
        let (url, w, h) = to_data_url(big).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        assert_eq!((w, h), (MAX_SIDE, MAX_SIDE / 2));
        let small = DynamicImage::ImageRgba8(image::RgbaImage::new(800, 600));
        assert_eq!(to_data_url(small).unwrap().1, 800);
    }

    /// A real picture of this machine's screen, kept in memory only. Not in the
    /// normal run (a CI runner has no screen); by hand on a new platform:
    /// `cargo test -p cinderpaw --lib -- --ignored photographs_the_real_screen`
    #[test]
    #[ignore]
    fn photographs_the_real_screen() {
        let shot = capture(None, &|_| false).unwrap();
        assert_eq!(shot.scope, "screen");
        let (url, w, h) = to_data_url(shot.image).unwrap();
        assert!(url.len() > 1000 && w > 0 && h > 0, "an empty picture: {w}x{h}");
    }
}
