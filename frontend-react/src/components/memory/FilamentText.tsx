// src/components/memory/FilamentText.tsx
import { useEffect, useMemo, useRef } from 'react';
import type { MemoryGraphSnapshot } from '@/lib/tauri';
import { complexToScreen, type View } from '@/lib/fractal/mandelbrot';
import { layoutNodes, type LaidOutNode } from '@/lib/fractal/layout';
import { filamentTangent } from '@/lib/fractal/escape';
import type { NodeDiff } from '@/lib/fractal/diff';

interface Props {
  snapshot: MemoryGraphSnapshot;
  view: View;
  colorFor: (type: string) => string;
  hiddenTypes: Set<string>;
  search: string;
  showLabels?: boolean;
  /** Transition progress 0..1; 1 = settled/idle. */
  phase: number;
  /** Extinct nodes (from the previous snapshot) fading out this transition. */
  departing: LaidOutNode[];
  /** Birth/extinction classification for the current snapshot. */
  diff: NodeDiff;
  onSelect: (id: string | null) => void;
}

const HIT_PX = 14;
const MAX_DRAWN = 4000;            // hard cap (100k-node safety)
const TEXT_SCALE_MAX = 0.12;       // show filament text only when zoomed in past this
const SPARK_RADIUS = 2.5;          // discrete dot when zoomed out / dense

/** Iteration budget for tangent sampling — coarse is fine for orientation. */
const TANGENT_ITER = 200;

/** Iridescent per-character hue: shift the node's base color along the palette. */
function iridescent(base: string, charIndex: number, alpha: number): string {
  // base is "#rrggbb"; rotate lightly by character to get the shimmer.
  const n = base.startsWith('#') ? parseInt(base.slice(1), 16) : 0x888888;
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const shimmer = Math.sin(charIndex * 0.6) * 28;
  r = Math.max(0, Math.min(255, r + shimmer));
  b = Math.max(0, Math.min(255, b - shimmer));
  return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
}

/** Draw a string along a tangent direction, one rotated glyph at a time. */
function drawAlong(
  ctx: CanvasRenderingContext2D,
  text: string, px: number, py: number, tx: number, ty: number,
  baseColor: string, alpha: number, reveal: number,
) {
  const angle = Math.atan2(ty, tx);
  const step = 7; // px between glyph centers
  const count = Math.max(1, Math.ceil(text.length * reveal));
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(angle);
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 6;
  for (let i = 0; i < count && i < text.length; i++) {
    const color = iridescent(baseColor, i, alpha);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.fillText(text[i], (i - text.length / 2) * step, 0);
  }
  ctx.restore();
}

export function FilamentText({
  snapshot, view, colorFor, hiddenTypes, search, showLabels = true,
  phase, departing, diff, onSelect,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const laidOut = useMemo(() => layoutNodes(snapshot), [snapshot]);
  const q = search.trim().toLowerCase();
  const visible = useMemo<LaidOutNode[]>(
    () => laidOut
      .filter((n) => !hiddenTypes.has(n.type) && (!q || n.label.toLowerCase().includes(q)))
      .sort((a, b) => b.degree - a.degree),
    [laidOut, hiddenTypes, q],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // eps for tangent sampling: ~1.5 device-independent px in complex units.
    const eps = (view.scale * 2) / h * 1.5;
    const asText = showLabels && view.scale < TEXT_SCALE_MAX;

    const paint = (n: LaidOutNode, alpha: number, reveal: number) => {
      const p = complexToScreen(n.wx, n.wy, w, h, view);
      if (p.px < -60 || p.py < -60 || p.px > w + 60 || p.py > h + 60) return;
      const color = colorFor(n.type);
      if (asText) {
        const { tx, ty } = filamentTangent(n.wx, n.wy, TANGENT_ITER, eps);
        drawAlong(ctx, n.label, p.px, p.py, tx, ty, color, alpha, reveal);
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(p.px, p.py, SPARK_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };

    let drawn = 0;
    // Current nodes: born nodes fade/draw in with `phase`; survivors are full.
    for (const n of visible) {
      if (drawn >= MAX_DRAWN) break;
      const born = diff.born.has(n.id);
      paint(n, born ? phase : 1, born ? phase : 1);
      drawn++;
    }
    // Departing (extinct) nodes from the previous snapshot fade/erase out.
    for (const n of departing) {
      if (drawn >= MAX_DRAWN) break;
      if (hiddenTypes.has(n.type)) continue;
      paint(n, 1 - phase, 1 - phase);
      drawn++;
    }
  }, [visible, departing, diff, view, phase, colorFor, hiddenTypes, showLabels]);

  const onClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best: { id: string; d: number } | null = null;
    for (const n of visible) {
      const p = complexToScreen(n.wx, n.wy, rect.width, rect.height, view);
      const d = Math.hypot(p.px - px, p.py - py);
      if (d <= HIT_PX && (!best || d < best.d)) best = { id: n.id, d };
    }
    onSelect(best?.id ?? null);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      className="pointer-events-none fixed inset-0 z-[1] h-full w-full"
    />
  );
}
