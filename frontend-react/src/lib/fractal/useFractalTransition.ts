import { useCallback, useEffect, useRef, useState } from 'react';
import type { FractalState } from '@/lib/fractal/signal';

const DURATION_MS = 1500;
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3); // cubic ease-out

const ZERO: FractalState = { depthBoost: 0, morph: 0 };

/**
 * Drives a one-shot, user-triggered ease of the fractal state + a 0→1 `phase`
 * for birth/extinction. No idle loop: the rAF cancels itself when the ease
 * completes, and a new `run()` cancels any in-flight ease first.
 */
export function useFractalTransition() {
  const [displayed, setDisplayed] = useState<FractalState>(ZERO);
  const [phase, setPhase] = useState(1);
  const rafRef = useRef<number | null>(null);

  const cancel = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const run = useCallback((from: FractalState, to: FractalState, animate: boolean) => {
    cancel();
    if (!animate) {
      setDisplayed(to);
      setPhase(1);
      return;
    }
    const start = performance.now();
    setPhase(0);
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / DURATION_MS);
      const e = easeOut(raw);
      setDisplayed({
        depthBoost: from.depthBoost + (to.depthBoost - from.depthBoost) * e,
        morph: from.morph + (to.morph - from.morph) * e,
      });
      setPhase(e);
      if (raw < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null; // settle — no idle loop
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => cancel, []); // cleanup on unmount

  return { displayed, phase, run };
}
