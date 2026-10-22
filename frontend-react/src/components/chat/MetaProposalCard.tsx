import { useEffect, useState } from 'react';
import { ArrowRight, Check, Cloud, Sparkles, TrendingDown, TrendingUp, X } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import { events, type MetaProposal, type MetaResultLine } from '@/lib/tauri/events';
import { cn } from '@/lib/utils';

const outOf100 = (score: number) => Math.round(score * 100);
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** One sentence, in plain words, for a change of `field` from `from` to `to`. */
export function changeWords(field: MetaProposal['field'], from: number, to: number): string {
  const up = to > from;
  switch (field) {
    case 'dream_batch':
      return up
        ? `Try ${to} ideas in each dream instead of ${from}. Dreams take a bit longer, and on a cloud model they cost a bit more, never past your spending limit.`
        : `Try ${to} ideas in each dream instead of ${from}. Dreams are shorter and cost less.`;
    case 'confidence_gate':
      return up
        ? `Be more careful: keep a new setting only when it is ${pct(to)} sure it is better, instead of ${pct(from)}.`
        : `Be a little less strict: keep a new setting when it is ${pct(to)} sure it is better, instead of ${pct(from)}. It never goes below 95%.`;
    case 'mutation_rate':
      return up
        ? 'Try bigger changes when it practices. It may find a better setting sooner, but more of its tries will miss.'
        : 'Try smaller, safer changes when it practices. Fewer tries will miss, but it gets better more slowly.';
    case 'exploration':
      return up
        ? 'Try brand-new ideas more often, instead of only tweaking what already works.'
        : 'Stick closer to what already works, and try brand-new ideas less often.';
    case 'selection_pressure':
      return up
        ? 'Build more on its very best tries, and less on the others.'
        : 'Give its other tries more of a chance, not only the very best ones.';
  }
}

/** What one side of the before → after tiles says: a number where the
 *  number means something to a person, a word where it would not. */
export function tileWords(field: MetaProposal['field'], value: number, other: number, side: 'from' | 'to'): { big: string; small: string } {
  switch (field) {
    case 'dream_batch':
      return { big: String(value), small: 'ideas per dream' };
    case 'confidence_gate':
      return { big: pct(value), small: 'sure before it keeps a change' };
    default: {
      const small = field === 'mutation_rate' ? 'change per try' : field === 'exploration' ? 'brand-new ideas' : 'focus on the best tries';
      return { big: side === 'from' ? 'Now' : value > other ? 'More' : 'Less', small };
    }
  }
}

/** First sentence bold, the rest plain: the change itself is read first. */
function Lead({ text }: { text: string }) {
  const cut = text.indexOf('. ');
  const head = cut === -1 ? text : text.slice(0, cut + 1);
  const tail = cut === -1 ? '' : text.slice(cut + 2);
  return (
    <p className="mt-3 text-sm leading-relaxed text-text-secondary">
      <span className="font-semibold text-text-primary">{head}</span>
      {tail && ` ${tail}`}
    </p>
  );
}

/**
 * L6 asks in chat (19 Oct 2026). After its dreams, Cinderpaw prepares one
 * change to HOW it practices; nothing changes until the person says yes here.
 * Layout from his reference (Direction 2): the verdict on the last change as
 * one line, the change as two tiles (before → after), the sentence that says
 * what it means for them, and the exact knob quietly by the buttons.
 */
export function MetaProposalCard() {
  const [p, setP] = useState<MetaProposal | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const offs: (() => void)[] = [];
    void events.onMetaProposal.listen((e) => {
      if (!alive) return;
      setP(e.proposal);
      if (e.proposal) setDone(null);
    }).then((off) => (alive ? offs.push(off) : off()), () => { /* outside the app: no events */ });
    void events.onMetaResult.listen((e: MetaResultLine) => {
      if (!alive || (e.op !== 'approve' && e.op !== 'deny')) return;
      setSending(false);
      setDone(
        !e.ok ? { ok: false, text: e.reason ?? 'Nothing was changed.' }
        : e.op === 'deny' ? { ok: false, text: "Okay, nothing changed. Cinderpaw won't ask about this again for a while." }
        : { ok: true, text: 'Done. After a few more dreams, Cinderpaw will tell you here whether it helped.' },
      );
    }).then((off) => (alive ? offs.push(off) : off()), () => { /* outside the app: no events */ });
    // Ask once on mount: a card made while this chat was closed is still waiting.
    void tauri.rsi.meta('proposal').catch(() => { /* sidecar not running */ });
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);

  if (!p && !done) return null;

  const answer = async (approve: boolean) => {
    if (!p) return;
    setSending(true);
    try {
      await tauri.rsi.meta(approve ? 'approve' : 'deny', p.id);
    } catch (err) {
      setSending(false);
      setDone({ ok: false, text: `Not sent: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const undo = p?.kind === 'undo';
  const before = p && tileWords(p.field, p.from, p.to, 'from');
  const after = p && tileWords(p.field, p.to, p.from, 'to');
  return (
    <div
      role="group"
      aria-label={undo ? 'Cinderpaw asks to undo a change' : 'Cinderpaw asks to change how it practices'}
      className="rounded-2xl border border-border-default bg-bg-surface p-5"
    >
      <h3 className="font-display text-lg leading-snug text-text-primary">
        {undo ? 'Cinderpaw wants to undo a change' : 'Cinderpaw wants to change how it practices'}
      </h3>
      {p && (
        <>
          {p.baselineScore !== null && (p.settled === 'accepted' || undo) && (
            <p className={cn('mt-1 flex items-center gap-1.5 text-xs font-medium', undo ? 'text-warning' : 'text-success')}>
              {undo ? <TrendingDown size={14} /> : <TrendingUp size={14} />}
              <span>
                {undo ? 'Your last yes did not help' : 'Your last yes helped'}: practice score{' '}
                <span className="tabular-nums">{outOf100(p.baselineScore)} → {outOf100(p.score)}</span> out of 100
              </span>
            </p>
          )}
          {before && after && (
            <div className="mt-4 flex items-stretch gap-3" aria-hidden>
              <div className="relative flex-1 overflow-hidden rounded-xl bg-bg-elevated px-4 py-3 text-center">
                <p className="text-2xl font-semibold tabular-nums text-text-primary">{before.big}</p>
                <p className="text-xs text-text-secondary">{before.small}</p>
                <Cloud size={20} className="absolute bottom-1.5 left-2 text-text-disabled/60" />
              </div>
              <ArrowRight size={20} className="shrink-0 self-center text-text-muted" />
              <div className="relative flex-1 overflow-hidden rounded-xl border border-success/25 bg-success/10 px-4 py-3 text-center">
                <p className="text-2xl font-semibold tabular-nums text-text-primary">{after.big}</p>
                <p className="text-xs text-text-secondary">{after.small}</p>
                <Sparkles size={14} className="absolute right-2.5 top-2 text-success/70" />
                <Cloud size={20} className="absolute bottom-1.5 right-2 text-success/40" />
              </div>
            </div>
          )}
          <Lead text={undo
            ? `It wants to go back to how it was: ${lowerFirst(changeWords(p.field, p.from, p.to))}`
            : `It wants to ${lowerFirst(changeWords(p.field, p.from, p.to))}`}
          />
          <p className="mt-2 text-2xs leading-relaxed text-text-muted">
            {undo
              ? 'Nothing changes unless you say yes.'
              : 'Nothing changes unless you say yes. If you do, it tries this for at least 5 dreams, then tells you here whether it helped. You can undo it anytime in Settings, Learning.'}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {/* The exact knob, for whoever wants it; the sentence above is the answer. */}
            <span className="mr-auto text-micro tabular-nums text-text-disabled">
              {p.field.replace(/_/g, ' ')} {p.from} → {p.to} · last {p.cycles} dreams
            </span>
            {sending ? (
              <span className="text-xs text-text-muted">Sending…</span>
            ) : (
              <>
                <button type="button" onClick={() => void answer(false)}
                  className="rounded-lg border border-border-default bg-bg-elevated px-4 py-1.5 text-sm font-medium text-text-primary hover:bg-text-primary/5">
                  Deny
                </button>
                <button type="button" onClick={() => void answer(true)}
                  className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground hover:opacity-90">
                  Approve
                </button>
              </>
            )}
          </div>
        </>
      )}
      {!p && done && (
        <p className={cn('mt-2 flex items-center gap-1.5 text-xs', done.ok ? 'text-success' : 'text-text-muted')}>
          {done.ok ? <Check size={14} /> : <X size={14} />}
          {done.text}
        </p>
      )}
    </div>
  );
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
