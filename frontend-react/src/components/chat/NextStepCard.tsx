import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The next-step card closing a finished reply: the agent's `followups` with an
 * `ask`. One question and one or two answers, the agent's recommendation first,
 * like the box under a Claude reply (Darius, 31 Oct: "cu 2 optiuni clare").
 * An answer is sent at once as the person's message. Once the chat has moved on
 * the card stays, greyed and no longer clickable, with the reply they sent
 * ticked, like Claude's. X closes it. The task card's buttons, so the two read
 * as one family.
 */
export function NextStepCard({ ask, next, onAnswer, answered }: {
  ask: string;
  next: string[];
  /** Absent once the chat has moved on: the card is a record then. */
  onAnswer?: (text: string) => void;
  /** What the person wrote next, to tick the answer they picked. */
  answered?: string;
}) {
  const [closed, setClosed] = useState(false);
  if (closed || next.length === 0) return null;
  const done = !onAnswer;
  const picked = answered?.trim();
  return (
    <section aria-label="Next step" className={cn('relative rounded-2xl border border-border-default bg-bg-elevated/60 p-4', !done && 'pr-10')}>
      <p className={cn('text-sm font-medium leading-snug', done ? 'text-text-secondary' : 'text-text-primary')}>{ask}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {next.slice(0, 2).map((text, i) => done ? (
          <span key={text} aria-disabled="true"
            className={cn('inline-flex items-center gap-1.5 rounded-full border border-border-subtle px-4 py-2 text-sm text-text-muted',
              picked === text && 'border-border-default text-text-secondary')}>
            {picked === text && <Check size={14} aria-label="Your answer" />}
            {text}
          </span>
        ) : (
          <button key={text} type="button" onClick={() => onAnswer(text)}
            className={i === 0
              ? 'rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90 cursor-pointer'
              : 'rounded-full border border-border-default px-4 py-2 text-sm text-text-secondary hover:bg-text-primary/5 hover:text-text-primary cursor-pointer'}>
            {text}
          </button>
        ))}
      </div>
      {!done && (
        <button type="button" aria-label="Close" onClick={() => setClosed(true)}
          className="absolute right-2 top-2 rounded-full p-1.5 text-text-muted hover:bg-text-primary/5 hover:text-text-primary cursor-pointer">
          <X size={14} aria-hidden />
        </button>
      )}
    </section>
  );
}
