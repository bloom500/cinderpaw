import { Bell, CalendarClock, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useChat } from '@/stores/chat';
import { useTasks } from '@/stores/tasks';

/**
 * A task the agent offered (`suggest_task`), above the message box like the
 * heads-up card. Nothing exists until Create: the card says what it will do,
 * when, and whether it costs anything, so the click is an informed one.
 */
export function TaskSuggestionCard() {
  const sessionId = useChat((s) => s.sessionId);
  const offered = useTasks((s) => s.offered[sessionId]);
  const create = useTasks((s) => s.create);
  const dismiss = useTasks((s) => s.dismiss);
  if (!offered) return null;
  const { card, state, error } = offered;
  const reminder = card.kind === 'reminder';
  const Icon = reminder ? Bell : CalendarClock;

  return (
    <section aria-label="Suggested task" className="mx-auto w-full max-w-[764px] px-4 pb-2">
      <div className="relative rounded-2xl border border-border-default bg-(--surface-typing) liquid-glass liquid-glass-rim px-3 py-2.5">
        <button type="button" aria-label="Close" onClick={() => dismiss(sessionId)}
          className="absolute right-2 top-2 rounded-full p-1 text-text-muted hover:bg-text-primary/5 hover:text-text-primary">
          <X size={16} />
        </button>
        <div className="flex gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-foreground">
            <Icon size={20} aria-hidden />
          </span>
          <span aria-hidden className="w-px shrink-0 self-stretch bg-border-default" />
          <div className="min-w-0 flex-1 pr-6">
            <p className="text-sm font-semibold text-text-primary">{card.title}</p>
            <p className="text-xs text-text-secondary">{card.when}</p>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">{card.task}</p>
            <p className="mt-1 text-2xs text-text-muted">
              {reminder
                ? 'A reminder: you get this text at that time. No AI runs, so it costs nothing.'
                : 'Cinderpaw does this each time, with your model, so each run uses it like a chat.'}
              {' '}It runs while Cinderpaw is open.
            </p>
            {state === 'created' ? (
              <p className="mt-2 text-xs text-text-primary">
                Created. <Link to="/tasks" className="text-brand underline-offset-2 hover:underline">See it in Tasks</Link>
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" disabled={state === 'creating'} onClick={() => create(sessionId)}
                  className="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground hover:opacity-90 disabled:opacity-60">
                  {state === 'creating' ? 'Creating…' : 'Create task'}
                </button>
                <button type="button" onClick={() => dismiss(sessionId)}
                  className="rounded-full border border-border-default px-3 py-1 text-xs font-medium text-text-primary hover:bg-text-primary/5">
                  Not now
                </button>
                {state === 'failed' && <span role="alert" className="text-xs text-error">Not created. {error}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
