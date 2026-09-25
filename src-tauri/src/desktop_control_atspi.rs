//! Linux: named elements through AT-SPI, the accessibility tree GTK, Qt,
//! Chromium, Electron and Firefox publish on their own D-Bus bus.
//!
//! What UI Automation is on Windows: find the "Send" button by its role and
//! name, press it through its own action (no mouse, no coordinates), read a
//! field, set a field's text. Talked to directly over D-Bus with `zbus`, which
//! the single-instance plugin already builds, so there is no C library and no
//! helper script whose interpreter could be missing.
//!
//! An element is re-found by its path of child indices from its application,
//! plus a check of its role and name: a path alone could name a different
//! button after the window changed, and a click on the wrong element is the
//! one failure this module must never have. When the check fails, the call
//! says the element changed and asks for a new search.
use super::*;
use std::collections::HashMap;
use std::time::Duration;
use zbus::blocking::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const REGISTRY: &str = "org.a11y.atspi.Registry";
const ROOT: &str = "/org/a11y/atspi/accessible/root";
const NULL_PATH: &str = "/org/a11y/atspi/null";

/// One unresponsive app must not hang a command for D-Bus's default 25 s.
const CALL_TIMEOUT: Duration = Duration::from_secs(3);

/// Elements read per search, a whole browser page included. Past this the
/// search stops and says what it found; the Windows backend caps the same way.
const MAX_VISITS: usize = 20_000;

// AT-SPI state bits (AtspiStateType), the ones read here.
const ST_DEFUNCT: u64 = 1 << 6;
const ST_EDITABLE: u64 = 1 << 7;
const ST_ENABLED: u64 = 1 << 8;
const ST_FOCUSED: u64 = 1 << 12;
const ST_SENSITIVE: u64 = 1 << 24;
const ST_SHOWING: u64 = 1 << 25;
const ST_VISIBLE: u64 = 1 << 30;
const ST_ACTIVE: u64 = 1 << 1;

/// Said when the accessibility bus is not there at all.
fn no_bus(e: impl std::fmt::Display) -> String {
    format!("desktop control: the accessibility bus (AT-SPI) is not available, so named elements cannot be read. Install at-spi2-core, sign in to a desktop session, and try again. ({e})")
}

fn gone() -> String {
    "desktop control: element_not_found: that element changed or is gone. Find it again (find_elements) and use the new id.".into()
}

#[derive(Clone, Debug)]
struct Node {
    bus: String,
    path: String,
}

impl Node {
    fn from_ref((bus, path): (String, OwnedObjectPath)) -> Option<Node> {
        let path = path.as_str().to_string();
        (path != NULL_PATH && !bus.is_empty()).then_some(Node { bus, path })
    }
}

struct Bus(Connection);

impl Bus {
    fn open() -> Result<Bus, String> {
        let addr = match std::env::var("AT_SPI_BUS_ADDRESS") {
            Ok(a) if !a.trim().is_empty() => a,
            _ => {
                let session = Connection::session().map_err(no_bus)?;
                let reply = session
                    .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &())
                    .map_err(no_bus)?;
                reply.body().deserialize::<String>().map_err(no_bus)?
            }
        };
        let conn = zbus::blocking::connection::Builder::address(addr.as_str())
            .map_err(no_bus)?
            .method_timeout(CALL_TIMEOUT)
            .build()
            .map_err(no_bus)?;
        Ok(Bus(conn))
    }

    fn call<B, R>(&self, n: &Node, iface: &str, method: &str, body: &B) -> zbus::Result<R>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
        R: for<'d> zbus::zvariant::DynamicDeserialize<'d>,
    {
        let msg = self.0.call_method(Some(n.bus.as_str()), n.path.as_str(), Some(iface), method, body)?;
        msg.body().deserialize::<R>()
    }

    fn prop(&self, n: &Node, iface: &str, name: &str) -> zbus::Result<OwnedValue> {
        self.call(n, "org.freedesktop.DBus.Properties", "Get", &(iface, name))
    }

    fn string_prop(&self, n: &Node, iface: &str, name: &str) -> String {
        self.prop(n, iface, name).ok().and_then(|v| String::try_from(v).ok()).unwrap_or_default()
    }

    fn children(&self, n: &Node) -> Vec<Node> {
        self.call::<_, Vec<(String, OwnedObjectPath)>>(n, ACCESSIBLE, "GetChildren", &())
            .map(|v| v.into_iter().filter_map(Node::from_ref).collect())
            .unwrap_or_default()
    }

    fn child_at(&self, n: &Node, i: i32) -> Option<Node> {
        self.call::<_, (String, OwnedObjectPath)>(n, ACCESSIBLE, "GetChildAtIndex", &(i,)).ok().and_then(Node::from_ref)
    }

    /// The role as AT-SPI numbers it (AtspiRole). The names differ between
    /// toolkits: GTK 4 calls an entry "text box", GTK 3 "text", so a role is
    /// matched by its number and the name is read only for a role the table
    /// below does not know.
    fn role(&self, n: &Node) -> u32 {
        self.call(n, ACCESSIBLE, "GetRole", &()).unwrap_or(0)
    }

    fn role_name(&self, n: &Node) -> String {
        self.call(n, ACCESSIBLE, "GetRoleName", &()).unwrap_or_default()
    }

    /// The UI Automation name of this node's role.
    fn ui_role(&self, n: &Node, role: u32, state: u64) -> String {
        match ui_role(role, state) {
            Some(r) => r.into(),
            None => camel(&self.role_name(n)),
        }
    }

    /// The accessible name, or its description when it has none: an icon
    /// button's words are often only there.
    fn name(&self, n: &Node) -> String {
        let name = self.string_prop(n, ACCESSIBLE, "Name");
        if name.trim().is_empty() { self.string_prop(n, ACCESSIBLE, "Description") } else { name }
    }

    fn state(&self, n: &Node) -> u64 {
        let words: Vec<u32> = self.call(n, ACCESSIBLE, "GetState", &()).unwrap_or_default();
        words.iter().take(2).enumerate().fold(0u64, |acc, (i, w)| acc | ((*w as u64) << (32 * i)))
    }

    fn interfaces(&self, n: &Node) -> Vec<String> {
        self.call(n, ACCESSIBLE, "GetInterfaces", &()).unwrap_or_default()
    }

    fn attributes(&self, n: &Node) -> HashMap<String, String> {
        self.call(n, ACCESSIBLE, "GetAttributes", &()).unwrap_or_default()
    }

    fn actions(&self, n: &Node) -> Vec<String> {
        self.call::<_, Vec<(String, String, String)>>(n, "org.a11y.atspi.Action", "GetActions", &())
            .map(|v| v.into_iter().map(|(name, _, _)| name).collect())
            .unwrap_or_default()
    }

    fn extents(&self, n: &Node) -> BoundingRect {
        // 0 = screen coordinates.
        match self.call::<_, (i32, i32, i32, i32)>(n, "org.a11y.atspi.Component", "GetExtents", &(0u32,)) {
            Ok((x, y, width, height)) => BoundingRect { x, y, width, height },
            Err(_) => BoundingRect { x: 0, y: 0, width: 0, height: 0 },
        }
    }

    /// The whole text. Asked with its length, not -1: GTK 4 answers "" to
    /// (0, -1) even when the field holds six characters.
    fn text(&self, n: &Node) -> Option<String> {
        let len = self
            .prop(n, "org.a11y.atspi.Text", "CharacterCount")
            .ok()
            .and_then(|v| i32::try_from(v).ok())
            .unwrap_or(-1);
        self.call::<_, String>(n, "org.a11y.atspi.Text", "GetText", &(0i32, len)).ok()
    }
}

/// The UI Automation name for an AT-SPI role number (atspi-constants.h), so
/// callers (Jev, the model) ask for "Button" or "Hyperlink" on every system.
/// `TEXT` is an editable field only when it says so: Firefox uses it for
/// plain text too.
pub fn ui_role(role: u32, state: u64) -> Option<&'static str> {
    Some(match role {
        43 | 62 | 129 => "Button", // push button, toggle button, push button menu
        88 => "Hyperlink",
        32 => "ListItem",
        37 => "TabItem",
        38 => "Tab",
        7 => "CheckBox",
        44 => "RadioButton",
        11 => "ComboBox",
        // A menu in a menu bar ("File") is pressed like its items.
        33 | 35 | 8 | 45 | 59 => "MenuItem",
        41 => "Menu", // popup menu
        34 => "MenuBar",
        91 => "TreeItem",
        56 | 90 => "DataItem",        // table cell, table row
        40 | 79 | 77 | 60 => "Edit", // password text, entry, editbar, terminal
        61 if state & ST_EDITABLE != 0 => "Edit",
        61 | 29 | 73 | 81 | 83 | 116 => "Text", // text, label, paragraph, caption, heading, static
        2 | 9 | 16 | 19 | 22 | 23 | 69 => "Window", // alert, choosers, dialog, frame, window
        82 | 92..=96 => "Document", // document frame, spreadsheet, presentation, text, web, email
        26 | 27 => "Image",
        31 | 98 => "List",
        65 | 66 => "Tree",
        55 => "Table",
        63 => "ToolBar",
        54 => "StatusBar",
        48 => "ScrollBar",
        51 => "Slider",
        52 => "Spinner",
        42 => "ProgressBar",
        50 => "Separator",
        64 => "ToolTip",
        75 => "Application",
        20 | 28 | 30 | 39 | 49 | 53 | 68 | 71 | 72 | 85 | 87 | 99 | 105 | 109 | 110 => "Group",
        _ => return None,
    })
}

/// A role the table does not know, in the same CamelCase: "color well" -> "ColorWell".
fn camel(role_name: &str) -> String {
    role_name
        .split(' ')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect()
}

const ROLE_PASSWORD: u32 = 40;
const ROLE_LANDMARK: u32 = 110;

/// The application a process published, by the pid of its bus connection.
fn app_of(bus: &Bus, pid: u32) -> Result<Node, String> {
    let root = Node { bus: REGISTRY.into(), path: ROOT.into() };
    let dbus = Node { bus: "org.freedesktop.DBus".into(), path: "/org/freedesktop/DBus".into() };
    for app in bus.children(&root) {
        let owner: zbus::Result<u32> = bus.call(&dbus, "org.freedesktop.DBus", "GetConnectionUnixProcessID", &(app.bus.as_str(),));
        if owner.ok() == Some(pid) {
            return Ok(app);
        }
    }
    let name = process_name(pid).unwrap_or_else(|| format!("process {pid}"));
    Err(format!("desktop control: {name} has not published an accessibility tree. GTK and Chromium apps do; a Qt (KDE) app needs QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1, and an Electron app needs --force-renderer-accessibility (launch it through Cinderpaw to get it). Its keys still work: send_keys to its window."))
}

/// The top-level window of the app: the one whose title contains
/// `title`, else the active one, else the first one on screen.
fn window_of(bus: &Bus, app: &Node, title: Option<&str>) -> Result<(i32, Node), String> {
    let wins: Vec<(i32, Node)> = bus.children(app).into_iter().enumerate().map(|(i, n)| (i as i32, n)).collect();
    if wins.is_empty() {
        return Err("desktop control: that app has no window in its accessibility tree".into());
    }
    if let Some(t) = title.map(str::to_lowercase).filter(|t| !t.is_empty()) {
        return wins
            .into_iter()
            .find(|(_, w)| bus.name(w).to_lowercase().contains(&t))
            .ok_or_else(|| format!("desktop control: no window of that app has \"{t}\" in its title"));
    }
    let states: Vec<u64> = wins.iter().map(|(_, w)| bus.state(w)).collect();
    let pick = states
        .iter()
        .position(|s| s & ST_ACTIVE != 0)
        .or_else(|| states.iter().position(|s| s & ST_SHOWING != 0))
        .unwrap_or(0);
    Ok(wins[pick].clone())
}

/// Preorder over `start`'s subtree (document order, as UIA's FindAll gives),
/// calling `visit` with each node, its path and its AT-SPI role. `visit`
/// returns false to stop.
fn walk(bus: &Bus, start: &Node, path: Vec<i32>, visit: &mut dyn FnMut(&Node, &[i32], u32) -> bool) {
    let mut stack = vec![(start.clone(), path)];
    let mut visits = 0usize;
    while let Some((n, p)) = stack.pop() {
        visits += 1;
        if visits > MAX_VISITS {
            return;
        }
        let role = bus.role(&n);
        if !visit(&n, &p, role) {
            return;
        }
        let kids = bus.children(&n);
        for (i, k) in kids.into_iter().enumerate().rev() {
            let mut kp = p.clone();
            kp.push(i as i32);
            stack.push((k, kp));
        }
    }
}

/// The first `under` scope in `win` ("Main" is the page's main landmark,
/// anything else a role such as "Document"), tried in order.
fn scope(bus: &Bus, win: &Node, win_path: &[i32], under: &str) -> Option<(Node, Vec<i32>)> {
    for want in under.split(',').map(str::trim).filter(|w| !w.is_empty()) {
        let mut found = None;
        walk(bus, win, win_path.to_vec(), &mut |n, p, role| {
            let hit = if want.eq_ignore_ascii_case("main") {
                role == ROLE_LANDMARK && bus.attributes(n).get("xml-roles").is_some_and(|r| r.eq_ignore_ascii_case("main"))
            } else {
                ui_role(role, 0).is_some_and(|r| r.eq_ignore_ascii_case(want))
            };
            if hit && bus.state(n) & ST_SHOWING != 0 {
                found = Some((n.clone(), p.to_vec()));
                return false;
            }
            true
        });
        if found.is_some() {
            return found;
        }
    }
    None
}

fn element(bus: &Bus, pid: u32, n: &Node, path: &[i32], role: u32, state: u64, name: String) -> AccessibilityElement {
    let ifaces = bus.interfaces(n);
    let has = |i: &str| ifaces.iter().any(|x| x == i);
    let ui = bus.ui_role(n, role, state);
    let value = if role == ROLE_PASSWORD {
        REDACTED.to_string()
    } else if has("org.a11y.atspi.Text") && ui == "Edit" {
        bus.text(n).unwrap_or_default()
    } else {
        String::new()
    };
    let mut actions = Vec::new();
    if has("org.a11y.atspi.Action") && press_action(&bus.actions(n)).is_some() {
        actions.push("press".to_string());
    }
    if has("org.a11y.atspi.EditableText") {
        actions.push("set_value".to_string());
    }
    if has("org.a11y.atspi.Component") {
        actions.push("focus".to_string());
    }
    AccessibilityElement {
        id: super::element_handle(pid, &role.to_string(), &name, path),
        role: ui,
        name,
        value,
        automation_id: bus.attributes(n).get("id").cloned().unwrap_or_default(),
        bounding_rect: bus.extents(n),
        actions,
        is_enabled: state & (ST_ENABLED | ST_SENSITIVE) != 0,
        is_offscreen: state & ST_SHOWING == 0 || state & ST_VISIBLE == 0,
    }
}

/// The action that presses an element, by the names toolkits give it
/// ("click" in GTK, "Click" in GTK 4, "jump" on a Firefox link, "press" on a
/// combo box). A label's "clipboard.copy" is not a press.
fn press_action(actions: &[String]) -> Option<i32> {
    const PRESS: [&str; 7] = ["click", "press", "activate", "jump", "open", "toggle", "select"];
    PRESS.iter().find_map(|want| actions.iter().position(|a| a.eq_ignore_ascii_case(want)).map(|i| i as i32))
}

pub fn find(pid: u32, q: &ElementQuery, window_title: Option<&str>) -> Result<Vec<AccessibilityElement>, String> {
    let bus = Bus::open()?;
    let app = app_of(&bus, pid)?;
    let (wi, win) = window_of(&bus, &app, window_title)?;
    let (root, root_path) = q
        .under_role
        .as_deref()
        .and_then(|u| scope(&bus, &win, &[wi], u))
        .unwrap_or((win, vec![wi]));
    let roles: Option<Vec<String>> = q
        .role
        .as_deref()
        .map(|s| s.split(',').map(|r| r.trim().to_lowercase()).filter(|r| !r.is_empty()).collect());
    let name_q = q.name.as_deref().map(str::to_lowercase);
    let aid_q = q.automation_id.as_deref().map(str::to_lowercase);
    let val_q = q.value_contains.as_deref().map(str::to_lowercase);
    let mut out = Vec::new();
    walk(&bus, &root, root_path, &mut |n, p, role| {
        let state = bus.state(n);
        if let Some(r) = &roles {
            if !r.contains(&bus.ui_role(n, role, state).to_lowercase()) {
                return true;
            }
        }
        let name = bus.name(n);
        if name_q.as_ref().is_some_and(|nq| !name.to_lowercase().contains(nq)) {
            return true;
        }
        let el = element(&bus, pid, n, p, role, state, name);
        if aid_q.as_ref().is_some_and(|a| !el.automation_id.to_lowercase().contains(a)) {
            return true;
        }
        // Never matched against a password field's value.
        if val_q.as_ref().is_some_and(|v| role == ROLE_PASSWORD || !el.value.to_lowercase().contains(v)) {
            return true;
        }
        out.push(el);
        out.len() < 500
    });
    Ok(out)
}

pub fn tree(pid: u32, depth: u8, window_title: Option<&str>) -> Result<AccessibilityNode, String> {
    let bus = Bus::open()?;
    let app = app_of(&bus, pid)?;
    let (wi, win) = window_of(&bus, &app, window_title)?;
    let mut budget = MAX_TREE_NODES;
    Ok(node(&bus, pid, &win, vec![wi], depth, &mut budget))
}

fn node(bus: &Bus, pid: u32, n: &Node, path: Vec<i32>, depth: u8, budget: &mut usize) -> AccessibilityNode {
    *budget = budget.saturating_sub(1);
    let role = bus.role(n);
    let el = element(bus, pid, n, &path, role, bus.state(n), bus.name(n));
    let mut children = Vec::new();
    if depth > 1 {
        for (i, k) in bus.children(n).into_iter().enumerate() {
            if *budget == 0 {
                break;
            }
            let mut kp = path.clone();
            kp.push(i as i32);
            children.push(node(bus, pid, &k, kp, depth - 1, budget));
        }
    }
    AccessibilityNode {
        id: el.id,
        role: el.role,
        name: el.name,
        value: el.value,
        automation_id: el.automation_id,
        bounding_rect: el.bounding_rect,
        children,
        actions: el.actions,
        is_enabled: el.is_enabled,
        is_offscreen: el.is_offscreen,
    }
}

/// The element a handle names, only if it is still the same element.
fn locate(bus: &Bus, pid: u32, check: i32, path: &[i32]) -> Result<(Node, u32, String), String> {
    let n = walk_path(bus, pid, path)?;
    let role = bus.role(&n);
    let name = bus.name(&n);
    if super::check_of(&role.to_string(), &name) != check || bus.state(&n) & ST_DEFUNCT != 0 {
        return Err(gone());
    }
    Ok((n, role, name))
}

pub fn press(pid: u32, check: i32, path: &[i32]) -> Result<(), String> {
    let bus = Bus::open()?;
    let (n, role, name) = locate(&bus, pid, check, path)?;
    let actions = bus.actions(&n);
    if let Some(i) = press_action(&actions) {
        let ok: bool = bus
            .call(&n, "org.a11y.atspi.Action", "DoAction", &(i,))
            .map_err(|e| format!("desktop control: pressing \"{name}\" failed: {e}"))?;
        return if ok { Ok(()) } else { Err(format!("desktop control: \"{name}\" refused the press")) };
    }
    // A tab or a list row often has no action of its own: its list selects it.
    if let Some((&index, parent_path)) = path.split_last() {
        if let Ok(parent) = walk_path(&bus, pid, parent_path) {
            if bus.interfaces(&parent).iter().any(|i| i == "org.a11y.atspi.Selection") {
                let ok: bool = bus
                    .call(&parent, "org.a11y.atspi.Selection", "SelectChild", &(index,))
                    .map_err(|e| format!("desktop control: selecting \"{name}\" failed: {e}"))?;
                if ok {
                    return Ok(());
                }
            }
        }
    }
    let offers = if actions.is_empty() { "no actions".to_string() } else { actions.join(", ") };
    Err(format!("desktop control: \"{name}\" ({}) cannot be pressed: it offers {offers}.", bus.ui_role(&n, role, bus.state(&n))))
}

fn walk_path(bus: &Bus, pid: u32, path: &[i32]) -> Result<Node, String> {
    let mut n = app_of(bus, pid)?;
    for &i in path {
        n = bus.child_at(&n, i).ok_or_else(gone)?;
    }
    Ok(n)
}

/// The top-level window an element is in, to the front: keys sent to the
/// element land in it and not in whatever window had the focus. Matched to
/// its X window by title; the app's first window when no title matches.
pub fn front(pid: u32, path: &[i32]) -> Result<(), String> {
    let bus = Bus::open()?;
    let title = bus.name(&walk_path(&bus, pid, &path[..1.min(path.len())])?);
    let wins = windows_of(pid)?;
    let n = wins
        .iter()
        .find(|(_, t)| *t == title)
        .or(wins.first())
        .map(|(n, _)| *n)
        .ok_or_else(|| "desktop control: that app has no window on screen".to_string())?;
    activate(pid, n)
}

/// The element takes the focus. Only when the app accepted the request or
/// the element already has it: GTK 4 does not implement GrabFocus, and keys
/// sent after a refused focus would land in whatever field had it. With
/// `for_keys`, a password field is refused, as on Windows: keystrokes into it
/// are not something to replay.
pub fn focus(pid: u32, check: i32, path: &[i32], for_keys: bool) -> Result<(), String> {
    let bus = Bus::open()?;
    let (n, role, name) = locate(&bus, pid, check, path)?;
    if for_keys && role == ROLE_PASSWORD {
        return Err("desktop control: refusing to send keystrokes to a secure/password field".into());
    }
    let focused = || bus.state(&n) & ST_FOCUSED != 0;
    match bus.call::<_, bool>(&n, "org.a11y.atspi.Component", "GrabFocus", &()) {
        Ok(true) => {
            for _ in 0..6 {
                if focused() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(())
        }
        _ if focused() => Ok(()),
        Ok(false) => Err(format!("desktop control: \"{name}\" refused the focus")),
        Err(e) => Err(format!("desktop control: \"{name}\" cannot take the focus in this app ({e}). Send the keys to its window instead: the id get_focused returns.")),
    }
}

pub fn value(pid: u32, check: i32, path: &[i32]) -> Result<String, String> {
    let bus = Bus::open()?;
    let (n, role, name) = locate(&bus, pid, check, path)?;
    if role == ROLE_PASSWORD {
        return Ok(REDACTED.into());
    }
    if let Some(t) = bus.text(&n) {
        return Ok(t);
    }
    if let Ok(v) = bus.prop(&n, "org.a11y.atspi.Value", "CurrentValue") {
        if let Ok(f) = f64::try_from(v) {
            return Ok(f.to_string());
        }
    }
    Ok(name)
}

/// The field's whole text, like UIA's SetValue: what was there is replaced.
pub fn set_text(pid: u32, check: i32, path: &[i32], text: &str) -> Result<(), String> {
    let bus = Bus::open()?;
    let (n, role, name) = locate(&bus, pid, check, path)?;
    if !bus.interfaces(&n).iter().any(|i| i == "org.a11y.atspi.EditableText") {
        return Err(format!("desktop control: \"{name}\" ({}) is not an editable field", bus.ui_role(&n, role, bus.state(&n))));
    }
    let _ = bus.call::<_, bool>(&n, "org.a11y.atspi.Component", "GrabFocus", &());
    let ok: bool = bus
        .call(&n, "org.a11y.atspi.EditableText", "SetTextContents", &(text,))
        .map_err(|e| format!("desktop control: typing into \"{name}\" failed: {e}"))?;
    if ok { Ok(()) } else { Err(format!("desktop control: \"{name}\" refused the text")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atspi_roles_read_as_uia_roles() {
        assert_eq!(ui_role(43, 0), Some("Button"));
        assert_eq!(ui_role(88, 0), Some("Hyperlink"));
        assert_eq!(ui_role(37, 0), Some("TabItem"));
        assert_eq!(ui_role(95, 0), Some("Document"));
        assert_eq!(ui_role(40, 0), Some("Edit"));
        assert_eq!(ui_role(61, ST_EDITABLE), Some("Edit"));
        assert_eq!(ui_role(61, 0), Some("Text"), "plain text is not a field");
        assert_eq!(ui_role(56, 0), Some("DataItem"));
        assert_eq!(ui_role(23, 0), Some("Window"));
        assert_eq!(ui_role(1000, 0), None);
        assert_eq!(camel("color well"), "ColorWell");
    }

    #[test]
    fn a_press_is_a_press_not_the_first_action() {
        let label = ["clipboard.copy", "link.open"].map(String::from);
        assert_eq!(press_action(&label), None);
        let button = ["Click"].map(String::from);
        assert_eq!(press_action(&button), Some(0));
        let link = ["jump", "click-ancestor"].map(String::from);
        assert_eq!(press_action(&link), Some(0));
        let tree_item = ["expand or contract", "activate"].map(String::from);
        assert_eq!(press_action(&tree_item), Some(1));
    }
}
