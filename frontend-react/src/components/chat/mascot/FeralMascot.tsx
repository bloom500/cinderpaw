import { useEffect, useRef, useState } from 'react';
import { FRAMES, PALETTE, FRAME_W, FRAME_H, type MascotState } from './frames';

const FRAME_MS = 160;
const CANVAS_H = FRAME_H + 2; // headroom so the 1px bob never clips
const DISPLAY = 38;           // CSS px (logical 16 → ~2.4x, image-rendering: pixelated)

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Vertical bob offset (px) for a given state + tick. Up is negative. */
function bobOffset(state: MascotState, tick: number): number {
  if (state === 'done' || state === 'running') return tick % 2 === 0 ? -1 : 0;
  return tick % 4 < 2 ? 0 : 1;
}

export function FeralMascot({ state, flip = false }: { state: MascotState; flip?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const frames = FRAMES[state];

    const draw = (frameIdx: number, tick: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, FRAME_W, CANVAS_H);
      if (flip) {
        // Mirror horizontally (facing left while running back).
        ctx.translate(FRAME_W, 0);
        ctx.scale(-1, 1);
      }
      const frame = frames[frameIdx % frames.length];
      const y0 = 1 + (reduced ? 0 : bobOffset(state, tick));
      for (let r = 0; r < frame.length; r++) {
        const row = frame[r];
        for (let c = 0; c < row.length; c++) {
          const color = PALETTE[row[c]];
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(c, y0 + r, 1, 1);
        }
      }
    };

    draw(0, 0);
    if (reduced) return; // static

    let tick = 0;
    const id = window.setInterval(() => {
      tick += 1;
      draw(tick, tick);
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [state, reduced, flip]);

  return (
    <canvas
      ref={ref}
      width={FRAME_W}
      height={CANVAS_H}
      aria-hidden="true"
      style={{
        width: DISPLAY,
        height: Math.round((DISPLAY * CANVAS_H) / FRAME_W),
        imageRendering: 'pixelated',
      }}
    />
  );
}
