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

const AUTO_DISMISS_MS = 8_000;
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
    // Errors stay until dismissed; info/success auto-clear.
    if (kind !== 'error') {
      setTimeout(() => get().dismiss(toast.id), AUTO_DISMISS_MS);
    }
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
