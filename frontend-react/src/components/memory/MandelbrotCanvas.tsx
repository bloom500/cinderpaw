// frontend-react/src/components/memory/MandelbrotCanvas.tsx
import { useEffect, useRef } from 'react';
import {
  createMandelbrotRenderer, screenToComplex,
  type View, type FractalTheme, type MandelbrotRenderer,
} from '@/lib/fractal/mandelbrot';

interface Props {
  view: View;
  theme: FractalTheme;
  /** User changed the view (wheel/drag). Parent owns the View (shared with nodes). */
  onViewChange: (v: View) => void;
}

const MIN_SCALE = 1e-6;   // fp32 deep-zoom floor
const MAX_SCALE = 2.0;    // fully zoomed out

/**
 * WebGL2 Mandelbrot backdrop. Fully user-driven: wheel zooms toward the cursor,
 * drag pans. No animation loop — we redraw only when `view`/`theme` change or
 * the user interacts. Falls back to a flat field if WebGL2 is unavailable.
 */
export function MandelbrotCanvas({ view, theme, onViewChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MandelbrotRenderer | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Create the renderer once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = createMandelbrotRenderer(canvas);
    rendererRef.current = r;
    if (!r) return; // fallback handled by CSS background below
    const onResize = () => { r.render(viewRef.current, theme); };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      r.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw on view/theme change.
  useEffect(() => {
    rendererRef.current?.render(view, theme);
  }, [view, theme]);

  // Wheel zoom toward cursor.
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const before = screenToComplex(px, py, rect.width, rect.height, viewRef.current);
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewRef.current.scale * factor));
    const v2: View = { ...viewRef.current, scale };
    const after = screenToComplex(px, py, rect.width, rect.height, v2);
    // Keep the point under the cursor fixed.
    onViewChange({
      centerX: v2.centerX + (before.x - after.x),
      centerY: v2.centerY + (before.y - after.y),
      scale,
    });
  };

  // Drag pan.
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const aspect = rect.width / rect.height;
    const dxPix = e.clientX - drag.current.x;
    const dyPix = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    // Convert pixel delta to complex delta (note the +imag-up flip).
    const v = viewRef.current;
    onViewChange({
      centerX: v.centerX - (dxPix / rect.width) * 2 * v.scale * aspect,
      centerY: v.centerY + (dyPix / rect.height) * 2 * v.scale,
      scale: v.scale,
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  // CSS fallback color = flat field if WebGL2 missing (renderer null).
  const fallbackBg = theme === 'dark' ? '#050508' : '#eae8f2';

  return (
    <canvas
      ref={canvasRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="fixed inset-0 z-0 h-full w-full touch-none cursor-grab active:cursor-grabbing"
      style={{ background: fallbackBg }}
    />
  );
}
