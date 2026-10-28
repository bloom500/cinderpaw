import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useMessageScroller,
  useMessageScrollerVisibility,
} from '@shadcn/react/message-scroller';
import { useChat } from '@/stores/chat';
import { useChatDockHeight } from '@/lib/chatDock';
import { cn } from '@/lib/utils';

/**
 * The conversation's chapter rail, Qwen-style.
 *
 * Every one of YOUR turns is a chapter: a tick on a slim rail pinned to the
 * right of the transcript. The tick nearest the reading position lights up,
 * clicking a tick jumps straight to that turn, and the count pill opens the
 * chapter list — each turn with a one-line preview, the live one marked —
 * for jumping across a long conversation without dragging the scrollbar.
 *
 * While it shows, the rail IS the scrollbar (28 Oct, Darius: two bars side by
 * side read as clutter): the transcript's native bar is hidden and a soft band
 * on the rail marks the part of the chat on screen. Wheel, keys and dragging
 * the rail still scroll. Its bottom clears the composer's measured height so
 * it never slides under the dock.
 *
 * Ticks sit where their message REALLY is: each tick's height is the
 * message's offset inside the scroll content, measured from the DOM, so a
 * long answer pushes the next chapters down exactly like the transcript
 * does. Re-measured on content edits, resizes and new messages (never on
 * scroll: the offset math is scroll-invariant); before the first measure
 * they fall back to an even spread. Hidden while the transcript fits.
 */
const PREVIEW_LEN = 44;

function previewOf(content: string, fallback: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (!oneLine) return fallback;
  return oneLine.length > PREVIEW_LEN ? `${oneLine.slice(0, PREVIEW_LEN - 1)}…` : oneLine;
}

// One rail tick. Memoized: during a fast scroll the visibility store fires
// every frame, and re-rendering all ticks per frame is pure waste — only the
// tick whose props actually changed may re-render.
const Tick = memo(function Tick({
  id,
  index,
  active,
  frac,
  preview,
  onSelect,
}: {
  id: string;
  index: number;
  active: boolean;
  frac: number;
  preview: string;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active}
      aria-label={`Go to message ${index + 1}: ${preview}`}
      title={preview}
      style={{ left: '50%', top: `${(frac * 100).toFixed(2)}%` }}
      // 24px hit area (WCAG minimum), 12px visual: easy to grab,
      // still slim next to the native bar.
      className="absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center"
    >
      <span
        aria-hidden
        className={cn(
          'rounded-full transition-all',
          active ? 'h-[5px] w-4 bg-text-primary' : 'h-[3px] w-2.5 bg-border-default/70 hover:w-3.5 hover:bg-text-muted',
        )}
      />
    </button>
  );
});

// One chapter-list row. Memoized for the same per-frame reason as Tick.
const ChapterRow = memo(function ChapterRow({
  id,
  active,
  preview,
  onSelect,
}: {
  id: string;
  active: boolean;
  preview: string;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active}
      className={cn(
        'group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
        active ? 'bg-bg-hover text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{preview}</span>
      <span
        aria-hidden
        className={cn('h-[3px] shrink-0 rounded-full', active ? 'w-4 bg-text-primary' : 'w-2.5 bg-border-default/70')}
      />
    </button>
  );
});

// Memoized: it takes no props, and the transcript draws again for every
// streamed piece; without this the rail redid every turn's preview each time.
export const ChapterRail = memo(function ChapterRail() {
  // Your turns only, compared item by item (useShallow, which also keeps the
  // fresh filtered array from looping the store): a streamed reply changes no
  // turn, so the rail is not drawn again on every frame of it (26 Oct: 300
  // ticks and their previews a frame, at 300 turns).
  const turns = useChat(useShallow((s) => s.messages.filter((m) => m.role === 'user')));
  const messageCount = useChat((s) => s.messages.length);
  const { scrollToMessage } = useMessageScroller();
  const { currentAnchorId, visibleMessageIds } = useMessageScrollerVisibility();
  const dockH = useChatDockHeight();
  // While a reply streams, every chunk grows scrollHeight and would remeasure
  // every row. Chapters never move mid-stream (new text only extends the
  // end, and the offset math is scroll-invariant), so the pass is skipped
  // until the stream ends, when the effect below runs once more.
  const streaming = useChat((s) => s.streamStatus === 'streaming');
  const [open, setOpen] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The viewport, kept for rail-drag scrolling (dragging the strip moves the
  // transcript exactly like the native bar, through the same scroll events,
  // so auto-scroll follow releases the same way a native grab releases it).
  const viewportRef = useRef<HTMLElement | null>(null);
  // A drag that travelled becomes a scroll, not a click: the click that
  // follows a real drag must not jump to the tick it started on.
  const suppressClick = useRef(false);
  const dragMove = useRef<((e: PointerEvent) => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  // Closing waits a beat: travelling between rail and dialog (or between two
  // ticks) briefly leaves both, and an instant close would blink the list.
  const closeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (dragMove.current) window.removeEventListener('pointermove', dragMove.current);
    },
    [],
  );
  const openNow = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  }, []);
  const closeSoon = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  }, []);
  const closeNow = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(false);
  }, []);
  // Read by the stable jump below: open as state would re-create it (and
  // defeat every memo) on each toggle.
  const openRef = useRef(open);
  openRef.current = open;

  // Hovering between the rail and its dialog keeps the list open; leaving
  // both closes it after a beat. relatedTarget is where the pointer went —
  // null when it left the window, and contains(null) throws in some engines,
  // hence the instanceof guard.
  const inside = (el: HTMLElement | null, node: unknown) =>
    !!el && node instanceof Node && el.contains(node);
  const railLeft = (e: React.MouseEvent) => {
    if (!inside(dialogRef.current, e.relatedTarget)) closeSoon();
  };
  const dialogLeft = (e: React.MouseEvent) => {
    if (!inside(railRef.current, e.relatedTarget)) closeSoon();
  };

  // Where each chapter really sits: message offset over scroll height,
  // re-measured on content edits (streaming writes text without scrolling),
  // resizes and new messages. NOT on scroll: the offset math
  // (rect.top - viewport.top + scrollTop) is scroll-invariant, so a scroll
  // listener would force a sync layout per message per frame and always get
  // the same fractions back (F1, 4 Oct 2026).
  const [fracs, setFracs] = useState<Record<string, number>>({});
  // True only when positively measured as fitting (scrollHeight > 0 guards
  // jsdom, where everything reads 0 and the rail must still render in tests).
  const [fits, setFits] = useState(false);
  const prevTurnCount = useRef(turns.length);
  const lastSig = useRef('');
  // Message count for the skip-if-unchanged signature below, read through a ref
  // so the measuring effect does not have to close over `messages`. It used to,
  // and `messages` is a new array identity on every streamed frame, so the whole
  // effect tore down and re-ran 60 times a second: each run called
  // `mo.observe(viewport, { subtree: true })` again, and registering a subtree
  // observer walks that subtree. On a long transcript that is the whole
  // transcript, every frame — the most expensive thing on the page during a
  // reply, for an observer whose handler does nothing while `streaming`.
  const msgCountRef = useRef(messageCount);
  msgCountRef.current = messageCount;
  useEffect(() => {
    let raf = 0;
    let dead = false;
    const viewport = railRef.current?.parentElement?.querySelector<HTMLElement>(
      '[aria-label="Conversation"]',
    );
    if (!viewport) return;
    viewportRef.current = viewport;
    const compute = (force = false) => {
      if (dead) return;
      if (streaming) return;
      const vRect = viewport.getBoundingClientRect();
      const h = viewport.scrollHeight;
      if (h <= 0) return;
      // Streaming tokens fire the observer constantly, but a token rarely
      // moves chapters: skip the rect reads when neither the height nor the
      // message count changed since the last pass (B1).
      const sig = `${h}:${msgCountRef.current}`;
      if (!force && sig === lastSig.current) return;
      lastSig.current = sig;
      const next: Record<string, number> = {};
      viewport.querySelectorAll<HTMLElement>('[data-message-id]').forEach((el) => {
        const id = el.dataset.messageId;
        if (!id) return;
        const absTop = el.getBoundingClientRect().top - vRect.top + viewport.scrollTop;
        next[id] = Math.min(1, Math.max(0, absTop / h));
      });
      // A transcript that fits needs no rail at all (F2).
      setFits(h <= viewport.clientHeight + 4);
      setFracs((prev) => {
        const keys = Object.keys(next);
        if (
          keys.length === Object.keys(prev).length &&
          keys.every((k) => Math.abs((prev[k] ?? -1) - next[k]) < 0.001)
        )
          return prev;
        return next;
      });
    };
    const schedule = (force = false) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => compute(force));
    };
    // Listeners pass their event/entries as first argument: a shared no-arg
    // wrapper, or every resize would arrive as force=true.
    const soft = () => schedule(false);
    const cleanups: Array<() => void> = [];
    schedule();
    window.addEventListener('resize', soft);
    cleanups.push(() => window.removeEventListener('resize', soft));
    // jsdom (tests) has no ResizeObserver; browsers all do.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(soft);
      ro.observe(viewport);
      cleanups.push(() => ro.disconnect());
    }
    const mo = new MutationObserver(soft);
    mo.observe(viewport, { childList: true, subtree: true, characterData: true });
    cleanups.push(() => mo.disconnect());
    // The band follows the scroll by writing its own style, once a frame: as
    // state it would draw the rail again on every scrolled frame.
    let bandRaf = 0;
    const band = () => {
      cancelAnimationFrame(bandRaf);
      bandRaf = requestAnimationFrame(() => {
        const el = bandRef.current;
        const h = viewport.scrollHeight;
        if (!el || h <= 0) return;
        el.style.top = `${((viewport.scrollTop / h) * 100).toFixed(2)}%`;
        el.style.height = `${((viewport.clientHeight / h) * 100).toFixed(2)}%`;
      });
    };
    band();
    viewport.addEventListener('scroll', band, { passive: true });
    window.addEventListener('resize', band);
    cleanups.push(() => {
      cancelAnimationFrame(bandRaf);
      viewport.removeEventListener('scroll', band);
      window.removeEventListener('resize', band);
    });
    // New turns arrive mid entrance-animation (slide-in): their rects are
    // still travelling, and nothing re-measures at landing. One delayed,
    // forced pass per turn-count change settles the ticks (F6).
    if (prevTurnCount.current !== turns.length) {
      prevTurnCount.current = turns.length;
      const t = window.setTimeout(() => schedule(true), 400);
      cleanups.push(() => window.clearTimeout(t));
    }
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      cleanups.forEach((fn) => fn());
    };
  }, [turns.length, streaming]);

  // Esc closes the chapter list. closeNow only touches refs and setState,
  // so it is stable and stays out of the dependency list.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // User turns ARE the scroll anchors (MessageList marks them scrollAnchor),
  // so the scroller's anchor is the live chapter. Fall back to the last
  // visible turn, then to the final turn when nothing is measured yet.
  // Optional-chained: with fewer than two turns there is no last turn.
  const turnIds = new Set(turns.map((t) => t.id));
  const activeId =
    (currentAnchorId && turnIds.has(currentAnchorId) ? currentAnchorId : null) ??
    [...visibleMessageIds].reverse().find((id) => turnIds.has(id)) ??
    turns[turns.length - 1]?.id ??
    null;

  const clearBottom = dockH === null ? '5.75rem' : `${dockH + 12}px`;
  // Jumping from the open list keeps it open: picking chapters one after
  // another must not pay a reopen per chapter. It still closes on leaving
  // both zones, on Esc, and on the count pill. Stable identity (reads open
  // through a ref) so the memoized ticks below actually skip renders.
  const jump = useCallback(
    (id: string, keepOpen = false) => {
      if (!keepOpen) closeNow();
      // Motion-sensitive readers get an instant jump, everyone else glides.
      const reduceMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scrollToMessage(id, { align: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    },
    [scrollToMessage],
  );

  // Rail drag: press anywhere on the ticks strip and pull. The strip is
  // 20px wide, sits clear of the OS edge and the window chrome, and clears
  // the dock — a grab surface no overlay and no engine quirk can steal.
  // Moves write scrollTop directly, producing the same scroll events as a
  // native-bar drag, so follow releases exactly like it does for one.
  const railDragStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const viewport = viewportRef.current;
    const railH = railRef.current?.clientHeight ?? 0;
    if (!viewport) return;
    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    const span = railH > 0 ? railH : viewport.clientHeight;
    if (maxScroll <= 0 || span <= 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startTop = viewport.scrollTop;
    let moved = false;
    suppressClick.current = false;
    setDragging(true);
    const onMove = (m: PointerEvent) => {
      const dy = m.clientY - startY;
      if (!moved && Math.abs(dy) > 4) moved = true;
      const frac = Math.min(1, Math.max(0, startTop / maxScroll + dy / span));
      viewport.scrollTop = frac * maxScroll;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      dragMove.current = null;
      if (moved) suppressClick.current = true;
      setDragging(false);
    };
    dragMove.current = onMove;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };
  const tickClick = useCallback(
    (id: string) => {
      // The click trailing a real drag belongs to the drag, not the tick.
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      jump(id, openRef.current);
    },
    [jump],
  );
  // Rows always keep the list open; stable so memoized rows skip renders.
  const rowSelect = useCallback((id: string) => jump(id, true), [jump]);

  // The native bar goes only while the rail stands in for it (globals.css,
  // [data-chapter-rail]); a short chat keeps its bar.
  const shown = turns.length >= 2 && !fits;
  useEffect(() => {
    const v = viewportRef.current;
    if (!v || !shown) return;
    v.dataset.chapterRail = '';
    return () => { delete v.dataset.chapterRail; };
  }, [shown]);

  // One chapter is not navigation, and a transcript that fits needs no rail
  // either. This return sits AFTER every hook: the callbacks above are
  // useCallbacks, and returning before them changes the hook count between
  // renders (React error, caught by test, 4 Oct 2026).
  if (!shown) return null;

  return (
    <>
      {/* The count pill doubles as the list toggle; hovering the rail opens it.
          The strip itself takes events (not just the ticks): the gaps between
          ticks would otherwise drop the hover mid-travel and blink the list. */}
      <div
        ref={railRef}
        onMouseEnter={openNow}
        onMouseLeave={railLeft}
        className="absolute top-3 z-10 flex w-5 flex-col items-center gap-2"
        style={{ right: '0.875rem', bottom: clearBottom }}
      >
        <button
          type="button"
          onClick={() => (open ? closeNow() : openNow())}
          aria-expanded={open}
          aria-label={`Conversation chapters, ${turns.length} turns`}
          title={`${turns.length} turns, open chapter list`}
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-full border text-micro transition-colors',
            open
              ? 'border-brand bg-brand text-white'
              : 'border-border-default bg-bg-primary text-text-secondary hover:border-brand hover:text-brand',
          )}
        >
          {turns.length > 99 ? '99' : turns.length}
        </button>
        <div
          className={cn(
            'relative min-h-0 w-full flex-1 touch-none select-none',
            dragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
          role="list"
          aria-label="Chapters. Press and drag to scroll."
          onPointerDown={railDragStart}
        >
          {/* What is on screen, on the same scale as the ticks. */}
          <div
            ref={bandRef}
            aria-hidden
            data-testid="chapter-band"
            className={cn(
              'pointer-events-none absolute inset-x-0.5 min-h-3 rounded-full transition-colors',
              dragging ? 'bg-text-primary/15' : 'bg-text-primary/[0.07]',
            )}
          />
          {turns.map((t, i) => (
            <Tick
              key={t.id}
              id={t.id}
              index={i}
              active={t.id === activeId}
              // Measured spot, or an even spread before the first measure.
              frac={fracs[t.id] ?? (turns.length > 1 ? i / (turns.length - 1) : 0)}
              preview={previewOf(t.content, `message ${i + 1}`)}
              onSelect={tickClick}
            />
          ))}
        </div>
      </div>

      {open && (
        <div
          ref={dialogRef}
          onMouseEnter={openNow}
          onMouseLeave={dialogLeft}
          role="dialog"
          aria-label="Conversation chapters"
          // SOLID ground, not glass: bg-elevated is a 34%-alpha token, and an
          // opacity modifier cannot fix that — color-mix takes 90% OF the
          // translucent colour, landing near 31% alpha, still a ghost over
          // scrolling text (4 Oct 2026). bg-primary is opaque in every theme.
          className="absolute top-12 z-20 flex w-72 flex-col overflow-hidden rounded-xl border border-border-default bg-bg-primary shadow-xl"
          // As tall as its chapters, never past the dock. Pinned at both ends,
          // two chapters opened a panel the height of the window, mostly empty.
          style={{ right: '3rem', maxHeight: `calc(100% - 3rem - ${clearBottom})` }}
        >
            <div className="min-h-0 overflow-y-auto p-2 thin-scrollbar">
              {turns.map((t, i) => (
                <ChapterRow
                  key={t.id}
                  id={t.id}
                  active={t.id === activeId}
                  preview={previewOf(t.content, `Message ${i + 1}`)}
                  onSelect={rowSelect}
                />
              ))}
            </div>
          </div>
      )}
    </>
  );
});
