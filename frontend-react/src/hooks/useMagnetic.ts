import { useEffect, useRef } from 'react';
import { useMotionValue, useSpring, useReducedMotion, type MotionValue } from 'framer-motion';

/**
 * Lean an element toward the pointer while it is nearby.
 *
 * Built on `useMotionValue` + `useSpring`, which have been in the bundle since
 * the day framer-motion was installed and had never been used: everything in
 * this app animates through `motion.div` props, which re-render React on every
 * frame they are driven from state. A motion value writes the transform
 * directly and React never hears about it, which is what makes a
 * pointer-tracked effect affordable in a rail that sits next to a streaming
 * conversation.
 *
 * `radius` is where the pull starts, `pull` is how far the element travels at
 * its strongest, both in pixels. Past the radius it springs home, so nothing
 * has to track when the pointer left.
 */
export function useMagnetic<T extends HTMLElement>(
  { radius = 80, pull = 6, enabled = true }: { radius?: number; pull?: number; enabled?: boolean } = {},
): { ref: React.RefObject<T | null>; x: MotionValue<number>; y: MotionValue<number> } {
  const ref = useRef<T>(null);
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  // Stiff and well damped: this should feel like the icon is attached to
  // something, not like it is floating. A loose spring on a navigation rail
  // reads as the UI being unsure where its own buttons are.
  const x = useSpring(rawX, { stiffness: 320, damping: 28, mass: 0.35 });
  const y = useSpring(rawY, { stiffness: 320, damping: 28, mass: 0.35 });

  // Not the `motion-reduce` class and not MotionConfig: those cover CSS
  // transitions and `motion.*` props. A motion value driven by hand ignores
  // both, so the setting has to be read here or this is the one thing on
  // screen that still moves for somebody who asked it not to.
  const still = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || still) {
      rawX.set(0);
      rawY.set(0);
      return;
    }

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const distance = Math.hypot(dx, dy);
      if (distance > radius) {
        rawX.set(0);
        rawY.set(0);
        return;
      }
      // Linear falloff from the centre out. A square or cubic curve looks
      // better in a gallery demo and worse here, because a row is only 36px
      // tall: most of the curve is spent doing nothing.
      const strength = 1 - distance / radius;
      rawX.set((dx / radius) * pull * strength * 2);
      rawY.set((dy / radius) * pull * strength * 2);
    };

    // On the window, not the element. Bound to the element it would only fire
    // once the pointer was already on top of it, which is exactly when the
    // effect has nothing left to say.
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      rawX.set(0);
      rawY.set(0);
    };
  }, [enabled, still, radius, pull, rawX, rawY]);

  return { ref, x, y };
}
