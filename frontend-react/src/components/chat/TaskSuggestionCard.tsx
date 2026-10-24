import { useEffect } from 'react';
import { Bell, CalendarClock } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TaskCard } from '@/lib/widgets';
import { isCreated, useTasks } from '@/stores/tasks';

/**
 * A task the agent offered (`suggest_task`), at the end of the reply it came
 * with, as if it noticed on its own. Nothing exists until Create: the card says
 * what it will do, when, and whether it costs anything, so the click is an
 * informed one. "Created" is read from the task list, so it holds after a reload.
 */
export function TaskSuggestionCard({ card, sessionId }: { card: TaskCard; sessionId: string }) {
  const jobs = useTasks((s) => s.jobs);
  const loaded = useTasks((s) => s.loaded);
  const pressed = useTasks((s) => s.creating[card.id]);
  const dismissed = useTasks((s) => !!s.dismissed[card.id]);
  const create = useTasks((s) => s.create);
  const dismiss = useTasks((s) => s.dismiss);
  const refresh = useTasks((s) => s.refresh);
  useEffect(() => { if (!loaded) refresh(); }, [loaded, refresh]);

  const created = pressed?.state === 'created' || isCreated(jobs, card);
  if (dismissed && !created) return null;
  const reminder = card.kind === 'reminder';
  const Icon = reminder ? Bell : CalendarClock;

  return (
    <section aria-label="Suggested task" className="rounded-2xl border border-border-default bg-bg-surface px-3 py-2.5">
      <div className="flex gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-active text-brand">
          <Icon size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">{card.title}</p>
          <p className="text-xs text-text-secondary">{card.when}</p>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">{card.task}</p>
          <p className="mt-1 text-2xs text-text-muted">
            {reminder
              ? 'A reminder: you get this text at that time. No AI runs, so it costs nothing.'
              : 'Cinderpaw does this each time, with your model, so each run uses it like a chat.'}
            {' '}It runs while Cinderpaw is open.
          </p>
          {created ? (
            <p className="mt-2 text-xs text-text-primary">
              Created. <Link to="/tasks" className="text-brand underline-offset-2 hover:underline">See it in Tasks</Link>
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" disabled={pressed?.state === 'creating'} onClick={() => create(card, sessionId)}
                className="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground hover:opacity-90 disabled:opacity-60">
                {pressed?.state === 'creating' ? 'Creating…' : 'Create task'}
              </button>
              <button type="button" onClick={() => dismiss(card.id)}
                className="rounded-full border border-border-default px-3 py-1 text-xs font-medium text-text-primary hover:bg-text-primary/5">
                Not now
              </button>
              {pressed?.state === 'failed' && <span role="alert" className="text-xs text-error">Not created. {pressed.error}</span>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
