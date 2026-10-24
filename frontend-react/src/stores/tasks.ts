import { create } from 'zustand';
import { tauri, type ScheduledTask, type TaskSchedule } from '@/lib/tauri';

/** A task the agent offered (`suggest_task`): nothing exists until Create. */
export interface TaskSuggestion {
  id: string;
  title: string;
  task: string;
  kind: 'agent' | 'reminder';
  schedule: TaskSchedule;
  /** The schedule in words, e.g. "Every weekday at 09:00". */
  when: string;
}

/**
 * Scheduled tasks: the Tasks page's list and the chat's task cards.
 *
 * Requests are fire-and-forget; every one is answered by a `cron_list_result`
 * holding the whole list after the change, which the stream hands to `receive`.
 * A card's Create is the only way a task the agent thought of comes to exist.
 */
interface TasksStore {
  jobs: ScheduledTask[];
  /** False until the first answer arrives, so "no tasks yet" is never a guess. */
  loaded: boolean;
  error: string | null;
  /** The newest offered card per chat, and what became of it. */
  offered: Record<string, { card: TaskSuggestion; state: 'open' | 'creating' | 'created' | 'failed'; error?: string }>;
  refresh: () => void;
  remove: (jobId: string) => void;
  toggle: (jobId: string, enabled: boolean) => void;
  /** From a `tool_done` of `suggest_task`: the card rides the tool's data. */
  offer: (sessionId: string, result: unknown) => void;
  create: (sessionId: string) => void;
  dismiss: (sessionId: string) => void;
  receive: (e: { id: string; ok: boolean; error?: string; jobs: ScheduledTask[] }) => void;
}

/** Which chat's card a request was for, so its answer can settle that card. */
const pendingCreate = new Map<string, string>();

export const useTasks = create<TasksStore>()((set, get) => {
  const send = (action: 'list' | 'add' | 'remove' | 'toggle', opts: Parameters<typeof tauri.raw.cinderpawCronOp>[2] = {}, forSession?: string) => {
    const requestId = crypto.randomUUID();
    if (forSession) pendingCreate.set(requestId, forSession);
    tauri.raw.cinderpawCronOp(requestId, action, opts).catch((err: unknown) => {
      // The engine is not running or refused it: say so, never a list that silently never loads.
      const message = err instanceof Error ? err.message : String(err);
      pendingCreate.delete(requestId);
      if (forSession) settle(forSession, 'failed', message);
      else set({ error: message });
    });
  };
  const settle = (sessionId: string, state: 'created' | 'failed', error?: string) =>
    set((s) => {
      const o = s.offered[sessionId];
      return o ? { offered: { ...s.offered, [sessionId]: { ...o, state, error } } } : {};
    });
  return {
    jobs: [],
    loaded: false,
    error: null,
    offered: {},
    refresh: () => send('list'),
    remove: (jobId) => send('remove', { jobId }),
    toggle: (jobId, enabled) => send('toggle', { jobId, enabled }),
    offer: (sessionId, result) => {
      const card = (result as { data?: { taskSuggestion?: TaskSuggestion } } | null)?.data?.taskSuggestion;
      if (!sessionId || !card?.id || !card.title || !card.schedule) return;
      set((s) => ({ offered: { ...s.offered, [sessionId]: { card, state: 'open' } } }));
    },
    create: (sessionId) => {
      const o = get().offered[sessionId];
      if (!o || o.state === 'creating' || o.state === 'created') return;
      set((s) => ({ offered: { ...s.offered, [sessionId]: { ...o, state: 'creating' } } }));
      const { card } = o;
      send('add', { name: card.title, task: card.task, schedule: card.schedule, kind: card.kind, sessionId }, sessionId);
    },
    dismiss: (sessionId) =>
      set((s) => {
        const rest = { ...s.offered };
        delete rest[sessionId];
        return { offered: rest };
      }),
    receive: (e) => {
      const forSession = pendingCreate.get(e.id);
      pendingCreate.delete(e.id);
      set({ jobs: e.jobs ?? [], loaded: true, error: e.ok ? null : (e.error ?? 'That did not work.') });
      if (forSession) settle(forSession, e.ok ? 'created' : 'failed', e.error);
    },
  };
});
