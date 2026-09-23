import { useEffect } from 'react';
import { create } from 'zustand';
import { Brain, FileText, Globe, LogIn, Moon, Phone, type LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CinderpawMascot } from '@/components/chat/mascot/CinderpawMascot';
import { useOnboarding } from '@/stores/onboarding';
import { readLocal, writeLocal } from '@/lib/utils';

/**
 * The big "what's new" card, for big releases only, after the one the Claude
 * app shows for a new model: a picture on top, then a few plain sentences.
 *
 * Shown once per RELEASE.id, on the first launch that carries it, to people
 * who were already using Cinderpaw. Someone who just installed meets the app
 * through the setup wizard, and a list of changes to an app they have never
 * seen would be noise, so a fresh install marks it seen without showing it.
 * Settings -> About opens it again.
 *
 * A small release ships without touching this file; a big one changes
 * RELEASE (a new id shows it once more to everybody).
 */

const SEEN_KEY = 'cinderpaw.whatsNew.seen';

const RELEASE: { id: string; title: string; subtitle: string; items: { icon: LucideIcon; title: string; body: string }[] } = {
  id: '2026-09-cinderpaw',
  title: 'Say hello to Cinderpaw',
  subtitle: 'Feral has a new name, and it can do a lot more.',
  items: [
    { icon: Globe, title: 'A browser inside the app', body: 'Cinderpaw can open websites next to your chat and use them for you. You can watch it work, and one click pauses it.' },
    { icon: FileText, title: 'Documents it makes, kept for you', body: 'Reports, PDFs, Word and Excel files it writes stay in Artifacts, even after the chat ends.' },
    { icon: Phone, title: 'Talk to it out loud', body: 'Press the phone button and have a real conversation, even while you use other apps.' },
    { icon: Brain, title: 'It remembers what matters', body: 'It uses what you told it before to answer better. You can make it forget anything.' },
    { icon: LogIn, title: 'Easier to start', body: 'Sign in with OpenRouter in one click. No keys to copy and paste.' },
    { icon: Moon, title: 'It practices while you are away', body: 'It tries small improvements on its own and keeps only what works. You choose how much it may spend.' },
  ],
};

export const useWhatsNew = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => {
    writeLocal(SEEN_KEY, RELEASE.id);
    set({ open: false });
  },
}));

export function WhatsNew() {
  const open = useWhatsNew((s) => s.open);
  const hide = useWhatsNew((s) => s.hide);

  useEffect(() => {
    if (readLocal(SEEN_KEY) === RELEASE.id) return;
    let alive = true;
    void useOnboarding.getState().loadPersisted().then((onboarded) => {
      if (!alive) return;
      if (onboarded) useWhatsNew.getState().show();
      else writeLocal(SEEN_KEY, RELEASE.id);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) hide(); }}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0 sm:rounded-2xl">
        {/* The picture: the brand's warmth as light, the mascot in it. */}
        <div className="relative flex h-44 items-end justify-center overflow-hidden bg-[radial-gradient(120%_90%_at_50%_0%,var(--brand)_0%,color-mix(in_oklab,var(--brand)_35%,var(--bg-primary))_45%,var(--bg-primary)_100%)]">
          <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_20%_20%,rgba(255,255,255,0.18),transparent_70%)]" aria-hidden />
          <div className="relative mb-2 scale-[2] origin-bottom" aria-hidden>
            <CinderpawMascot state="celebrate" />
          </div>
        </div>

        <div className="px-6 pb-6 pt-5">
          <DialogTitle className="text-2xl font-semibold tracking-[-0.01em] text-text-primary">{RELEASE.title}</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-text-muted">{RELEASE.subtitle}</DialogDescription>

          <ul className="mt-5 grid gap-4 sm:grid-cols-2">
            {RELEASE.items.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--bubble-user) text-brand">
                  <Icon size={16} aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-medium text-text-primary">{title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">{body}</span>
                </span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={hide}
            className="mt-6 w-full rounded-xl bg-brand py-2.5 text-sm font-medium text-on-brand hover:bg-brand/90"
          >
            Got it
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
