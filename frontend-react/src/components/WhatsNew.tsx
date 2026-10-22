import { useEffect } from 'react';
import { create } from 'zustand';
import { Download, Layers, Lightbulb, ShieldCheck, Sparkles, Zap, type LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useOnboarding } from '@/stores/onboarding';
import { readLocal, writeLocal } from '@/lib/utils';
import { useAttentionTurn } from '@/lib/attention';

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

/** Longest it may hold the notice queue while it finds out who this is. A
 *  read that never answers must not keep every other notice away; it gives up
 *  for this launch without marking the release seen, so the next one shows it. */
export const WHATS_NEW_DECIDE_MS = 3_000;

const RELEASE: { id: string; hero: string; picture: string; title: string; subtitle: string; items: { icon: LucideIcon; title: string; body: string }[] } = {
  id: '2026-10-mycena',
  hero: 'Cinderpaw',
  // Each big release gets its own science picture (Darius, 20 Oct): glowing
  // Mycena mushrooms over the mycelium that links them, picked from Google
  // Flow. Bundled, so it shows offline. The site's release page should carry
  // the same picture (cinderpaw.dev lib/releases.ts).
  picture: '/releases/2026-10-mycena.webp',
  title: 'Calmer, and it asks first',
  subtitle: 'This update is about trust: you see what it may do, and it tells you what it found.',
  items: [
    { icon: ShieldCheck, title: 'You choose what it may do', body: 'Under the message box: look only, edit files, or full access. Each one says in plain words what it means.' },
    { icon: Lightbulb, title: 'It tells you what matters', body: 'While it works, Cinderpaw can point out something you should know. Say you knew it, and it flags less.' },
    { icon: Sparkles, title: 'It asks before it changes itself', body: 'After it practices, it shows the change it wants as before and after. You say yes or no, and you can undo it.' },
    { icon: Layers, title: 'One thing at a time', body: 'Notices no longer pile up on the screen. They come one by one, the most important first.' },
    { icon: Download, title: 'A quieter first start', body: 'The big memory download now waits until after your first answer, instead of starting the moment you open the app.' },
    { icon: Zap, title: 'Steadier everywhere', body: 'Messages you queue, chats you switch and waits for the provider no longer get lost or mixed up.' },
  ],
};

export const useWhatsNew = create<{
  open: boolean;
  /** Opens by itself this launch: null = not decided yet (the onboarding state
   *  is read async), and while undecided it holds its place in the notice
   *  queue so the Alpha card cannot jump ahead of it. */
  due: boolean | null;
  show: () => void;
  hide: () => void;
}>((set) => ({
  open: false,
  due: readLocal(SEEN_KEY) === RELEASE.id ? false : null,
  show: () => set({ open: true }),
  hide: () => {
    writeLocal(SEEN_KEY, RELEASE.id);
    set({ open: false, due: false });
  },
}));

export function WhatsNew() {
  const open = useWhatsNew((s) => s.open);
  const hide = useWhatsNew((s) => s.hide);
  const due = useWhatsNew((s) => s.due);
  // First in the notice queue: the Alpha card and the rest wait until it is closed.
  const turn = useAttentionTurn('whatsNew', due !== false);

  useEffect(() => {
    if (due !== null) return;
    let alive = true;
    const giveUp = setTimeout(() => { alive = false; useWhatsNew.setState({ due: false }); }, WHATS_NEW_DECIDE_MS);
    void useOnboarding.getState().loadPersisted().then((onboarded) => {
      if (!alive) return;
      clearTimeout(giveUp);
      if (!onboarded) writeLocal(SEEN_KEY, RELEASE.id);
      useWhatsNew.setState({ due: onboarded });
    }).catch(() => { if (alive) { clearTimeout(giveUp); useWhatsNew.setState({ due: false }); } });
    return () => { alive = false; clearTimeout(giveUp); };
  }, [due]);

  useEffect(() => {
    if (turn && due) useWhatsNew.getState().show();
  }, [turn, due]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) hide(); }}>
      {/* Closed only by its own buttons or X (Darius, 18 Oct 2026): a stray
          click outside, or closing the Alpha card, used to dismiss it. */}
      {/* The dialog's X sits on the release picture, which changes every big
          release. Bare, it took the theme's text colour: dark on the dark
          mushroom photo in light mode, so it vanished (Darius, 20 Oct: it
          must be visible at all times). Its own dark chip and white X read on
          any picture, in either theme. */}
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0 sm:rounded-2xl [&>button:last-child]:z-10 [&>button:last-child]:rounded-full [&>button:last-child]:bg-black/55! [&>button:last-child]:p-1.5 [&>button:last-child]:text-white! [&>button:last-child]:opacity-100 [&>button:last-child]:shadow-md [&>button:last-child]:backdrop-blur-sm [&>button:last-child]:hover:bg-black/75!"
        onInteractOutside={(e) => e.preventDefault()}
      >
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
