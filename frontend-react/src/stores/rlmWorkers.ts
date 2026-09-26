import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Background workers spawned by the notebook's `rlm()`, per chat session.
 *
 * Its own store, not entries in the chat store's `toolCallStream`: that list
 * is wiped after every turn, and the only component that ever drew it (the
 * mascot's bubbles) was deleted on 17 Sep. Workers kept being written into a
 * list nobody read, so from then on a worker had no UI at all. A worker
 * outlives the turn that spawned it by design; it needs a home that does too.
 */

export type RlmWorkerStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface RlmWorker {
  /** The ChildRegistry id: stable, so every update lands on one row. */
  childId: string;
  /** The chat session that spawned it. */
  sessionId: string;
  /** Registry name, e.g. `subagent-count-the-files-a1b2`. */
  name: string;
  status: RlmWorkerStatus;
  /** What it is doing right now, or why it ended. */
  detail: string | null;
  /** Its final answer, once it has one. */
  answer: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface RlmWorkerEvent {
  sessionId: string;
  childId: string;
  name: string;
  status: RlmWorkerStatus;
  detail?: string;
  answer?: string;
}

/** Oldest rows go first past this, across every chat. */
export const RLM_WORKERS_MAX = 50;

/** One chat's workers, oldest first. */
export function workersFor(workers: RlmWorker[], sessionId: string | null): RlmWorker[] {
  if (!sessionId) return [];
  return workers.filter((w) => w.sessionId === sessionId);
}

/**
 * `subagent-count-the-files-a1b2` reads as a slug. The words in the middle are
 * the task; the prefix and the id tail are bookkeeping the person never chose.
 * A name the model picked itself (`api-reviewer`) is shown as it is.
 */
export function displayName(name: string): string {
  const m = /^subagent-(.+)-[a-z0-9]{1,8}$/i.exec(name);
  return (m ? m[1] : name).replace(/-/g, ' ');
}

interface RlmWorkersStore {
  workers: RlmWorker[];
  upsert: (e: RlmWorkerEvent) => void;
  dismiss: (childId: string) => void;
  /** Remove every settled worker of one chat. Running ones stay. */
  clearSettled: (sessionId: string) => void;
}

export const useRlmWorkers = create<RlmWorkersStore>()(
  persist(
    (set) => ({
      workers: [],
      upsert: (e) =>
        set((s) => {
          const existing = s.workers.find((w) => w.childId === e.childId);
          const settled = e.status !== 'running';
          const row: RlmWorker = {
            childId: e.childId,
            sessionId: e.sessionId,
            name: e.name,
            status: e.status,
            detail: e.detail ?? existing?.detail ?? null,
            answer: e.answer ?? existing?.answer ?? null,
            startedAt: existing?.startedAt ?? Date.now(),
            endedAt: settled ? (existing?.endedAt ?? Date.now()) : null,
          };
          const next = existing
            ? s.workers.map((w) => (w.childId === e.childId ? row : w))
            : [...s.workers, row];
          return { workers: next.slice(-RLM_WORKERS_MAX) };
        }),
      dismiss: (childId) => set((s) => ({ workers: s.workers.filter((w) => w.childId !== childId) })),
      clearSettled: (sessionId) =>
        set((s) => ({
          workers: s.workers.filter((w) => w.sessionId !== sessionId || w.status === 'running'),
        })),
    }),
    {
      name: 'rlm-workers',
      storage: createJSONStorage(() => localStorage),
      // Only settled workers survive a reload. A running row cannot know
      // whether the engine that ran it is still alive, and one that restarted
      // would leave it spinning for ever. A worker still alive re-creates its
      // row on its next event anyway.
      partialize: (state) => ({ workers: state.workers.filter((w) => w.status !== 'running') }),
      version: 1,
    },
  ),
);
