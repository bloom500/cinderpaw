import { useEffect, useState } from 'react';
import { Lightbulb, X } from 'lucide-react';
import { useChat } from '@/stores/chat';
import { useHeadsUp, type HeadsUpChoice } from '@/stores/headsUp';
import { cn } from '@/lib/utils';

/** Typing in a field must never trigger a card: 1, 2, 3 only act outside one. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

function Pill({ n, primary, label, onClick }: { n: number; primary?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-xs font-medium transition-colors',
        primary
          ? 'bg-brand text-brand-foreground hover:opacity-90'
          : 'border border-border-default text-text-primary hover:bg-text-primary/5',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold tabular-nums',
          primary ? 'bg-brand-foreground text-brand' : 'bg-text-primary/10 text-text-secondary',
        )}
      >
        {n}
      </span>
      {label}
    </button>
  );
}

/**
 * "Something you should know": one low bar above the message box, shown while
 * the agent keeps working (the `heads_up` tool). Same width and material as
 * the composer under it; layout from his reference (19 Oct): icon tile, the
 * finding, then numbered answers. Learn more opens the agent's evidence in
 * place; "I already knew this" tells the agent to flag less of the obvious.
 */
export function HeadsUpCard() {
  const sessionId = useChat((s) => s.sessionId);
  const card = useHeadsUp((s) => s.bySession[sessionId]);
  const answer = useHeadsUp((s) => s.answer);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = !!card && openId === card.id;

  const choose = (choice: HeadsUpChoice) => {
    if (!card) return;
    if (choice === 'more') setOpenId(card.id);
    answer(sessionId, choice);
  };

  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const choice = ({ '1': card.more && !open ? 'more' : null, '2': 'knew', '3': 'dismiss' } as Record<string, HeadsUpChoice | null>)[e.key];
      if (choice) {
        e.preventDefault();
        choose(choice);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!card) return null;

  return (
    <section aria-label="Something you should know" className="mx-auto w-full max-w-[764px] px-4 pb-2">
      <div className="relative rounded-2xl border border-border-default bg-(--surface-typing) liquid-glass liquid-glass-rim px-3 py-2.5">
        <button type="button" aria-label="Close" onClick={() => choose('dismiss')}
          className="absolute right-2 top-2 rounded-full p-1 text-text-muted hover:bg-text-primary/5 hover:text-text-primary">
          <X size={15} />
        </button>
        <div className="flex gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-foreground">
            <Lightbulb size={19} aria-hidden />
          </span>
          <span aria-hidden className="w-px shrink-0 self-stretch bg-border-default" />
          <div className="min-w-0 flex-1 pr-6">
            <p className="text-sm font-semibold text-text-primary">{card.title}</p>
            <p className="text-xs leading-relaxed text-text-secondary">{card.detail}</p>
            {open && card.more && (
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">{card.more}</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {card.more && !open && <Pill n={1} primary label="Learn more" onClick={() => choose('more')} />}
              <Pill n={2} label="I already knew this" onClick={() => choose('knew')} />
              <Pill n={3} label="Dismiss" onClick={() => choose('dismiss')} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
