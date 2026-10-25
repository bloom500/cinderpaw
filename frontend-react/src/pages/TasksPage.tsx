import { useEffect, useId, useState } from 'react';
import { ArrowUpRight, Bell, CalendarClock, ChevronDown, Pause, Play, ScanSearch, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { ScheduledTask, TaskSchedule } from '@/lib/tauri';
import { useTasks } from '@/stores/tasks';
import { useFollowUps } from '@/stores/followUps';
import { cn } from '@/lib/utils';

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A schedule in words, in English like the rest of the app (the system locale
 *  wrote "sâm., 24 oct."). The shapes suggest_task builds read as sentences; any
 *  other cron expression stays a custom schedule, editable in its details. */
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
  if (!m) return 'Custom schedule';
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
  budget_exceeded: 'Weekly limit reached', skipped: 'Skipped',
  waiting: 'Waiting for condition', expired: 'Expired', running: 'Running or interrupted',
};

function sourceHost(source: string): string {
  try { return new URL(source).hostname.replace(/^www\./, ''); } catch { return 'Source page'; }
}

/** A date as the time-picker shows it: the person's own clock, not UTC. Read
 *  as UTC, a time picked in Romania fired three hours late (24 Oct review). */
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function TaskEditor({job,close}: {job:ScheduledTask;close:()=>void}) {
  const edit = useTasks(s => s.edit);
  const [name,setName] = useState(job.name);
  const [task,setTask] = useState(job.task);
  const [kind,setKind] = useState(job.schedule.kind);
  const [schedule,setSchedule] = useState(job.schedule.kind === 'every' ? String(job.schedule.intervalMs / 60000) : job.schedule.kind === 'cron' ? job.schedule.expression : localInput(new Date(job.schedule.isoTimestamp)));
  const [source,setSource] = useState(job.watch?.sourceUrl ?? '');
  const [contains,setContains] = useState(job.watch?.contains ?? '');
  const [expiry,setExpiry] = useState('30');
  const [renew,setRenew] = useState(false);
  const [error,setError] = useState('');
  const field = 'mt-1.5 block w-full rounded-lg border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary';
  return <form className="mt-4 space-y-4 rounded-xl border border-border-subtle bg-bg-surface/60 p-4 text-sm text-text-secondary" onSubmit={event => {
    event.preventDefault();
    try {
      if (!name.trim() || !task.trim()) throw Error('Name and instruction are required.');
      const next:TaskSchedule = kind === 'every' ? {kind,intervalMs:Number(schedule)*60000} : kind === 'cron' ? {kind,expression:schedule} : {kind,isoTimestamp:new Date(schedule).toISOString()};
      if (next.kind === 'every' && (!Number.isFinite(next.intervalMs) || next.intervalMs < 60000)) throw Error('Use an interval of at least one minute.');
      if (job.kind === 'watch' && (new URL(source).protocol !== 'https:' || !contains.trim())) throw Error('Use a HTTPS source and the exact text to verify.');
      edit(job,{name:name.trim(),task:task.trim(),schedule:next,...(job.kind === 'watch' ? {watch:{...job.watch,sourceUrl:source,contains},...(renew ? {expiryDays:Number(expiry)} : {})} : {})});
      close();
    } catch(e) { setError(e instanceof Error ? e.message : String(e)); }
  }}>
    <label className="block">Task name<input aria-label="Task name" value={name} onChange={e=>setName(e.target.value)} className={field}/></label>
    <label className="block">Instruction<textarea aria-label="Instruction" value={task} onChange={e=>setTask(e.target.value)} className={field}/></label>
    <label className="block">Schedule<select aria-label="Schedule type" value={kind} onChange={e=>{const value=e.target.value as TaskSchedule['kind'];setKind(value);setSchedule(value==='every'?'60':value==='cron'?'0 9 * * *':localInput(new Date(Date.now()+3600000)));}} className={field}>
      <option value="every">Every N minutes</option><option value="cron">Cron expression</option>{job.kind !== 'watch' && <option value="at">Once</option>}
    </select></label>
    <label className="block">{kind === 'every' ? 'Interval (minutes)' : kind === 'cron' ? 'Cron expression' : 'Time'}<input aria-label="Schedule value" type={kind==='every'?'number':kind==='at'?'datetime-local':'text'} value={schedule} onChange={e=>setSchedule(e.target.value)} className={field}/></label>
    {job.kind === 'watch' && <>
      <label className="block">Source URL<input aria-label="Source URL" type="url" value={source} onChange={e=>setSource(e.target.value)} className={field}/></label>
      <label className="block">Expected text<input aria-label="Expected text" value={contains} onChange={e=>setContains(e.target.value)} className={field}/></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={renew} onChange={e=>setRenew(e.target.checked)}/>Renew expiry from today</label>
      {renew && <label className="block">Expiry (days)<input aria-label="Expiry (days)" type="number" min="1" max="365" value={expiry} onChange={e=>setExpiry(e.target.value)} className={field}/></label>}
      <p className="text-xs leading-relaxed text-text-muted">After renewing an expired or completed watch, press Resume to start checking again.</p>
    </>}
    {error && <p role="alert" className="text-error">{error}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground">Save changes</button><button type="button" onClick={close} className="rounded-full px-3 py-2 text-sm text-text-muted hover:text-text-primary">Cancel</button></div>
  </form>;
}

function TaskRow({ job }: { job: ScheduledTask }) {
  const remove = useTasks((s) => s.remove);
  const toggle = useTasks((s) => s.toggle);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [editing,setEditing] = useState(false);
  const detailsId = useId();
  const Icon = job.kind === 'reminder' ? Bell : job.kind === 'watch' ? ScanSearch : CalendarClock;
  const runs = [...(job.history ?? [])].reverse();
  const latest = runs[0];
  const completed = latest?.status === 'success' && ((job.schedule.kind === 'at' && !job.nextRunMs) || (job.kind === 'watch' && !job.enabled));
  const state = latest?.status === 'expired' ? 'Expired' : completed ? 'Done' : !job.enabled ? 'Paused' : latest?.status === 'running' ? 'Running' : job.nextRunMs ? 'Active' : 'Not scheduled';
  const measured = runs.filter(r => r.costUsd !== undefined);

  return (
    <li className="rounded-xl border border-border-subtle bg-bg-surface/60">
      <button type="button" aria-label={job.name} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-3 rounded-xl px-4 py-4 text-left transition-colors hover:bg-bg-hover">
        <Icon size={16} aria-hidden className="mt-0.5 shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="break-words text-sm font-semibold text-text-primary">{job.name}</p>
            <span className={cn('hidden text-xs sm:inline', state === 'Active' ? 'text-brand' : 'text-text-muted')}>{state}</span>
          </div>
          <p className="mt-1 text-sm text-text-secondary">{scheduleWords(job.schedule)}</p>
          <p className="mt-1.5 text-xs text-text-muted"><span className="sm:hidden">{state} · </span>{job.kind === 'reminder' ? 'Reminder · Free' : job.kind === 'watch' ? 'Source watch · Free' : <><span className="hidden sm:inline">Uses your model · </span><span className="tabular-nums">${(job.spentUsd ?? 0).toFixed(2)} used</span></>}</p>
        </div>
        <ChevronDown size={16} aria-hidden className={cn('mt-1 shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div id={detailsId} className="border-t border-border-subtle px-4 pb-4 pt-4 sm:px-5">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary">{job.task}</p>
          {job.watch && <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-text-muted">Source</dt><dd className="mt-1"><a href={job.watch.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-brand hover:underline"><span className="break-all">{sourceHost(job.watch.sourceUrl)}</span><ArrowUpRight size={12} className="shrink-0" aria-hidden /></a></dd></div>
            <div><dt className="text-xs text-text-muted">Expires</dt><dd className="mt-1 text-text-primary">{when(job.expiresAt) || 'Not set'}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Notify when this text appears</dt><dd className="mt-1 break-words font-medium text-text-primary">“{job.watch.contains}”</dd></div>
          </dl>}
          {job.kind === 'agent' && <div className="mt-4">
            <dl className="flex flex-wrap gap-x-8 gap-y-3"><div><dt className="text-xs text-text-muted">Used or reserved</dt><dd className="mt-1 text-base font-medium tabular-nums text-text-primary">${(job.spentUsd ?? 0).toFixed(2)}</dd></div></dl>
            <p className="mt-2 text-xs text-text-muted">Includes the allowance held for running or interrupted work.</p>
          </div>}
          {job.nextRunMs && <p className="mt-3 text-xs text-text-muted">Next run {when(job.nextRunMs)}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" aria-label={job.enabled ? `Pause ${job.name}` : `Resume ${job.name}`} onClick={() => toggle(job.id, !job.enabled)}
              className="flex items-center gap-1.5 rounded-full border border-border-default px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover">
              {job.enabled ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}{job.enabled ? 'Pause' : 'Resume'}
            </button>
            <button type="button" onClick={()=>setEditing(!editing)} className="rounded-full px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary">Edit task</button>
            {confirm ? <span className="ml-auto flex items-center gap-1">
              <button type="button" onClick={() => remove(job.id)} className="rounded-full bg-error px-3 py-1.5 text-xs font-medium text-white">Delete</button>
              <button type="button" onClick={() => setConfirm(false)} className="rounded-full px-2 py-1.5 text-xs text-text-muted">Keep</button>
            </span> : <button type="button" aria-label={`Delete ${job.name}`} onClick={() => setConfirm(true)} className="ml-auto flex items-center gap-1 rounded-full px-2 py-1.5 text-xs text-text-muted hover:text-error"><Trash2 size={14} aria-hidden />Delete</button>}
          </div>
          {editing && <TaskEditor job={job} close={()=>setEditing(false)}/>}
          <details className="group/activity mt-4 border-t border-border-subtle pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-xs text-text-muted hover:text-text-primary [&::-webkit-details-marker]:hidden"><span>Activity</span><span className="ml-auto">{runs.length} {runs.length === 1 ? 'run' : 'runs'}</span><ChevronDown size={14} className="group-open/activity:rotate-180" aria-hidden /></summary>
            {job.kind === 'agent' && <p className="mt-3 text-xs text-text-muted">{measured.length ? `Estimated next run: $${(measured.reduce((sum,r)=>sum+(r.costUsd??0),0)/measured.length).toFixed(4)}, based on recent runs. Actual usage varies.` : 'No runs yet, so no cost estimate.'}</p>}
            {runs.length === 0 ? <p className="mt-3 text-sm text-text-muted">It has not run yet.</p> : <ul className="mt-3 space-y-4">
              {runs.map((r) => (
                <li key={r.runAt}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className={cn('text-sm font-medium', r.status === 'success' ? 'text-success' : ['failed','timeout','budget_exceeded'].includes(r.status) ? 'text-error' : 'text-text-secondary')}>{STATUS[r.status] ?? r.status}</span><span className="text-xs text-text-muted">{when(r.runAt)}{r.costUsd !== undefined ? ` · $${r.costUsd.toFixed(4)}` : ''}</span></div>
                  {(r.result || r.error) && <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary">{r.error ?? r.result}</p>}
                  {r.proof && <details className="mt-2 text-xs"><summary className="cursor-pointer text-text-muted hover:text-text-primary">Verified evidence · {sourceHost(r.proof.sourceUrl)}</summary><div className="mt-2 space-y-1 border-l border-border-default pl-3 text-text-secondary"><p>Checked {when(r.proof.checkedAt)}</p><a href={r.proof.sourceUrl} target="_blank" rel="noreferrer" className="block break-all text-brand hover:underline">{r.proof.sourceUrl}</a><p className="break-words leading-relaxed">“{r.proof.excerpt}”</p></div></details>}
                </li>
              ))}
            </ul>}
          </details>
        </div>
      )}
    </li>
  );
}

/** The one weekly limit for all scheduled tasks. The agent changes it too, when asked in chat. */
function WeeklyLimit() {
  const limit = useTasks((s) => s.limit);
  const setLimit = useTasks((s) => s.setLimit);
  const [amount, setAmount] = useState('');
  if (!limit) return null;
  const ok = Number.isFinite(Number(amount)) && Number(amount) > 0;
  return (
    <div className="text-sm">
      <p className="text-text-primary">Weekly spending limit: <span className="font-medium">{limit.weeklyUsd == null ? 'none' : `$${limit.weeklyUsd.toFixed(2)}`}</span></p>
      <p className="mt-1 text-xs text-text-muted">For all scheduled tasks together. Used in the last 7 days: <span className="tabular-nums">${limit.spentUsd.toFixed(2)}</span>. Reminders and source checks are free.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-muted">$</span>
        <input aria-label="New weekly limit in dollars" type="number" min="0.01" step="0.5" value={amount} onChange={e => setAmount(e.target.value)} placeholder={limit.weeklyUsd == null ? '5' : String(limit.weeklyUsd)} className="w-20 rounded-lg border border-border-default bg-bg-surface px-2 py-1 text-text-primary" />
        <button type="button" disabled={!ok} onClick={() => { setLimit(Number(amount)); setAmount(''); }} className="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground disabled:opacity-60">Set limit</button>
        {limit.weeklyUsd != null && <button type="button" onClick={() => setLimit(null)} className="rounded-full px-2 py-1 text-xs text-text-muted hover:text-text-primary">Remove limit</button>}
      </div>
    </div>
  );
}

/** Things Cinderpaw does later: every scheduled task, pause, delete, and what each run said. */
export function TasksPage() {
  const { jobs, loaded, error, refresh } = useTasks();
  const suggestions = useFollowUps(s=>s.enabled);
  const setSuggestions = useFollowUps(s=>s.setEnabled);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
  useEffect(() => { refresh(); const timer=setInterval(refresh,30000); return ()=>clearInterval(timer); }, [refresh]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="mx-auto max-w-3xl px-6 pb-14">
          <header className="mb-6">
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Tasks</h1>
              <button type="button" aria-label="Task settings" aria-expanded={settingsOpen} aria-controls={settingsId} onClick={() => setSettingsOpen(!settingsOpen)} className="flex items-center gap-1.5 rounded-lg py-2 text-sm text-text-muted hover:text-text-primary"><SlidersHorizontal size={14} aria-hidden />Settings</button>
            </div>
            <p className="mt-1 text-sm text-text-muted">Reminders, source checks, and work for later.</p>
            <div id={settingsId} hidden={!settingsOpen} className="mt-4 space-y-3 rounded-xl border border-border-subtle bg-bg-surface/60 p-4">
              <WeeklyLimit />
              <div><label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={suggestions} onChange={e=>setSuggestions(e.target.checked)} className="accent-brand"/>Follow-up suggestions</label><p className="mt-1 text-xs leading-relaxed text-text-muted">Offer unfinished work in chat. Suggestions are free; nothing resumes until you ask.</p></div>
              <div className="space-y-2 border-t border-border-subtle pt-3 text-xs leading-relaxed text-text-muted"><p>Tasks run while Cinderpaw is running, including in the tray. Quit stops them. Missed reminders and source checks catch up once; past agent actions wait for you to resume them.</p><p>Automatic proactivity has a separate monthly limit ($1 by default).</p></div>
            </div>
          </header>
          {error && <p role="alert" className="mt-4 text-sm text-error">{error}</p>}
          {!loaded && !error ? (
            <p className="mt-8 text-sm text-text-muted">Loading…</p>
          ) : jobs.length === 0 ? (
            <div className="mt-8 rounded-xl border border-dashed border-border-default p-6 text-sm text-text-secondary">
              <p className="font-semibold text-text-primary">No tasks yet.</p>
              <p className="mt-1">In a chat, ask for one in your own words, for example "remind me to call the bank on Monday at 9" or "every Friday, sum up my week". Cinderpaw shows a card, and you create it with one click.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {jobs.map((j) => <TaskRow key={j.id} job={j} />)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
