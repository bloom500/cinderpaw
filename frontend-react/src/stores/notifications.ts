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
 * "feral-agent is not running" from one bad moment sat on the screen through
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
