/**
 * Memory Resume (Sprint 1.5) — current-task persistence.
 *
 * The agent and the TUI write here so the next session can greet the user
 * with "Welcome back to {last task}." Updated every time the user's active
 * work shifts (auto-tracked) or explicitly via a `set_current_task` tool
 * (Sprint 1.5 follow-up). Stored in the `meta` table (see `db.ts`);
 * reserved key `current_task`.
 *
 * Distinct from `rsi_meta` (RSI-internal).
 *
 * Sprint 1.6 — the Tauri command `get_last_task` reads the same row from
 * the SQLite file directly, so the WelcomeBack banner can show
 * `{title, last_active_at, workspace_id}` without round-tripping through
 * the sidecar. The schema is the wire contract between the two runtimes.
 */

import type { Database } from "bun:sqlite";

export interface CurrentTask {
  /** Short human-readable label — shown in the WelcomeBack banner. */
  title: string;
  /** Wall-clock when the task was set; controls banner staleness UX. */
  ts: number;
  /**
   * Workspace the task is in; null = global. Tauri command echoes this
   * field back to the React shell so the banner can show
   * "Working in <workspace name>" alongside the title.
   */
  workspaceId?: string | null;
}

const CURRENT_TASK_KEY = "current_task";

function isCurrentTask(value: unknown): value is CurrentTask {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CurrentTask>;
  if (typeof v.title !== "string" || v.title.length === 0) return false;
  if (typeof v.ts !== "number" || !Number.isFinite(v.ts)) return false;
  if (v.workspaceId !== undefined && v.workspaceId !== null && typeof v.workspaceId !== "string") {
    return false;
  }
  return true;
}

/** Read the persisted current task, or null if none / corrupt. */
export function getCurrentTask(db: Database): CurrentTask | null {
  const row = db
    .query("SELECT value FROM meta WHERE key = ?")
    .get(CURRENT_TASK_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return isCurrentTask(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist the current task. Passing `null` clears it.
 *
 * `INSERT OR REPLACE` because `meta.key` is the primary key — the row is
 * idempotent across writes; no upsert dance required.
 */
export function setCurrentTask(db: Database, task: CurrentTask | null): void {
  if (task === null) {
    db.prepare("DELETE FROM meta WHERE key = ?").run(CURRENT_TASK_KEY);
    return;
  }
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, ?)",
  ).run(CURRENT_TASK_KEY, JSON.stringify(task), Date.now());
}

/**
 * Wall-clock of the last user activity across any workspace. Updated by the
 * agent loop on every turn (cheap — one row in `meta`). The WelcomeBack
 * banner uses this to suppress itself on first-launch and to render the
 * "yesterday / 3h ago" copy without re-querying the audit log.
 */
const LAST_ACTIVE_KEY = "last_active_at";

export function touchLastActive(db: Database, ts: number = Date.now()): void {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, ?)",
  ).run(LAST_ACTIVE_KEY, String(ts), ts);
}

export function getLastActive(db: Database): number | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?")
    .get(LAST_ACTIVE_KEY) as { value: string } | undefined;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}