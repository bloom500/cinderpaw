import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Clock } from 'lucide-react';
import type { ScheduledTask } from '@/lib/tauri';
import { tauri } from '@/lib/tauri';
import { useT } from '@/lib/i18n';
import { greetingKey } from '@/components/shell/HomeGreeting';
import { useTasks } from '@/stores/tasks';
import { useFollowUps } from '@/stores/followUps';
import { useOnboarding } from '@/stores/onboarding';
import { ComposedPages } from '@/components/ComposedPages';

/**
 * Today (spec 4.13, slice 3; mockup canvas 6dDtSAjoLHXtvUC6ZmHYgW board 1):
 * what needs you, what is planned for today, and what the agent already did,
 * each from data the app has (the follow-up card, the scheduled tasks and
 * their run history). Home stays as it is until Darius has seen this live.
 */

const DAY = 24 * 60 * 60_000;
const startOfDay = (now: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** Enabled tasks whose next run falls later today, earliest first. */
export function plannedToday(jobs: ScheduledTask[], now: number) {
  const end = startOfDay(now) + DAY;
  return jobs
    .filter((j) => j.enabled && j.nextRunMs !== undefined && j.nextRunMs >= now && j.nextRunMs < end)
    .sort((a, b) => a.nextRunMs! - b.nextRunMs!);
}

/** Runs that went well since the start of yesterday, newest first. */
export function doneLately(jobs: ScheduledTask[], now: number) {
  const from = startOfDay(now) - DAY;
  return jobs
    .flatMap((job) => job.history.filter((r) => r.runAt >= from && r.status === 'ok').map((run) => ({ job, run })))
    .sort((a, b) => b.run.runAt - a.run.runAt);
}

export function headline(needs: number) {
  if (needs === 0) return 'Nothing needs you right now. The rest is handled.';
  return `${needs === 1 ? 'One thing needs' : `${needs} things need`} you. The rest is handled.`;
}

function report(action: 'nudge_opened' | 'nudge_dismissed', cardId: string) {
  void tauri.raw.cinderpawCronOp(crypto.randomUUID(), action, { jobId: cardId }).catch(() => {});
}

/**
 * How often the agent wrote first this week and how often that helped,
 * straight from the ledger on this computer (spec 4.13, 4.12).
 */
function ThisWeek({ agent, week, now }: { agent: string; week: { wroteFirst: number; answered: number; days: number[] }; now: number }) {
  const most = Math.max(1, ...week.days);
  const dayName = (i: number) => new Date(now - (6 - i) * DAY).toLocaleDateString('en-GB', { weekday: 'narrow' });
  return (
    <section aria-labelledby="today-week" className={SECTION}>
      <h2 id="today-week" className={LABEL}>This week with {agent}</h2>
      <div className="flex flex-wrap items-end justify-between gap-6 rounded-2xl bg-bg-surface px-6 py-5">
        <dl className="flex gap-8">
          <div>
            <dt className="text-sm text-text-muted">Wrote to you first</dt>
            <dd className="font-display text-3xl tabular-nums text-text-primary">{week.wroteFirst}</dd>
          </div>
          <div>
            <dt className="text-sm text-text-muted">You opened or answered</dt>
            <dd className="font-display text-3xl tabular-nums text-text-primary">{week.answered}</dd>
          </div>
        </dl>
        <figure className="flex flex-col items-end gap-1.5">
          <div className="flex h-12 items-end gap-1.5" role="img" aria-label={`Messages per day, last 7 days: ${week.days.join(', ')}`}>
            {week.days.map((n, i) => (
              <span key={i} className={`w-3 rounded-sm ${i === 6 ? 'bg-brand' : 'bg-text-muted/40'}`} style={{ height: `${Math.max(8, (n / most) * 100)}%` }} />
            ))}
          </div>
          <div aria-hidden className="flex gap-1.5">
            {week.days.map((_, i) => <span key={i} className="w-3 text-center text-2xs text-text-muted">{dayName(i)}</span>)}
          </div>
        </figure>
        <SendNumbers />
      </div>
    </section>
  );
}

/**
 * "Send my numbers" (spec 4.12): nothing leaves until the person presses it, and then only counts.
 * The same counts are written to telemetry-sent.jsonl first (Settings, Privacy shows that file).
 */
export function SendNumbers() {
  const numbers = useTasks((s) => s.numbers);
  const send = useTasks((s) => s.sendNumbers);
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
      <p>
        {numbers.state === 'sent' ? 'Sent. Thank you for helping make it better.'
          : numbers.state === 'failed' ? `Not sent. ${numbers.error ?? ''}`
          : 'Stays on this computer. You can send only these counts to help us: no messages, no names, no times.'}
      </p>
      {numbers.state !== 'sent' && (
        <button type="button" disabled={numbers.state === 'sending'} onClick={send}
          className="rounded-full border border-border-default px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:opacity-60">
          {numbers.state === 'sending' ? 'Sending…' : numbers.state === 'failed' ? 'Try again' : 'Send my numbers'}
        </button>
      )}
    </div>
  );
}

const SECTION = 'flex flex-col gap-3';
const LABEL = 'text-sm font-medium text-text-muted';
const LIST = 'rounded-2xl bg-bg-surface py-1.5';
const ROW = 'flex min-h-[52px] items-center gap-3.5 px-6';

/**
 * What the agent learned to stop saying (spec 4.7), each line with Undo.
 * Hidden while there is nothing learned: an empty list says nothing useful.
 */
export function Learned() {
  const learned = useTasks((s) => s.learned);
  const undo = useTasks((s) => s.undoLearned);
  if (!learned.length) return null;
  return (
    <section aria-labelledby="today-learned" className={SECTION}>
      <h2 id="today-learned" className={LABEL}>What I learned</h2>
      <ul className="space-y-2">
        {learned.map((l) => (
          <li key={l.bucket} className="flex items-start justify-between gap-3 text-sm text-text-secondary">
            <span>{l.line}</span>
            <button type="button" onClick={() => undo(l.bucket)} className="shrink-0 rounded-full border border-border-default px-3 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover">Undo</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TodayPage() {
  const t = useT();
  const navigate = useNavigate();
  const { jobs, loaded, refresh, week } = useTasks();
  const followUp = useFollowUps();
  const { userName, agentName } = useOnboarding();
  const [proof, setProof] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    refresh();
    const timer = setInterval(() => { refresh(); setNow(Date.now()); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const key = greetingKey();
  const name = userName.trim();
  const hello = name && !key.startsWith('home.night') ? `${t(key)}, ${name}.` : t(key);
  const card = followUp.enabled && followUp.card && followUp.expiresAt > now ? followUp.card : null;
  const planned = plannedToday(jobs, now);
  const done = doneLately(jobs, now);
  const agent = agentName.trim() || 'Cinderpaw';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <main className="mx-auto flex max-w-[764px] flex-col gap-10 px-6 pb-16 pt-6">
          <header className="flex flex-col gap-1.5">
            <span className="text-sm text-text-muted">
              {new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
            <h1 className="font-display text-4xl font-normal tracking-tight text-text-primary">{hello}</h1>
            <p className="text-lg text-text-secondary">{headline(card ? 1 : 0)}</p>
          </header>

          {card && (
            <section aria-labelledby="today-needs" className={SECTION}>
              <h2 id="today-needs" className={LABEL}>Needs you</h2>
              <article className="flex flex-col gap-3.5 rounded-2xl bg-bg-surface px-6 py-5">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden className="h-2 w-2 rounded-full bg-brand" />
                  <span className="text-sm text-text-muted">Unfinished work</span>
                </div>
                <div>
                  <h3 className="text-lg font-medium text-text-primary">You left something unfinished</h3>
                  <p className="line-clamp-2 text-text-secondary">{card.mission}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button type="button" className="min-h-11 rounded-lg bg-brand px-4 text-sm font-medium text-white hover:brightness-110 active:scale-[.97]" onClick={() => {
                    report('nudge_opened', card.id);
                    navigate(`/chat/${encodeURIComponent(card.sessionId)}`);
                    followUp.dismiss();
                  }}>Open conversation</button>
                  <button type="button" className="min-h-11 rounded-lg border border-border-default px-4 text-sm text-text-primary hover:bg-bg-active active:scale-[.97]" onClick={() => {
                    report('nudge_dismissed', card.id);
                    followUp.dismiss();
                  }}>Not now</button>
                  <span className="text-sm text-text-muted">Nothing resumes until you ask.</span>
                </div>
              </article>
            </section>
          )}

          <section aria-labelledby="today-planned" className={SECTION}>
            <h2 id="today-planned" className={LABEL}>Today</h2>
            <ul className={LIST}>
              {planned.length === 0 && (
                <li className={`${ROW} text-text-muted`}>{loaded ? 'Nothing planned for the rest of today.' : 'Looking…'}</li>
              )}
              {planned.map((job, i) => (
                <li key={job.id} className={`${ROW} ${i > 0 ? 'border-t border-border-subtle' : ''}`}>
                  <Clock size={18} aria-hidden className="shrink-0 text-text-muted" />
                  <span className="flex-1 text-text-primary">{job.name}</span>
                  <span className="text-sm tabular-nums text-text-muted">{hhmm(job.nextRunMs!)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="today-done" className={SECTION}>
            <h2 id="today-done" className={LABEL}>Done by {agent} · since yesterday</h2>
            <ul className={LIST}>
              {done.length === 0 && (
                <li className={`${ROW} text-text-muted`}>Nothing yet. When I finish something for you, it shows here.</li>
              )}
              {done.map(({ job, run }, i) => {
                const id = `${job.id}-${run.runAt}`;
                const said = run.proof ? `“${run.proof.excerpt}” on ${new URL(run.proof.sourceUrl).hostname}` : run.result;
                return (
                  <li key={id} className={i > 0 ? 'border-t border-border-subtle' : ''}>
                    <div className={ROW}>
                      <Check size={18} aria-hidden className="shrink-0 text-success" />
                      <span className="flex-1 text-text-primary">{job.name}</span>
                      <span className="text-sm tabular-nums text-text-muted">{hhmm(run.runAt)}</span>
                      {said && (
                        <button type="button" aria-expanded={proof === id} onClick={() => setProof(proof === id ? null : id)} className="min-h-11 text-sm text-brand hover:underline">
                          {proof === id ? 'Hide' : 'See proof'}
                        </button>
                      )}
                    </div>
                    {proof === id && said && (
                      <p className="whitespace-pre-wrap px-6 pb-4 pl-[56px] text-sm text-text-secondary">{said.length > 600 ? `${said.slice(0, 600)}…` : said}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <ComposedPages />
          {week && <ThisWeek agent={agent} week={week} now={now} />}
          <Learned />
        </main>
      </div>
    </div>
  );
}
