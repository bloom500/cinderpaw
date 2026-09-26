import { useEffect } from 'react';
import { create } from 'zustand';
import { Brain, FileText, Globe, LogIn, Moon, Phone, type LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useOnboarding } from '@/stores/onboarding';
import { readLocal, writeLocal } from '@/lib/utils';

/**
 * The big "what's new" card, for big releases only, after the one the Claude
 * app shows for a new model: a picture on top with the name set large, then a
 * few plain sentences. No mascot (his call, 24 Sep): the picture carries it.
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

const RELEASE: { id: string; hero: string; picture: string; title: string; subtitle: string; items: { icon: LucideIcon; title: string; body: string }[] } = {
  id: '2026-09-cinderpaw',
  hero: 'Cinderpaw',
  // The release's picture, the same one the site's hero and share card use
  // (cinderpaw.dev lib/releases.ts). Bundled, so it shows offline.
  picture: '/releases/2026-09-moth.webp',
  title: 'Feral has a new name',
  subtitle: 'And it can do a lot more. Here is what changed.',
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
        <ReleasePicture name={RELEASE.hero} src={RELEASE.picture} />

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

/**
 * The release's picture with its name set over it, the way Claude's new-model
 * card does it: one real photograph per big release (a moth's wing, close up,
 * for September 2026), shared with the site's hero. Fixed colours on purpose:
 * it is a picture, the same in either theme. It replaced a CSS dusk horizon
 * that read as a copy of another company's launch picture.
 */
function ReleasePicture({ name, src }: { name: string; src: string }) {
  return (
    <div className="relative flex h-56 items-center justify-center overflow-hidden bg-[#1C1814]">
      <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(55% 60% at 50% 50%, rgba(20,14,8,0.4), transparent 80%)' }} aria-hidden />
      <span
        className="relative text-5xl tracking-[-0.01em] text-[#f6efe4]"
        style={{ fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif", textShadow: '0 2px 24px rgba(0,0,0,0.45)' }}
      >
        {name}
      </span>
    </div>
  );
}
