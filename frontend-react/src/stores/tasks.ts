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
  /** The one weekly limit for all scheduled tasks; null until the first answer. */
  limit: { weeklyUsd: number | null; asked: boolean; spentUsd: number } | null;
  setLimit: (weeklyUsd: number | null) => void;
  /** Where a fired task reaches the person away from the computer: the
   *  messenger id, or null when none is connected. `tested` after a real test;
   *  `testing` while one is on its way. */
  phone: { via: string | null; tested: boolean } | null;
  testing: boolean;
  /** Send a real notice to the phone, and learn where it went. */
  testPhone: () => void;
  /** What a card's Create is doing, by card id. Absent = not pressed this session. */
  creating: Record<string, { state: 'creating' | 'created' | 'failed'; error?: string }>;
  /** Cards closed with Not now, by card id. */
  dismissed: Record<string, true>;
  refresh: () => void;
  remove: (jobId: string) => void;
  toggle: (jobId: string, enabled: boolean) => void;
  edit: (job: ScheduledTask, changes: {name:string;task:string;schedule:ScheduledTask["schedule"];watch?:ScheduledTask["watch"];expiryDays?:number}) => void;
  create: (card: TaskCard, sessionId: string) => void;
  dismiss: (cardId: string) => void;
  receive: (e: { id: string; ok: boolean; error?: string; jobs: ScheduledTask[]; taskLimit?: TasksStore['limit']; phone?: TasksStore['phone'] }) => void;
}

/** Which card a request was for, so its answer can settle that card. */
const pendingCreate = new Map<string, string>();

/** A card is already a task when one with its name and text exists: true after a reload too. */
export const isCreated = (jobs: ScheduledTask[], card: TaskCard) =>
  jobs.some((j) => j.name === card.title && j.task === card.task);

export const useTasks = create<TasksStore>()((set) => {
  const settle = (cardId: string, state: 'created' | 'failed', error?: string) =>
    set((s) => ({ creating: { ...s.creating, [cardId]: { state, error } } }));
  const send = (action: 'list' | 'add' | 'edit' | 'remove' | 'toggle' | 'limit' | 'test_notify', opts: Parameters<typeof tauri.raw.cinderpawCronOp>[2] = {}, forCard?: string) => {
    const requestId = crypto.randomUUID();
    if (forCard) pendingCreate.set(requestId, forCard);
    tauri.raw.cinderpawCronOp(requestId, action, opts).catch((err: unknown) => {
      // The engine is not running or refused it: say so, never a list that silently never loads.
      const message = err instanceof Error ? err.message : String(err);
      pendingCreate.delete(requestId);
      if (forCard) settle(forCard, 'failed', message);
      else set({ error: message, testing: false });
    });
  };
  return {
    jobs: [],
    loaded: false,
    error: null,
    limit: null,
    setLimit: (weeklyUsd) => send('limit', { weeklyLimitUsd: weeklyUsd }),
    phone: null,
    testing: false,
    testPhone: () => {
      set({ testing: true });
      send('test_notify');
    },
    creating: {},
    dismissed: {},
    refresh: () => send('list'),
    remove: (jobId) => send('remove', { jobId }),
    toggle: (jobId, enabled) => send('toggle', { jobId, enabled }),
    edit: (job, changes) => send('edit', {jobId:job.id,kind:job.kind,...changes}),
    create: (card, sessionId) => {
      set((s) => ({ creating: { ...s.creating, [card.id]: { state: 'creating' } } }));
      send('add', { name: card.title, task: card.task, schedule: card.schedule, kind: card.kind, watch:card.watch,expiryDays:card.expiryDays, sessionId }, card.id);
    },
    dismiss: (cardId) => set((s) => ({ dismissed: { ...s.dismissed, [cardId]: true } })),
    receive: (e) => {
      const forCard = pendingCreate.get(e.id);
      pendingCreate.delete(e.id);
      set((s) => ({
        jobs: e.jobs ?? [], loaded: true, limit: e.taskLimit ?? s.limit, error: e.ok ? null : (e.error ?? 'That did not work.'),
        // A plain list after a test must not wipe the test's answer.
        phone: e.phone && (e.phone.tested || !s.phone?.tested) ? e.phone : s.phone,
        testing: e.phone?.tested ? false : s.testing,
      }));
      if (forCard) settle(forCard, e.ok ? 'created' : 'failed', e.error);
    },
  };
});
