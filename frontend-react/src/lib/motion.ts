/**
 * How Cinderpaw moves (29 Oct, his "smooth, fluide ca la Apple, dar solide"),
 * on Apple's own model: springs set by a perceptual duration and a bounce
 * (WWDC23 "Animate with springs"; SwiftUI `Spring`). It replaced 32 durations
 * and 14 curves, each picked where it was needed and never compared with its
 * neighbours, which is what made the app feel built from separate pieces.
 *
 * Bounce 0 everywhere: what Apple calls the most versatile, general-purpose
 * spring, a smooth change with a long tail that never passes the mark. Fluid on
 * the way, solid at the end. A spring keeps its speed when it is interrupted,
 * which a fixed curve cannot (HIG Motion: "Let people cancel motion").
 * Loops that only show life (shimmer, breathing, spinners) keep their rhythm.
 */

/** Perceptual durations in seconds (Apple's `duration`): fast for hover, press
 *  and small things, base for panels, cards and menus, slow for whole surfaces. */
export const MOTION = { fast: 0.15, base: 0.2, slow: 0.32 } as const;

/**
 * Apple's conversion to a physical spring, mass 1: stiffness (2π/d)², damping
 * 4π(1 − bounce)/d. Spring(duration: 0.5, bounce: 0.3) gives 157.9 and 17.6,
 * as Apple documents it (test/motion.test.ts checks this).
 */
export function spring(duration: number, bounce = 0) {
  return {
    type: 'spring' as const,
    mass: 1,
    stiffness: (2 * Math.PI / duration) ** 2,
    damping: (4 * Math.PI * (1 - bounce)) / duration,
  };
}

/** framer-motion transitions on the scale. */
export const FAST = spring(MOTION.fast);
export const BASE = spring(MOTION.base);
export const SLOW = spring(MOTION.slow);

/**
 * The same bounce-0 spring for CSS and the Web Animations API, which have no
 * springs: its curve, 1 − (1 + ωt)·e^(−ωt), sampled into `linear()`. It plays
 * over CSS_TIME × the perceptual duration; at 1× it is 98.6% of the way there,
 * the rest is the spring's long tail. globals.css carries the same string.
 */
export const SPRING_CSS = 'linear(0, 0.0401, 0.1313, 0.2431, 0.3577, 0.4656, 0.562, 0.6452, 0.7154, 0.7736, 0.821, 0.8594, 0.89, 0.9144, 0.9336, 0.9487, 0.9605, 0.9696, 0.9767, 0.9822, 0.9864, 0.9896, 0.9921, 0.994, 0.9955, 0.9966, 0.9974, 0.998, 0.9985, 0.9989, 1)';
export const CSS_TIME = 1.5;
/** The one curve for loops that only show life (an orb breathing): even in, even out. */
export const LOOP_CSS = 'cubic-bezier(0.45, 0, 0.55, 1)';
/** How long a CSS or Web Animations transition on the scale runs, in ms. */
export const cssMs = (duration: number) => Math.round(duration * CSS_TIME * 1000);
