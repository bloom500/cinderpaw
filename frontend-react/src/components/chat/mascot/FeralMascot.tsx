import { useEffect, useRef, useState, useCallback } from 'react';
import { VARIANTS, PALETTE, FRAME_W, FRAME_H, type MascotState, type Frame } from './frames';

const FRAME_MS = 160;
const CANVAS_H = FRAME_H + 2;
const DISPLAY = 38;

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

function pickVariant(pool: Frame[][], lastIdx: number): number {
  if (pool.length === 1) return 0;
  let idx: number;
  do { idx = Math.floor(Math.random() * pool.length); }
  while (idx === lastIdx);
  return idx;
}

function bobOffset(state: MascotState, tick: number): number {
  if (state === 'sleep' || state === 'stretching') return 1;
  if (state === 'done' || state === 'running' || state === 'excited' || state === 'spawning')
    return tick % 2 === 0 ? -1 : 0;
  if (state === 'error' || state === 'cool') return tick % 3 === 0 ? -1 : 0;
  return tick % 4 < 2 ? 0 : 1;
}

export function FeralMascot({ state, flip = false }: { state: MascotState; flip?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();
  const variantRef = useRef<Frame[]>([]);
  const lastIdx = useRef<number>(-1);
  const prevState = useRef<MascotState | null>(null);

  useEffect(() => {
    if (state !== prevState.current) {
      const pool = VARIANTS[state];
      const idx = pickVariant(pool, lastIdx.current);
      variantRef.current = pool[idx];
      lastIdx.current = idx;
      prevState.current = state;
    }
  }, [state]);

  const drawFrame = useCallback((canvas: HTMLCanvasElement, frameIdx: number, tick: number) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, FRAME_W, CANVAS_H);
    if (flip) {
      ctx.translate(FRAME_W, 0);
      ctx.scale(-1, 1);
    }

    const frames = variantRef.current;
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
  }, [state, reduced, flip]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    drawFrame(canvas, 0, 0);
    if (reduced) return;

    let tick = 0;
    const id = window.setInterval(() => {
      tick += 1;
      drawFrame(canvas, tick, tick);
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [drawFrame, reduced]);

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
