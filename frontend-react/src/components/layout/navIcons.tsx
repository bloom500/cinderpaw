import type { ReactNode } from 'react';

/**
 * Sidebar icon micro-animations (14 Nov, Darius).
 *
 * His rules, in the order he gave them:
 * - Never a visible reset. A move starts on hover (or keyboard focus) and
 *   always runs to its end, even if the pointer leaves halfway, and it ends
 *   looking exactly like it began.
 * - Icons made of pieces animate each piece on its own.
 * - Sharp, never blurred. Moving or turning an 18px icon blurs it however it
 *   is done, so nothing moves: each line is traced again by a pen, in place.
 *   The geometry never shifts, so it stays crisp in every frame.
 *
 * How the comet works (his "mai wild, colorat"): a copy of each line, in
 * Cinderpaw orange with a glow, shows only a short dash (pathLength 1) that
 * runs from the line's start to its end and fades, then the copy is removed.
 * Only on hover or focus: nothing plays by itself to grab attention.
 *
 * Web Animations API: no React state, no re-render. Nothing plays for people
 * who asked their computer for less motion.
 */

/** When each piece starts and how long its trace takes; `still` pieces stay put. */
const TRACE: Record<string, { delay: number; duration: number; still?: boolean }> = {
  search: { delay: 0, duration: 560 },
  'artifacts-triangle': { delay: 0, duration: 480 },
  'artifacts-square': { delay: 110, duration: 480 },
  'artifacts-circle': { delay: 220, duration: 520 },
  // Tasks: the calendar stays, so the eye goes to the clock: its face is
  // traced round from 12 like a timer, then the hands are drawn in.
  'tasks-calendar': { delay: 0, duration: 0, still: true },
  'tasks-face': { delay: 0, duration: 760 },
  'tasks-hands': { delay: 420, duration: 420 },
  spin: { delay: 0, duration: 640 },
  pop: { delay: 0, duration: 600 },
  gear: { delay: 0, duration: 720 },
};
/** Within one piece, each line starts a little after the one before. */
const STAGGER = 80;
const DRAWABLE = 'path, circle, rect, line, polyline, polygon, ellipse';

/** Play every piece inside a sidebar row, once, to the end. */
export function playNavIcons(row: Element): void {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  row.querySelectorAll<SVGElement>('[data-anim]').forEach((piece) => {
    const t = TRACE[piece.dataset.anim ?? ''];
    if (!t || t.still) return;
    const lines = piece.matches(DRAWABLE) ? [piece] : [...piece.querySelectorAll<SVGElement>(DRAWABLE)];
    lines.forEach((line, i) => {
      if (typeof line.animate !== 'function' || !line.parentNode) return;
      // Still running from the last hover: let it finish rather than stack another.
      if (line.nextElementSibling?.classList.contains('nav-comet')) return;
      // The comet: a glowing copy of the line in Cinderpaw orange, of which
      // only a short dash shows, running from the line's start to its end.
      // The line itself is never touched, so the icon is whole and sharp in
      // every frame, and nothing is left to reset when the comet is gone.
      const comet = line.cloneNode(false) as SVGElement;
      comet.removeAttribute('data-anim');
      comet.classList.add('nav-comet');
      comet.setAttribute('pathLength', '1');
      line.parentNode.insertBefore(comet, line.nextSibling);
      const run = comet.animate(
        [
          { strokeDasharray: '0.32 1.68', strokeDashoffset: '0.32', opacity: 1 },
          { strokeDasharray: '0.32 1.68', strokeDashoffset: '-0.85', opacity: 1, offset: 0.85 },
          { strokeDasharray: '0.32 1.68', strokeDashoffset: '-1', opacity: 0 },
        ],
        { duration: t.duration, delay: t.delay + i * STAGGER, easing: 'cubic-bezier(.55, 0, .3, 1)', fill: 'both' },
      );
      run.onfinish = () => comet.remove();
      run.oncancel = () => comet.remove();
    });
  });
}

type IconProps = { size?: number | string; strokeWidth?: number; className?: string };

function Svg({ size = 24, strokeWidth = 2, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

/** Lucide's calendar-clock (ISC), split into its calendar and its clock. */
export function TasksIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <g data-anim="tasks-calendar">
        <path d="M16 2v4" />
        <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
        <path d="M3 10h5" />
        <path d="M8 2v4" />
      </g>
      {/* Turned a quarter back once, so its trace starts at 12 o'clock. A fixed
          attribute, drawn once, not an animation: it does not blur. */}
      <circle data-anim="tasks-face" cx="16" cy="16" r="6" transform="rotate(-90 16 16)" />
      <path data-anim="tasks-hands" d="M16 14v2.2l1.6 1" />
    </Svg>
  );
}

/** Lucide's shapes (ISC): a triangle, a square and a circle, each its own piece. */
export function ArtifactsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path data-anim="artifacts-triangle" d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
      <rect data-anim="artifacts-square" x="3" y="14" width="7" height="7" rx="1" />
      <circle data-anim="artifacts-circle" cx="17.5" cy="17.5" r="3.5" />
    </Svg>
  );
}
