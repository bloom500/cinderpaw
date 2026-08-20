/**
 * useAskUser — Zustand store for Claude.ai-style interactive questions.
 *
 * When the Cinderpaw Agent sidecar emits an `ask_user` event, the React side
 * routes it here. The store presents ONE question at a time (`pending`, the
 * head), but any further requests that arrive before the user answers are
 * QUEUED in `waiting` rather than overwriting the head. This is essential for
 * tools that ask in quick succession — e.g. `control_app` emits a confirmation
 * per click, and the model may fire those clicks as parallel tool calls, so
 * several `ask_user` events land back-to-back. The previous single-slot design
 * silently dropped all but the last, orphaning the earlier Promises so their
 * cards hung forever ("answer one, the next does nothing").
 *
 * When the user picks options and clicks "Submit", the store resolves the
 * head's Promise (which the stream wiring forwards to Rust as
 * `feral_ask_user_response`) and promotes the next queued request to head.
 *
 * History is kept per-session in memory only — reloading the app clears it.
 * Persisting ask_user history is out of scope for v0.1.7; SQLite persistence
 * is in v0.2.x.
 */

import { create } from 'zustand';

export interface AskUserOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AskUserQuestion {
  question: string;
  header?: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

export interface AskUserAnswer {
  question: string;
  selected: string[];
  customText?: string;
}

interface PendingRequest {
  id: string;
  sessionId: string;
  questions: AskUserQuestion[];
  resolve: (answers: AskUserAnswer[]) => void;
  reject: (err: Error) => void;
  /** Wall-clock ms when the request was received — for diagnostics / timeout. */
  createdAt: number;
}

interface AskUserHistoryEntry {
  id: string;
  sessionId: string;
  questions: AskUserQuestion[];
  answers: AskUserAnswer[];
  askedAt: number;
  answeredAt: number;
}

interface AskUserStore {
  /** The request currently shown to the user (head of the queue). */
  pending: PendingRequest | null;
  /** Requests that arrived while `pending` was busy, in arrival order. */
  waiting: PendingRequest[];
  history: AskUserHistoryEntry[];

  /**
   * Called by useCinderpawStream when an `ask_user` event arrives from the
   * sidecar. Returns a Promise that resolves when the user picks options
   * (or rejects on cancel / timeout). The consumer is expected to call
   * `feralAskUserResponse(requestId, answers)` when the Promise resolves.
   *
   * If a request is already pending, the new one is QUEUED — it becomes the
   * head only once the earlier requests have been answered/cancelled, so no
   * request is ever lost.
   */
  request: (
    id: string,
    sessionId: string,
    questions: AskUserQuestion[],
  ) => Promise<AskUserAnswer[]>;

  /**
   * Called when the user submits their selection. Resolves the head's
   * Promise, archives the request into history, and promotes the next
   * queued request (if any) to `pending`.
   */
  submit: (answers: AskUserAnswer[]) => void;

  /**
   * Called on cancel (UI: "skip" button; transport: timeout; shutdown).
   * Rejects the head's Promise and promotes the next queued request.
   */
  cancel: (reason?: string) => void;

  /**
   * Cancel a SPECIFIC request by id, wherever it sits in the queue. Used when
   * the sidecar reports a cancel/timeout for one request — we must not blow
   * away the others the user is still working through.
   */
  cancelById: (id: string, reason?: string) => void;

  /** Reject every pending + queued request (app shutdown / hard reset). */
  cancelAll: (reason?: string) => void;

  /** True when the user is currently being asked. */
  isPending: () => boolean;
}

export const useAskUser = create<AskUserStore>((set, get) => ({
  pending: null,
  waiting: [],
  history: [],

  request: (id, sessionId, questions) => {
    return new Promise<AskUserAnswer[]>((resolve, reject) => {
      const entry: PendingRequest = {
        id,
        sessionId,
        questions,
        resolve,
        reject,
        createdAt: Date.now(),
      };
      // Become the head only when nothing is currently being asked;
      // otherwise queue behind the in-flight request(s).
      set((s) => (s.pending ? { waiting: [...s.waiting, entry] } : { pending: entry }));
    });
  },

  submit: (answers) => {
    const p = get().pending;
    if (!p) return;
    set((s) => {
      const [next, ...rest] = s.waiting;
      return {
        pending: next ?? null,
        waiting: next ? rest : [],
        history: [
          ...s.history,
          {
            id: p.id,
            sessionId: p.sessionId,
            questions: p.questions,
            answers,
            askedAt: p.createdAt,
            answeredAt: Date.now(),
          },
        ],
      };
    });
    p.resolve(answers);
  },

  cancel: (reason) => {
    const p = get().pending;
    if (!p) return;
    set((s) => {
      const [next, ...rest] = s.waiting;
      return { pending: next ?? null, waiting: next ? rest : [] };
    });
    p.reject(new Error(reason ?? 'cancelled'));
  },

  cancelById: (id, reason) => {
    const { pending, waiting } = get();
    if (pending?.id === id) {
      get().cancel(reason);
      return;
    }
    const target = waiting.find((w) => w.id === id);
    if (!target) return;
    set((s) => ({ waiting: s.waiting.filter((w) => w.id !== id) }));
    target.reject(new Error(reason ?? 'cancelled'));
  },

  cancelAll: (reason) => {
    const { pending, waiting } = get();
    const all = [pending, ...waiting].filter((p): p is PendingRequest => p !== null);
    set({ pending: null, waiting: [] });
    for (const p of all) p.reject(new Error(reason ?? 'cancelled'));
  },

  isPending: () => get().pending !== null,
}));
