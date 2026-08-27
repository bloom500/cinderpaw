/**
 * Lightweight global toast notifications (X3 / #12).
 *
 * Used for events that happen outside any visible chat — scheduled (cron)
 * job results and failures, sidecar lifecycle events, etc. Before this,
 * `cron_fired` events from the sidecar reached the frontend and were
 * silently dropped: a scheduled job could run for weeks and the user would
 * never see a single result or error.
 */

import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  /** Optional body — long content is clamped by the component. */
  message?: string;
  createdAt: number;
}

interface NotificationStore {
  toasts: Toast[];
  push(kind: ToastKind, title: string, message?: string): void;
  dismiss(id: string): void;
}

/**
 * How long any toast stays, including errors.
 *
 * Errors used to stay until dismissed, on the theory that a failure is too
 * important to let slip past. In practice that made them furniture: a
 * "cinderpaw-agent is not running" from one bad moment sat on the screen through
 * everything that came after, including the part where it started working
 * again. A notice that outlives the condition it reports stops being read.
 *
 * Nothing is lost by clearing it: an error that matters is also shown where it
 * happened — the call screen has its own notice line, the chat keeps the failed
 * turn, and the terminal keeps the log. The toast is the announcement, not the
 * record.
 */
const AUTO_DISMISS_MS = 5_000;
const MAX_VISIBLE = 4;

export const useNotifications = create<NotificationStore>((set, get) => ({
  toasts: [],

  push(kind, title, message) {
    const toast: Toast = {
      id: crypto.randomUUID(),
      kind,
      title,
      message,
      createdAt: Date.now(),
    };
    set((s) => ({ toasts: [...s.toasts, toast].slice(-MAX_VISIBLE) }));
    // Every kind clears itself, errors included — see AUTO_DISMISS_MS.
    setTimeout(() => get().dismiss(toast.id), AUTO_DISMISS_MS);
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/**
 * Run something the user asked for, and if it fails, say so on their screen.
 *
 * Renaming a chat, deleting a project, dragging a chat into a project: every
 * one of these went to the backend with no `catch` at all, or with a `catch`
 * that reached `console.error`. On a machine where the sidecar has not started
 * — which is every machine, for the first few seconds after launch, and any
 * machine where the setup did not finish — the rename simply did not happen.
 * The dialog closed, the name stayed the same, and the only account of why was
 * in a DevTools console the person does not have open.
 *
 * Wrapping the store mutation rather than each caller is what makes it hold:
 * `addChat` alone has three entry points (the row menu, the project menu, and
 * dropping a chat onto a project in the rail), and a guard in one of them is a
 * guard in one of them.
 *
 * Returns `undefined` on failure, so a caller that cares can still branch;
 * nothing is rethrown, because a rejected promise is what nobody was catching
 * in the first place.
 */
export async function reportFailure<T>(what: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    useNotifications.getState().push('error', what, err instanceof Error ? err.message : String(err));
    console.error(`[${what}]`, err);
    return undefined;
  }
}
