//! Feral Agent sidecar — binary discovery and process lifecycle.
//!
//! Feral Agent is the proactive AI agent with a native security sandbox.
//! It speaks newline-delimited JSON over stdin/stdout (the Tauri sidecar
//! protocol it was built for). All stdout JSON lines are forwarded to the
//! React frontend as `feral://agent-output` events; the frontend parses the
//! `type` field and routes to chunk/done/tool/proactive/error handlers.
//!
//! Data files live under `~/.feral/agent/` (DB) and `~/.feral/workspace/`.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::events::FeralAgentOutputEvent;
use crate::paths;

/// A single user answer to a single `ask_user` question.
///
/// Mirrors the TS `AskUserAnswer` shape on the React side so the JSON
/// payload we write to the sidecar's stdin is round-trippable:
/// `{ question, selected[], customText? }`. Used by the
/// `feral_ask_user_response` Tauri command (and the corresponding
/// `build_ask_user_response_line` helper).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AskUserAnswer {
    pub question: String,
    pub selected: Vec<String>,
    #[serde(rename = "customText", skip_serializing_if = "Option::is_none", default)]
    pub custom_text: Option<String>,
}

/// Default cancel reason when the UI doesn't supply one.
const DEFAULT_CANCEL_REASON: &str = "user cancelled";

/// Build the JSON line the sidecar expects for an `ask_user_response`.
///
/// Returns an `Err` when `request_id` is empty/whitespace — the sidecar
/// would silently ignore the message anyway, so failing fast at the
/// Tauri boundary surfaces the bug to the UI instead.
pub fn build_ask_user_response_line(
    request_id: &str,
    answers: &[AskUserAnswer],
) -> Result<String, String> {
    if request_id.trim().is_empty() {
        return Err("ask_user_response: requestId is required".to_string());
    }
    Ok(serde_json::json!({
        "type": "ask_user_response",
        "requestId": request_id,
        "answers": answers,
    })
    .to_string())
}

/// Build the JSON line the sidecar expects for an `ask_user_cancel`.
///
/// `reason` is optional; the helper substitutes `DEFAULT_CANCEL_REASON`
/// when `None` so the sidecar's `AskUserBridge.cancel(id, reason)` is
/// always called with a non-empty reason.
pub fn build_ask_user_cancel_line(
    request_id: &str,
    reason: Option<&str>,
) -> Result<String, String> {
    if request_id.trim().is_empty() {
        return Err("ask_user_cancel: requestId is required".to_string());
    }
    Ok(serde_json::json!({
        "type": "ask_user_cancel",
        "requestId": request_id,
        "reason": reason.unwrap_or(DEFAULT_CANCEL_REASON),
    })
    .to_string())
}

/// Resolve the feral-agent binary, checking the Tauri resource directory
/// (production bundle) and the `src-tauri/binaries/` directory (dev mode).
pub fn find_binary(app: &AppHandle) -> Option<PathBuf> {
    let name = binary_filename();

    // Production: Tauri copies externalBin entries into the resource directory.
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join(&name);
        if p.exists() {
            return Some(p);
        }
    }

    // Development (cargo tauri dev): the binary lives in src-tauri/binaries/.
    // Walk up from the running executable to find a `binaries/<name>` tree.
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.as_path();
        for _ in 0..10 {
            for sub in &["binaries", "src-tauri/binaries"] {
                let candidate = cursor.join(sub).join(&name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
            match cursor.parent() {
                Some(p) => cursor = p,
                None => break,
            }
        }
    }

    None
}

fn binary_filename() -> String {
    if cfg!(target_os = "windows") {
        "feral-agent-x86_64-pc-windows-msvc.exe".to_string()
    } else if cfg!(target_arch = "aarch64") {
        "feral-agent-aarch64-apple-darwin".to_string()
    } else {
        "feral-agent-x86_64-apple-darwin".to_string()
    }
}

/// Spawn the feral-agent sidecar and wire up stdin/stdout communication.
///
/// Populates `tx_slot` with a `Sender<String>`; Tauri commands clone it to
/// write JSON messages to the agent's stdin. Stdout lines are parsed and
/// forwarded to the React frontend as `feral://agent-output` events.
///
/// Returns the child process so the caller can store it in `AppState` and
/// kill it on app exit.
pub async fn spawn(
    app: AppHandle,
    tx_slot: Arc<Mutex<Option<mpsc::Sender<String>>>>,
) -> Result<tokio::process::Child, String> {
    let binary = find_binary(&app).ok_or_else(|| {
        concat!(
            "feral-agent binary not found. ",
            "Run `bun run build` in the feral-agent repo and copy ",
            "dist/feral-agent.exe to ",
            "src-tauri/binaries/feral-agent-x86_64-pc-windows-msvc.exe"
        )
        .to_string()
    })?;

    tracing::info!("feral-agent: binary resolved to {:?}", binary);

    let db_path = paths::feral_agent_db_path();
    let workspace = paths::feral_agent_workspace_path();

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.env("FERAL_DB", &db_path)
        .env("FERAL_WORKSPACE", &workspace)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // Suppress console window flash on Windows.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn feral-agent: {e}"))?;

    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    // Channel: commands → stdin writer task.
    let (tx, rx) = mpsc::channel::<String>(64);
    *tx_slot.lock() = Some(tx);

    tokio::spawn(stdin_writer(stdin, rx));
    tokio::spawn(stdout_reader(app.clone(), stdout));
    tokio::spawn(stderr_logger(app.clone(), stderr));

    tracing::info!("feral-agent: started (pid {:?})", child.id());
    Ok(child)
}

/// Drain the mpsc channel into the child's stdin, one JSON line at a time.
async fn stdin_writer(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::Receiver<String>) {
    while let Some(msg) = rx.recv().await {
        let line = format!("{msg}\n");
        if stdin.write_all(line.as_bytes()).await.is_err() {
            tracing::warn!("feral-agent: stdin write failed — agent may have exited");
            break;
        }
    }
    tracing::debug!("feral-agent: stdin writer exiting");
}

/// Read stdout line-by-line, forward each JSON line as a Tauri event.
async fn stdout_reader(app: AppHandle, stdout: tokio::process::ChildStdout) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        tracing::debug!("feral-agent out: {}", &line);
        let _ = app.emit("feral://agent-output", FeralAgentOutputEvent { data: line });
    }
    tracing::info!("feral-agent: stdout closed");
}

/// Log stderr from the agent; emit `feral://agent-ready` when the ready line appears.
async fn stderr_logger(app: AppHandle, stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        tracing::info!("[feral-agent] {}", &line);
        // The agent writes "[feral] ready — ..." to stderr on startup.
        if line.contains("ready") {
            let _ = app.emit("feral://agent-ready", serde_json::json!({}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_filename_has_expected_extension_on_windows() {
        let name = binary_filename();
        #[cfg(target_os = "windows")]
        assert!(name.ends_with(".exe"), "Windows binary must end with .exe");
        #[cfg(not(target_os = "windows"))]
        assert!(!name.ends_with(".exe"), "non-Windows binary must not end with .exe");
    }

    #[test]
    fn binary_filename_contains_target_triple() {
        let name = binary_filename();
        assert!(name.contains('-'), "binary name must contain a target triple");
        assert!(name.starts_with("feral-agent-"));
    }

    // --- ask_user message builders (regression test for missing Tauri command) ---

    #[test]
    fn build_ask_user_response_line_emits_correct_json() {
        let answers = vec![
            AskUserAnswer {
                question: "Pick a database".to_string(),
                selected: vec!["Postgres".to_string()],
                custom_text: None,
            },
        ];
        let line = build_ask_user_response_line("req-1", &answers).expect("ok");
        // Parse back to assert on shape (string match is too brittle).
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_response");
        assert_eq!(v["requestId"], "req-1");
        assert_eq!(v["answers"][0]["question"], "Pick a database");
        assert_eq!(v["answers"][0]["selected"][0], "Postgres");
        // customText is omitted when None (skip_serializing_if), not serialized as null.
        assert!(v["answers"][0].get("customText").is_none(), "customText must be omitted when None");
    }

    #[test]
    fn build_ask_user_response_line_rejects_empty_request_id() {
        let line = build_ask_user_response_line("", &[]);
        assert!(line.is_err(), "empty requestId must be rejected");
        let err = line.unwrap_err();
        assert!(err.contains("requestId") || err.contains("request_id"), "error should mention requestId: {err}");
    }

    #[test]
    fn build_ask_user_response_line_rejects_whitespace_request_id() {
        let line = build_ask_user_response_line("   ", &[]);
        assert!(line.is_err(), "whitespace-only requestId must be rejected");
    }

    #[test]
    fn build_ask_user_cancel_line_emits_correct_json_with_explicit_reason() {
        let line = build_ask_user_cancel_line("req-2", Some("user clicked Skip"))
            .expect("ok");
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_cancel");
        assert_eq!(v["requestId"], "req-2");
        assert_eq!(v["reason"], "user clicked Skip");
    }

    #[test]
    fn build_ask_user_cancel_line_uses_default_reason_when_none_provided() {
        let line = build_ask_user_cancel_line("req-3", None).expect("ok");
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_cancel");
        assert_eq!(v["requestId"], "req-3");
        assert!(v["reason"].is_string(), "reason must be a string");
        assert!(!v["reason"].as_str().unwrap().is_empty(), "default reason must not be empty");
    }

    #[test]
    fn build_ask_user_cancel_line_rejects_empty_request_id() {
        let line = build_ask_user_cancel_line("", None);
        assert!(line.is_err(), "empty requestId must be rejected");
    }

    #[test]
    fn ask_user_response_and_cancel_messages_are_distinct() {
        // Regression guard: the bug was that "ask_user_response" was the
        // only supported inbound type — adding "ask_user_cancel" must not
        // accidentally fall through to the same code path.
        let r = build_ask_user_response_line("req", &[]).unwrap();
        let c = build_ask_user_cancel_line("req", None).unwrap();
        assert_ne!(r, c, "response and cancel must produce distinct JSON");
        assert!(r.contains("\"type\":\"ask_user_response\""));
        assert!(c.contains("\"type\":\"ask_user_cancel\""));
    }
}
