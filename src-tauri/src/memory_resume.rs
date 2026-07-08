/**
 * Memory Resume — Tauri command (Sprint 1.6).
 *
 * Returns the persisted `current_task` + active workspace + last-active
 * timestamp so the React `WelcomeBack` banner and the TUI last-task row can
 * greet the user with "Welcome back to X." on app launch.
 *
 * Architecture (Sprint 1.9 writer contract, see
 * `docs/agents-memory/project_memory_roadmap.md`):
 *
 *   React shell / TUI ─► Tauri command (this file) ─► sidecar stdin
 *     (`InboundMessage` `resume_get`, id-correlated) ─►
 *     `FeralAgent/src/memory/resume.ts` reads `meta` + `workspaces` tables
 *     ─► reply on stdout as `OutboundEvent` `resume_get_result`.
 *
 * Why this shape? The sidecar holds the sole writer lock on the SQLite
 * database. Tauri must NEVER open the same file for writes (would race the
 * sidecar's writer-lock discipline); routing the read through the sidecar
 * preserves the writer contract. On first-ever launch the sidecar returns
 * an empty payload — the React shell mounts the banner with "fresh start"
 * copy and the TUI omits the row.
 *
 * The subscribe-before-send discipline is the same one
 * `crates/feral-core/src/api.rs::meta_roundtrip` uses for the meta routes —
 * duplicate, not extract, because extracting would need a feral-core
 * method that takes a closure for the JSON reply shape, and the
 * duplication is small enough to keep the Sprint 1 surface tight.
 */

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::broadcast;

#[derive(Serialize, Deserialize, specta::Type, Debug, Clone)]
pub struct LastTaskView {
    /// The persisted current-task payload, if any. Null on first launch.
    pub task: Option<TaskView>,
    /// The active workspace id (UUID), if any.
    pub workspace_id: Option<String>,
    /// Workspace display name, looked up alongside the id for the banner copy.
    pub workspace_name: Option<String>,
    /// Wall-clock of the last user activity across any workspace.
    pub last_active_at: Option<u64>,
}

#[derive(Serialize, Deserialize, specta::Type, Debug, Clone)]
pub struct TaskView {
    pub title: String,
    pub ts: u64,
    pub workspace_id: Option<String>,
}

const TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

#[tauri::command]
#[specta::specta]
pub async fn get_last_task(
    state: tauri::State<'_, crate::AppState>,
) -> Result<LastTaskView, String> {
    // 1. Subscribe BEFORE we send — same discipline as meta_roundtrip.
    let mut rx = state.runtime.events_tx.subscribe();

    // 2. Clone the mpsc sender without holding the lock during the await.
    let tx = {
        let guard = state.feral_agent_tx.lock();
        match guard.as_ref() {
            Some(s) => s.clone(),
            None => return Ok(empty()),
        }
    };

    let msg_id = uuid::Uuid::new_v4().to_string();
    let msg = json!({ "type": "resume_get", "id": msg_id }).to_string();
    if tx.send(msg).await.is_err() {
        // Sidecar died between the lock check and the send. Empty payload is
        // the safe default — the React shell mounts "fresh start" copy and
        // the TUI omits the row.
        return Ok(empty());
    }

    // 3. Wait for the sidecar to emit a `resume_get_result` event with our id.
    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(empty());
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) => {
                if ev.event != "feral://agent-output" {
                    continue;
                }
                let Some(line) = ev.payload.get("data").and_then(|s| s.as_str()) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                let same_id = v.get("id").and_then(|i| i.as_str()) == Some(msg_id.as_str());
                let is_result = v.get("type").and_then(|t| t.as_str()) == Some("resume_get_result");
                if same_id && is_result {
                    return Ok(serde_json::from_value(v).unwrap_or_else(|_| empty()));
                }
            }
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(broadcast::error::RecvError::Closed)) => return Ok(empty()),
            Err(_) => return Ok(empty()),
        }
    }
}

fn empty() -> LastTaskView {
    LastTaskView {
        task: None,
        workspace_id: None,
        workspace_name: None,
        last_active_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_task_view_serializes_with_optional_fields() {
        let v = LastTaskView {
            task: Some(TaskView {
                title: "refactor".into(),
                ts: 1700000000000,
                workspace_id: Some("ws-1".into()),
            }),
            workspace_id: Some("ws-1".into()),
            workspace_name: Some("Feral repo".into()),
            last_active_at: Some(1700000000000),
        };
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains("\"title\":\"refactor\""));
        assert!(json.contains("\"workspace_name\":\"Feral repo\""));
    }

    #[test]
    fn last_task_view_empty_payload_serializes() {
        let json = serde_json::to_string(&empty()).unwrap();
        assert_eq!(
            json,
            "{\"task\":null,\"workspace_id\":null,\"workspace_name\":null,\"last_active_at\":null}"
        );
    }

    #[test]
    fn empty_is_a_valid_default_for_first_launch() {
        // The React shell + TUI treat empty == "first launch" — they render
        // "fresh start" copy and never crash on null fields.
        let v = empty();
        assert!(v.task.is_none());
        assert!(v.workspace_id.is_none());
        assert!(v.workspace_name.is_none());
        assert!(v.last_active_at.is_none());
    }
}