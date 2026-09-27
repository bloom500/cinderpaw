import { useEffect, useRef, useState, useCallback } from 'react';
import { VARIANTS, FRAME_W, FRAME_H, SHEET_COLS, TICK_MS, type MascotState, type Frame } from './frames';
import sheetUrl from './sheet.webp';

// The clay character is rendered at 2x (256px frames) and drawn at 128 CSS
// px, so it stays sharp on a high-density screen. The creature fills about
// 100px of that; the room above its head is where the ?, ... and Zzz live.
const DISPLAY = 128;

// Every frame in sheet.webp already carries its own motion and marks (the
// breathing, the hop, the Zzz), so the canvas is exactly one frame. The old
// procedural effects layer (effects.ts) is not drawn.
const CANVAS_W = FRAME_W;
const CANVAS_H = FRAME_H;

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

  const drawFrame = useCallback((canvas: HTMLCanvasElement, frameIdx: number) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (!SHEET || !sheetReady) return;

    if (flip) {
      ctx.translate(CANVAS_W, 0);
      ctx.scale(-1, 1);
    }

    const frames = variantRef.current;
    const frame: Frame = frames[frameIdx % frames.length] ?? 0;
    const sx = (frame % SHEET_COLS) * FRAME_W;
    const sy = Math.floor(frame / SHEET_COLS) * FRAME_H;
    ctx.drawImage(SHEET, sx, sy, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
  }, [state, flip]); // a new state restarts its loop from the first frame

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    drawFrame(canvas, 0);
    if (reduced) return;

    let tick = 0;
    const id = window.setInterval(() => {
      tick += 1;
      drawFrame(canvas, tick);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [drawFrame, reduced]);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'relative',
        width: DISPLAY,
        height: DISPLAY,
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
          width: DISPLAY,
          height: DISPLAY,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
