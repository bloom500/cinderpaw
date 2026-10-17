import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, AppWindow, GraduationCap, KeyRound, Moon, type LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ReleasePicture, useWhatsNew } from '@/components/WhatsNew';
import { useOnboarding } from '@/stores/onboarding';
import { useSettings } from '@/stores/settings';
import { closePayIntent, EXTRAS, PRO_STEPS, sendPayIntent, shouldAskPayIntent, type ExtraId, type PayAnswer } from '@/lib/payIntent';

const ICONS: Record<ExtraId, LucideIcon> = { apps: AppWindow, packs: GraduationCap, always_on: Moon, ai_included: KeyRound };

/**
 * The one paid-extra question (lib/payIntent.ts says when and what is sent),
 * as a card over the whole app like the What's new one (Darius, 18 Oct 2026):
 * the same picture on top, the page behind it blurred. Decided when the app
 * opens, so it never interrupts a task in progress; never on top of What's
 * new, the setup wizard, or the usage question.
 */
export function PayIntentDialog() {
  const settings = useSettings((s) => s.settings);
  const fetchSettings = useSettings((s) => s.fetchSettings);
  const whatsNewOpen = useWhatsNew((s) => s.open);
  const wizard = useOnboarding((s) => s.active);
  const [due, setDue] = useState(() => shouldAskPayIntent());
  const [picked, setPicked] = useState<ExtraId | null>(null);
  const [thanked, setThanked] = useState(false);

  useEffect(() => {
    if (due && !settings) void fetchSettings();
  }, [due, settings, fetchSettings]);

  const open = due && !!settings && settings.usage_sharing !== null && !whatsNewOpen && !wizard;
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
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      {/* Closed only by its own buttons or X (Darius, 18 Oct 2026): a stray
          click outside, or closing the Alpha card, used to dismiss it. */}
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0 sm:rounded-2xl" onInteractOutside={(e) => e.preventDefault()}>
        <ReleasePicture name="Cinderpaw" src="/releases/2026-09-moth.webp" />

        <div className="px-6 pb-6 pt-5">
          {thanked ? (
            <>
              <DialogTitle className="text-2xl font-semibold tracking-[-0.01em] text-text-primary">Thank you!</DialogTitle>
              <DialogDescription className="mt-1 text-sm text-text-muted">That helps us decide what to build next.</DialogDescription>
              <button type="button" onClick={close} className="mt-6 w-full rounded-xl bg-brand py-2.5 text-sm font-medium text-on-brand hover:bg-brand/90">
                Back to Cinderpaw
              </button>
            </>
          ) : !extra ? (
            <>
              <DialogTitle className="text-2xl font-semibold tracking-[-0.01em] text-text-primary">Cinderpaw stays free</DialogTitle>
              <DialogDescription className="mt-1 text-sm text-text-muted">
                Everything you use today stays free. We are thinking about ONE paid extra. Which would you want?
              </DialogDescription>

              <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
                {EXTRAS.map((e) => {
                  const Icon = ICONS[e.id];
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setPicked(e.id)}
                      className="group flex gap-3 rounded-xl border border-border-subtle p-3 text-left transition-colors hover:border-brand/60 hover:bg-bg-hover"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--bubble-user) text-brand">
                        <Icon size={16} aria-hidden />
                      </span>
                      <span>
                        <span className="block text-sm font-medium text-text-primary">{e.label}</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">{e.body}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => answer('none', 'none')} className="text-sm text-brand hover:underline">
                  No thanks, I'll stay on free
                </button>
                <button type="button" onClick={close} className="text-sm text-text-muted hover:text-text-secondary">
                  Don't ask again
                </button>
              </div>
              <p className="mt-4 text-[11px] leading-relaxed text-text-muted">
                We only send your answer: the extra you pick, the price we show and your yes, maybe or no. Never your
                chats, files or name.
              </p>
            </>
          ) : (
            <>
              <DialogTitle className="text-2xl font-semibold tracking-[-0.01em] text-text-primary">{extra.label}</DialogTitle>
              <DialogDescription className="mt-1 text-sm text-text-muted">Would you pay this for it?</DialogDescription>

              <ol className="mt-5 flex items-stretch gap-2" aria-label="Price">
                {PRO_STEPS.map((s, i) => (
                  <li key={s.when} className="flex flex-1 items-center gap-2">
                    <span className={`flex-1 rounded-xl border px-3 py-2.5 text-center ${i === PRO_STEPS.length - 1 ? 'border-brand/60 bg-(--bubble-user)' : 'border-border-subtle'}`}>
                      <span className="block text-xl font-semibold text-text-primary">{s.price}</span>
                      <span className="block text-[11px] text-text-muted">{s.when}</span>
                    </span>
                    {i < PRO_STEPS.length - 1 && <ArrowRight size={14} className="shrink-0 text-text-muted" aria-hidden />}
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs text-text-muted">
                The price goes down the longer you stay.{extra.note ? ` ${extra.note}` : ''}
              </p>

              <div className="mt-5 grid grid-cols-3 gap-2">
                <button type="button" onClick={() => answer(extra.id, 'yes')} className="rounded-xl bg-brand py-2.5 text-sm font-medium text-on-brand hover:bg-brand/90">Yes</button>
                <button type="button" onClick={() => answer(extra.id, 'maybe')} className="rounded-xl border border-border-subtle py-2.5 text-sm text-text-primary hover:bg-bg-hover">Maybe</button>
                <button type="button" onClick={() => answer(extra.id, 'no')} className="rounded-xl border border-border-subtle py-2.5 text-sm text-text-primary hover:bg-bg-hover">No</button>
              </div>
              <button type="button" onClick={() => setPicked(null)} className="mt-4 flex items-center gap-1 text-sm text-text-muted hover:text-text-secondary">
                <ArrowLeft size={14} aria-hidden /> Pick another
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
