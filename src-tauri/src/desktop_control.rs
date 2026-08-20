//! Desktop control — structural OS-level control of native GUI apps via the
//! platform accessibility tree.
//!
//! This is **structural** automation: it reads the UI Automation (Windows) /
//! Accessibility (macOS) element tree and drives elements through their
//! accessibility patterns (Invoke / SetValue / Toggle / Expand). It never
//! takes screenshots, never runs OCR, and never synthesizes blind global
//! mouse/keyboard input — every action targets a specific, named element the
//! agent has already discovered. That makes the agent's actions auditable and
//! far less likely to "click the wrong thing" than pixel automation.
//!
//! ## Security model (the whole point of this module)
//!
//! An agent that can click any button and type into any field of any app is a
//! large amount of power. The guard rails here are deliberately conservative —
//! see [`security`]:
//!
//!   * **Opt-in.** The agent-facing `control_app` tool is only registered when
//!     `FERAL_ENABLE_DESKTOP_CONTROL=true` (mirrors `shell_exec`). The Tauri
//!     commands themselves additionally refuse to run unless the same flag is
//!     set, so the React UI can't reach them by accident either.
//!   * **Hard denylist.** Security-sensitive targets can NEVER be driven,
//!     regardless of any allowlist: Cinderpaw itself (no self-manipulation /
//!     confused-deputy), the Windows UAC/consent + credential UIs, the OS
//!     keychain, and well-known password managers. Reads and writes against
//!     these are blocked.
//!   * **Optional allowlist.** When `FERAL_DESKTOP_CONTROL_ALLOWED_APPS` is
//!     set (comma-separated process names), ONLY those apps may be driven.
//!     Unset → every app except the denylist.
//!   * **Secure-field redaction.** Password / secure-text fields are never
//!     read back to the model, and their typed values are logged as
//!     `[REDACTED]`. Writing into them is still allowed (a user may legitimately
//!     want the agent to fill a password) but the secret never lands in a log
//!     or a tool result.
//!
//! Confirmation-before-write is enforced one layer up, in the sidecar's
//! `control_app` tool, which routes state-changing actions through the
//! `ask_user` bridge so the human approves them (unless explicitly disabled).
//!
//! ## Element handles
//!
//! Handles are **re-locatable**, not live pointers: an element id is
//! `"{pid}:{r0.r1.r2…}"` where the tail is the platform RuntimeId. COM objects
//! are apartment-threaded and not `Send`, so we never stash live
//! `IUIAutomationElement` pointers in a shared map. Instead every command does
//! its work on a dedicated blocking thread that initializes COM, re-locates the
//! element by RuntimeId from the owning window, acts, and tears COM down. If
//! the element (or its window) is gone, re-location fails and we return a
//! *recoverable* `element_not_found` error.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Wire types (shared across platforms; serialized to the sidecar / React)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WindowInfo {
    pub pid: u32,
    pub title: String,
    pub app_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BoundingRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AccessibilityNode {
    pub id: String,
    pub role: String,
    pub name: String,
    pub value: String,
    pub automation_id: String,
    pub bounding_rect: BoundingRect,
    pub children: Vec<AccessibilityNode>,
    pub actions: Vec<String>,
    pub is_enabled: bool,
    pub is_offscreen: bool,
}

/// Flat element returned by find/get_focused — same fields as a node but with
/// no children (callers fetch a subtree separately if they need one).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AccessibilityElement {
    pub id: String,
    pub role: String,
    pub name: String,
    pub value: String,
    pub automation_id: String,
    pub bounding_rect: BoundingRect,
    pub actions: Vec<String>,
    pub is_enabled: bool,
    pub is_offscreen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LaunchResult {
    pub launched: bool,
    /// Pid of the spawned process. For launcher stubs / UWP apps this is the
    /// stub's pid (which exits immediately) — the real window may belong to a
    /// different pid, so callers should re-run `list_windows` to locate it.
    pub pid: Option<u32>,
    pub note: String,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
pub struct ElementQuery {
    pub role: Option<String>,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub value_contains: Option<String>,
}

/// Maximum tree depth we will ever walk, regardless of caller input. Deep
/// accessibility trees (e.g. a browser DOM or an Electron app like VS Code /
/// Discord) bury their real content well past the old depth-8 ceiling, so the
/// agent kept seeing only empty `Pane` wrappers. We allow a much deeper walk
/// now; the payload is bounded instead by [`MAX_TREE_NODES`], so a deep-but-not
/// infinitely-wide tree is fully visible while a giant web DOM is still capped.
pub const MAX_DEPTH: u8 = 30;

/// Hard cap on the total number of nodes serialized into a single `get_tree`
/// response. Bounds payload size independently of depth: a deep, narrow tree is
/// returned in full; a sprawling one is truncated once this many nodes are
/// emitted. (Children are added breadth-first within each parent, so the cap
/// degrades gracefully rather than chopping one branch.)
pub const MAX_TREE_NODES: usize = 4000;

/// Clamp a caller-supplied depth into `1..=MAX_DEPTH`.
pub fn clamp_depth(requested: u8) -> u8 {
    requested.clamp(1, MAX_DEPTH)
}

/// Sentinel value substituted for any secure-field text in logs and results.
pub const REDACTED: &str = "[REDACTED]";

// ---------------------------------------------------------------------------
// Security gating (platform-independent)
// ---------------------------------------------------------------------------

pub mod security {
    //! App allow/deny decisions. Pure string logic so it is unit-testable
    //! without a live accessibility tree.

    /// Process-name fragments that may NEVER be driven, allowlist or not.
    /// Matched case-insensitively as substrings of the process image name so
    /// `consent.exe`, `Consent`, etc. all match. Keep this list conservative
    /// and additive — when in doubt, block.
    pub const HARD_DENY: &[&str] = &[
        // Cinderpaw itself — no confused-deputy / self-manipulation.
        "feral",
        // Windows UAC / consent / credential surfaces.
        "consent",
        "credentialuibroker",
        "lsass",
        "winlogon",
        "logonui",
        // Shells / terminals / script hosts. Driving (or launching then
        // driving) one of these turns "type into a field" into arbitrary
        // command execution — the exact harm desktop control must not enable.
        // Bare stems so both "cmd" and "cmd.exe" (name or launch arg) match.
        "cmd",
        "powershell",
        "pwsh",
        "conhost",
        "windowsterminal",
        "wscript",
        "cscript",
        "mshta",
        // OS secret stores.
        "keychain",
        "securityagent",
        // Well-known password managers.
        "1password",
        "bitwarden",
        "keepass",
        "dashlane",
        "lastpass",
        "nordpass",
        "enpass",
        "keeper",
        "protonpass",
    ];

    /// Env var holding the optional comma-separated allowlist of process names.
    pub const ALLOWLIST_ENV: &str = "FERAL_DESKTOP_CONTROL_ALLOWED_APPS";

    /// Env flag that must be exactly "true" to enable desktop control at all.
    pub const ENABLE_ENV: &str = "FERAL_ENABLE_DESKTOP_CONTROL";

    /// True when desktop control is enabled for this process.
    pub fn is_enabled() -> bool {
        std::env::var(ENABLE_ENV).map(|v| v == "true").unwrap_or(false)
    }

    fn norm(s: &str) -> String {
        s.to_lowercase()
    }

    /// Decide whether `app_name` (a process image name like `notepad.exe`) may
    /// be driven. `allowlist` is the parsed `ALLOWLIST_ENV` value (empty =
    /// no allowlist configured = allow everything-except-deny).
    ///
    /// Returns `Ok(())` when allowed, or `Err(reason)` when blocked. The reason
    /// is safe to surface to the model (it names a policy, not a secret).
    pub fn check_app(app_name: &str, allowlist: &[String]) -> Result<(), String> {
        let n = norm(app_name);
        if n.is_empty() {
            return Err("desktop control: refusing to act on a window with no resolvable app name".into());
        }
        for deny in HARD_DENY {
            if n.contains(deny) {
                return Err(format!(
                    "desktop control: \"{app_name}\" is on the security denylist (matched \"{deny}\") and can never be controlled"
                ));
            }
        }
        if !allowlist.is_empty() {
            let permitted = allowlist.iter().any(|a| {
                let a = norm(a);
                // Exact match only. `n.contains(&a)` meant allowlisting
                // "notepad" silently also allowed "notepad-evil.exe" and
                // "xxnotepad.exe" — an allowlist that grows entries the user
                // never wrote. (The denylist above stays substring-based: there
                // the loose match errs toward refusing, which is the safe way
                // to be wrong.)
                !a.is_empty() && n == a
            });
            if !permitted {
                return Err(format!(
                    "desktop control: \"{app_name}\" is not in {ALLOWLIST_ENV}; add it to the allowlist to control it"
                ));
            }
        }
        Ok(())
    }

    /// Read + parse the allowlist env var into a clean Vec.
    pub fn allowlist_from_env() -> Vec<String> {
        std::env::var(ALLOWLIST_ENV)
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    /// Convenience: gate by pid's resolved process name in one call.
    pub fn check_pid(pid: u32) -> Result<(), String> {
        if !is_enabled() {
            return Err(format!(
                "desktop control is disabled. Set {ENABLE_ENV}=true to enable it."
            ));
        }
        let app = super::process_name(pid)
            .ok_or_else(|| format!("desktop control: no process found for pid {pid}"))?;
        check_app(&app, &allowlist_from_env())
    }
}

/// Resolve a pid to its process image name (e.g. `notepad.exe`). Cross-platform
/// via `sysinfo`. Returns `None` when the process is gone.
pub fn process_name(pid: u32) -> Option<String> {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new()),
    );
    sys.process(Pid::from_u32(pid))
        .map(|p| p.name().to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Element id encoding (re-locatable handle: "pid:r0.r1.r2")
// ---------------------------------------------------------------------------

/// Encode a pid + RuntimeId into a stable, opaque-ish handle string.
pub fn encode_handle(pid: u32, runtime_id: &[i32]) -> String {
    let tail = runtime_id
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(".");
    format!("{pid}:{tail}")
}

/// Decode a handle string back into (pid, RuntimeId). Returns a recoverable
/// error string on malformed input.
pub fn decode_handle(handle: &str) -> Result<(u32, Vec<i32>), String> {
    let (pid_s, rid_s) = handle
        .split_once(':')
        .ok_or_else(|| format!("malformed element id \"{handle}\" (expected \"pid:runtimeId\")"))?;
    let pid: u32 = pid_s
        .parse()
        .map_err(|_| format!("malformed element id \"{handle}\": bad pid"))?;
    let rid = rid_s
        .split('.')
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<i32>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| format!("malformed element id \"{handle}\": bad runtimeId"))?;
    if rid.is_empty() {
        return Err(format!("malformed element id \"{handle}\": empty runtimeId"));
    }
    Ok((pid, rid))
}

// ---------------------------------------------------------------------------
// Tauri commands — thin async wrappers that gate + dispatch to the platform
// implementation on a blocking thread.
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    if !security::is_enabled() {
        return Err(format!(
            "desktop control is disabled. Set {}=true to enable it.",
            security::ENABLE_ENV
        ));
    }
    run_blocking(imp::list_windows).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_accessibility_tree(
    pid: u32,
    depth: u8,
    window_title: Option<String>,
) -> Result<AccessibilityNode, String> {
    security::check_pid(pid)?;
    let d = clamp_depth(depth);
    run_blocking(move || imp::get_accessibility_tree(pid, d, window_title.as_deref())).await
}

#[tauri::command]
#[specta::specta]
pub async fn find_elements(
    pid: u32,
    query: ElementQuery,
    window_title: Option<String>,
) -> Result<Vec<AccessibilityElement>, String> {
    security::check_pid(pid)?;
    run_blocking(move || imp::find_elements(pid, &query, window_title.as_deref())).await
}

#[tauri::command]
#[specta::specta]
pub async fn click_element(element_id: String) -> Result<(), String> {
    gate_handle(&element_id)?;
    run_blocking(move || imp::click_element(&element_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn type_into_element(element_id: String, text: String) -> Result<(), String> {
    gate_handle(&element_id)?;
    run_blocking(move || imp::type_into_element(&element_id, &text)).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_element_value(element_id: String) -> Result<String, String> {
    gate_handle(&element_id)?;
    run_blocking(move || imp::get_element_value(&element_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_focused_element() -> Result<AccessibilityElement, String> {
    if !security::is_enabled() {
        return Err(format!(
            "desktop control is disabled. Set {}=true to enable it.",
            security::ENABLE_ENV
        ));
    }
    let el = run_blocking(imp::get_focused_element).await?;
    // The focused window could belong to a denylisted app — gate by its pid.
    security::check_pid(decode_handle(&el.id)?.0)?;
    Ok(el)
}

#[tauri::command]
#[specta::specta]
pub async fn take_element_action(element_id: String, action: String) -> Result<(), String> {
    gate_handle(&element_id)?;
    run_blocking(move || imp::take_element_action(&element_id, &action)).await
}

/// Synthesize real keystrokes into a focused element. Unlike `type_into_element`
/// (ValuePattern.SetValue), this dispatches OS-level key events, so it works in
/// Electron/Chromium apps and can press named keys like Enter to submit.
#[tauri::command]
#[specta::specta]
pub async fn send_keys(element_id: String, keys: String) -> Result<(), String> {
    gate_handle(&element_id)?;
    run_blocking(move || imp::send_keys(&element_id, &keys)).await
}

/// Launch a desktop application by executable name or absolute path.
///
/// Security: this is process creation, so it is tightly constrained —
///   * desktop control must be enabled (`FERAL_ENABLE_DESKTOP_CONTROL`);
///   * `app` is treated as a SINGLE program token — never a shell command line.
///     Shell metacharacters are rejected and no arguments are forwarded, so
///     there is no command chaining / injection (unlike a real shell);
///   * the resolved app name is run through the same allow/deny policy as
///     control, so password managers, credential UIs, and — importantly —
///     shells/terminals can neither be controlled NOR launched;
///   * the `control_app` tool additionally requires explicit user confirmation
///     before every launch.
///
/// The launched process is detached (it keeps running after this returns).
#[tauri::command]
#[specta::specta]
pub async fn launch_app(app: String) -> Result<LaunchResult, String> {
    if !security::is_enabled() {
        return Err(format!(
            "desktop control is disabled. Set {}=true to enable it.",
            security::ENABLE_ENV
        ));
    }
    let app = app.trim().to_string();
    if app.is_empty() {
        return Err("desktop control: launch requires a non-empty app name".into());
    }
    // No shell: reject anything that looks like a command line rather than a
    // single program token. This is what keeps `launch` from degenerating into
    // arbitrary shell execution.
    if app.contains(['&', '|', ';', '\n', '\r', '`', '>', '<', '%', '"', '\'']) {
        return Err(
            "desktop control: app name contains illegal characters (give a plain executable name or path, no arguments or shell syntax)"
                .into(),
        );
    }
    // Apply the same allow/deny policy as control, keyed on the basename.
    security::check_app(&app_basename(&app), &security::allowlist_from_env())?;

    run_blocking(move || spawn_detached(&app)).await
}

/// Lowercased final path component of an executable name/path, used for the
/// allow/deny check. `C:\\Windows\\System32\\notepad.exe` → `notepad.exe`.
fn app_basename(app: &str) -> String {
    app.rsplit(['\\', '/'])
        .next()
        .unwrap_or(app)
        .to_lowercase()
}

/// Chromium/Electron executable stems that hide their real UI (web content /
/// renderer) behind an accessibility tree that is OFF until a client asks for
/// it — which is why the agent kept seeing only empty `Pane` wrappers for
/// Discord, VS Code and browser pages. Launching them with
/// `--force-renderer-accessibility` makes the renderer expose its full tree, so
/// `get_tree`/`find_elements` can actually see and drive web/Electron content.
/// Only effective for apps we launch FRESH — an already-running instance just
/// gets focused and ignores the flag.
const CHROMIUM_STEMS: &[&str] = &[
    "chrome", "msedge", "edge", "brave", "vivaldi", "opera", "chromium", "discord", "slack", "code",
];

/// True when `basename` (lowercased, e.g. "msedge.exe") is a known Chromium/
/// Electron app whose renderer accessibility we should force on at launch.
fn is_chromium_app(basename: &str) -> bool {
    let stem = basename.strip_suffix(".exe").unwrap_or(basename);
    CHROMIUM_STEMS.contains(&stem)
}

/// Spawn a GUI app detached from Cinderpaw. Cross-platform: `open -a` on macOS,
/// direct exec elsewhere (PATH-resolved). No shell, no agent-supplied arguments
/// — the only flag ever added is the constant `--force-renderer-accessibility`
/// for known Chromium/Electron apps (see [`is_chromium_app`]), which carries no
/// injection risk because it is a fixed string, never caller input.
fn spawn_detached(app: &str) -> Result<LaunchResult, String> {
    use std::process::Command;

    let chromium = is_chromium_app(&app_basename(app));

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg("-a").arg(app);
        // `open --args` forwards the rest to the app itself.
        if chromium {
            c.arg("--args").arg("--force-renderer-accessibility");
        }
        c
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = {
        let mut c = Command::new(app);
        if chromium {
            c.arg("--force-renderer-accessibility");
        }
        c
    };

    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            // Drop the handle without waiting — the app stays alive (std's
            // Child does not kill on drop), so it is fully detached.
            drop(child);
            Ok(LaunchResult {
                launched: true,
                pid: Some(pid),
                note: "Launched. If you need to control it, call list_windows to find the app's window pid (it may differ from the launcher pid).".into(),
            })
        }
        Err(e) => Err(format!("desktop control: failed to launch \"{app}\": {e}")),
    }
}

/// Gate a handle-bearing command: enable flag + decode + per-app policy.
fn gate_handle(handle: &str) -> Result<(), String> {
    let (pid, _) = decode_handle(handle)?;
    security::check_pid(pid)
}

/// Run blocking COM work off the async runtime. Each closure is fully
/// self-contained w.r.t. COM (init + uninit inside the platform impl).
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("desktop control task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Sidecar bridge dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `desktop_control_request` coming from the Cinderpaw Agent sidecar.
/// `action` + `params` mirror the `control_app` tool's input. Returns a JSON
/// value on success or an error string. This is the single entry point the
/// `cinderpaw_agent` stdout reader calls, so all gating lives in the command
/// wrappers above which this re-uses.
pub async fn handle_request(
    action: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::json;
    let pid = || -> Result<u32, String> {
        params
            .get("pid")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .ok_or_else(|| format!("desktop control: action \"{action}\" requires a numeric \"pid\""))
    };
    let element_id = || -> Result<String, String> {
        params
            .get("element_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("desktop control: action \"{action}\" requires \"element_id\""))
    };

    match action {
        "list_windows" => Ok(json!(list_windows().await?)),
        "get_tree" => {
            let depth = params.get("depth").and_then(|v| v.as_u64()).unwrap_or(4) as u8;
            let window_title = params
                .get("window_title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Ok(json!(get_accessibility_tree(pid()?, depth, window_title).await?))
        }
        "find_elements" => {
            let query: ElementQuery = params
                .get("query")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("desktop control: bad query: {e}"))?
                .unwrap_or_default();
            let window_title = params
                .get("window_title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Ok(json!(find_elements(pid()?, query, window_title).await?))
        }
        "click" => {
            click_element(element_id()?).await?;
            Ok(json!({ "ok": true }))
        }
        "type" => {
            let text = params
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "desktop control: \"type\" requires \"text\"".to_string())?;
            type_into_element(element_id()?, text.to_string()).await?;
            Ok(json!({ "ok": true }))
        }
        "get_value" => Ok(json!({ "value": get_element_value(element_id()?).await? })),
        "get_focused" => Ok(json!(get_focused_element().await?)),
        "launch" => {
            let app = params
                .get("app")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "desktop control: \"launch\" requires \"app\"".to_string())?;
            Ok(json!(launch_app(app.to_string()).await?))
        }
        "perform_action" => {
            let name = params
                .get("action_name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "desktop control: \"perform_action\" requires \"action_name\"".to_string())?;
            take_element_action(element_id()?, name.to_string()).await?;
            Ok(json!({ "ok": true }))
        }
        "send_keys" => {
            let keys = params
                .get("keys")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "desktop control: \"send_keys\" requires \"keys\"".to_string())?;
            send_keys(element_id()?, keys.to_string()).await?;
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("desktop control: unknown action \"{other}\"")),
    }
}

// ---------------------------------------------------------------------------
// Platform implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[path = "desktop_control_windows.rs"]
mod imp;

#[cfg(not(target_os = "windows"))]
mod imp {
    //! Non-Windows fallback. macOS AX support is planned; until then every
    //! entry point returns a clear, recoverable error. On Linux it is simply
    //! unsupported. Everything still compiles so the Tauri command surface and
    //! the sidecar bridge exist on every platform.
    use super::*;

    #[cfg(target_os = "macos")]
    const MSG: &str = "Desktop control on macOS (Accessibility API) is not implemented yet — Windows (UIA) only for now.";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    const MSG: &str = "Desktop control is not yet supported on Linux — UIA (Windows) and AX (macOS) only.";

    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        Err(MSG.into())
    }
    pub fn get_accessibility_tree(_pid: u32, _depth: u8, _window_title: Option<&str>) -> Result<AccessibilityNode, String> {
        Err(MSG.into())
    }
    pub fn find_elements(_pid: u32, _q: &ElementQuery, _window_title: Option<&str>) -> Result<Vec<AccessibilityElement>, String> {
        Err(MSG.into())
    }
    pub fn click_element(_id: &str) -> Result<(), String> {
        Err(MSG.into())
    }
    pub fn type_into_element(_id: &str, _text: &str) -> Result<(), String> {
        Err(MSG.into())
    }
    pub fn get_element_value(_id: &str) -> Result<String, String> {
        Err(MSG.into())
    }
    pub fn get_focused_element() -> Result<AccessibilityElement, String> {
        Err(MSG.into())
    }
    pub fn take_element_action(_id: &str, _action: &str) -> Result<(), String> {
        Err(MSG.into())
    }
    pub fn send_keys(_id: &str, _keys: &str) -> Result<(), String> {
        Err(MSG.into())
    }
}

// ---------------------------------------------------------------------------
// Tests (platform-independent: encoding + security policy)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_roundtrips() {
        let h = encode_handle(4242, &[42, -7, 3]);
        assert_eq!(h, "4242:42.-7.3");
        let (pid, rid) = decode_handle(&h).unwrap();
        assert_eq!(pid, 4242);
        assert_eq!(rid, vec![42, -7, 3]);
    }

    #[test]
    fn decode_rejects_malformed() {
        assert!(decode_handle("nope").is_err());
        assert!(decode_handle("12:").is_err());
        assert!(decode_handle("abc:1.2").is_err());
        assert!(decode_handle("12:1.x").is_err());
    }

    #[test]
    fn depth_is_clamped() {
        assert_eq!(clamp_depth(0), 1);
        assert_eq!(clamp_depth(4), 4);
        assert_eq!(clamp_depth(200), MAX_DEPTH);
    }

    #[test]
    fn denylist_blocks_sensitive_apps_even_with_allowlist() {
        // An attacker-set allowlist must not be able to re-enable a denied app.
        let allow = vec!["1password.exe".to_string(), "feral.exe".to_string()];
        assert!(security::check_app("1Password.exe", &allow).is_err());
        assert!(security::check_app("feral.exe", &allow).is_err());
        assert!(security::check_app("consent.exe", &[]).is_err());
        assert!(security::check_app("BitWarden.exe", &[]).is_err());
    }

    #[test]
    fn allowlist_restricts_to_listed_apps() {
        let allow = vec!["notepad.exe".to_string()];
        assert!(security::check_app("notepad.exe", &allow).is_ok());
        assert!(security::check_app("calc.exe", &allow).is_err());
    }

    #[test]
    fn empty_allowlist_allows_non_denied_apps() {
        assert!(security::check_app("notepad.exe", &[]).is_ok());
        assert!(security::check_app("calc.exe", &[]).is_ok());
    }

    #[test]
    fn empty_app_name_is_refused() {
        assert!(security::check_app("", &[]).is_err());
    }

    #[test]
    fn shells_and_terminals_are_denied() {
        // Both control AND launch run through check_app, so this covers both:
        // an agent can neither drive nor open a shell/terminal.
        for app in [
            "cmd.exe",
            "cmd",
            "powershell.exe",
            "pwsh.exe",
            "conhost.exe",
            "WindowsTerminal.exe",
            "wscript.exe",
            "mshta.exe",
        ] {
            assert!(
                security::check_app(app, &[]).is_err(),
                "{app} must be denied"
            );
        }
        // A normal app the agent SHOULD be able to launch/control.
        assert!(security::check_app("notepad.exe", &[]).is_ok());
        assert!(security::check_app("calc.exe", &[]).is_ok());
    }

    #[test]
    fn app_basename_extracts_final_component() {
        assert_eq!(app_basename("C:\\Windows\\System32\\notepad.exe"), "notepad.exe");
        assert_eq!(app_basename("/usr/bin/gedit"), "gedit");
        assert_eq!(app_basename("calc.exe"), "calc.exe");
    }

    #[test]
    fn chromium_apps_get_renderer_accessibility() {
        // Known Chromium/Electron apps (with or without .exe) → flagged.
        for app in ["msedge.exe", "chrome", "discord.exe", "code", "Brave.exe"] {
            assert!(is_chromium_app(&app.to_lowercase()), "{app} should be chromium");
        }
        // Plain native apps → not flagged (no stray flag appended).
        for app in ["notepad.exe", "calc.exe", "gedit"] {
            assert!(!is_chromium_app(&app.to_lowercase()), "{app} should not be chromium");
        }
    }

    // Regression: the old ceiling of 8 hid Electron/DOM content. Keep it
    // comfortably deep so VS Code / Discord structure is reachable. MAX_DEPTH
    // is a constant, so this is worth more as a compile-time assertion than a
    // test one: lowering it fails the build rather than one test run.
    const _: () = assert!(MAX_DEPTH >= 20);

    #[test]
    fn depth_ceiling_allows_deep_electron_trees() {
        assert_eq!(clamp_depth(25), 25);
        assert_eq!(clamp_depth(255), MAX_DEPTH);
    }
}
