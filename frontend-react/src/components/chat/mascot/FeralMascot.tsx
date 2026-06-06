import { useEffect, useRef, useState } from 'react';
import { FRAMES, PALETTE, FRAME_W, FRAME_H, type MascotState } from './frames';

const FRAME_MS = 160;
const CANVAS_H = FRAME_H + 2; // headroom so the 1px bob never clips
const DISPLAY = 34;           // CSS px (logical 16 → ~2.1x, image-rendering: pixelated)

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
  if (state === 'done') return tick % 2 === 0 ? -1 : 0; // quick hop
  // idle/typing/thinking/calling: gentle 0↔1 sway every ~2 frames
  return tick % 4 < 2 ? 0 : 1;
}

export function FeralMascot({ state }: { state: MascotState }) {
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
      ctx.clearRect(0, 0, FRAME_W, CANVAS_H);
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
  }, [state, reduced]);

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
