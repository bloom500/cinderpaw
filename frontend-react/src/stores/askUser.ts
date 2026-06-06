/**
 * useAskUser — Zustand store for Claude.ai-style interactive questions.
 *
 * When the Feral Agent sidecar emits an `ask_user` event, the React side
 * routes it here. The store holds a single "pending" request (the user
 * can only answer one question at a time). When the user picks options
 * and clicks "Submit", the store resolves the pending Promise, which
 * the consumer (useFeralStream wiring) translates into a
 * `feralAskUserResponse` invoke call back to Rust → sidecar → bridge.
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
  pending: PendingRequest | null;
  history: AskUserHistoryEntry[];

  /**
   * Called by useFeralStream when an `ask_user` event arrives from the
   * sidecar. Returns a Promise that resolves when the user picks options
   * (or rejects on cancel / timeout). The consumer is expected to call
   * `feralAskUserResponse(requestId, answers)` when the Promise resolves.
   */
  request: (
    id: string,
    sessionId: string,
    questions: AskUserQuestion[],
  ) => Promise<AskUserAnswer[]>;

  /**
   * Called when the user submits their selection. Resolves the pending
   * Promise, archives the request into history, and clears `pending`.
   */
  submit: (answers: AskUserAnswer[]) => void;

  /**
   * Called on cancel (UI: "skip" button; transport: timeout; shutdown).
   * Rejects the pending Promise.
   */
  cancel: (reason?: string) => void;

  /** True when the user is currently being asked. */
  isPending: () => boolean;
}

export const useAskUser = create<AskUserStore>((set, get) => ({
  pending: null,
  history: [],

  request: (id, sessionId, questions) => {
    return new Promise<AskUserAnswer[]>((resolve, reject) => {
      set({
        pending: {
          id,
          sessionId,
          questions,
          resolve,
          reject,
          createdAt: Date.now(),
        },
      });
    });
  },

  submit: (answers) => {
    const p = get().pending;
    if (!p) return;
    set((s) => ({
      pending: null,
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
    }));
    p.resolve(answers);
  },

  cancel: (reason) => {
    const p = get().pending;
    if (!p) return;
    set({ pending: null });
    p.reject(new Error(reason ?? 'cancelled'));
  },

  isPending: () => get().pending !== null,
}));
