import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useSettings } from '@/stores/settings';
import { closePayIntent, EXTRAS, sendPayIntent, shouldAskPayIntent, type ExtraId, type PayAnswer } from '@/lib/payIntent';

/** Asked once: which ONE paid extra would you want (lib/payIntent.ts says when and what is sent). */
export function PayIntentCard() {
  const settings = useSettings((s) => s.settings);
  const [due, setDue] = useState(() => shouldAskPayIntent());
  const [picked, setPicked] = useState<ExtraId | null>(null);
  const [thanked, setThanked] = useState(false);

  // Not while the usage question is open (or settings are not loaded yet and
  // it might be): one question at a time.
  if (!due || !settings || settings.usage_sharing === null) return null;

  const close = () => {
    if (!thanked) closePayIntent();
    setDue(false);
  };
  const answer = (extra: ExtraId | 'none', a: PayAnswer | 'none') => {
    sendPayIntent(extra, a);
    setThanked(true);
  };
  const extra = EXTRAS.find((e) => e.id === picked);

  return (
    <div className="mt-4 w-full max-w-md rounded-xl border border-border-subtle bg-(--surface-typing) px-4 py-3 text-xs text-text-muted pointer-events-auto">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Sparkles size={14} /> {thanked ? 'Thank you!' : 'Cinderpaw stays free'}
        </p>
        <button type="button" onClick={close} aria-label="Close" className="-mr-1 -mt-0.5 rounded p-1 hover:bg-bg-hover">
          <X size={12} />
        </button>
      </div>

      {thanked ? (
        <p className="mt-1 leading-relaxed">That helps us decide what to build next.</p>
      ) : !extra ? (
        <>
          <p className="mt-1 leading-relaxed">
            Everything you use today stays free. We are thinking about ONE paid extra. Which would you want?
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {EXTRAS.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setPicked(e.id)}
                className="rounded-lg border border-border-subtle px-3 py-1.5 text-left text-text-primary hover:bg-bg-hover"
              >
                {e.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => answer('none', 'none')} className="mt-2 px-1 text-brand hover:underline">
            No thanks, I'll stay on free
          </button>
          <p className="mt-2 leading-relaxed">
            We only send your answer: the extra you pick, the price we show and your yes, maybe or no. Never your chats,
            files or name.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 leading-relaxed">
            <span className="text-text-primary">{extra.label}.</span> Would you pay {extra.ask} for it?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => answer(extra.id, 'yes')} className="rounded-lg bg-brand px-3 py-1.5 text-on-brand">Yes</button>
            <button type="button" onClick={() => answer(extra.id, 'maybe')} className="rounded-lg border border-border-subtle px-3 py-1.5">Maybe</button>
            <button type="button" onClick={() => answer(extra.id, 'no')} className="rounded-lg border border-border-subtle px-3 py-1.5">No</button>
            <button type="button" onClick={() => setPicked(null)} className="px-1 text-brand hover:underline">Back</button>
          </div>
        </>
      )}
    </div>
  );
}
