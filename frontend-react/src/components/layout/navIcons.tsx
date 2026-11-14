import type { ReactNode } from 'react';

/**
 * Sidebar icon micro-animations (14 Nov, Darius).
 *
 * Two rules from him:
 * - An animation never visibly resets. It is started on hover and always runs
 *   to its end, even if the pointer leaves halfway (a CSS :hover animation is
 *   cut off and snaps back), and every one ends looking exactly like it began:
 *   the gear turns 120 degrees, which its six teeth make look like 0.
 * - Icons made of pieces move each piece separately: the calendar, its clock
 *   face and its hands; the triangle, square and circle of Artifacts.
 *
 * Web Animations API on the element itself: no React state, no re-render.
 * Nothing plays for people who asked their computer for less motion.
 */

type Move = [Keyframe[], KeyframeAnimationOptions];
const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';

const MOVES: Record<string, Move> = {
  // Search: the magnifier tilts in to look, then settles.
  search: [[{ transform: 'none' }, { transform: 'translate(-1px, -1px) rotate(-14deg)', offset: 0.45 }, { transform: 'none' }], { duration: 520, easing: 'ease-out' }],
  // Artifacts: the three shapes Cubby made play one after another: the
  // triangle hops, the square tips over a quarter turn, the circle bounces.
  'artifacts-triangle': [[{ transform: 'none' }, { transform: 'translateY(-3px)', offset: 0.4 }, { transform: 'translateY(1px)', offset: 0.75 }, { transform: 'none' }], { duration: 520, easing: 'ease-out' }],
  'artifacts-square': [[{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }], { duration: 560, delay: 70, easing: SPRING }],
  'artifacts-circle': [[{ transform: 'none' }, { transform: 'translateY(-3px)', offset: 0.35 }, { transform: 'translateY(1px)', offset: 0.7 }, { transform: 'none' }], { duration: 560, delay: 140, easing: 'ease-out' }],
  // Tasks: the calendar dips, the clock face thickens for a beat, and the
  // hands sweep a full turn around the clock's centre, ending where they began.
  'tasks-calendar': [[{ transform: 'none' }, { transform: 'translateY(1px)', offset: 0.3 }, { transform: 'none' }], { duration: 420, easing: 'ease-out' }],
  'tasks-face': [[{ strokeWidth: 'var(--nav-stroke)' }, { strokeWidth: 'calc(var(--nav-stroke) + 0.9px)', offset: 0.3 }, { strokeWidth: 'var(--nav-stroke)' }], { duration: 640, easing: 'ease-out' }],
  'tasks-hands': [[{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 760, easing: 'cubic-bezier(.45, 0, .2, 1)' }],
  // Browser: the globe turns once, a full turn, so it ends where it began.
  spin: [[{ transform: 'perspective(40px) rotateY(0deg)' }, { transform: 'perspective(40px) rotateY(360deg)' }], { duration: 720, easing: 'cubic-bezier(.45, 0, .2, 1)' }],
  // Models: the box hops and tips, then lands.
  pop: [[{ transform: 'none' }, { transform: 'translateY(-2px) rotate(-10deg)', offset: 0.45 }, { transform: 'none' }], { duration: 460, easing: 'ease-out' }],
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
    // Sharp, not blurred: a transform-only animation is handed to the GPU,
    // which moves a picture of the 18px icon and blurs it while it turns.
    // Carrying the stroke width in every frame keeps it on the main thread,
    // where the icon is drawn again, crisp, each frame. Same width, so
    // nothing visible changes.
    const width = getComputedStyle(el).strokeWidth || '1.6';
    el.style.setProperty('--nav-stroke', width);
    const frames = move[0].map((f) => ('strokeWidth' in f ? f : { ...f, strokeWidth: width }));
    el.animate(frames, move[1]);
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
      <circle data-anim="tasks-face" className="nav-part" cx="16" cy="16" r="6" />
      {/* Turns around the clock's centre (16,16), not its own middle. */}
      <path data-anim="tasks-hands" className="nav-hands" d="M16 14v2.2l1.6 1" />
    </Svg>
  );
}

/** Lucide's shapes (ISC): a triangle, a square and a circle, each its own piece. */
export function ArtifactsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path data-anim="artifacts-triangle" className="nav-part" d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
      <rect data-anim="artifacts-square" className="nav-part" x="3" y="14" width="7" height="7" rx="1" />
      <circle data-anim="artifacts-circle" className="nav-part" cx="17.5" cy="17.5" r="3.5" />
    </Svg>
  );
}
