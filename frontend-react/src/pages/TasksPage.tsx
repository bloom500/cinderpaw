import { useEffect, useState } from 'react';
import { Bell, CalendarClock, ChevronDown, Pause, Play, Trash2 } from 'lucide-react';
import type { ScheduledTask, TaskSchedule } from '@/lib/tauri';
import { useTasks } from '@/stores/tasks';
import { cn } from '@/lib/utils';

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A schedule in words, in English like the rest of the app (the system locale
 *  wrote "sâm., 24 oct."). The shapes suggest_task builds read as sentences; any
 *  other cron expression is shown as it is, never guessed at. */
export function scheduleWords(s: TaskSchedule): string {
  if (s.kind === 'every') {
    const h = s.intervalMs / 3_600_000;
    if (Number.isInteger(h)) return h === 1 ? 'Every hour' : `Every ${h} hours`;
    return `Every ${Math.round(s.intervalMs / 60_000)} minutes`;
  }
  if (s.kind === 'at') {
    const d = new Date(s.isoTimestamp);
    return `Once, ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(s.expression.trim());
  if (!m) return `Custom schedule (${s.expression})`;
  const at = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`;
  if (m[3] === '*') return `Every day at ${at}`;
  if (m[3] === '1-5') return `Every weekday at ${at}`;
  return `Every ${DAY[Number(m[3])]} at ${at}`;
}

function when(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `today at ${time}` : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
}

const STATUS: Record<string, string> = {
  success: 'Done', incomplete: 'Stopped before the end', failed: 'Failed', timeout: 'Took too long',
  budget_exceeded: 'Stopped at the spending limit', skipped: 'Skipped',
};

function TaskRow({ job }: { job: ScheduledTask }) {
  const remove = useTasks((s) => s.remove);
  const toggle = useTasks((s) => s.toggle);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const Icon = job.kind === 'reminder' ? Bell : CalendarClock;
  const runs = [...(job.history ?? [])].reverse();
  const finishedOnce = job.schedule.kind === 'at' && !job.nextRunMs && runs.length > 0;

  return (
    <li className="rounded-2xl border border-border-default bg-bg-surface">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', job.enabled ? 'bg-bg-active text-brand' : 'bg-bg-hover text-text-muted')}>
          <Icon size={18} aria-hidden />
        </span>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="min-w-0 flex-1 text-left cursor-pointer">
          <p className="truncate text-sm font-semibold text-text-primary">{job.name}</p>
          <p className="truncate text-xs text-text-muted">
            {scheduleWords(job.schedule)}
            {' · '}{job.kind === 'reminder' ? 'Reminder, free' : 'Agent task, uses your model'}
            {/* A one-time task turns itself off once done: that is Done, not Paused. */}
            {' · '}{finishedOnce ? 'Done' : !job.enabled ? 'Paused' : job.nextRunMs ? `Next ${when(job.nextRunMs)}` : 'Not scheduled'}
          </p>
        </button>
        <button type="button" aria-label={job.enabled ? `Pause ${job.name}` : `Resume ${job.name}`} onClick={() => toggle(job.id, !job.enabled)}
          className="rounded-lg p-2 text-text-muted hover:bg-text-primary/5 hover:text-text-primary">
          {job.enabled ? <Pause size={16} /> : <Play size={16} />}
        </button>
        {confirm ? (
          <span className="flex items-center gap-1">
            <button type="button" onClick={() => remove(job.id)} className="rounded-lg bg-error/90 px-2.5 py-1 text-xs font-medium text-white hover:bg-error">Delete</button>
            <button type="button" onClick={() => setConfirm(false)} className="rounded-lg px-2 py-1 text-xs text-text-muted hover:text-text-primary">Keep</button>
          </span>
        ) : (
          <button type="button" aria-label={`Delete ${job.name}`} onClick={() => setConfirm(true)}
            className="rounded-lg p-2 text-text-muted hover:bg-error/10 hover:text-error">
            <Trash2 size={16} />
          </button>
        )}
        <ChevronDown size={16} aria-hidden className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
      </div>
      {open && (
        <div className="border-t border-border-subtle px-4 py-3 text-xs">
          <p className="whitespace-pre-wrap text-text-secondary">{job.task}</p>
          <p className="mt-3 font-semibold text-text-primary">Last results</p>
          {runs.length === 0 ? (
            <p className="mt-1 text-text-muted">It has not run yet.</p>
          ) : (
            <ul className="mt-1 space-y-2">
              {runs.map((r) => (
                <li key={r.runAt}>
                  <span className={cn('font-medium', r.status === 'success' ? 'text-success' : r.status === 'skipped' ? 'text-text-muted' : 'text-error')}>
                    {STATUS[r.status] ?? r.status}
                  </span>
                  <span className="text-text-muted"> · {when(r.runAt)}</span>
                  {(r.result || r.error) && <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-text-secondary">{r.error ?? r.result}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** Things Cinderpaw does later: every scheduled task, pause, delete, and what each run said. */
export function TasksPage() {
  const { jobs, loaded, error, refresh } = useTasks();
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="mx-auto max-w-3xl px-6 pb-14">
          <header>
            <h1 className="font-display text-3xl text-text-primary">Tasks</h1>
            <p className="mt-1 text-sm text-text-muted">
              Reminders and jobs Cinderpaw does for you later. They run while Cinderpaw is open; one missed while it was closed runs once when you open it.
            </p>
          </header>
          {error && <p role="alert" className="mt-4 text-sm text-error">{error}</p>}
          {!loaded && !error ? (
            <p className="mt-8 text-sm text-text-muted">Loading…</p>
          ) : jobs.length === 0 ? (
            <div className="mt-8 rounded-2xl border border-dashed border-border-default p-6 text-sm text-text-secondary">
              <p className="font-semibold text-text-primary">No tasks yet.</p>
              <p className="mt-1">In a chat, ask for one in your own words, for example "remind me to call the bank on Monday at 9" or "every Friday, sum up my week". Cinderpaw shows a card, and you create it with one click.</p>
            </div>
          ) : (
            <ul className="mt-8 space-y-2">
              {jobs.map((j) => <TaskRow key={j.id} job={j} />)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
