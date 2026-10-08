import type { Database } from "bun:sqlite";
import type { ErrorCategory } from "./error-category.ts";

export type TaskOutcome = "completed" | "stuck" | "out_of_time" | "ceiling" | "stopped" | "no_answer" | "error";
export const TASK_OUTCOMES: readonly TaskOutcome[] = [
  "completed", "stuck", "out_of_time", "ceiling", "stopped", "no_answer", "error",
];

let warned = false;
/** Telemetry is not the work: a failed write is said once and never thrown. */
function guard(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`[cinderpaw] task_metrics ${what} failed, usage stats are blind: ${String(err)}`);
    }
  }
}

export function beginTask(
  db: Database,
  t: { taskId: string; sessionId: string; startedAt: number; brsiOn: boolean; memoryOn: boolean },
): void {
  guard("begin", () =>
    db.query(
      `INSERT OR IGNORE INTO task_metrics (task_id, session_id, started_at, brsi_on, memory_on)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(t.taskId, t.sessionId, t.startedAt, t.brsiOn ? 1 : 0, t.memoryOn ? 1 : 0),
  );
}

export function finishTask(
  db: Database,
  taskId: string,
  f: { durationMs: number; outcome: TaskOutcome; errorCategory: ErrorCategory | null; toolCalls: number; attemptedProvider: string; attemptedModel: string },
): void {
  guard("finish", () =>
    db.query(
      `UPDATE task_metrics SET duration_ms = ?, outcome = ?, error_category = ?, tool_calls = ?,
         attempted_provider = ?, attempted_model = ? WHERE task_id = ?`,
    ).run(f.durationMs, f.outcome, f.errorCategory, f.toolCalls, f.attemptedProvider, f.attemptedModel, taskId),
  );
}

export function noteTaskFallback(db: Database, taskId: string): void {
  guard("fallback", () => db.query(`UPDATE task_metrics SET fallbacks = fallbacks + 1 WHERE task_id = ?`).run(taskId));
}

export function setTaskFeedback(db: Database, taskId: string, value: "up" | "down"): void {
  guard("feedback", () =>
    db.query(`UPDATE task_metrics SET feedback = ? WHERE task_id = ?`).run(value === "up" ? 1 : -1, taskId),
  );
}
