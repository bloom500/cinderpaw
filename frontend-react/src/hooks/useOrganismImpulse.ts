import { useCallback, useEffect, useRef } from 'react';
import type { OrganismState } from '@/lib/fractal/signal';

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Animate the organism from one state to another over a short, self-settling
 * impulse (one rAF run, then cancelled). No persistent loop — idle = frozen.
 */
export function useOrganismImpulse(opts: { onFrame: (s: OrganismState) => void; durationMs?: number }) {
  const { onFrame, durationMs = 1500 } = opts;
  const rafRef = useRef<number | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  const impulseTo = useCallback((from: OrganismState, to: OrganismState) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / durationMs);
      const t = easeOutCubic(raw);
      // morph blips up then back to the target (a breath) while structure eases in.
      const breath = Math.sin(raw * Math.PI) * 0.12;
      onFrameRef.current({
        power: lerp(from.power, to.power, t),
        depthBoost: lerp(from.depthBoost, to.depthBoost, t),
        morph: Math.min(0.12, lerp(from.morph, to.morph, t) + breath),
        warpSeeds: to.warpSeeds,
      });
      if (raw < 1) { rafRef.current = requestAnimationFrame(tick); }
      else { rafRef.current = null; onFrameRef.current(to); }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [durationMs]);

  return { impulseTo };
}
