import { useEffect, useState } from 'react';
import { Check, Moon, X } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import { events, type MetaProposal, type MetaResultLine } from '@/lib/tauri/events';
import { cn } from '@/lib/utils';

const outOf100 = (score: number) => Math.round(score * 100);

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
        ? `Be more careful: keep a new setting only when it is ${Math.round(to * 1000) / 10}% sure it is better, instead of ${Math.round(from * 1000) / 10}%.`
        : `Be a little less strict: keep a new setting when it is ${Math.round(to * 1000) / 10}% sure it is better, instead of ${Math.round(from * 1000) / 10}%. It never goes below 95%.`;
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

/**
 * L6 asks in chat (19 Oct 2026). After its dreams, Cinderpaw prepares one
 * change to HOW it practices; nothing changes until the person says yes here.
 * The words say what changes and what it means for them; the numbers stay
 * small underneath, for whoever wants them.
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
  return (
    <div
      role="group"
      aria-label={undo ? 'Cinderpaw asks to undo a change' : 'Cinderpaw asks to change how it practices'}
      className={cn('rounded-2xl border bg-bg-surface p-4', p ? 'border-warning/40' : 'border-border-default')}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-active text-brand"><Moon size={16} /></span>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-text-primary">
            {undo ? 'Cinderpaw wants to undo a change' : 'Cinderpaw wants to change how it practices'}
          </span>
          {p && (
            <>
              {p.settled === 'accepted' && p.baselineScore !== null && (
                <p className="mt-1.5 text-sm text-text-secondary">
                  Good news: the last change you said yes to helped. Its practice score went from {outOf100(p.baselineScore)} to {outOf100(p.score)} out of 100.
                </p>
              )}
              {undo ? (
                <p className="mt-1.5 text-sm text-text-primary">
                  Last time you said yes to this: {changeWords(p.field, p.to, p.from)} It did not help. Its practice score went from{' '}
                  {outOf100(p.baselineScore ?? 0)} to {outOf100(p.score)} out of 100. Undo it and go back to how it was?
                </p>
              ) : (
                <p className="mt-1.5 text-sm text-text-primary">It wants to {lowerFirst(changeWords(p.field, p.from, p.to))}</p>
              )}
              <p className="mt-1.5 text-2xs text-text-muted">
                {undo
                  ? 'Nothing changes unless you say yes.'
                  : 'Nothing changes unless you say yes. If you do, it tries this for at least 5 dreams, then tells you here whether it helped. You can undo it anytime in Settings, Learning.'}
                {' '}
                <span className="tabular-nums">({p.field.replace(/_/g, ' ')}: {p.from} → {p.to}, from its last {p.cycles} dreams)</span>
              </p>
              <div className="mt-3 flex items-center gap-2">
                {sending ? (
                  <span className="text-xs text-text-muted">Sending…</span>
                ) : (
                  <>
                    <button type="button" onClick={() => void answer(false)}
                      className="rounded-lg border border-border-default bg-bg-elevated px-3.5 py-1.5 text-sm font-medium text-text-primary hover:bg-text-primary/5">
                      Deny
                    </button>
                    <button type="button" onClick={() => void answer(true)}
                      className="rounded-lg bg-brand px-3.5 py-1.5 text-sm font-medium text-brand-foreground hover:opacity-90">
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
      </div>
    </div>
  );
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
