//! Desktop control on macOS and Linux: windows, focus, keys and text.
//!
//! What a person does with a keyboard works here the way it works on Windows:
//! bring a window to the front, press its shortcuts, type into it, scroll it,
//! go back, change tabs, control playback. Pressing a *named* element (a
//! button called "Send") needs the platform's accessibility tree (AX on macOS,
//! AT-SPI on Linux), which is not built yet: those calls say so instead of
//! guessing.
//!
//! No native bindings, on purpose. macOS goes through `osascript` (System
//! Events), Linux through `xdotool` (X11 and XWayland). Both are the tools a
//! person would use by hand, both fail with a readable message, and neither
//! adds a C dependency that could break the build on a platform CI does not
//! exercise.
//!
//! Element ids are `pid:<n>`, the shape every caller already decodes: `n` is
//! the X window id on Linux and the window's 1-based index in its process on
//! macOS.
use super::*;
use super::keys::{parse, KeyTok};
use std::process::Command;

/// Said for everything that needs an element tree.
pub const NO_ELEMENT_TREE: &str = "desktop control: reading and pressing named elements (buttons, links, fields) is Windows only for now. On this system, act on the window in front with keys: send_keys to the element from get_focused, e.g. \"{Tab}\" to move and \"{Enter}\" to press.";

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(program).args(args).output().map_err(|e| missing(program, e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(explain(program, &String::from_utf8_lossy(&out.stderr)))
    }
}

fn missing(program: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound && program == "xdotool" {
        return "desktop control: xdotool is not installed. Install it (sudo apt install xdotool, or your distribution's package) to let Cinderpaw use the keyboard and windows.".into();
    }
    format!("desktop control: could not run {program}: {e}")
}

fn explain(program: &str, stderr: &str) -> String {
    let s = stderr.trim();
    if program == "osascript" && (s.contains("not allowed") || s.contains("-1719") || s.contains("-25211") || s.contains("-1743")) {
        return "desktop control: macOS has not allowed Cinderpaw to control the computer. Turn Cinderpaw on in System Settings > Privacy & Security > Accessibility (and Automation > System Events), then try again.".into();
    }
    if program == "xdotool" && std::env::var_os("DISPLAY").is_none() {
        return "desktop control: no X display. On Wayland only apps running under XWayland can be controlled for now.".into();
    }
    format!("desktop control: {program} failed: {s}")
}

fn handle(pid: u32, n: u32) -> String {
    encode_handle(pid, &[n as i32])
}

fn decode(h: &str) -> Result<(u32, u32), String> {
    let (pid, rid) = decode_handle(h)?;
    Ok((pid, rid[0] as u32))
}

fn window_element(pid: u32, n: u32, role: &str, title: &str) -> AccessibilityElement {
    AccessibilityElement {
        id: handle(pid, n),
        role: role.into(),
        name: title.into(),
        value: String::new(),
        automation_id: String::new(),
        bounding_rect: BoundingRect { x: 0, y: 0, width: 0, height: 0 },
        actions: vec!["focus".into()],
        is_enabled: true,
        is_offscreen: false,
    }
}

// ---------------------------------------------------------------------------
// Linux: xdotool
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "macos"))]
mod os {
    use super::*;

    fn windows_with_ids() -> Result<Vec<(u32, u32, String)>, String> {
        let ids = run("xdotool", &["search", "--onlyvisible", "--name", "."]).or_else(|e| {
            // No match is exit 1 with empty output, not an error.
            if e.contains("failed: ") && !e.contains("Can't open display") { Ok(String::new()) } else { Err(e) }
        })?;
        let mut out = Vec::new();
        for id in ids.lines().filter_map(|l| l.trim().parse::<u32>().ok()) {
            let id_s = id.to_string();
            let Ok(pid) = run("xdotool", &["getwindowpid", &id_s]).and_then(|p| p.trim().parse::<u32>().map_err(|e| e.to_string())) else { continue };
            let title = run("xdotool", &["getwindowname", &id_s]).unwrap_or_default();
            if title.trim().is_empty() {
                continue;
            }
            out.push((pid, id, title));
        }
        Ok(out)
    }

    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        let names = process_names();
        Ok(windows_with_ids()?
            .into_iter()
            .map(|(pid, _, title)| WindowInfo { app_name: names.get(&pid).cloned().unwrap_or_default(), pid, title })
            .collect())
    }

    pub fn windows_of(pid: u32) -> Result<Vec<(u32, String)>, String> {
        Ok(windows_with_ids()?.into_iter().filter(|(p, _, _)| *p == pid).map(|(_, id, t)| (id, t)).collect())
    }

    pub fn focused() -> Result<(u32, u32, String), String> {
        // `getactivewindow` asks the window manager; a session without one
        // (a kiosk, a bare X server) still knows which window has the focus.
        let id = run("xdotool", &["getactivewindow"]).or_else(|_| run("xdotool", &["getwindowfocus", "-f"]))?;
        let pid = run("xdotool", &["getwindowpid", &id])?
            .trim()
            .parse::<u32>()
            .map_err(|_| "desktop control: the window in front has no process id".to_string())?;
        let title = run("xdotool", &["getwindowname", &id]).unwrap_or_default();
        let id = id.trim().parse::<u32>().map_err(|_| "desktop control: bad window id".to_string())?;
        Ok((pid, id, title))
    }

    pub fn activate(_pid: u32, n: u32) -> Result<(), String> {
        let id = n.to_string();
        // Raised through the window manager when there is one; without one,
        // the input focus is set directly, which is all the keys need.
        run("xdotool", &["windowactivate", "--sync", &id])
            .or_else(|_| run("xdotool", &["windowfocus", "--sync", &id]))
            .map(|_| ())
    }

    /// X keysym for a key name the grammar uses.
    pub fn keysym(key: &str) -> Option<String> {
        Some(match key {
            "enter" | "return" => "Return".into(),
            "tab" => "Tab".into(),
            "esc" | "escape" => "Escape".into(),
            "backspace" | "back" => "BackSpace".into(),
            "delete" | "del" => "Delete".into(),
            "up" => "Up".into(),
            "down" => "Down".into(),
            "left" => "Left".into(),
            "right" => "Right".into(),
            "home" => "Home".into(),
            "end" => "End".into(),
            "space" => "space".into(),
            "pageup" | "pgup" => "Prior".into(),
            "pagedown" | "pgdn" => "Next".into(),
            "win" | "super" | "cmd" => "Super_L".into(),
            "print" | "printscreen" => "Print".into(),
            "browserback" => "XF86Back".into(),
            "browserforward" => "XF86Forward".into(),
            "browserrefresh" => "XF86Reload".into(),
            "playpause" => "XF86AudioPlay".into(),
            "nexttrack" => "XF86AudioNext".into(),
            "prevtrack" => "XF86AudioPrev".into(),
            "volumeup" => "XF86AudioRaiseVolume".into(),
            "volumedown" => "XF86AudioLowerVolume".into(),
            "volumemute" => "XF86AudioMute".into(),
            "=" => "equal".into(),
            "+" => "plus".into(),
            "-" => "minus".into(),
            "." => "period".into(),
            "," => "comma".into(),
            "/" => "slash".into(),
            "\\" => "backslash".into(),
            "[" => "bracketleft".into(),
            "]" => "bracketright".into(),
            ";" => "semicolon".into(),
            "'" => "apostrophe".into(),
            "`" => "grave".into(),
            k if k.len() >= 2 && k.starts_with('f') && k[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) => k.to_uppercase(),
            k if k.chars().count() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) => k.into(),
            _ => return None,
        })
    }

    /// `ctrl+shift+t` as xdotool writes it.
    pub fn combo(mods: &[&str], key: &str) -> Result<String, String> {
        let sym = keysym(key).ok_or_else(|| format!("desktop control: unknown key \"{key}\""))?;
        let mut parts: Vec<String> = mods
            .iter()
            .map(|m| match *m { "ctrl" | "control" => "ctrl", "alt" => "alt", "shift" => "shift", _ => "super" }.to_string())
            .collect();
        parts.push(sym);
        Ok(parts.join("+"))
    }

    pub fn press(toks: &[KeyTok]) -> Result<(), String> {
        for t in toks {
            match t {
                KeyTok::Text(s) => {
                    run("xdotool", &["type", "--clearmodifiers", "--delay", "8", "--", s])?;
                }
                KeyTok::Chord { mods, key } => {
                    run("xdotool", &["key", "--clearmodifiers", &combo(mods, key)?])?;
                }
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// macOS: osascript + System Events
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod os {
    use super::*;

    fn osa(script: &str) -> Result<String, String> {
        run("osascript", &["-e", script])
    }

    /// AppleScript string literal.
    pub fn quoted(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        let out = osa(r#"set out to ""
tell application "System Events"
  repeat with p in (processes whose background only is false)
    try
      repeat with w in windows of p
        set out to out & (unix id of p) & tab & (name of p) & tab & (name of w) & linefeed
      end repeat
    end try
  end repeat
end tell
return out"#)?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let mut f = l.splitn(3, '\t');
                let pid = f.next()?.trim().parse().ok()?;
                let app_name = f.next()?.to_string();
                let title = f.next().unwrap_or("").to_string();
                Some(WindowInfo { pid, title, app_name })
            })
            .collect())
    }

    pub fn windows_of(pid: u32) -> Result<Vec<(u32, String)>, String> {
        let out = osa(&format!(r#"set out to ""
tell application "System Events"
  set p to first process whose unix id is {pid}
  set i to 0
  repeat with w in windows of p
    set i to i + 1
    set out to out & i & tab & (name of w) & linefeed
  end repeat
end tell
return out"#))?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let (i, t) = l.split_once('\t')?;
                Some((i.trim().parse().ok()?, t.to_string()))
            })
            .collect())
    }

    pub fn focused() -> Result<(u32, u32, String), String> {
        let out = osa(r#"tell application "System Events"
  set p to first process whose frontmost is true
  set t to ""
  try
    set t to name of front window of p
  end try
  return (unix id of p as text) & tab & t
end tell"#)?;
        let (pid, title) = out.split_once('\t').unwrap_or((out.as_str(), ""));
        let pid = pid.trim().parse::<u32>().map_err(|_| "desktop control: the app in front has no process id".to_string())?;
        Ok((pid, 1, title.to_string()))
    }

    pub fn activate(pid: u32, n: u32) -> Result<(), String> {
        osa(&format!(r#"tell application "System Events"
  set p to first process whose unix id is {pid}
  set frontmost of p to true
  try
    perform action "AXRaise" of window {n} of p
  end try
end tell"#))
        .map(|_| ())
    }

    /// System Events key code for a named key.
    pub fn key_code(key: &str) -> Option<u16> {
        Some(match key {
            "enter" | "return" => 36,
            "tab" => 48,
            "space" => 49,
            "backspace" | "back" => 51,
            "esc" | "escape" => 53,
            "delete" | "del" => 117,
            "left" => 123,
            "right" => 124,
            "down" => 125,
            "up" => 126,
            "home" => 115,
            "end" => 119,
            "pageup" | "pgup" => 116,
            "pagedown" | "pgdn" => 121,
            "f1" => 122, "f2" => 120, "f3" => 99, "f4" => 118, "f5" => 96, "f6" => 97,
            "f7" => 98, "f8" => 100, "f9" => 101, "f10" => 109, "f11" => 103, "f12" => 111,
            _ => return None,
        })
    }

    fn using(mods: &[&str]) -> String {
        if mods.is_empty() {
            return String::new();
        }
        let m: Vec<&str> = mods
            .iter()
            .map(|m| match *m { "ctrl" | "cmd" => "command down", "control" => "control down", "alt" => "option down", _ => "shift down" })
            .collect();
        format!(" using {{{}}}", m.join(", "))
    }

    /// One chord as AppleScript. The keys Windows has for the browser and the
    /// player are Mac shortcuts or system calls here; Ctrl+Home/End (top and
    /// bottom of a page) are Command+Up/Down.
    pub fn chord_script(mods: &[&str], key: &str) -> Result<String, String> {
        let se = |body: String| format!("tell application \"System Events\" to {body}");
        let accel = mods.iter().any(|m| *m == "ctrl" || *m == "cmd");
        Ok(match key {
            "browserback" => se("keystroke \"[\" using {command down}".into()),
            "browserforward" => se("keystroke \"]\" using {command down}".into()),
            "browserrefresh" => se("keystroke \"r\" using {command down}".into()),
            "home" if accel => se("key code 126 using {command down}".into()),
            "end" if accel => se("key code 125 using {command down}".into()),
            "volumeup" => "set volume output volume ((output volume of (get volume settings)) + 10)".into(),
            "volumedown" => "set volume output volume ((output volume of (get volume settings)) - 10)".into(),
            "volumemute" => "set volume output muted (not (output muted of (get volume settings)))".into(),
            "playpause" | "nexttrack" | "prevtrack" => {
                let verb = match key { "playpause" => "playpause", "nexttrack" => "next track", _ => "previous track" };
                format!(
                    "if application \"Spotify\" is running then\ntell application \"Spotify\" to {verb}\nelse if application \"Music\" is running then\ntell application \"Music\" to {verb}\nelse\nerror \"No music player is running. Say pause with the player in front.\"\nend if"
                )
            }
            k => match key_code(k) {
                Some(code) => se(format!("key code {code}{}", using(mods))),
                None if k.chars().count() == 1 => se(format!("keystroke {}{}", quoted(k), using(mods))),
                None => return Err(format!("desktop control: unknown key \"{k}\"")),
            },
        })
    }

    pub fn press(toks: &[KeyTok]) -> Result<(), String> {
        for t in toks {
            let script = match t {
                KeyTok::Text(s) => format!("tell application \"System Events\" to keystroke {}", quoted(s)),
                KeyTok::Chord { mods, key } => chord_script(mods, key)?,
            };
            osa(&script)?;
        }
        Ok(())
    }
}

use os::{activate, focused, press, windows_of};

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    os::list_windows()
}

// ---------------------------------------------------------------------------
// The backend surface desktop_control.rs dispatches to.
// ---------------------------------------------------------------------------

pub fn get_focused_element() -> Result<AccessibilityElement, String> {
    let (pid, n, title) = focused()?;
    Ok(window_element(pid, n, "Window", &title))
}

/// Only windows can be found here: `Window` lists the process's windows, and
/// `Document` (what a page is on Windows) answers with them too, so "focus the
/// page, then press its keys" works unchanged. Anything else needs the tree.
pub fn find_elements(pid: u32, q: &ElementQuery, window_title: Option<&str>) -> Result<Vec<AccessibilityElement>, String> {
    let roles = q.role.as_deref().unwrap_or("");
    let wanted = roles.split(',').map(str::trim).find(|r| r.eq_ignore_ascii_case("window") || r.eq_ignore_ascii_case("document"));
    let Some(role) = wanted else { return Err(NO_ELEMENT_TREE.into()) };
    let name = q.name.as_deref().map(str::to_lowercase);
    let title = window_title.map(str::to_lowercase);
    Ok(windows_of(pid)?
        .into_iter()
        .filter(|(_, t)| {
            let t = t.to_lowercase();
            name.as_ref().is_none_or(|n| t.contains(n)) && title.as_ref().is_none_or(|w| t.contains(w))
        })
        .map(|(n, t)| window_element(pid, n, if role.eq_ignore_ascii_case("document") { "Document" } else { "Window" }, &t))
        .collect())
}

pub fn get_accessibility_tree(_pid: u32, _depth: u8, _window_title: Option<&str>) -> Result<AccessibilityNode, String> {
    Err(NO_ELEMENT_TREE.into())
}

pub fn click_element(_id: &str) -> Result<(), String> {
    Err(NO_ELEMENT_TREE.into())
}

pub fn type_into_element(id: &str, text: &str) -> Result<(), String> {
    // A window can take typed text; a named field cannot be found here.
    let (pid, n) = decode(id)?;
    activate(pid, n)?;
    press(&[KeyTok::Text(text.to_string())])
}

pub fn get_element_value(_id: &str) -> Result<String, String> {
    Err(NO_ELEMENT_TREE.into())
}

pub fn take_element_action(id: &str, action: &str) -> Result<(), String> {
    let (pid, n) = decode(id)?;
    match action.to_lowercase().as_str() {
        "focus" => activate(pid, n),
        other => Err(format!("desktop control: \"{other}\" needs the element tree. {NO_ELEMENT_TREE}")),
    }
}

/// The window first, then the keys: sent to whatever is in front, they could
/// land in the wrong app.
pub fn send_keys(id: &str, keys: &str) -> Result<(), String> {
    let toks = parse(keys)?;
    if toks.is_empty() {
        return Ok(());
    }
    let (pid, n) = decode(id)?;
    activate(pid, n)?;
    press(&toks)
}

/// Real keys into a real window, on an X display. Run it with one:
/// `Xvfb :99 & DISPLAY=:99 cargo test -p cinderpaw desktop_control -- --ignored`
/// (CI does, on Linux and macOS: see `desktop-control` in ci.yml).
#[cfg(all(test, not(target_os = "macos")))]
mod live {
    use super::*;
    use std::io::Read as _;
    use std::time::Duration;

    #[test]
    #[ignore = "needs an X display and xev"]
    fn keys_and_text_reach_a_real_window() {
        let mut xev = Command::new("xev")
            .args(["-name", "cinderpaw-keytest", "-event", "keyboard"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("xev");
        let pid = xev.id();
        // xev is plain Xlib and does not announce its pid; every GTK, Qt and
        // Electron window does (_NET_WM_PID). Set it the way they would.
        for _ in 0..50 {
            if let Ok(ids) = run("xdotool", &["search", "--name", "^cinderpaw-keytest$"]) {
                for id in ids.lines() {
                    let _ = run("xprop", &["-id", id.trim(), "-f", "_NET_WM_PID", "32c", "-set", "_NET_WM_PID", &pid.to_string()]);
                }
                if !ids.trim().is_empty() {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let mut win = None;
        for _ in 0..50 {
            if let Some((n, _)) = windows_of(pid).unwrap_or_default().into_iter().next() {
                win = Some(n);
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let n = win.expect("the xev window appeared");
        let focused_before = get_focused_element();
        send_keys(&handle(pid, n), "ab{ctrl+t}{Enter}").expect("keys sent");
        std::thread::sleep(Duration::from_millis(500));
        let focused = get_focused_element().expect("focused window");
        let _ = xev.kill();
        let mut out = String::new();
        xev.stdout.take().unwrap().read_to_string(&mut out).unwrap();
        assert_eq!(decode(&focused.id).unwrap().0, pid, "the target window has the focus (before: {focused_before:?})");
        assert!(out.contains("(keysym 0x61, a)"), "a typed: {out}");
        assert!(out.contains("(keysym 0x62, b)"), "b typed: {out}");
        assert!(out.contains("state 0x4") && out.contains("(keysym 0x74, t)"), "ctrl+t pressed: {out}");
        assert!(out.contains("Return"), "enter pressed: {out}");
    }

    #[test]
    fn key_names_map_to_x_keysyms() {
        assert_eq!(os::combo(&["ctrl", "shift"], "t").unwrap(), "ctrl+shift+t");
        assert_eq!(os::combo(&[], "pagedown").unwrap(), "Next");
        assert_eq!(os::combo(&["ctrl"], "=").unwrap(), "ctrl+equal");
        assert_eq!(os::combo(&[], "playpause").unwrap(), "XF86AudioPlay");
        assert_eq!(os::combo(&["cmd"], "f5").unwrap(), "super+F5");
        assert_eq!(os::combo(&[], "win").unwrap(), "Super_L");
        assert_eq!(os::combo(&[], "print").unwrap(), "Print");
        assert!(os::combo(&[], "nonsense").is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod live {
    use super::*;

    #[test]
    fn chords_become_mac_shortcuts() {
        assert_eq!(os::chord_script(&["ctrl"], "t").unwrap(), "tell application \"System Events\" to keystroke \"t\" using {command down}");
        assert_eq!(os::chord_script(&[], "browserback").unwrap(), "tell application \"System Events\" to keystroke \"[\" using {command down}");
        assert_eq!(os::chord_script(&["ctrl"], "home").unwrap(), "tell application \"System Events\" to key code 126 using {command down}");
        assert_eq!(os::chord_script(&[], "enter").unwrap(), "tell application \"System Events\" to key code 36");
        assert_eq!(os::quoted("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    /// Keys typed into TextEdit read back from the document. Needs the
    /// Accessibility permission for the process running the test, which
    /// GitHub's macOS runners grant.
    #[test]
    #[ignore = "needs a macOS desktop with Accessibility granted"]
    fn text_reaches_textedit() {
        let _ = run("osascript", &["-e", "tell application \"TextEdit\" to make new document", "-e", "tell application \"TextEdit\" to activate"]);
        std::thread::sleep(std::time::Duration::from_secs(2));
        let (pid, n, _) = focused().expect("front app");
        send_keys(&handle(pid, n), "hello cinderpaw{Enter}").expect("keys sent");
        std::thread::sleep(std::time::Duration::from_secs(1));
        let text = run("osascript", &["-e", "tell application \"TextEdit\" to get text of front document"]).expect("read back");
        let _ = run("osascript", &["-e", "tell application \"TextEdit\" to close front document saving no"]);
        assert!(text.contains("hello cinderpaw"), "TextEdit has: {text:?}");
    }
}
