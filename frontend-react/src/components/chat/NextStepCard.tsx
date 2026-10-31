import { useState } from 'react';
import { X } from 'lucide-react';

/**
 * The next-step card closing a finished reply: the agent's `followups` with an
 * `ask`. One question and one or two answers, the agent's recommendation first,
 * like the box under a Claude reply (Darius, 31 Oct: "cu 2 optiuni clare").
 * An answer is sent at once as the person's message; X just closes the card.
 * The task card's buttons, so the two read as one family.
 */
export function NextStepCard({ ask, next, onAnswer }: { ask: string; next: string[]; onAnswer: (text: string) => void }) {
  const [closed, setClosed] = useState(false);
  if (closed || next.length === 0) return null;
  const [first, second] = next;
  return (
    <section aria-label="Next step" className="relative rounded-2xl border border-border-default bg-bg-elevated/60 p-4 pr-10">
      <p className="text-sm font-medium leading-snug text-text-primary">{ask}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onAnswer(first)}
          className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90 cursor-pointer">
          {first}
        </button>
        {second && (
          <button type="button" onClick={() => onAnswer(second)}
            className="rounded-full border border-border-default px-4 py-2 text-sm text-text-secondary hover:bg-text-primary/5 hover:text-text-primary cursor-pointer">
            {second}
          </button>
        )}
      </div>
      <button type="button" aria-label="Close" onClick={() => setClosed(true)}
        className="absolute right-2 top-2 rounded-full p-1.5 text-text-muted hover:bg-text-primary/5 hover:text-text-primary cursor-pointer">
        <X size={14} aria-hidden />
      </button>
    </section>
  );
}
