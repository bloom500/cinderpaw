/**
 * Memory Resume state — Sprint 1.7.
 *
 * `useResumeTask()` asks the sidecar (via the `get_last_task` Tauri command)
 * for the persisted `current_task` + active workspace + last-active timestamp.
 * The new-chat empty state renders it as the hero heading
 * ("Welcome back to <task>") in place of the rotating greetings — the
 * headline payoff of Sprint 1 is that the app "remembers".
 *
 * Copy rules:
 *   - No task + no last-active  → null (silent first launch; the wizard
 *     handles that case).
 *   - stale (>30 days)          → null; the wizard marker (if present)
 *     decides re-onboarding.
 */

import { useEffect, useState } from 'react';
import { tauri } from '@/lib/tauri';

const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface ResumeState {
  title: string;
  workspaceName: string | null;
  /** Wall-clock of when the task was set, for the relative-time chip. */
  ts: number;
}

function shouldShow(
  task: { title: string; ts: number } | null,
  lastActiveAt: number | null,
): boolean {
  if (!task) return false;
  if (task.title.trim().length === 0) return false;
  if (!Number.isFinite(task.ts)) return false;
  const ref = lastActiveAt ?? task.ts;
  return Number.isFinite(ref) && Date.now() - ref <= STALE_MS;
}

export function formatRelative(ts: number, now: number = Date.now()): string {
  const d = Math.max(0, now - ts);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (d < min) return 'just now';
  if (d < hr) return `${Math.floor(d / min)}m ago`;
  if (d < day) return `${Math.floor(d / hr)}h ago`;
  return `${Math.floor(d / day)}d ago`;
}

/** One fire-and-forget read on mount; null while loading / nothing to show. */
export function useResumeTask(): ResumeState | null {
  const [state, setState] = useState<ResumeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await tauri.memory.getLastTask();
        if (cancelled) return;
        if (!shouldShow(view.task, view.last_active_at)) return;
        setState({
          title: view.task!.title,
          workspaceName: view.workspace_name,
          ts: view.task!.ts,
        });
      } catch {
        // Sidecar offline or command unavailable — silently skip. The wizard
        // is the recovery surface; resume copy is pure delight, not a gate.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return state;
}
