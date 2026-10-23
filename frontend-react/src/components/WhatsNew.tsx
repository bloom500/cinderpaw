import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useOnboarding } from '@/stores/onboarding';
import { PlayCircle } from 'lucide-react';
import { readLocal, writeLocal } from '@/lib/utils';
import { useAttentionTurn } from '@/lib/attention';

/**
 * The big "what's new" card, for big releases only, laid out like Notion's
 * (Darius, 22 Oct): one coloured tile per change. No mascot (his call, 24 Sep).
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

/**
 * Tiles like Notion's "What's new": each change gets its own colour, a short
 * headline, and a real screenshot of the part of the app it changed, so the
 * eye sees the feature before reading about it. Each shot exists twice,
 * `<shot>-dark.webp` and `<shot>-light.webp`, taken from the real component
 * at 2x on a transparent ground. Four tiles fill a page; a fifth starts a
 * second page. `wide` alternates the column widths row by row.
 */
const RELEASE = {
  id: '2026-10-mycena',
  date: 'October 2026',
  title: 'Calmer, and it asks first',
  tiles: [
    { tone: 'var(--brand)', title: 'You choose what it may do', shot: '/releases/2026-10/access', wide: false },
    { tone: 'var(--success)', title: 'It asks before it changes how it practises', shot: '/releases/2026-10/approve', wide: true },
    { tone: 'var(--info)', title: 'One notice at a time', shot: '/releases/2026-10/notices', wide: true },
    { tone: 'var(--warning)', title: 'Memory waits for your first answer', shot: '/releases/2026-10/download', wide: false },
  ],
  // ponytail: no recap video yet; the "Watch the recap" link appears once this is set.
  recap: null as string | null,
} as const;

/** Four tiles a page: a big release with more changes gets more pages. */
export const toPages = <T,>(tiles: readonly T[], size = 4): T[][] =>
  Array.from({ length: Math.ceil(tiles.length / size) }, (_, i) => tiles.slice(i * size, i * size + size));
const PAGES = toPages(RELEASE.tiles);

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
  const [page, setPage] = useState(0);
  useEffect(() => { if (open) setPage(0); }, [open]);
  const last = page === PAGES.length - 1;
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
      {/* The X must be visible at all times (Darius, 20 Oct): its own dark
          chip and white X read on any background, in either theme. */}
      <DialogContent
        className="max-w-3xl gap-0 overflow-hidden p-0 sm:rounded-2xl [&>button:last-child]:z-10 [&>button:last-child]:rounded-full [&>button:last-child]:bg-black/55! [&>button:last-child]:p-1.5 [&>button:last-child]:text-white! [&>button:last-child]:opacity-100 [&>button:last-child]:shadow-md [&>button:last-child]:backdrop-blur-sm [&>button:last-child]:hover:bg-black/75!"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex max-h-[90vh] flex-col overflow-y-auto bg-bg-primary px-8 pb-6 pt-8">
          <DialogTitle className="text-[1.75rem] font-semibold leading-tight tracking-[-0.01em] text-text-primary">
            What&apos;s new in Cinderpaw
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-text-muted">
            {RELEASE.date} · <span>{RELEASE.title}</span>
          </DialogDescription>

          <div className="mt-6 grid grid-cols-5 gap-3">
            {PAGES[page].map((t) => (
              <section
                key={t.title}
                className={`overflow-hidden rounded-2xl pb-2 ${t.wide ? 'col-span-3' : 'col-span-2'}`}
                style={{ background: `color-mix(in oklab, ${t.tone} 16%, var(--bg-primary))` }}
              >
                <h3
                  className="px-6 pt-6 text-lg font-semibold leading-snug"
                  style={{ color: `color-mix(in oklab, ${t.tone} 72%, var(--text-primary))` }}
                >
                  {t.title}
                </h3>
                {/* 2x shots drawn at a third of their pixels (2/3 size): small enough
                    that a whole control fits the tile, like Notion's. */}
                <img srcSet={`${t.shot}-light.webp 3x`} alt="" draggable={false} className="max-w-none dark:hidden" />
                <img srcSet={`${t.shot}-dark.webp 3x`} alt="" draggable={false} className="hidden max-w-none dark:block" />
              </section>
            ))}
          </div>

          <div className="mt-5 flex items-center justify-between">
            {RELEASE.recap ? (
              <a href={RELEASE.recap} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
                <PlayCircle size={16} /> Watch the recap
              </a>
            ) : <span />}
            <div className="flex items-center gap-3">
              {PAGES.length > 1 && (
                <span className="flex gap-1.5" aria-label={`Page ${page + 1} of ${PAGES.length}`}>
                  {PAGES.map((_, i) => <span key={i} className={`h-1.5 w-1.5 rounded-full ${i === page ? 'bg-text-primary' : 'bg-border-default'}`} />)}
                </span>
              )}
              {page > 0 && (
                <button type="button" onClick={() => setPage(page - 1)} className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-bg-hover">
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={last ? hide : () => setPage(page + 1)}
                className="rounded-lg bg-bg-elevated px-5 py-2 text-sm font-medium text-text-primary hover:bg-bg-hover"
              >
                {last ? 'Got it' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
