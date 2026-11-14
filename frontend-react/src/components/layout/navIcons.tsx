import type { ReactNode } from 'react';

/**
 * Sidebar icon micro-animations (14 Nov, Darius).
 *
 * Two rules from him:
 * - An animation never visibly resets. It is started on hover and always runs
 *   to its end, even if the pointer leaves halfway (a CSS :hover animation is
 *   cut off and snaps back), and every one ends looking exactly like it began:
 *   the gear turns 120 degrees, which its six teeth make look like 0.
 * - Two-part icons move their parts separately: the calendar and its clock,
 *   the file and its box.
 *
 * Web Animations API on the element itself: no React state, no re-render.
 * Nothing plays for people who asked their computer for less motion.
 */

type Move = [Keyframe[], KeyframeAnimationOptions];
const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';

const MOVES: Record<string, Move> = {
  // Search: the magnifier tilts in to look, then settles.
  search: [[{ transform: 'none' }, { transform: 'translate(-1px, -1px) rotate(-14deg) scale(1.08)', offset: 0.45 }, { transform: 'none' }], { duration: 520, easing: 'ease-out' }],
  // Artifacts: the file shifts back a hair while the box hops out and lands.
  'artifacts-file': [[{ transform: 'none' }, { transform: 'translate(0.5px, -0.5px)', offset: 0.4 }, { transform: 'none' }], { duration: 520, easing: 'ease-out' }],
  'artifacts-box': [[{ transform: 'none' }, { transform: 'translate(-0.5px, -3px) rotate(-10deg)', offset: 0.4 }, { transform: 'translateY(0.6px)', offset: 0.75 }, { transform: 'none' }], { duration: 560, easing: 'ease-out' }],
  // Tasks: the calendar dips once, the clock rings like an alarm.
  'tasks-calendar': [[{ transform: 'none' }, { transform: 'translateY(0.8px)', offset: 0.3 }, { transform: 'none' }], { duration: 420, easing: 'ease-out' }],
  'tasks-clock': [[
    { transform: 'none' },
    { transform: 'rotate(-16deg) scale(1.08)', offset: 0.18 },
    { transform: 'rotate(13deg) scale(1.08)', offset: 0.36 },
    { transform: 'rotate(-8deg)', offset: 0.54 },
    { transform: 'rotate(4deg)', offset: 0.72 },
    { transform: 'none' },
  ], { duration: 620, easing: 'ease-in-out' }],
  // Browser: the globe turns once, a full turn, so it ends where it began.
  spin: [[{ transform: 'perspective(40px) rotateY(0deg)' }, { transform: 'perspective(40px) rotateY(360deg)' }], { duration: 720, easing: 'cubic-bezier(.45, 0, .2, 1)' }],
  // Models: the box pops.
  pop: [[{ transform: 'none' }, { transform: 'scale(1.15) rotate(-6deg)', offset: 0.45 }, { transform: 'none' }], { duration: 460, easing: 'ease-out' }],
  // Settings: the gear turns 120 degrees; with six teeth it lands looking unmoved.
  gear: [[{ transform: 'rotate(0deg)' }, { transform: 'rotate(120deg)' }], { duration: 700, easing: SPRING }],
};

/** Play every move inside a sidebar row, once, to the end. */
export function playNavIcons(row: Element): void {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  row.querySelectorAll<SVGElement>('[data-anim]').forEach((el) => {
    const move = MOVES[el.dataset.anim ?? ''];
    if (!move || typeof el.animate !== 'function') return;
    // Still playing from the last hover: let it finish rather than restart it.
    if (el.getAnimations().some((a) => a.playState === 'running')) return;
    el.animate(move[0], move[1]);
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
      <g data-anim="tasks-calendar" className="nav-part">
        <path d="M16 2v4" />
        <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
        <path d="M3 10h5" />
        <path d="M8 2v4" />
      </g>
      <g data-anim="tasks-clock" className="nav-part">
        <circle cx="16" cy="16" r="6" />
        <path d="M16 14v2.2l1.6 1" />
      </g>
    </Svg>
  );
}

/** Lucide's file-box (ISC), split into its file and its box. */
export function ArtifactsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <g data-anim="artifacts-file" className="nav-part">
        <path d="M14.5 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v3.8" />
        <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      </g>
      <g data-anim="artifacts-box" className="nav-part">
        <path d="M11.7 14.2 7 17l-4.7-2.8" />
        <path d="M3 13.1a2 2 0 0 0-.999 1.76v3.24a2 2 0 0 0 .969 1.78L6 21.7a2 2 0 0 0 2.03.01L11 19.9a2 2 0 0 0 1-1.76V14.9a2 2 0 0 0-.97-1.78L8 11.3a2 2 0 0 0-2.03-.01z" />
        <path d="M7 17v5" />
      </g>
    </Svg>
  );
}
