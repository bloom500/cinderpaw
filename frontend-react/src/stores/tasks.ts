import { create } from 'zustand';
import { tauri, type ScheduledTask } from '@/lib/tauri';
import type { TaskCard } from '@/lib/widgets';

/**
 * Scheduled tasks: the Tasks page's list and the task cards in replies.
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
  /** What a card's Create is doing, by card id. Absent = not pressed this session. */
  creating: Record<string, { state: 'creating' | 'created' | 'failed'; error?: string }>;
  /** Cards closed with Not now, by card id. */
  dismissed: Record<string, true>;
  refresh: () => void;
  remove: (jobId: string) => void;
  toggle: (jobId: string, enabled: boolean) => void;
  create: (card: TaskCard, sessionId: string) => void;
  dismiss: (cardId: string) => void;
  receive: (e: { id: string; ok: boolean; error?: string; jobs: ScheduledTask[] }) => void;
}

/** Which card a request was for, so its answer can settle that card. */
const pendingCreate = new Map<string, string>();

/** A card is already a task when one with its name and text exists: true after a reload too. */
export const isCreated = (jobs: ScheduledTask[], card: TaskCard) =>
  jobs.some((j) => j.name === card.title && j.task === card.task);

export const useTasks = create<TasksStore>()((set) => {
  const settle = (cardId: string, state: 'created' | 'failed', error?: string) =>
    set((s) => ({ creating: { ...s.creating, [cardId]: { state, error } } }));
  const send = (action: 'list' | 'add' | 'remove' | 'toggle', opts: Parameters<typeof tauri.raw.cinderpawCronOp>[2] = {}, forCard?: string) => {
    const requestId = crypto.randomUUID();
    if (forCard) pendingCreate.set(requestId, forCard);
    tauri.raw.cinderpawCronOp(requestId, action, opts).catch((err: unknown) => {
      // The engine is not running or refused it: say so, never a list that silently never loads.
      const message = err instanceof Error ? err.message : String(err);
      pendingCreate.delete(requestId);
      if (forCard) settle(forCard, 'failed', message);
      else set({ error: message });
    });
  };
  return {
    jobs: [],
    loaded: false,
    error: null,
    creating: {},
    dismissed: {},
    refresh: () => send('list'),
    remove: (jobId) => send('remove', { jobId }),
    toggle: (jobId, enabled) => send('toggle', { jobId, enabled }),
    create: (card, sessionId) => {
      set((s) => ({ creating: { ...s.creating, [card.id]: { state: 'creating' } } }));
      send('add', { name: card.title, task: card.task, schedule: card.schedule, kind: card.kind, sessionId }, card.id);
    },
    dismiss: (cardId) => set((s) => ({ dismissed: { ...s.dismissed, [cardId]: true } })),
    receive: (e) => {
      const forCard = pendingCreate.get(e.id);
      pendingCreate.delete(e.id);
      set({ jobs: e.jobs ?? [], loaded: true, error: e.ok ? null : (e.error ?? 'That did not work.') });
      if (forCard) settle(forCard, e.ok ? 'created' : 'failed', e.error);
    },
  };
});
