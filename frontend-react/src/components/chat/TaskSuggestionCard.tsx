import { useEffect, useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Bell, CalendarClock, ChevronDown, ScanSearch } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TaskCard } from '@/lib/widgets';
import { isCreated, useTasks } from '@/stores/tasks';
import { GooeyCard } from './GooeyCard';
import { BASE } from '@/lib/motion';

/**
 * A task the agent offered (`suggest_task`), at the end of the reply it came
 * with, as if it noticed on its own. Nothing exists until Create: the card says
 * what it will do, when, and whether it costs anything, so the click is an
 * informed one. It stays until the person acts; then it goes, on a spring (his
 * call, 24 Oct, after Sileo's toasts): Not now at once, Create after a moment
 * of "Created". A card whose task already exists is not shown again on reload.
 *
 * The first card ever for a task that uses the model also asks, once, whether
 * scheduled tasks get a weekly spending limit (24 Oct, Darius). None is the
 * default, like OpenClaw and Hermes Agent; the person can change it later on the
 * Tasks page or just by asking Cinderpaw.
 */
export function TaskSuggestionCard({ card, sessionId }: { card: TaskCard; sessionId: string }) {
  const reduced = useReducedMotion();
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const jobs = useTasks((s) => s.jobs);
  const loaded = useTasks((s) => s.loaded);
  const pressed = useTasks((s) => s.creating[card.id]);
  const dismissed = useTasks((s) => !!s.dismissed[card.id]);
  const create = useTasks((s) => s.create);
  const dismiss = useTasks((s) => s.dismiss);
  const refresh = useTasks((s) => s.refresh);
  const limit = useTasks((s) => s.limit);
  const setLimit = useTasks((s) => s.setLimit);
  // Asked once ever, on the first card whose task uses the model.
  const askLimit = card.kind === 'agent' && limit !== null && !limit.asked;
  const [wantsLimit, setWantsLimit] = useState(false);
  const [weekly, setWeekly] = useState('5');
  const weeklyOk = Number.isFinite(Number(weekly)) && Number(weekly) > 0;
  useEffect(() => { if (!loaded) refresh(); }, [loaded, refresh]);

  const justCreated = pressed?.state === 'created';
  const created = justCreated || isCreated(jobs, card);
  // Seen "Created" long enough to read it, then out.
  const [settled, setSettled] = useState(false);
  const [expiry, setExpiry] = useState(String(card.expiryDays ?? 30));
  useEffect(() => {
    if (!justCreated) return;
    const t = setTimeout(() => setSettled(true), 1800);
    return () => clearTimeout(t);
  }, [justCreated]);
  // Created in an earlier visit: nothing left to decide, nothing to show.
  if (created && !justCreated) return null;
  const visible = !dismissed && !settled;
  const reminder = card.kind === 'reminder';
  const watch = card.kind === 'watch';
  const Icon = reminder ? Bell : watch ? ScanSearch : CalendarClock;
  let sourceHost = 'Source page';
  try { sourceHost = new URL(card.watch?.sourceUrl ?? '').hostname.replace(/^www\./, ''); } catch { /* The full source stays available in Details. */ }
  const cost = limit?.weeklyUsd != null ? `Uses your AI model · weekly limit $${limit.weeklyUsd}` : 'Uses your AI model';

  return (
    <AnimatePresence>
    {visible && (
    <motion.section
      aria-label="Suggested task"
      initial={false}
      animate={{ opacity: 1, y: 0, height: 'auto' }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.96, height: 0, marginTop: 0, paddingTop: 0, paddingBottom: 0 }}
      transition={reduced ? { duration: 0 } : BASE}>
      <GooeyCard key={card.id}>
      <div className="min-w-0 p-1">
          <div className="flex items-start gap-1.5 text-xs text-text-muted">
            <Icon size={14} aria-hidden className="mt-0.5 shrink-0" />
            <span>{reminder ? 'Reminder · Free' : watch ? 'Source watch · Free' : cost}</span>
          </div>
          <p className="mt-2 text-base font-semibold leading-snug tracking-tight text-text-primary">{card.title}</p>
          <p className="mt-1 text-sm font-medium text-text-primary">{card.when}</p>
          {watch && card.watch ? (
            <p className="mt-3 break-words text-sm leading-relaxed text-text-secondary">
              Notify when <span className="font-medium text-text-primary">“{card.watch.contains}”</span> appears on{' '}
              <a href={card.watch.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-0.5 text-brand hover:underline">
                <span className="break-all">{sourceHost}</span><ArrowUpRight size={12} className="shrink-0" aria-hidden />
              </a>.
            </p>
          ) : <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-text-secondary">{card.task}</p>}
          {askLimit && !created && (
            <fieldset className="mt-4 rounded-xl border border-border-subtle p-3 text-sm">
              <legend className="px-1 text-xs text-text-muted">Spending limit for scheduled tasks (asked once)</legend>
              <label className="flex items-start gap-2 py-1">
                <input type="radio" name={`limit-${card.id}`} checked={!wantsLimit} onChange={() => setWantsLimit(false)} className="mt-1" />
                <span><span className="text-text-primary">No limit</span><span className="block text-xs text-text-muted">Tasks use your own API key. You can also set a cap in your AI provider's account.</span></span>
              </label>
              <label className="flex flex-wrap items-center gap-2 py-1">
                <input type="radio" name={`limit-${card.id}`} checked={wantsLimit} onChange={() => setWantsLimit(true)} />
                <span className="text-text-primary">Up to $</span>
                <input aria-label="Weekly limit in dollars" type="number" min="0.01" step="0.5" value={weekly} onFocus={() => setWantsLimit(true)} onChange={e => setWeekly(e.target.value)} className="w-20 rounded-lg border border-border-default bg-bg-surface px-2 py-1 text-text-primary" />
                <span className="text-text-primary">a week, for all tasks together</span>
              </label>
              <p className="mt-1 text-xs text-text-muted">Change it any time on the Tasks page, or just ask Cinderpaw.</p>
            </fieldset>
          )}
          {created ? (
            <p className="mt-4 text-sm text-text-primary">
              Created. <Link to="/tasks" className="text-brand underline-offset-2 hover:underline">See it in Tasks</Link>
            </p>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-1">
              <button type="button" disabled={pressed?.state === 'creating' || (askLimit && wantsLimit && !weeklyOk) || (card.kind === 'watch' && (Number(expiry) < 1 || Number(expiry) > 365))} onClick={() => { if (askLimit) setLimit(wantsLimit ? Number(weekly) : null); create({...card,...(card.kind === 'watch' ? {expiryDays:Number(expiry)} : {})}, sessionId); }}
                className="rounded-full bg-brand px-3 py-2 text-sm font-medium text-brand-foreground hover:opacity-90 disabled:opacity-60 sm:px-4">
                {pressed?.state === 'creating' ? 'Creating…' : 'Create task'}
              </button>
              <button type="button" onClick={() => dismiss(card.id)}
                className="rounded-full px-2 py-2 text-sm text-text-muted hover:bg-text-primary/5 hover:text-text-primary sm:px-3">
                Not now
              </button>
              <button type="button" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(!detailsOpen)}
                className="ml-auto flex items-center gap-1 rounded-lg py-2 text-xs text-text-muted hover:text-text-primary sm:px-1">
                Details <ChevronDown size={14} aria-hidden className={detailsOpen ? 'rotate-180' : ''} />
              </button>
            </div>
          )}
          {pressed?.state === 'failed' && <p role="alert" className="mt-2 text-sm text-error">Not created. {pressed.error}</p>}
          <div id={detailsId} hidden={!detailsOpen || created} className="mt-4 space-y-4 border-t border-border-subtle pt-4 text-sm text-text-secondary">
            {!watch && <div><p className="text-xs text-text-muted">Instruction</p><p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{card.task}</p></div>}
            {card.kind === 'agent' && !askLimit && <p className="text-xs leading-relaxed text-text-muted">Each run uses your own API key. {limit?.weeklyUsd != null ? `All scheduled tasks share a weekly limit of $${limit.weeklyUsd}.` : 'There is no weekly limit; ask Cinderpaw or open Tasks to set one.'}</p>}
            {watch && card.watch && <div className="space-y-3">
              <div><p className="text-xs text-text-muted">Full source</p><a href={card.watch.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-brand hover:underline">{card.watch.sourceUrl}</a></div>
              <label className="flex flex-wrap items-center justify-between gap-2">Watch expiry (days)
                <input aria-label="Watch expiry (days)" type="number" min="1" max="365" value={expiry} onChange={e => setExpiry(e.target.value)} className="w-24 rounded-lg border border-border-default bg-bg-surface px-3 py-1.5 text-text-primary" />
              </label>
              <p className="text-xs leading-relaxed text-text-muted">Uses no AI. Stops after the first verified match or expiry; renew it in Tasks. Prefer the publisher’s official source.</p>
            </div>}
            <p className="text-xs leading-relaxed text-text-muted">Runs while Cinderpaw is running, including in the tray. Quit stops it. Missed reminders may appear once on restart; sensitive actions need your confirmation.</p>
          </div>
      </div>
      </GooeyCard>
    </motion.section>
    )}
    </AnimatePresence>
  );
}
