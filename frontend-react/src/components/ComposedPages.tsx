import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useOnboarding } from '@/stores/onboarding';
import type { CardView, PageView } from '@/lib/tauri';
import { PriceGraph } from '@/pages/TasksPage';
import { useTasks } from '@/stores/tasks';
import { cn } from '@/lib/utils';

/**
 * Pages the agent composed for this person (spec 4.14). Every card is drawn
 * from data the engine already resolved; nothing here fetches or guesses, and
 * no piece knows a field (lei, grades, builds all look the same).
 */
export function ComposedPages() {
  const pages = useTasks((s) => s.pages);
  const remove = useTasks((s) => s.removePage);
  if (!pages.length) return <PageIdeas />;
  return <>{pages.map((p) => <Page key={p.id} page={p} remove={() => remove(p.id)} />)}</>;
}

/**
 * The starter set (spec 4.14): with no page yet, a few plain asks for different
 * people, so nobody has to know what to ask. A tap puts the words in the chat
 * box; pressing Enter stays the person's.
 */
export const PAGE_IDEAS = [
  'Make me a page for a price I am waiting to drop',
  'Make me a page that counts down to my exam',
  'Make me a page for my shop: supplier prices and this week',
  'Make me a page for my project: what ran and what broke',
] as const;

function PageIdeas() {
  const navigate = useNavigate();
  return (
    <section aria-labelledby="page-ideas" className="flex flex-col gap-3">
      <h2 id="page-ideas" className="text-sm font-medium text-text-muted">Make a page of your own</h2>
      <div className="flex flex-wrap gap-2">
        {PAGE_IDEAS.map((idea) => (
          <button key={idea} type="button" onClick={() => { useOnboarding.getState().setFirstTask(idea); navigate('/chat'); }}
            className="rounded-full border border-border-default px-3 py-1.5 text-left text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary">{idea}</button>
        ))}
      </div>
    </section>
  );
}

function Page({ page, remove }: { page: PageView; remove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(page.recipe).then(() => setCopied(true), () => {}); };
  const id = `page-${page.id}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-sm font-medium text-text-muted">{page.title}</h2>
        {confirm
          ? <span className="flex gap-1">
              <button type="button" onClick={remove} className="rounded-full bg-error px-3 py-1 text-xs font-medium text-white">Remove page</button>
              <button type="button" onClick={() => setConfirm(false)} className="rounded-full px-2 py-1 text-xs text-text-muted">Keep</button>
            </span>
          : <span className="flex gap-1">
              <button type="button" onClick={copy} title="A copy without your tasks, for someone else to fill in" className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-text-muted hover:text-text-primary"><Copy size={12} aria-hidden />{copied ? 'Copied' : 'Copy recipe'}</button>
              <button type="button" aria-label={`Remove ${page.title}`} onClick={() => setConfirm(true)} className="rounded-full px-2 py-1 text-xs text-text-muted hover:text-error">Remove</button>
            </span>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {page.cards.map((c, i) => <Card key={i} card={c} answer={(yes) => useTasks.getState().answerCard(page.id, i, yes)} />)}
      </div>
    </section>
  );
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const unitOf = (u?: string) => (u ? ` ${u}` : '');

function Card({ card, answer }: { card: CardView; answer: (yes: boolean) => void }) {
  const wide = card.piece === 'number_over_time' || card.piece === 'done_with_proof';
  return (
    <article className={cn('rounded-2xl bg-bg-surface px-5 py-4', wide && 'sm:col-span-2')}>
      <h3 className="text-sm font-medium text-text-primary">{card.label}</h3>
      <Body card={card} answer={answer} />
    </article>
  );
}

function Body({ card, answer }: { card: CardView; answer: (yes: boolean) => void }) {
  switch (card.piece) {
    case 'number_over_time':
      return <PriceGraph reads={card.prices} limit={card.limit} currency={card.unit} />;
    case 'before_after': {
      if (card.before === undefined || card.after === undefined) return <p className="mt-2 text-sm text-text-muted">No reading yet. It fills in after the first check.</p>;
      const diff = card.after - card.before;
      return (
        <p className="mt-2 flex items-baseline gap-2 tabular-nums">
          <span className="text-sm text-text-muted line-through">{fmt(card.before)}{unitOf(card.unit)}</span>
          <span className="text-2xl font-medium text-text-primary">{fmt(card.after)}{unitOf(card.unit)}</span>
          {diff !== 0 && <span className="text-sm text-text-muted">{diff < 0 ? '−' : '+'}{fmt(Math.abs(diff))}</span>}
        </p>
      );
    }
    case 'countdown':
      return <Countdown at={card.at} />;
    case 'done_with_proof':
      if (!card.runs.length) return <p className="mt-2 text-sm text-text-muted">It has not run yet.</p>;
      return (
        <ul className="mt-2 space-y-2">
          {card.runs.map((r) => (
            <li key={r.at} className="flex items-start gap-2 text-sm">
              {r.ok ? <Check size={16} aria-label="Done" className="mt-0.5 shrink-0 text-success" /> : <X size={16} aria-label="Did not work" className="mt-0.5 shrink-0 text-error" />}
              <span className="flex-1 text-text-secondary">{r.text}</span>
              <span className="shrink-0 tabular-nums text-xs text-text-muted">{new Date(r.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
              {r.link && <a href={r.link} target="_blank" rel="noreferrer" aria-label="See proof" className="shrink-0 text-brand"><ArrowUpRight size={14} aria-hidden /></a>}
            </li>
          ))}
        </ul>
      );
    case 'your_numbers':
      return (
        <div className="mt-2">
          <p className="text-sm text-text-secondary"><span className="text-2xl font-medium tabular-nums text-text-primary">{card.wroteFirst}</span> times I wrote first · {card.answered} you used</p>
          <div className="mt-3 flex h-8 items-end gap-1" aria-hidden>
            {card.days.map((d, i) => <span key={i} className="flex-1 rounded-sm bg-brand/70" style={{ height: `${Math.max(8, (d / Math.max(1, ...card.days)) * 100)}%`, opacity: d ? 1 : 0.25 }} />)}
          </div>
        </div>
      );
    case 'plain_list':
      return <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">{card.items.map((it, i) => <li key={i}>{it}</li>)}</ul>;
    case 'question':
      return (
        <div className="mt-2">
          <p className="text-sm text-text-secondary">{card.ask}</p>
          {card.answer
            ? <p className="mt-2 text-sm text-text-muted">{card.answer === 'yes' ? 'You said yes.' : 'You said not now.'}</p>
            : <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => answer(true)} className="rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-white">Yes</button>
                <button type="button" onClick={() => answer(false)} className="rounded-full border border-border-default px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover">Not now</button>
              </div>}
        </div>
      );
    case 'gone':
      return <p className="mt-2 text-sm text-text-muted">The task or watch behind this card was deleted.</p>;
  }
}

/** Days, or hours on the last day. Ticks once a minute, only while shown. */
function Countdown({ at }: { at?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  if (!at) return <p className="mt-2 text-sm text-text-muted">No date yet.</p>;
  const left = at - now;
  const when = new Date(at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const big = left <= 0 ? 'Now' : left < 86_400_000 ? `${Math.max(1, Math.round(left / 3_600_000))} h` : `${Math.ceil(left / 86_400_000)} days`;
  return (
    <p className="mt-2 flex items-baseline gap-2">
      <span className="text-2xl font-medium tabular-nums text-text-primary">{big}</span>
      <span className="text-sm text-text-muted">{when}</span>
    </p>
  );
}
