import { useEffect, useRef, useState, useCallback } from 'react';
import { VARIANTS, FRAME_W, FRAME_H, SHEET_COLS, type MascotState, type Frame } from './frames';
import sheetUrl from './sheet.png';

const FRAME_MS = 160;
const SPRITE_H = FRAME_H + 2; // body rows + 1px bob headroom
// 2×: the drawn frame is 64px with the creature filling 48 of them, so on
// screen the creature is 96px tall and the 8px margin around it, where props
// and Z's live, is 16px. 1:1 (64) was tried first and read as "super mica";
// keep the scale an integer or the pixel-art smears at pixel boundaries.
const DISPLAY = 128;
const SCALE = DISPLAY / FRAME_W;

// Every frame in sheet.png already carries its own props and effects (the
// sparkles, the Z's, the magnifier), so the canvas is exactly one frame plus
// the bob headroom. The old procedural effects layer (effects.ts) is not drawn.
const CANVAS_W = FRAME_W;
const CANVAS_H = SPRITE_H;

// One shared sheet for every instance. Frames drawn before it has loaded are
// simply skipped; the next tick paints them.
const SHEET = typeof Image !== 'undefined' ? new Image() : null;
let sheetReady = false;
if (SHEET) {
  SHEET.onload = () => { sheetReady = true; };
  SHEET.src = sheetUrl;
}

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

export function CinderpawMascot({ state, flip = false }: { state: MascotState; flip?: boolean }) {
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
    if (!SHEET || !sheetReady) return;

    if (flip) {
      ctx.translate(CANVAS_W, 0);
      ctx.scale(-1, 1);
    }

    const frames = variantRef.current;
    const frame: Frame = frames[frameIdx % frames.length] ?? 0;
    const y0 = 1 + (reduced ? 0 : bobOffset(state, tick));
    const sx = (frame % SHEET_COLS) * FRAME_W;
    const sy = Math.floor(frame / SHEET_COLS) * FRAME_H;
    ctx.drawImage(SHEET, sx, sy, FRAME_W, FRAME_H, 0, y0, FRAME_W, FRAME_H);
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
          left: 0,
          top: 0,
          width: Math.round(CANVAS_W * SCALE),
          height: Math.round(CANVAS_H * SCALE),
          imageRendering: 'pixelated',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
