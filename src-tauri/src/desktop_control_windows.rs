//! Windows UI Automation backend for [`super`] (desktop control).
//!
//! Every public function here is called from a `spawn_blocking` thread, so it
//! is free to initialize COM, do its work, and tear COM down synchronously.
//! COM objects never cross the thread boundary.
//!
//! Design choices that keep this robust:
//!   * **`FindAll` + a true-condition** is used to enumerate children, not the
//!     `IUIAutomationTreeWalker`. The walker returns `S_OK` with a *null*
//!     element when there are no more siblings/children, which is a classic
//!     windows-rs footgun; `IUIAutomationElementArray` carries an explicit
//!     length and never hands back a null element.
//!   * **Pattern-availability is checked via the `Is*PatternAvailable`
//!     boolean properties** before a pattern pointer is ever requested, so we
//!     never `cast()` a null COM pointer.
//!   * Element re-location compares **RuntimeId** integer arrays directly — no
//!     `VARIANT` array construction required.

use super::*;

use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::RECT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_MULTITHREADED, SAFEARRAY,
};
use windows::Win32::System::Ole::{
    SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
};
use windows::Win32::System::Variant::VariantToBooleanWithDefault;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE,
    VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_HOME,
    VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_TAB,
    VK_UP,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationExpandCollapsePattern,
    IUIAutomationInvokePattern, IUIAutomationTogglePattern, IUIAutomationValuePattern,
    TreeScope_Children, TreeScope_Subtree, UIA_ButtonControlTypeId, UIA_CONTROLTYPE_ID,
    UIA_CalendarControlTypeId, UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId,
    UIA_DataGridControlTypeId, UIA_DataItemControlTypeId, UIA_DocumentControlTypeId,
    UIA_EditControlTypeId, UIA_GroupControlTypeId, UIA_HyperlinkControlTypeId,
    UIA_ImageControlTypeId, UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsInvokePatternAvailablePropertyId, UIA_IsPasswordPropertyId,
    UIA_IsTogglePatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId,
    UIA_ListControlTypeId, UIA_ListItemControlTypeId, UIA_MenuControlTypeId,
    UIA_MenuItemControlTypeId, UIA_PaneControlTypeId, UIA_ProgressBarControlTypeId,
    UIA_RadioButtonControlTypeId, UIA_ScrollBarControlTypeId, UIA_SliderControlTypeId,
    UIA_SpinnerControlTypeId, UIA_SplitButtonControlTypeId, UIA_StatusBarControlTypeId,
    UIA_TabControlTypeId, UIA_TabItemControlTypeId, UIA_TableControlTypeId,
    UIA_TextControlTypeId, UIA_ToolBarControlTypeId, UIA_TreeControlTypeId,
    UIA_TreeItemControlTypeId, UIA_WindowControlTypeId,
};

/// Hard ceiling on elements visited during a subtree re-location, so a runaway
/// accessibility tree (e.g. a giant web page) can never hang the thread.
const MAX_LOCATE_VISITS: usize = 50_000;

/// RAII COM apartment guard for the current (blocking) thread.
struct ComGuard;

impl ComGuard {
    fn new() -> Self {
        // SAFETY: called once per blocking thread before any COM use. A second
        // init in the same thread returns S_FALSE, which we ignore; we still
        // balance it with a CoUninitialize on drop.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        ComGuard
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn automation() -> Result<IUIAutomation, String> {
    // SAFETY: CUIAutomation is a registered in-proc COM server.
    unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
        .map_err(|e| format!("desktop control: failed to create UIAutomation: {e}"))
}

fn bstr_to_string(b: BSTR) -> String {
    b.to_string()
}

/// Read an element's RuntimeId as a plain `Vec<i32>`.
fn runtime_id(elem: &IUIAutomationElement) -> Result<Vec<i32>, String> {
    // SAFETY: GetRuntimeId returns a freshly-allocated SAFEARRAY of VT_I4 that
    // we own and must read then drop. We read bounds and each element, then
    // let it leak only on error paths (acceptable, rare).
    unsafe {
        let psa: *mut SAFEARRAY = elem
            .GetRuntimeId()
            .map_err(|e| format!("desktop control: GetRuntimeId failed: {e}"))?;
        if psa.is_null() {
            return Err("desktop control: element has no RuntimeId".into());
        }
        let lbound = SafeArrayGetLBound(psa, 1).map_err(|e| e.to_string())?;
        let ubound = SafeArrayGetUBound(psa, 1).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for i in lbound..=ubound {
            let mut val: i32 = 0;
            SafeArrayGetElement(psa, &i, &mut val as *mut i32 as *mut core::ffi::c_void)
                .map_err(|e| e.to_string())?;
            out.push(val);
        }
        Ok(out)
    }
}

fn process_id(elem: &IUIAutomationElement) -> Result<u32, String> {
    // SAFETY: simple property read on a live element.
    unsafe { elem.CurrentProcessId() }
        .map(|p| p as u32)
        .map_err(|e| format!("desktop control: CurrentProcessId failed: {e}"))
}

/// Map a UIA control-type id to a short, stable role name.
fn control_type_name(ct: UIA_CONTROLTYPE_ID) -> String {
    let name = if ct == UIA_ButtonControlTypeId {
        "Button"
    } else if ct == UIA_CalendarControlTypeId {
        "Calendar"
    } else if ct == UIA_CheckBoxControlTypeId {
        "CheckBox"
    } else if ct == UIA_ComboBoxControlTypeId {
        "ComboBox"
    } else if ct == UIA_EditControlTypeId {
        "Edit"
    } else if ct == UIA_HyperlinkControlTypeId {
        "Hyperlink"
    } else if ct == UIA_ImageControlTypeId {
        "Image"
    } else if ct == UIA_ListItemControlTypeId {
        "ListItem"
    } else if ct == UIA_ListControlTypeId {
        "List"
    } else if ct == UIA_MenuControlTypeId {
        "Menu"
    } else if ct == UIA_MenuItemControlTypeId {
        "MenuItem"
    } else if ct == UIA_ProgressBarControlTypeId {
        "ProgressBar"
    } else if ct == UIA_RadioButtonControlTypeId {
        "RadioButton"
    } else if ct == UIA_ScrollBarControlTypeId {
        "ScrollBar"
    } else if ct == UIA_SliderControlTypeId {
        "Slider"
    } else if ct == UIA_SpinnerControlTypeId {
        "Spinner"
    } else if ct == UIA_StatusBarControlTypeId {
        "StatusBar"
    } else if ct == UIA_TabControlTypeId {
        "Tab"
    } else if ct == UIA_TabItemControlTypeId {
        "TabItem"
    } else if ct == UIA_TextControlTypeId {
        "Text"
    } else if ct == UIA_ToolBarControlTypeId {
        "ToolBar"
    } else if ct == UIA_TreeControlTypeId {
        "Tree"
    } else if ct == UIA_TreeItemControlTypeId {
        "TreeItem"
    } else if ct == UIA_WindowControlTypeId {
        "Window"
    } else if ct == UIA_GroupControlTypeId {
        "Group"
    } else if ct == UIA_PaneControlTypeId {
        "Pane"
    } else if ct == UIA_DocumentControlTypeId {
        "Document"
    } else if ct == UIA_SplitButtonControlTypeId {
        "SplitButton"
    } else if ct == UIA_DataGridControlTypeId {
        "DataGrid"
    } else if ct == UIA_DataItemControlTypeId {
        "DataItem"
    } else if ct == UIA_TableControlTypeId {
        "Table"
    } else {
        return format!("Control({})", ct.0);
    };
    name.to_string()
}

/// Read a boolean UIA property; `false` on any read failure / non-bool. Uses
/// the propsys `VariantToBooleanWithDefault` helper so we never touch the
/// VARIANT union directly.
fn bool_property(elem: &IUIAutomationElement, prop: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID) -> bool {
    // SAFETY: property read on a live element; the returned VARIANT is owned
    // and dropped (VariantClear) when it goes out of scope.
    unsafe {
        match elem.GetCurrentPropertyValue(prop) {
            Ok(var) => VariantToBooleanWithDefault(&var, false).as_bool(),
            Err(_) => false,
        }
    }
}

/// Is this element a password / secure-text field?
fn is_secure(elem: &IUIAutomationElement) -> bool {
    bool_property(elem, UIA_IsPasswordPropertyId)
}

fn bounding_rect(elem: &IUIAutomationElement) -> BoundingRect {
    // SAFETY: property read; defaults to a zero rect on failure.
    let r: RECT = unsafe { elem.CurrentBoundingRectangle() }.unwrap_or(RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    });
    BoundingRect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

fn available_actions(elem: &IUIAutomationElement) -> Vec<String> {
    let mut actions = Vec::new();
    if bool_property(elem, UIA_IsInvokePatternAvailablePropertyId) {
        actions.push("press".to_string());
    }
    if bool_property(elem, UIA_IsTogglePatternAvailablePropertyId) {
        actions.push("toggle".to_string());
    }
    if bool_property(elem, UIA_IsExpandCollapsePatternAvailablePropertyId) {
        actions.push("expand".to_string());
        actions.push("collapse".to_string());
    }
    if bool_property(elem, UIA_IsValuePatternAvailablePropertyId) {
        actions.push("set_value".to_string());
    }
    actions
}

/// Read an element's current value, honoring secure-field redaction.
fn element_value(elem: &IUIAutomationElement) -> String {
    if is_secure(elem) {
        return REDACTED.to_string();
    }
    if bool_property(elem, UIA_IsValuePatternAvailablePropertyId) {
        // Availability was just confirmed, so the pattern pointer is non-null.
        if let Some(p) = value_pattern(elem) {
            if let Ok(v) = unsafe { p.CurrentValue() } {
                return bstr_to_string(v);
            }
        }
    }
    // Fallback: the element's name often carries the visible text.
    unsafe { elem.CurrentName() }.map(bstr_to_string).unwrap_or_default()
}

fn name_of(elem: &IUIAutomationElement) -> String {
    unsafe { elem.CurrentName() }.map(bstr_to_string).unwrap_or_default()
}

fn automation_id_of(elem: &IUIAutomationElement) -> String {
    unsafe { elem.CurrentAutomationId() }.map(bstr_to_string).unwrap_or_default()
}

fn role_of(elem: &IUIAutomationElement) -> String {
    match unsafe { elem.CurrentControlType() } {
        Ok(ct) => control_type_name(ct),
        Err(_) => "Unknown".to_string(),
    }
}

fn is_enabled_of(elem: &IUIAutomationElement) -> bool {
    unsafe { elem.CurrentIsEnabled() }.map(|b| b.as_bool()).unwrap_or(false)
}

fn is_offscreen_of(elem: &IUIAutomationElement) -> bool {
    unsafe { elem.CurrentIsOffscreen() }.map(|b| b.as_bool()).unwrap_or(false)
}

fn value_pattern(elem: &IUIAutomationElement) -> Option<IUIAutomationValuePattern> {
    // SAFETY: caller confirmed value-pattern availability.
    unsafe { elem.GetCurrentPattern(UIA_ValuePatternId) }
        .ok()
        .and_then(|u| u.cast::<IUIAutomationValuePattern>().ok())
}

use windows::Win32::UI::Accessibility::{
    UIA_ExpandCollapsePatternId, UIA_InvokePatternId, UIA_TogglePatternId, UIA_ValuePatternId,
};

/// Enumerate an element's direct children using a true-condition FindAll.
fn children(auto: &IUIAutomation, elem: &IUIAutomationElement) -> Result<Vec<IUIAutomationElement>, String> {
    let cond = unsafe { auto.CreateTrueCondition() }.map_err(|e| e.to_string())?;
    let arr = unsafe { elem.FindAll(TreeScope_Children, &cond) }
        .map_err(|e| format!("desktop control: FindAll(children) failed: {e}"))?;
    let n = unsafe { arr.Length() }.map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        if let Ok(child) = unsafe { arr.GetElement(i) } {
            out.push(child);
        }
    }
    Ok(out)
}

fn node_from(
    auto: &IUIAutomation,
    pid: u32,
    elem: &IUIAutomationElement,
    depth: u8,
    budget: &mut usize,
) -> Result<AccessibilityNode, String> {
    let rid = runtime_id(elem)?;
    let mut node = AccessibilityNode {
        id: encode_handle(pid, &rid),
        role: role_of(elem),
        name: name_of(elem),
        value: element_value(elem),
        automation_id: automation_id_of(elem),
        bounding_rect: bounding_rect(elem),
        children: Vec::new(),
        actions: available_actions(elem),
        is_enabled: is_enabled_of(elem),
        is_offscreen: is_offscreen_of(elem),
    };
    if depth > 1 && *budget > 0 {
        for child in children(auto, elem)? {
            // Stop descending once the global node budget is spent — the tree
            // is returned truncated rather than ballooning the payload.
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            // Best-effort: a child that fails to serialize is skipped, never
            // fails the whole tree.
            if let Ok(cn) = node_from(auto, pid, &child, depth - 1, budget) {
                node.children.push(cn);
            }
        }
    }
    Ok(node)
}

fn element_from(pid: u32, elem: &IUIAutomationElement) -> Result<AccessibilityElement, String> {
    let rid = runtime_id(elem)?;
    Ok(AccessibilityElement {
        id: encode_handle(pid, &rid),
        role: role_of(elem),
        name: name_of(elem),
        value: element_value(elem),
        automation_id: automation_id_of(elem),
        bounding_rect: bounding_rect(elem),
        actions: available_actions(elem),
        is_enabled: is_enabled_of(elem),
        is_offscreen: is_offscreen_of(elem),
    })
}

/// True for shell artifact windows that share a pid with real app windows and
/// are never what an agent driving "the app" wants (Win11's `explorer.exe`
/// owns the Taskbar and the desktop "Program Manager" under the SAME pid as a
/// File Explorer window). Matched case-insensitively on the window title.
fn is_shell_window(name_lc: &str) -> bool {
    name_lc.is_empty()
        || name_lc == "taskbar"
        || name_lc == "progman"
        || name_lc.contains("program manager")
}

/// All top-level window elements owned by `pid`. A single process can own
/// several (Win11 explorer.exe is the canonical example), so callers that need
/// a specific one disambiguate via [`window_root_for`]; element re-location
/// ([`locate`]) searches across all of them.
fn windows_for_pid(auto: &IUIAutomation, pid: u32) -> Result<Vec<IUIAutomationElement>, String> {
    let root = unsafe { auto.GetRootElement() }.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for win in children(auto, &root)? {
        if process_id(&win).map(|p| p == pid).unwrap_or(false) {
            out.push(win);
        }
    }
    if out.is_empty() {
        return Err(format!(
            "desktop control: no top-level window found for pid {pid} (the app may have closed)"
        ));
    }
    Ok(out)
}

/// Choose which top-level window of `pid` to read from.
///
///   * `title_filter` given → the window whose title contains it (case-
///     insensitive). Lets the agent target a specific window when one pid owns
///     several (use the title from `list_windows`).
///   * no filter, several windows → prefer the first real, on-screen, named
///     window, skipping shell artifacts (Taskbar / Program Manager) so a
///     `get_tree` on explorer.exe lands on the File Explorer window, not the
///     Taskbar.
///   * otherwise → the first window.
fn window_root_for(
    auto: &IUIAutomation,
    pid: u32,
    title_filter: Option<&str>,
) -> Result<IUIAutomationElement, String> {
    let wins = windows_for_pid(auto, pid)?;
    if let Some(t) = title_filter {
        let t = t.to_lowercase();
        return wins
            .iter()
            .find(|w| name_of(w).to_lowercase().contains(t.as_str()))
            .cloned()
            .ok_or_else(|| {
                format!(
                    "desktop control: no window whose title contains \"{t}\" for pid {pid} (check list_windows)"
                )
            });
    }
    if wins.len() > 1 {
        if let Some(w) = wins.iter().find(|w| {
            !is_shell_window(&name_of(w).to_lowercase()) && !is_offscreen_of(w)
        }) {
            return Ok(w.clone());
        }
    }
    Ok(wins.into_iter().next().expect("windows_for_pid is non-empty"))
}

/// Re-locate an element by RuntimeId across ALL windows owned by `pid`. Trying
/// every top-level window (not just the first) is what makes handles survive on
/// shared-pid apps like explorer.exe, where the element may live in a sibling
/// window of the one `window_root_for` would pick.
fn locate(auto: &IUIAutomation, pid: u32, rid: &[i32]) -> Result<IUIAutomationElement, String> {
    let wins = windows_for_pid(auto, pid)?;
    for root in &wins {
        if runtime_id(root).map(|r| r == rid).unwrap_or(false) {
            return Ok(root.clone());
        }
        let Ok(cond) = (unsafe { auto.CreateTrueCondition() }) else { continue };
        let Ok(arr) = (unsafe { root.FindAll(TreeScope_Subtree, &cond) }) else { continue };
        let n = unsafe { arr.Length() }.unwrap_or(0);
        let limit = (n as usize).min(MAX_LOCATE_VISITS);
        for i in 0..limit as i32 {
            if let Ok(el) = unsafe { arr.GetElement(i) } {
                if runtime_id(&el).map(|r| r == rid).unwrap_or(false) {
                    return Ok(el);
                }
            }
        }
    }
    Err("desktop control: element_not_found (it may have changed or its window closed)".into())
}

fn locate_by_handle(auto: &IUIAutomation, handle: &str) -> Result<(u32, IUIAutomationElement), String> {
    let (pid, rid) = decode_handle(handle)?;
    let el = locate(auto, pid, &rid)?;
    Ok((pid, el))
}

// ---------------------------------------------------------------------------
// Public surface (called by super:: command wrappers)
// ---------------------------------------------------------------------------

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let _com = ComGuard::new();
    let auto = automation()?;
    let root = unsafe { auto.GetRootElement() }.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for win in children(&auto, &root)? {
        let pid = match process_id(&win) {
            Ok(p) => p,
            Err(_) => continue,
        };
        // Skip offscreen shell artifacts to keep the list user-meaningful.
        if is_offscreen_of(&win) {
            continue;
        }
        let title = name_of(&win);
        let app_name = process_name(pid).unwrap_or_default();
        out.push(WindowInfo { pid, title, app_name });
    }
    Ok(out)
}

pub fn get_accessibility_tree(
    pid: u32,
    depth: u8,
    window_title: Option<&str>,
) -> Result<AccessibilityNode, String> {
    let _com = ComGuard::new();
    let auto = automation()?;
    let root = window_root_for(&auto, pid, window_title)?;
    let mut budget = MAX_TREE_NODES;
    node_from(&auto, pid, &root, clamp_depth(depth), &mut budget)
}

pub fn find_elements(
    pid: u32,
    query: &ElementQuery,
    window_title: Option<&str>,
) -> Result<Vec<AccessibilityElement>, String> {
    let _com = ComGuard::new();
    let auto = automation()?;
    let root = window_root_for(&auto, pid, window_title)?;
    let cond = unsafe { auto.CreateTrueCondition() }.map_err(|e| e.to_string())?;
    let arr = unsafe { root.FindAll(TreeScope_Subtree, &cond) }
        .map_err(|e| format!("desktop control: subtree FindAll failed: {e}"))?;
    let n = unsafe { arr.Length() }.map_err(|e| e.to_string())?;
    let limit = (n as usize).min(MAX_LOCATE_VISITS);

    let role_q = query.role.as_deref().map(|s| s.to_lowercase());
    let name_q = query.name.as_deref().map(|s| s.to_lowercase());
    let aid_q = query.automation_id.as_deref().map(|s| s.to_lowercase());
    let val_q = query.value_contains.as_deref().map(|s| s.to_lowercase());

    let mut out = Vec::new();
    for i in 0..limit as i32 {
        let Ok(el) = (unsafe { arr.GetElement(i) }) else { continue };
        if let Some(ref r) = role_q {
            if role_of(&el).to_lowercase() != *r {
                continue;
            }
        }
        if let Some(ref nq) = name_q {
            if !name_of(&el).to_lowercase().contains(nq) {
                continue;
            }
        }
        if let Some(ref aq) = aid_q {
            if !automation_id_of(&el).to_lowercase().contains(aq) {
                continue;
            }
        }
        if let Some(ref vq) = val_q {
            // Never match against a secure field's value.
            if is_secure(&el) || !element_value(&el).to_lowercase().contains(vq) {
                continue;
            }
        }
        if let Ok(e) = element_from(pid, &el) {
            out.push(e);
        }
        // Cap result size so a broad query can't return tens of thousands.
        if out.len() >= 500 {
            break;
        }
    }
    Ok(out)
}

pub fn click_element(handle: &str) -> Result<(), String> {
    let _com = ComGuard::new();
    let auto = automation()?;
    let (_pid, el) = locate_by_handle(&auto, handle)?;
    invoke(&el)
}

pub fn type_into_element(handle: &str, text: &str) -> Result<(), String> {
    let _com = ComGuard::new();
    let auto = automation()?;
    let (_pid, el) = locate_by_handle(&auto, handle)?;

    if !bool_property(&el, UIA_IsValuePatternAvailablePropertyId) {
        return Err(
            "desktop control: element does not support setting a value (it may not be an editable field)"
                .into(),
        );
    }
    // Focus first so the app treats the change as user input.
    let _ = unsafe { el.SetFocus() };
    let p = value_pattern(&el).ok_or("desktop control: value pattern unavailable")?;
    unsafe { p.SetValue(&BSTR::from(text)) }
        .map_err(|e| format!("desktop control: SetValue failed: {e}"))
}

pub fn get_element_value(handle: &str) -> Result<String, String> {
    let _com = ComGuard::new();
    let auto = automation()?;
    let (_pid, el) = locate_by_handle(&auto, handle)?;
    Ok(element_value(&el))
}

pub fn get_focused_element() -> Result<AccessibilityElement, String> {
    let _com = ComGuard::new();
    let auto = automation()?;
    let el = unsafe { auto.GetFocusedElement() }
        .map_err(|e| format!("desktop control: GetFocusedElement failed: {e}"))?;
    let pid = process_id(&el)?;
    element_from(pid, &el)
}

pub fn take_element_action(handle: &str, action: &str) -> Result<(), String> {
    let _com = ComGuard::new();
    let auto = automation()?;
    let (_pid, el) = locate_by_handle(&auto, handle)?;
    match action.to_lowercase().as_str() {
        "press" | "invoke" | "click" => invoke(&el),
        "toggle" => toggle(&el),
        "expand" => expand_collapse(&el, true),
        "collapse" => expand_collapse(&el, false),
        "focus" => unsafe { el.SetFocus() }.map_err(|e| e.to_string()),
        other => Err(format!("desktop control: unsupported action \"{other}\"")),
    }
}

// ---------------------------------------------------------------------------
// Pattern actions
// ---------------------------------------------------------------------------

fn invoke(el: &IUIAutomationElement) -> Result<(), String> {
    if bool_property(el, UIA_IsInvokePatternAvailablePropertyId) {
        let p = unsafe { el.GetCurrentPattern(UIA_InvokePatternId) }
            .ok()
            .and_then(|u| u.cast::<IUIAutomationInvokePattern>().ok())
            .ok_or("desktop control: invoke pattern unavailable")?;
        return unsafe { p.Invoke() }.map_err(|e| format!("desktop control: Invoke failed: {e}"));
    }
    // Fallback: a toggleable element (checkbox) responds to a "press" by toggling.
    if bool_property(el, UIA_IsTogglePatternAvailablePropertyId) {
        return toggle(el);
    }
    Err("desktop control: element is not invokable (no Invoke or Toggle pattern)".into())
}

fn toggle(el: &IUIAutomationElement) -> Result<(), String> {
    let p = unsafe { el.GetCurrentPattern(UIA_TogglePatternId) }
        .ok()
        .and_then(|u| u.cast::<IUIAutomationTogglePattern>().ok())
        .ok_or("desktop control: toggle pattern unavailable")?;
    unsafe { p.Toggle() }.map_err(|e| format!("desktop control: Toggle failed: {e}"))
}

fn expand_collapse(el: &IUIAutomationElement, expand: bool) -> Result<(), String> {
    let p = unsafe { el.GetCurrentPattern(UIA_ExpandCollapsePatternId) }
        .ok()
        .and_then(|u| u.cast::<IUIAutomationExpandCollapsePattern>().ok())
        .ok_or("desktop control: expand/collapse pattern unavailable")?;
    let r = if expand {
        unsafe { p.Expand() }
    } else {
        unsafe { p.Collapse() }
    };
    r.map_err(|e| format!("desktop control: ExpandCollapse failed: {e}"))
}

// ---------------------------------------------------------------------------
// Synthetic keyboard input (send_keys)
// ---------------------------------------------------------------------------
//
// `ValuePattern.SetValue` (used by `type`) writes straight into the control's
// value and many Electron/Chromium apps (Discord, Slack, VS Code) never see it
// — their React state stays empty, so there is nothing to submit and Enter
// sends nothing. `send_keys` synthesizes REAL keystrokes via `SendInput`, which
// those apps process exactly like physical typing, and it can press named keys
// like Enter — the only reliable way to "type and send" in such apps.

/// Max keystroke-spec length, bounding the SendInput batch we will dispatch.
const MAX_KEYS_LEN: usize = 2000;

/// Focus `el` and CONFIRM the OS focus actually landed on the target process
/// before any synthetic input is dispatched.
///
/// Why this exists: `SetFocus()` is asynchronous and subject to Windows'
/// foreground-lock — the focused window does not change the instant the call
/// returns. `SendInput` always delivers to whatever window currently holds the
/// foreground, so firing it immediately after `SetFocus` raced: keystrokes
/// landed in the *previous* foreground window (often Feral itself), and the
/// tool still reported success. That is the "focus lost / wrong window" class
/// of failures. We now retry SetFocus with a short settle, then verify via the
/// system-wide `GetFocusedElement` that the focused element belongs to the
/// target pid. If it never does, we fail SAFE (recoverable) instead of typing
/// into the wrong place.
fn ensure_focused(auto: &IUIAutomation, el: &IUIAutomationElement, pid: u32) -> Result<(), String> {
    for attempt in 0..3u64 {
        let _ = unsafe { el.SetFocus() };
        // Linear backoff: 50ms, 100ms, 150ms. Generous enough for a window to
        // come to the foreground; cheap enough not to stall the agent.
        std::thread::sleep(std::time::Duration::from_millis(50 * (attempt + 1)));
        if let Ok(focused) = unsafe { auto.GetFocusedElement() } {
            if process_id(&focused).map(|p| p == pid).unwrap_or(false) {
                return Ok(());
            }
        }
    }
    Err(
        "desktop control: could not bring the target window to the foreground before typing \
         (another window holds focus — input would have gone to the wrong place). Recoverable: \
         retry, or click/activate the window first."
            .into(),
    )
}

/// Send a keystroke spec to `handle` after focusing it. See [`parse_keys`] for
/// the spec syntax. Refuses secure fields (no synthetic typing into passwords).
pub fn send_keys(handle: &str, keys: &str) -> Result<(), String> {
    let _com = ComGuard::new();
    let auto = automation()?;
    let (pid, el) = locate_by_handle(&auto, handle)?;
    if is_secure(&el) {
        return Err("desktop control: refusing to send keystrokes to a secure/password field".into());
    }
    let inputs = parse_keys(keys)?;
    if inputs.is_empty() {
        return Ok(());
    }
    // Focus AND verify the foreground actually moved before dispatching input —
    // otherwise SendInput races and types into the wrong (previous) window.
    ensure_focused(&auto, &el, pid)?;
    // SAFETY: `inputs` is a valid, fully-initialized slice of INPUT for the
    // lifetime of the call; cbsize is the per-record size as the API requires.
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(format!(
            "desktop control: SendInput dispatched only {sent}/{} events (input may be blocked by a higher-integrity window)",
            inputs.len()
        ));
    }
    Ok(())
}

fn vk_for_name(name: &str) -> Option<VIRTUAL_KEY> {
    Some(match name.to_lowercase().as_str() {
        "enter" | "return" => VK_RETURN,
        "tab" => VK_TAB,
        "esc" | "escape" => VK_ESCAPE,
        "backspace" | "back" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "home" => VK_HOME,
        "end" => VK_END,
        "space" => VK_SPACE,
        "pageup" | "pgup" => VK_PRIOR,
        "pagedown" | "pgdn" => VK_NEXT,
        "f1" => VK_F1,
        "f2" => VK_F2,
        "f3" => VK_F3,
        "f4" => VK_F4,
        "f5" => VK_F5,
        "f6" => VK_F6,
        "f7" => VK_F7,
        "f8" => VK_F8,
        "f9" => VK_F9,
        "f10" => VK_F10,
        "f11" => VK_F11,
        "f12" => VK_F12,
        _ => return None,
    })
}

/// Resolve a key name to a virtual key. Falls back to single ASCII
/// alphanumerics (whose VK equals the uppercase ASCII code, e.g. 'A' → VK_A),
/// so chords like `{Ctrl+A}` or `{Alt+F4}` work.
fn resolve_key(name: &str) -> Option<VIRTUAL_KEY> {
    if let Some(vk) = vk_for_name(name) {
        return Some(vk);
    }
    let bytes = name.as_bytes();
    if bytes.len() == 1 {
        let c = bytes[0].to_ascii_uppercase();
        if c.is_ascii_alphanumeric() {
            return Some(VIRTUAL_KEY(c as u16));
        }
    }
    None
}

fn modifier_vk(name: &str) -> Option<VIRTUAL_KEY> {
    Some(match name.to_lowercase().as_str() {
        "ctrl" | "control" => VK_CONTROL,
        "shift" => VK_SHIFT,
        "alt" => VK_MENU,
        "win" | "super" | "meta" => VK_LWIN,
        _ => return None,
    })
}

fn vk_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn unicode_input(unit: u16, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Parse a keystroke spec into a flat `INPUT` sequence.
///
///   * Literal characters are typed as real Unicode keystrokes (so
///     Electron/React fields register them). `{{` / `}}` emit literal braces.
///   * `{Name}` presses a named virtual key (e.g. `{Enter}`, `{Tab}`, `{Esc}`).
///   * `{Mod+Mod+Name}` wraps the key press in modifier hold/release
///     (e.g. `{Ctrl+A}`, `{Ctrl+Enter}`). Modifiers: ctrl, shift, alt, win.
///
/// Example: `"hello Bloom{Enter}"` types the text then presses Enter — the full
/// "type and send" flow for a chat app in one call.
fn parse_keys(spec: &str) -> Result<Vec<INPUT>, String> {
    if spec.len() > MAX_KEYS_LEN {
        return Err(format!("desktop control: key spec too long (max {MAX_KEYS_LEN} chars)"));
    }
    let mut out = Vec::new();
    let mut chars = spec.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            // `{{` → literal '{'.
            if chars.peek() == Some(&'{') {
                chars.next();
                push_char('{', &mut out);
                continue;
            }
            let mut token = String::new();
            let mut closed = false;
            for n in chars.by_ref() {
                if n == '}' {
                    closed = true;
                    break;
                }
                token.push(n);
            }
            if !closed {
                return Err("desktop control: unterminated '{' in key spec".into());
            }
            if token.is_empty() {
                continue;
            }
            let parts: Vec<&str> = token
                .split('+')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            if parts.is_empty() {
                continue;
            }
            let (mods, keyname) = parts.split_at(parts.len() - 1);
            let keyname = keyname[0];
            let mod_vks: Vec<VIRTUAL_KEY> = mods
                .iter()
                .map(|m| modifier_vk(m).ok_or_else(|| format!("desktop control: unknown modifier \"{m}\"")))
                .collect::<Result<_, _>>()?;
            let key_vk = resolve_key(keyname)
                .ok_or_else(|| format!("desktop control: unknown key \"{keyname}\""))?;
            for m in &mod_vks {
                out.push(vk_input(*m, false));
            }
            out.push(vk_input(key_vk, false));
            out.push(vk_input(key_vk, true));
            for m in mod_vks.iter().rev() {
                out.push(vk_input(*m, true));
            }
        } else if c == '}' && chars.peek() == Some(&'}') {
            // `}}` → literal '}'.
            chars.next();
            push_char('}', &mut out);
        } else {
            push_char(c, &mut out);
        }
    }
    Ok(out)
}

/// Append the keydown+keyup Unicode events for a single char (UTF-16, so chars
/// outside the BMP emit their surrogate pair).
fn push_char(c: char, out: &mut Vec<INPUT>) {
    let mut buf = [0u16; 2];
    for unit in c.encode_utf16(&mut buf) {
        out.push(unicode_input(*unit, false));
        out.push(unicode_input(*unit, true));
    }
}

#[cfg(test)]
mod key_tests {
    use super::parse_keys;

    #[test]
    fn literal_text_is_one_downup_pair_per_char() {
        // "ab" → a↓ a↑ b↓ b↑.
        assert_eq!(parse_keys("ab").unwrap().len(), 4);
    }

    #[test]
    fn named_key_is_a_downup_pair() {
        // "{Enter}" → Enter↓ Enter↑.
        assert_eq!(parse_keys("{Enter}").unwrap().len(), 2);
    }

    #[test]
    fn type_then_send_combines_text_and_key() {
        // "hi{Enter}" → 2 chars (4) + Enter (2) = 6.
        assert_eq!(parse_keys("hi{Enter}").unwrap().len(), 6);
    }

    #[test]
    fn chord_wraps_key_in_modifier_hold_release() {
        // "{Ctrl+A}" → Ctrl↓ A↓ A↑ Ctrl↑.
        assert_eq!(parse_keys("{Ctrl+A}").unwrap().len(), 4);
    }

    #[test]
    fn escaped_braces_are_literal() {
        // "{{" → one literal '{' = 2 events; "}}" likewise.
        assert_eq!(parse_keys("{{").unwrap().len(), 2);
        assert_eq!(parse_keys("}}").unwrap().len(), 2);
    }

    #[test]
    fn unknown_key_and_modifier_error() {
        assert!(parse_keys("{Nope}").is_err());
        assert!(parse_keys("{Hyper+A}").is_err());
        assert!(parse_keys("{Enter").is_err()); // unterminated
    }

    #[test]
    fn shell_windows_are_recognized() {
        use super::is_shell_window;
        // explorer.exe's shared-pid artifacts → skipped when picking a window.
        assert!(is_shell_window(""));
        assert!(is_shell_window("taskbar"));
        assert!(is_shell_window("progman"));
        assert!(is_shell_window("program manager"));
        // A real File Explorer window title → kept.
        assert!(!is_shell_window("documents"));
        assert!(!is_shell_window("test_bloom_v2 - notepad"));
    }
}

