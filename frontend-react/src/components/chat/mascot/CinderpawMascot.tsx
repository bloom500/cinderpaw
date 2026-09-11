import { useEffect, useState } from 'react';
import { frameFor, artUrl, type MascotState } from './frames';

const FRAME_MS = 160;
// 32px art at 3x = 96 display. Integer scale with pixelated rendering keeps
// every pixel square.
export const DISPLAY = 96;

/** Exported because the perch needs it too — the sprite freezing while the
 *  creature still runs the width of the composer trailing dust is the setting
 *  half-honoured, which for a vestibular trigger is not honoured. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    // Optional-called, like the two other reduced-motion checks in this app:
    // an environment without `matchMedia` must lose the preference, not throw
    // and take the whole composer down with it.
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

function bobOffset(state: MascotState, tick: number): number {
  if (state === 'sleep' || state === 'stretching') return 1;
  if (state === 'done' || state === 'running' || state === 'excited' || state === 'spawning')
    return tick % 2 === 0 ? -1 : 0;
  if (state === 'error' || state === 'cool') return tick % 3 === 0 ? -1 : 0;
  return tick % 4 < 2 ? 0 : 1;
}

export function CinderpawMascot({ state, flip = false }: { state: MascotState; flip?: boolean }) {
  const [tick, setTick] = useState(0);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setTick((t) => t + 1), FRAME_MS);
    return () => window.clearInterval(id);
  }, [reduced]);

  // Frozen motion shows the resting frame, never a mid-blink catch.
  const art = frameFor(state, reduced ? 0 : tick);
  const dy = reduced ? 0 : bobOffset(state, tick);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'relative',
        width: DISPLAY,
        height: DISPLAY,
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <img
        src={artUrl(art)}
        alt=""
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        style={{
          width: DISPLAY,
          height: DISPLAY,
          imageRendering: 'pixelated',
          pointerEvents: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          transform: `${flip ? 'scaleX(-1) ' : ''}translateY(${dy}px)`,
        }}
      />
    </div>
  );
}
