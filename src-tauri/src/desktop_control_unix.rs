//! Desktop control on macOS and Linux: windows, focus, keys, text, and named
//! elements.
//!
//! What a person does with a keyboard works here the way it works on Windows:
//! bring a window to the front, press its shortcuts, type into it, scroll it,
//! go back, change tabs, control playback. Windows and keys go through the
//! tools a person would use by hand: `osascript` (System Events) on macOS,
//! `xdotool` (X11 and XWayland) on Linux. Both fail with a readable message
//! and add no C dependency.
//!
//! Named elements (the button called "Send") come from the platform's
//! accessibility tree: AT-SPI on Linux (desktop_control_atspi.rs), AX through
//! System Events on macOS (desktop_control_ax.rs).
//!
//! Window ids are `pid:<n>`, the shape every caller already decodes: `n` is
//! the X window id on Linux and the window's 1-based index in its process on
//! macOS. Element ids are `pid:0.<check>.<path>` (see `element_handle`).
use super::*;
use super::keys::{parse, KeyTok};
use std::process::Command;

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

/// Named elements: AT-SPI on Linux, the AX tree (through System Events) on
/// macOS. Both answer in the same shapes, and neither is asked for windows,
/// which the functions above list faster.
#[cfg(not(target_os = "macos"))]
#[path = "desktop_control_atspi.rs"]
mod tree;
#[cfg(target_os = "macos")]
#[path = "desktop_control_ax.rs"]
mod tree;

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    os::list_windows()
}

// ---------------------------------------------------------------------------
// Element ids
// ---------------------------------------------------------------------------

/// A window is `pid:<n>`. An element is `pid:0.<check>.<path>`: 0 is never a
/// window (X ids and macOS window numbers start at 1), `path` is the child
/// indices from the app down, and `check` is its role and name. A path alone
/// could name another button once the window changed; with the check, a stale
/// id is refused instead of pressing whatever is there now.
pub fn element_handle(pid: u32, role: &str, name: &str, path: &[i32]) -> String {
    let mut rid = vec![0, check_of(role, name)];
    rid.extend_from_slice(path);
    encode_handle(pid, &rid)
}

/// FNV-1a over the role and name, as an i32 (ids carry i32 parts).
pub fn check_of(role: &str, name: &str) -> i32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in role.bytes().chain([0x1f]).chain(name.bytes()) {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h as i32
}

enum Target {
    Window(u32, u32),
    Element { pid: u32, check: i32, path: Vec<i32> },
}

fn target(h: &str) -> Result<Target, String> {
    let (pid, rid) = decode_handle(h)?;
    match rid.as_slice() {
        [n] if *n != 0 => Ok(Target::Window(pid, *n as u32)),
        [0, check, path @ ..] if !path.is_empty() => Ok(Target::Element { pid, check: *check, path: path.to_vec() }),
        _ => Err(format!("malformed element id \"{h}\"")),
    }
}

// ---------------------------------------------------------------------------
// The backend surface desktop_control.rs dispatches to.
// ---------------------------------------------------------------------------

pub fn get_focused_element() -> Result<AccessibilityElement, String> {
    let (pid, n, title) = focused()?;
    Ok(window_element(pid, n, "Window", &title))
}

fn window_elements(pid: u32, role: &str, name: Option<&str>, window_title: Option<&str>) -> Result<Vec<AccessibilityElement>, String> {
    let name = name.map(str::to_lowercase);
    let title = window_title.map(str::to_lowercase);
    Ok(windows_of(pid)?
        .into_iter()
        .filter(|(_, t)| {
            let t = t.to_lowercase();
            name.as_ref().is_none_or(|n| t.contains(n)) && title.as_ref().is_none_or(|w| t.contains(w))
        })
        .map(|(n, t)| window_element(pid, n, role, &t))
        .collect())
}

/// `Window` lists the process's windows, as before. Everything else is read
/// from the element tree. `Document` (the page in a browser) falls back to the
/// window when the tree has none, so "focus the page, then press its keys"
/// works in an app that publishes no tree.
pub fn find_elements(pid: u32, q: &ElementQuery, window_title: Option<&str>) -> Result<Vec<AccessibilityElement>, String> {
    let roles: Vec<&str> = q.role.as_deref().unwrap_or("").split(',').map(str::trim).filter(|r| !r.is_empty()).collect();
    if !roles.is_empty() && roles.iter().all(|r| r.eq_ignore_ascii_case("window")) {
        return window_elements(pid, "Window", q.name.as_deref(), window_title);
    }
    let found = tree::find(pid, q, window_title);
    if roles.len() == 1 && roles[0].eq_ignore_ascii_case("document") && found.as_ref().map_or(true, Vec::is_empty) {
        return window_elements(pid, "Document", q.name.as_deref(), window_title);
    }
    found
}

pub fn get_accessibility_tree(pid: u32, depth: u8, window_title: Option<&str>) -> Result<AccessibilityNode, String> {
    tree::tree(pid, depth, window_title)
}

pub fn click_element(id: &str) -> Result<(), String> {
    match target(id)? {
        Target::Element { pid, check, path } => tree::press(pid, check, &path),
        Target::Window(..) => Err("desktop control: that id is a window, not something to press. Find the element in it (find_elements) and click that.".into()),
    }
}

pub fn type_into_element(id: &str, text: &str) -> Result<(), String> {
    match target(id)? {
        Target::Element { pid, check, path } => tree::set_text(pid, check, &path, text),
        // A window takes typed text wherever its focus is.
        Target::Window(pid, n) => {
            activate(pid, n)?;
            press(&[KeyTok::Text(text.to_string())])
        }
    }
}

pub fn get_element_value(id: &str) -> Result<String, String> {
    match target(id)? {
        Target::Element { pid, check, path } => tree::value(pid, check, &path),
        Target::Window(pid, n) => Ok(windows_of(pid)?.into_iter().find(|(w, _)| *w == n).map(|(_, t)| t).unwrap_or_default()),
    }
}

/// The element's window to the front, then the element takes the focus.
fn focus_element(pid: u32, check: i32, path: &[i32], for_keys: bool) -> Result<(), String> {
    tree::front(pid, path)?;
    tree::focus(pid, check, path, for_keys)
}

pub fn take_element_action(id: &str, action: &str) -> Result<(), String> {
    let action = action.to_lowercase();
    match target(id)? {
        Target::Window(pid, n) if action == "focus" => activate(pid, n),
        Target::Window(..) => Err(format!("desktop control: a window can only take the focus, not \"{action}\". Find the element in it (find_elements).")),
        Target::Element { pid, check, path } => match action.as_str() {
            // Toggling is a press: toolkits name it "click" or "toggle", and
            // the press picks whichever the element has.
            "press" | "invoke" | "click" | "toggle" => tree::press(pid, check, &path),
            "focus" => focus_element(pid, check, &path, false),
            other => Err(format!("desktop control: \"{other}\" is not available on this system; press, toggle and focus are.")),
        },
    }
}

/// The window first, then the keys: sent to whatever is in front, they could
/// land in the wrong app. An element (the page in a browser) is also asked to
/// take the focus, so its keys reach it and not the search box.
pub fn send_keys(id: &str, keys: &str) -> Result<(), String> {
    let toks = parse(keys)?;
    if toks.is_empty() {
        return Ok(());
    }
    match target(id)? {
        Target::Window(pid, n) => activate(pid, n)?,
        Target::Element { pid, check, path } => focus_element(pid, check, &path, true)?,
    }
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
        assert_eq!(decode_handle(&focused.id).unwrap().0, pid, "the target window has the focus (before: {focused_before:?})");
        assert!(out.contains("(keysym 0x61, a)"), "a typed: {out}");
        assert!(out.contains("(keysym 0x62, b)"), "b typed: {out}");
        assert!(out.contains("state 0x4") && out.contains("(keysym 0x74, t)"), "ctrl+t pressed: {out}");
        assert!(out.contains("Return"), "enter pressed: {out}");
    }

    /// Waits for `pid` to publish elements matching `q` that satisfy `ready`.
    fn wait_for(pid: u32, q: &ElementQuery, ready: impl Fn(&[AccessibilityElement]) -> bool) -> Vec<AccessibilityElement> {
        let mut last = Err(String::new());
        for _ in 0..100 {
            last = find_elements(pid, q, None);
            if last.as_deref().is_ok_and(&ready) {
                return last.unwrap();
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("elements never appeared: {last:?}");
    }

    fn exit_code(child: &mut std::process::Child) -> Option<i32> {
        for _ in 0..50 {
            if let Some(s) = child.try_wait().unwrap() {
                return s.code();
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        None
    }

    fn buttons() -> ElementQuery {
        ElementQuery { role: Some("Button".into()), ..Default::default() }
    }

    /// A GTK dialog's button, found by name through AT-SPI and pressed through
    /// its own action: zenity's exit code says which button that was. Needs
    /// an X display, a D-Bus session (the accessibility bus starts on demand)
    /// and zenity: `dbus-run-session -- xvfb-run -a cargo test ...`.
    #[test]
    #[ignore = "needs an X display, a D-Bus session with at-spi2-core, and zenity"]
    fn a_named_button_is_pressed_in_a_real_app() {
        let mut z = Command::new("zenity").args(["--question", "--text", "Send it?"]).spawn().expect("zenity");
        let pid = z.id();
        let found = wait_for(pid, &buttons(), |b| b.iter().any(|e| e.name == "Yes") && b.iter().any(|e| e.name == "No"));
        let yes = found.iter().find(|e| e.name == "Yes").unwrap();
        let no = found.iter().find(|e| e.name == "No").unwrap();
        assert!(yes.is_enabled && !yes.is_offscreen, "{yes:?}");
        assert!(yes.actions.iter().any(|a| a == "press"), "{yes:?}");

        // "No"'s place with "Yes"'s check: the id of an element that is no
        // longer what it was. Refused, and nothing is pressed.
        let (_, yes_rid) = decode_handle(&yes.id).unwrap();
        let (_, no_rid) = decode_handle(&no.id).unwrap();
        let mut forged = no_rid.clone();
        forged[1] = yes_rid[1];
        let err = click_element(&encode_handle(pid, &forged)).unwrap_err();
        assert!(err.contains("element_not_found"), "{err}");
        std::thread::sleep(Duration::from_millis(300));
        assert!(z.try_wait().unwrap().is_none(), "a stale id pressed something");

        // The same buttons in the tree, with the ids find_elements gives.
        fn all(n: &AccessibilityNode, out: &mut Vec<(String, String, String)>) {
            out.push((n.role.clone(), n.name.clone(), n.id.clone()));
            n.children.iter().for_each(|c| all(c, out));
        }
        let mut nodes = Vec::new();
        all(&get_accessibility_tree(pid, 30, None).expect("tree"), &mut nodes);
        assert!(nodes.iter().any(|(r, n, id)| r == "Button" && n == "Yes" && *id == yes.id), "{nodes:?}");

        click_element(&yes.id).expect("pressed");
        assert_eq!(exit_code(&mut z), Some(0), "zenity exits 0 for Yes");
    }

    /// A field found by role, its text set and read back, keys typed into it
    /// after it takes the focus, and OK pressed: zenity prints the field.
    #[test]
    #[ignore = "needs an X display, a D-Bus session with at-spi2-core, and zenity"]
    fn a_named_field_takes_text_and_keys() {
        let mut z = Command::new("zenity")
            .args(["--entry", "--text", "Name?"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("zenity");
        let pid = z.id();
        let fields = wait_for(pid, &ElementQuery { role: Some("Edit".into()), ..Default::default() }, |f| !f.is_empty());
        let field = &fields[0];
        // Jev's keys for "the page" ask for the Document. A dialog has none:
        // the window answers, as before there was a tree.
        let page = find_elements(pid, &ElementQuery { role: Some("Document".into()), ..Default::default() }, None).expect("page");
        assert!(page.iter().all(|p| p.role == "Document" && target(&p.id).is_ok_and(|t| matches!(t, Target::Window(..)))), "{page:?}");
        assert!(!page.is_empty(), "the window stands in for the page");
        type_into_element(&field.id, "cinder").expect("text set");
        assert_eq!(get_element_value(&field.id).expect("value"), "cinder");
        // The window to the front, the field focused, real keys typed.
        send_keys(&field.id, "{End}paw 42").expect("keys sent");
        let mut value = String::new();
        for _ in 0..30 {
            value = get_element_value(&field.id).unwrap_or_default();
            if value == "cinderpaw 42" {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(value, "cinderpaw 42");
        let ok = wait_for(pid, &buttons(), |b| b.iter().any(|e| e.name == "OK"));
        click_element(&ok.iter().find(|e| e.name == "OK").unwrap().id).expect("OK pressed");
        assert_eq!(exit_code(&mut z), Some(0));
        let mut out = String::new();
        z.stdout.take().unwrap().read_to_string(&mut out).unwrap();
        assert_eq!(out.trim_end(), "cinderpaw 42");
    }

    #[test]
    fn ids_tell_windows_from_elements() {
        let el = element_handle(42, "push button", "Send", &[0, 3, 1]);
        match target(&el).unwrap() {
            Target::Element { pid, check, path } => {
                assert_eq!((pid, path), (42, vec![0, 3, 1]));
                assert_eq!(check, check_of("push button", "Send"));
            }
            Target::Window(..) => panic!("an element read as a window"),
        }
        assert!(matches!(target("42:12345").unwrap(), Target::Window(42, 12345)));
        assert!(target("42:0").is_err(), "0 is no window");
        assert!(target("42:0.7").is_err(), "an element needs a path");
        assert_ne!(check_of("push button", "Send"), check_of("push button", "Sent"));
        assert_ne!(check_of("push button", "Send"), check_of("link", "Send"));
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

    /// A text file opened in TextEdit, the way a person double-clicks it:
    /// through LaunchServices (`open -e`), and read back through the AX tree,
    /// never an Apple Event to TextEdit. The first CI run sent TextEdit two
    /// and each waited two minutes to time out (-1712): a bare launch shows
    /// the Open panel, and scripting TextEdit needs its own Automation
    /// consent, a dialog nobody answers on a runner. The product never sends
    /// TextEdit an Apple Event, only System Events, so the tests do not
    /// either. Returns the pid, the window's number and the file.
    fn open_in_textedit(stem: &str, text: &str) -> (u32, u32, std::path::PathBuf) {
        // The title shows the name with or without ".txt", depending on the
        // Finder setting: matched without it.
        let name = format!("{stem}-{}", std::process::id());
        let path = std::env::temp_dir().join(format!("{name}.txt"));
        std::fs::write(&path, text).expect("temp file");
        Command::new("open").arg("-e").arg(&path).status().expect("open -e");
        for _ in 0..100 {
            if let Some(w) = list_windows().unwrap_or_default().into_iter().find(|w| w.title.contains(&name)) {
                if let Some((n, _)) = windows_of(w.pid).unwrap_or_default().into_iter().find(|(_, t)| t.contains(&name)) {
                    return (w.pid, n, path);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        panic!("TextEdit never showed {name}: {:?}", list_windows());
    }

    fn text_area(pid: u32, n: u32) -> AccessibilityElement {
        let title = windows_of(pid).unwrap().into_iter().find(|(w, _)| *w == n).map(|(_, t)| t);
        let fields = find_elements(pid, &ElementQuery { role: Some("Edit".into()), ..Default::default() }, title.as_deref()).expect("fields");
        fields.into_iter().next().expect("the document's text area")
    }

    fn close_button(pid: u32, n: u32) -> AccessibilityElement {
        let title = windows_of(pid).unwrap().into_iter().find(|(w, _)| *w == n).map(|(_, t)| t);
        let found = find_elements(pid, &ElementQuery { role: Some("Button".into()), ..Default::default() }, title.as_deref()).expect("buttons");
        found
            .iter()
            .find(|e| e.name.to_lowercase().contains("close"))
            .cloned()
            .unwrap_or_else(|| panic!("no close button among {found:?}"))
    }

    fn value_becomes(id: &str, want: &str) -> String {
        let mut value = String::new();
        for _ in 0..30 {
            value = get_element_value(id).unwrap_or_default();
            if value == want {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        value
    }

    /// Keys typed into a TextEdit window arrive in its document. Needs the
    /// Accessibility permission for the process running the test, which
    /// GitHub's macOS runners grant.
    #[test]
    #[ignore = "needs a macOS desktop with Accessibility granted"]
    fn text_reaches_textedit() {
        let (pid, n, path) = open_in_textedit("cinderpaw-keys", "");
        send_keys(&handle(pid, n), "hello cinderpaw").expect("keys sent");
        let field = text_area(pid, n);
        let mut text = String::new();
        for _ in 0..30 {
            text = get_element_value(&field.id).unwrap_or_default();
            // macOS capitalises the first word of a sentence as it is typed
            // ("Hello cinderpaw" on the runner): the keys arrived either way.
            if text.eq_ignore_ascii_case("hello cinderpaw") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = click_element(&close_button(pid, n).id);
        let _ = std::fs::remove_file(path);
        assert!(text.eq_ignore_ascii_case("hello cinderpaw"), "TextEdit has: {text:?}");
    }

    /// The document window's close button, found by name in the AX tree and
    /// pressed through AXPress: the window is gone. A stale id is refused
    /// first, and nothing closes.
    #[test]
    #[ignore = "needs a macOS desktop with Accessibility granted"]
    fn a_named_button_is_pressed_in_textedit() {
        let (pid, n, path) = open_in_textedit("cinderpaw-press", "unchanged");
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        // Asked a few times: one System Events answer can fail while TextEdit
        // is busy, and a failed answer is not a closed window.
        let open = || -> (bool, String) {
            let mut seen = String::new();
            for _ in 0..5 {
                match windows_of(pid) {
                    Ok(w) => return (w.iter().any(|(_, t)| t.contains(&name)), format!("{w:?}")),
                    Err(e) => seen = e,
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            (false, seen)
        };
        let close = close_button(pid, n);
        assert!(close.is_enabled && !close.is_offscreen, "{close:?}");

        let (_, rid) = decode_handle(&close.id).unwrap();
        let mut forged = rid.clone();
        forged[1] = forged[1].wrapping_add(1);
        let err = click_element(&encode_handle(pid, &forged)).unwrap_err();
        assert!(err.contains("element_not_found"), "{err}");
        std::thread::sleep(std::time::Duration::from_millis(500));
        let (still_open, windows) = open();
        assert!(still_open, "the window is gone after a refused stale id; windows: {windows}");

        fn all(n: &AccessibilityNode, out: &mut Vec<String>) {
            out.push(n.id.clone());
            n.children.iter().for_each(|c| all(c, out));
        }
        let mut ids = Vec::new();
        let title = windows_of(pid).unwrap().into_iter().find(|(w, _)| *w == n).map(|(_, t)| t);
        all(&get_accessibility_tree(pid, 30, title.as_deref()).expect("tree"), &mut ids);
        assert!(ids.contains(&close.id), "the tree has the same button: {ids:?}");

        click_element(&close.id).expect("pressed");
        let mut still = open();
        for _ in 0..30 {
            if !still.0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            still = open();
        }
        let _ = std::fs::remove_file(path);
        assert!(!still.0, "the window is still open: {}", still.1);
    }

    /// The document's text area found by role: its text set and read back,
    /// then real keys typed into it once it has the focus.
    #[test]
    #[ignore = "needs a macOS desktop with Accessibility granted"]
    fn a_named_field_takes_text_in_textedit() {
        let (pid, n, path) = open_in_textedit("cinderpaw-field", "x");
        let field = text_area(pid, n);
        // Jev's keys for "the page" ask for the Document. TextEdit has none:
        // the window answers, as before there was a tree.
        let page = find_elements(pid, &ElementQuery { role: Some("Document".into()), ..Default::default() }, None).expect("page");
        assert!(!page.is_empty() && page.iter().all(|p| matches!(target(&p.id), Ok(Target::Window(..)))), "{page:?}");
        type_into_element(&field.id, "cinder").expect("text set");
        assert_eq!(value_becomes(&field.id, "cinder"), "cinder");
        send_keys(&field.id, "{ctrl+end}paw").expect("keys sent");
        let value = value_becomes(&field.id, "cinderpaw");
        let _ = click_element(&close_button(pid, n).id);
        let _ = std::fs::remove_file(path);
        assert_eq!(value, "cinderpaw");
    }
}
