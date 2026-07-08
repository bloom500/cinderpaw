/**
 * WelcomeBack banner — Sprint 1.7.
 *
 * Mounted by `AppShell` once on app boot. Asks the sidecar (via the
 * `get_last_task` Tauri command) for the persisted `current_task` +
 * active workspace + last-active timestamp and renders a small dismissable
 * card at the top of the main view if there is something to greet the user
 * with.
 *
 * Why mount it in the shell (not in the chat page)?
 *   - The user should see it the moment the app opens, not after navigating
 *     to /chat. The shell is the constant surface.
 *   - It's a single fire-and-forget read on boot — never blocks the chat.
 *
 * Copy rules:
 *   - No task + no last-active  → "fresh start" copy is suppressed (silent
 *     first launch). The wizard handles that case, not the banner.
 *   - task present + workspaceName  → "Welcome back to <title> · in <workspace>"
 *   - task present + no workspace  → "Welcome back to <title>"
 *   - stale (>30 days)             → banner is suppressed; the wizard marker
 *     (if present) decides re-onboarding.
 *
 * Dismissal is **per session** only — closing and reopening the app shows
 * the banner again, by design (the headline payoff of Sprint 1 is that
 * the app "remembers" — the user shouldn't have to dig into Settings).
 */

import { useEffect, useState } from 'react';
import { History, X, FolderOpen } from 'lucide-react';
import { tauri } from '@/lib/tauri';

const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface ResumeState {
  visible: boolean;
  title: string;
  workspaceName: string | null;
  /** Wall-clock of when the task was set, for the relative-time chip. */
  ts: number;
  /** Wall-clock of the last activity, used for the staleness gate. */
  lastActiveAt: number | null;
}

function shouldShow(task: { title: string; ts: number } | null, lastActiveAt: number | null): ResumeState | null {
  if (!task) return null;
  if (task.title.trim().length === 0) return null;
  if (!Number.isFinite(task.ts)) return null;

  const ref = lastActiveAt ?? task.ts;
  if (!Number.isFinite(ref) || Date.now() - ref > STALE_MS) return null;

  // workspaceName is filled by a follow-up lookup if needed; the banner
  // payload already carries it (looked up server-side).
  return {
    visible: true,
    title: task.title,
    workspaceName: null, // populated by caller from the same payload
    ts: task.ts,
    lastActiveAt,
  };
}

function formatRelative(ts: number, now: number = Date.now()): string {
  const d = Math.max(0, now - ts);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (d < min) return 'just now';
  if (d < hr) return `${Math.floor(d / min)}m ago`;
  if (d < day) return `${Math.floor(d / hr)}h ago`;
  return `${Math.floor(d / day)}d ago`;
}

export function WelcomeBack() {
  const [state, setState] = useState<ResumeState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await tauri.memory.getLastTask();
        if (cancelled) return;
        const candidate = shouldShow(view.task, view.last_active_at);
        if (!candidate) return;
        setState({ ...candidate, workspaceName: view.workspace_name });
      } catch {
        // Sidecar offline or command unavailable — silently skip. The wizard
        // is the recovery surface; the banner is pure delight, not a gate.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (dismissed || !state) return null;

  const hasWorkspace = !!state.workspaceName;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="welcome-back-banner"
      className="pointer-events-auto fixed top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-2xl border border-border-subtle bg-bg-surface/90 px-4 py-2.5 shadow-lg backdrop-blur"
    >
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand"
      >
        <History size={14} />
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-[13px] font-medium text-text-primary">
          Welcome back to <span className="text-brand">{state.title}</span>
        </span>
        <span className="flex items-center gap-1 text-[11px] text-text-muted">
          {hasWorkspace && (
            <>
              <FolderOpen size={10} aria-hidden />
              <span>in {state.workspaceName}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span>{formatRelative(state.ts)}</span>
        </span>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-muted/60 transition-colors hover:bg-bg-hover hover:text-text-secondary"
      >
        <X size={12} />
      </button>
    </div>
  );
}