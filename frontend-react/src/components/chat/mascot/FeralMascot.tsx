import { useEffect, useRef, useState, useCallback } from 'react';
import { VARIANTS, PALETTE, FRAME_W, FRAME_H, type MascotState, type Frame } from './frames';
import { EFFECTS, FX_MARGIN_X, FX_MARGIN_TOP } from './effects';

const FRAME_MS = 160;
const SPRITE_H = FRAME_H + 2; // body rows + 1px bob headroom
// 3× integer scale: big enough that every state/effect reads clearly, small
// enough to perch on the input without stealing space. Integer scale keeps
// the pixel-art crisp (non-integer scales smear pixel boundaries).
const DISPLAY = 48;
const SCALE = DISPLAY / FRAME_W;

// The canvas is larger than the sprite so per-state pixel effects (confetti,
// sparkles, hearts, Z's — see effects.ts) can play AROUND the body. The
// component's layout footprint stays exactly DISPLAY×(sprite height): the
// canvas is absolutely positioned with negative offsets inside a fixed-size
// wrapper, so MascotPerch travel math and the input layout are unaffected.
const CANVAS_W = FRAME_W + FX_MARGIN_X * 2;
const CANVAS_H = SPRITE_H + FX_MARGIN_TOP;

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
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Effects are drawn unflipped (their compositions are tuned per side);
    // only the body mirrors when running back across the input.
    if (!reduced) {
      const fx = EFFECTS[state];
      if (fx) {
        for (const p of fx(tick)) {
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x, p.y, 1, 1);
        }
      }
    }

    if (flip) {
      ctx.translate(CANVAS_W, 0);
      ctx.scale(-1, 1);
    }

    const frames = variantRef.current;
    const frame = frames[frameIdx % frames.length];
    const y0 = FX_MARGIN_TOP + 1 + (reduced ? 0 : bobOffset(state, tick));
    for (let r = 0; r < frame.length; r++) {
      const row = frame[r];
      for (let c = 0; c < row.length; c++) {
        const color = PALETTE[row[c]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(FX_MARGIN_X + c, y0 + r, 1, 1);
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
    <div
      aria-hidden="true"
      style={{
        position: 'relative',
        width: DISPLAY,
        height: Math.round(SPRITE_H * SCALE),
      }}
    >
      <canvas
        ref={ref}
        width={CANVAS_W}
        height={CANVAS_H}
        style={{
          position: 'absolute',
          left: -Math.round(FX_MARGIN_X * SCALE),
          top: -Math.round(FX_MARGIN_TOP * SCALE),
          width: Math.round(CANVAS_W * SCALE),
          height: Math.round(CANVAS_H * SCALE),
          imageRendering: 'pixelated',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
