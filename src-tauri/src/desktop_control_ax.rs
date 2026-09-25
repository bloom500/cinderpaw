//! macOS: named elements through the AX tree, read and pressed through
//! System Events (JavaScript for Automation, `osascript -l JavaScript`).
//!
//! What UI Automation is on Windows: find the "Send" button by its role and
//! name, press it through its own action (AXPress, no mouse), read a field,
//! set a field's text. No native bindings, like the rest of this backend: the
//! script only reads raw attributes and acts, and every decision (roles,
//! names, ids, what counts as the same element) is made here, in Rust, where
//! it is unit-tested.
//!
//! An element is re-found by its path (window number, then 1-based child
//! indices), plus a check of its role and name. Before it acts, the script
//! compares the element's raw role, title and description with the ones the
//! check was made from: a click on the wrong element is the one failure this
//! module must never have.
use super::*;
use std::io::Read as _;
use std::time::{Duration, Instant};

/// Elements read per window, a whole web page included.
const MAX_NODES: usize = 5000;

/// A hung app answers Apple Events after two minutes; a command waits this.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(20);

/// Shared by every mode. `run(argv)`: mode, pid, then the mode's arguments.
/// Prints JSON. Raw attributes only; the Rust side interprets them.
const SCRIPT: &str = r#"
function run(argv) {
  const se = Application('System Events');
  const mode = argv[0];
  const ps = se.processes.whose({ unixId: Number(argv[1]) })();
  if (ps.length === 0) throw new Error('no process ' + argv[1]);
  const p = ps[0];
  const str = (v) => (v === null || v === undefined) ? '' : String(v);
  const get = (f) => { try { return f(); } catch (e) { return null; } };
  const text = (v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? String(v) : '';
  const bulk = (list, prop) => {
    try { return list[prop](); } catch (e) {
      const n = list.length, out = [];
      for (let i = 0; i < n; i++) { try { out.push(list[i][prop]()); } catch (e2) { out.push(null); } }
      return out;
    }
  };
  if (mode === 'walk') {
    const title = argv[2].toLowerCase();
    const max = Number(argv[3]), maxDepth = Number(argv[4]);
    // Windows are listed front to back: with no title, the one in front.
    const names = bulk(p.windows, 'name');
    if (names.length === 0) throw new Error('no window');
    const w = title ? names.findIndex((n) => str(n).toLowerCase().includes(title)) : 0;
    if (w < 0) throw new Error('no window titled ' + argv[2]);
    const win = p.windows[w];
    const out = [];
    const frame = { p: [w + 1], r: 'AXWindow', s: str(get(() => win.subrole())), t: str(names[w]), d: '', v: '', e: true, x: 0, y: 0, w: 0, h: 0 };
    const pos = get(() => win.position()), size = get(() => win.size());
    if (pos && size) { frame.x = pos[0]; frame.y = pos[1]; frame.w = size[0]; frame.h = size[1]; }
    out.push(frame);
    const queue = [[win, [w + 1]]];
    while (queue.length && out.length < max) {
      const [el, path] = queue.shift();
      if (path.length > maxDepth) continue;
      const kids = el.uiElements;
      const n = get(() => kids.length) || 0;
      if (!n) continue;
      const role = bulk(kids, 'role'), sub = bulk(kids, 'subrole'), name = bulk(kids, 'name'),
        desc = bulk(kids, 'description'), val = bulk(kids, 'value'), en = bulk(kids, 'enabled'),
        pos = bulk(kids, 'position'), size = bulk(kids, 'size');
      for (let i = 0; i < n && out.length < max; i++) {
        const cp = path.concat([i + 1]);
        out.push({
          p: cp, r: str(role[i]), s: str(sub[i]), t: str(name[i]), d: str(desc[i]), v: text(val[i]),
          e: en[i] !== false,
          x: pos[i] ? pos[i][0] : 0, y: pos[i] ? pos[i][1] : 0, w: size[i] ? size[i][0] : 0, h: size[i] ? size[i][1] : 0,
        });
        queue.push([kids[i], cp]);
      }
    }
    return JSON.stringify(out);
  }
  // One element, by path: window number, then 1-based child indices.
  const path = JSON.parse(argv[2]);
  let el = p.windows[path[0] - 1];
  for (let k = 1; k < path.length; k++) el = el.uiElements[path[k] - 1];
  const raw = { r: str(el.role()), s: str(get(() => el.subrole())), t: str(get(() => el.name())), d: str(get(() => el.description())) };
  if (mode === 'info') {
    raw.v = text(get(() => el.value()));
    raw.a = get(() => el.actions.name()) || [];
    raw.f = get(() => el.focused()) === true;
    return JSON.stringify(raw);
  }
  // The element must still be the one the caller checked.
  const want = JSON.parse(argv[3]);
  if (raw.r !== want.r || raw.t !== want.t || raw.d !== want.d) throw new Error('element_not_found: changed');
  if (mode === 'press') {
    const acts = get(() => el.actions.name()) || [];
    const pick = ['AXPress', 'AXPick', 'AXConfirm', 'AXOpen'].find((a) => acts.includes(a));
    if (pick) {
      const act = el.actions.byName(pick);
      try { act.perform(); } catch (e) { se.perform(act); }
      return JSON.stringify({ ok: pick });
    }
    // A row or a tab with no action of its own: selected, as a click would.
    el.selected = true;
    return JSON.stringify({ ok: 'selected' });
  }
  if (mode === 'focus') {
    try { el.focused = true; } catch (e) {}
    return JSON.stringify({ ok: get(() => el.focused()) === true });
  }
  if (mode === 'set') {
    try { el.focused = true; } catch (e) {}
    el.value = argv[4];
    return JSON.stringify({ ok: true });
  }
  throw new Error('unknown mode ' + mode);
}
"#;

/// Runs the script with a deadline. Its output can be a whole page, so it is
/// read while the script runs, not after.
fn script(args: &[&str]) -> Result<String, String> {
    let mut child = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT])
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("desktop control: could not run osascript: {e}"))?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if started.elapsed() > SCRIPT_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop control: the app did not answer within 20 s".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    if status.success() {
        Ok(stdout.trim_end().to_string())
    } else if stderr.contains("element_not_found") || stderr.contains("-1719") && stderr.contains("Invalid index") {
        Err(gone())
    } else {
        Err(explain("osascript", &stderr))
    }
}

fn gone() -> String {
    "desktop control: element_not_found: that element changed or is gone. Find it again (find_elements) and use the new id.".into()
}

#[derive(serde::Deserialize, Debug, Clone)]
struct Raw {
    p: Vec<i32>,
    r: String,
    #[serde(default)]
    s: String,
    #[serde(default)]
    t: String,
    #[serde(default)]
    d: String,
    #[serde(default)]
    v: String,
    #[serde(default = "yes")]
    e: bool,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    #[serde(default)]
    w: f64,
    #[serde(default)]
    h: f64,
}

fn yes() -> bool {
    true
}

#[derive(serde::Deserialize, Debug)]
struct Info {
    r: String,
    #[serde(default)]
    s: String,
    #[serde(default)]
    t: String,
    #[serde(default)]
    d: String,
    #[serde(default)]
    v: String,
    #[serde(default)]
    a: Vec<String>,
    #[serde(default)]
    f: bool,
}

/// The UI Automation name for an AX role (and subrole), so callers (Jev, the
/// model) ask for "Button" or "Hyperlink" on every system.
pub fn ui_role(role: &str, subrole: &str) -> String {
    match (role, subrole) {
        ("AXRadioButton", "AXTabButton") => "TabItem",
        ("AXGroup", "AXLandmarkMain") => "Main",
        ("AXButton" | "AXMenuButton" | "AXDisclosureTriangle", _) => "Button",
        ("AXLink", _) => "Hyperlink",
        ("AXCheckBox", _) => "CheckBox",
        ("AXRadioButton", _) => "RadioButton",
        ("AXPopUpButton" | "AXComboBox", _) => "ComboBox",
        ("AXMenuItem" | "AXMenuBarItem", _) => "MenuItem",
        ("AXMenu", _) => "Menu",
        ("AXMenuBar", _) => "MenuBar",
        ("AXRow", "AXOutlineRow") => "TreeItem",
        ("AXRow" | "AXCell", _) => "DataItem",
        ("AXTextField" | "AXTextArea", _) => "Edit",
        ("AXStaticText" | "AXHeading", _) => "Text",
        ("AXWebArea", _) => "Document",
        ("AXWindow" | "AXSheet" | "AXDrawer", _) => "Window",
        ("AXImage", _) => "Image",
        ("AXList", _) => "List",
        ("AXOutline", _) => "Tree",
        ("AXTable", _) => "Table",
        ("AXTabGroup", _) => "Tab",
        ("AXToolbar", _) => "ToolBar",
        ("AXScrollBar", _) => "ScrollBar",
        ("AXSlider", _) => "Slider",
        ("AXIncrementor", _) => "Spinner",
        ("AXProgressIndicator" | "AXBusyIndicator", _) => "ProgressBar",
        ("AXSplitter", _) => "Separator",
        ("AXHelpTag", _) => "ToolTip",
        ("AXApplication", _) => "Application",
        ("AXGroup" | "AXScrollArea" | "AXSplitGroup" | "AXLayoutArea" | "AXLayoutItem" | "AXRadioGroup", _) => "Group",
        (r, _) => return r.strip_prefix("AX").unwrap_or(r).to_string(),
    }
    .into()
}

fn is_secure(subrole: &str) -> bool {
    subrole == "AXSecureTextField"
}

/// What a person would call it: the title, else the description (an icon
/// button's words, "close button"), else a text's own words.
fn name_of(role: &str, title: &str, desc: &str, value: &str) -> String {
    if !title.trim().is_empty() {
        title.into()
    } else if !desc.trim().is_empty() {
        desc.into()
    } else if role == "AXStaticText" {
        value.into()
    } else {
        String::new()
    }
}

/// The raw fields the check is made from (the script re-compares them before
/// it acts): the title and the description, both, so a button whose title
/// is empty is still told from its neighbour by its description.
fn raw_name(title: &str, desc: &str) -> String {
    format!("{title}\u{1f}{desc}")
}

fn element(pid: u32, r: &Raw, win: (f64, f64, f64, f64)) -> AccessibilityElement {
    let ui = ui_role(&r.r, &r.s);
    let name = name_of(&r.r, &r.t, &r.d, &r.v);
    let value = if is_secure(&r.s) { REDACTED.into() } else if ui == "Edit" || ui == "ComboBox" { r.v.clone() } else { String::new() };
    let pressable = matches!(ui.as_str(), "Button" | "Hyperlink" | "CheckBox" | "RadioButton" | "TabItem" | "ComboBox" | "MenuItem" | "DataItem" | "TreeItem");
    let mut actions = Vec::new();
    if pressable {
        actions.push("press".to_string());
    }
    if ui == "Edit" {
        actions.push("set_value".to_string());
    }
    actions.push("focus".to_string());
    // Scrolled out of the window, or no size at all: not on screen.
    let (wx, wy, ww, wh) = win;
    let inside = r.w > 0.0 && r.h > 0.0 && r.x < wx + ww && r.x + r.w > wx && r.y < wy + wh && r.y + r.h > wy;
    AccessibilityElement {
        id: super::element_handle(pid, &r.r, &raw_name(&r.t, &r.d), &r.p),
        role: ui,
        name,
        value,
        automation_id: String::new(),
        bounding_rect: BoundingRect { x: r.x as i32, y: r.y as i32, width: r.w as i32, height: r.h as i32 },
        actions,
        is_enabled: r.e,
        is_offscreen: !inside,
    }
}

fn walk(pid: u32, window_title: Option<&str>, depth: u8) -> Result<Vec<Raw>, String> {
    let out = script(&["walk", &pid.to_string(), window_title.unwrap_or(""), &MAX_NODES.to_string(), &depth.to_string()])?;
    serde_json::from_str(&out).map_err(|e| format!("desktop control: unreadable accessibility tree: {e}"))
}

fn frame(nodes: &[Raw]) -> (f64, f64, f64, f64) {
    nodes.first().map(|w| (w.x, w.y, w.w, w.h)).unwrap_or((0.0, 0.0, 0.0, 0.0))
}

/// The first `under` scope ("Main" is the page's main landmark, anything else
/// a role such as "Document"), tried in order, as a path prefix.
fn scope(nodes: &[Raw], under: &str) -> Option<Vec<i32>> {
    under
        .split(',')
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .find_map(|want| nodes.iter().find(|n| ui_role(&n.r, &n.s).eq_ignore_ascii_case(want)).map(|n| n.p.clone()))
}

pub fn find(pid: u32, q: &ElementQuery, window_title: Option<&str>) -> Result<Vec<AccessibilityElement>, String> {
    let nodes = walk(pid, window_title, MAX_DEPTH)?;
    let win = frame(&nodes);
    let under = q.under_role.as_deref().and_then(|u| scope(&nodes, u));
    let roles: Option<Vec<String>> = q
        .role
        .as_deref()
        .map(|s| s.split(',').map(|r| r.trim().to_lowercase()).filter(|r| !r.is_empty()).collect());
    let name_q = q.name.as_deref().map(str::to_lowercase);
    let val_q = q.value_contains.as_deref().map(str::to_lowercase);
    Ok(nodes
        .iter()
        .filter(|n| under.as_ref().is_none_or(|u| n.p.starts_with(u)))
        .map(|n| (n, element(pid, n, win)))
        .filter(|(_, e)| roles.as_ref().is_none_or(|r| r.contains(&e.role.to_lowercase())))
        .filter(|(_, e)| name_q.as_ref().is_none_or(|nq| e.name.to_lowercase().contains(nq)))
        // AX has no automation id; a query for one finds nothing rather than everything.
        .filter(|_| q.automation_id.is_none())
        .filter(|(n, e)| val_q.as_ref().is_none_or(|v| !is_secure(&n.s) && e.value.to_lowercase().contains(v)))
        .map(|(_, e)| e)
        .take(500)
        .collect())
}

pub fn tree(pid: u32, depth: u8, window_title: Option<&str>) -> Result<AccessibilityNode, String> {
    // The window is depth 1; its children depth 2.
    let nodes = walk(pid, window_title, depth.saturating_sub(1))?;
    if nodes.is_empty() {
        return Err("desktop control: that app has no window".into());
    }
    let win = frame(&nodes);
    let mut kids: std::collections::HashMap<&[i32], Vec<usize>> = std::collections::HashMap::new();
    for (i, n) in nodes.iter().enumerate().skip(1) {
        kids.entry(&n.p[..n.p.len() - 1]).or_default().push(i);
    }
    fn build(nodes: &[Raw], kids: &std::collections::HashMap<&[i32], Vec<usize>>, at: usize, pid: u32, win: (f64, f64, f64, f64), budget: &mut usize) -> AccessibilityNode {
        *budget = budget.saturating_sub(1);
        let e = element(pid, &nodes[at], win);
        let mut children = Vec::new();
        for &c in kids.get(nodes[at].p.as_slice()).map(Vec::as_slice).unwrap_or(&[]) {
            if *budget == 0 {
                break;
            }
            children.push(build(nodes, kids, c, pid, win, budget));
        }
        AccessibilityNode {
            id: e.id,
            role: e.role,
            name: e.name,
            value: e.value,
            automation_id: e.automation_id,
            bounding_rect: e.bounding_rect,
            children,
            actions: e.actions,
            is_enabled: e.is_enabled,
            is_offscreen: e.is_offscreen,
        }
    }
    let mut budget = MAX_TREE_NODES;
    Ok(build(&nodes, &kids, 0, pid, win, &mut budget))
}

/// Reads the element and checks it is the one the id was made for; returns
/// what the script needs to re-check before acting.
fn locate(pid: u32, check: i32, path: &[i32]) -> Result<(Info, String), String> {
    let p = serde_json::to_string(path).unwrap_or_default();
    let info: Info = serde_json::from_str(&script(&["info", &pid.to_string(), &p])?)
        .map_err(|e| format!("desktop control: unreadable element: {e}"))?;
    if super::check_of(&info.r, &raw_name(&info.t, &info.d)) != check {
        return Err(gone());
    }
    let want = serde_json::json!({ "r": info.r, "t": info.t, "d": info.d }).to_string();
    Ok((info, want))
}

fn act(mode: &str, pid: u32, path: &[i32], want: &str, extra: Option<&str>) -> Result<serde_json::Value, String> {
    let p = serde_json::to_string(path).unwrap_or_default();
    let pid = pid.to_string();
    let mut args = vec![mode, pid.as_str(), p.as_str(), want];
    if let Some(x) = extra {
        args.push(x);
    }
    let out = script(&args)?;
    serde_json::from_str(&out).map_err(|e| format!("desktop control: unreadable answer: {e}"))
}

pub fn press(pid: u32, check: i32, path: &[i32]) -> Result<(), String> {
    let (_, want) = locate(pid, check, path)?;
    act("press", pid, path, &want, None).map(|_| ())
}

pub fn focus(pid: u32, check: i32, path: &[i32], for_keys: bool) -> Result<(), String> {
    let (info, want) = locate(pid, check, path)?;
    if for_keys && is_secure(&info.s) {
        return Err("desktop control: refusing to send keystrokes to a secure/password field".into());
    }
    let r = act("focus", pid, path, &want, None)?;
    // Keys after a refused focus would land in whatever had it.
    if r.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(())
    } else {
        Err(format!(
            "desktop control: \"{}\" cannot take the focus in this app. Send the keys to its window instead: the id get_focused returns.",
            name_of(&info.r, &info.t, &info.d, &info.v)
        ))
    }
}

pub fn value(pid: u32, check: i32, path: &[i32]) -> Result<String, String> {
    let (info, _) = locate(pid, check, path)?;
    if is_secure(&info.s) {
        return Ok(REDACTED.into());
    }
    Ok(if info.v.is_empty() { name_of(&info.r, &info.t, &info.d, &info.v) } else { info.v })
}

pub fn set_text(pid: u32, check: i32, path: &[i32], text: &str) -> Result<(), String> {
    let (info, want) = locate(pid, check, path)?;
    if ui_role(&info.r, &info.s) != "Edit" {
        return Err(format!("desktop control: \"{}\" ({}) is not an editable field", name_of(&info.r, &info.t, &info.d, &info.v), ui_role(&info.r, &info.s)));
    }
    act("set", pid, path, &want, Some(text)).map(|_| ())
}

/// The element's window to the front: its app first, then the window raised.
pub fn front(pid: u32, path: &[i32]) -> Result<(), String> {
    let window = path.first().copied().unwrap_or(1);
    activate(pid, window as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ax_roles_read_as_uia_roles() {
        assert_eq!(ui_role("AXButton", "AXCloseButton"), "Button");
        assert_eq!(ui_role("AXLink", ""), "Hyperlink");
        assert_eq!(ui_role("AXRadioButton", "AXTabButton"), "TabItem");
        assert_eq!(ui_role("AXRadioButton", ""), "RadioButton");
        assert_eq!(ui_role("AXWebArea", ""), "Document");
        assert_eq!(ui_role("AXTextArea", ""), "Edit");
        assert_eq!(ui_role("AXTextField", "AXSecureTextField"), "Edit");
        assert_eq!(ui_role("AXRow", "AXOutlineRow"), "TreeItem");
        assert_eq!(ui_role("AXGroup", "AXLandmarkMain"), "Main");
        assert_eq!(ui_role("AXColorWell", ""), "ColorWell");
    }

    #[test]
    fn names_are_what_a_person_reads() {
        assert_eq!(name_of("AXButton", "Send", "", ""), "Send");
        assert_eq!(name_of("AXButton", "", "close button", ""), "close button");
        assert_eq!(name_of("AXStaticText", "", "", "Hello"), "Hello");
        assert_eq!(name_of("AXTextArea", "", "", "typed words"), "", "a field's text is its value, not its name");
    }

    #[test]
    fn offscreen_is_outside_the_window() {
        let raw = |x: f64, y: f64| Raw { p: vec![1, 1], r: "AXLink".into(), s: String::new(), t: "a".into(), d: String::new(), v: String::new(), e: true, x, y, w: 10.0, h: 10.0 };
        let win = (0.0, 0.0, 800.0, 600.0);
        assert!(!element(1, &raw(100.0, 100.0), win).is_offscreen);
        assert!(element(1, &raw(100.0, 2000.0), win).is_offscreen, "scrolled below the window");
        let e = element(1, &raw(100.0, 100.0), win);
        assert!(matches!(target(&e.id), Ok(Target::Element { .. })), "{}", e.id);
    }
}
