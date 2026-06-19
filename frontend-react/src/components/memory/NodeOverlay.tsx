import { useEffect, useMemo, useRef } from 'react';
import type { MemoryGraphSnapshot } from '@/lib/tauri';
import { complexToScreen, type View } from '@/lib/fractal/mandelbrot';
import { layoutNodes, type LaidOutNode } from '@/lib/fractal/layout';

interface Props {
  snapshot: MemoryGraphSnapshot;
  view: View;
  colorFor: (type: string) => string;   // reuse the page's theme type palette
  hiddenTypes: Set<string>;
  search: string;
  onSelect: (id: string | null) => void;
}

/** Hit radius in px around a node center for click selection. */
const HIT_PX = 14;
/** Scale guards: at very large graphs (100k+) drawing every orb with a glow
 *  would tank the framerate. Cap how many we draw per frame (highest-degree
 *  first) and drop the expensive shadowBlur glow above a second threshold. */
const MAX_DRAWN = 4000;   // hard cap on orbs drawn per frame
const MAX_GLOW = 1200;    // above this many drawn, skip shadowBlur (cheap dots)

/**
 * Vector node/edge layer drawn on a 2D canvas above the fractal. Nodes are glow
 * orbs (size = degree, hue = type); edges are faint links. DPR-aware so it stays
 * crisp at any zoom. LOD: labels + edges fade out when zoomed far out or dense,
 * keeping ~1000+ nodes readable and cheap (one draw per view change, no physics).
 */
export function NodeOverlay({ snapshot, view, colorFor, hiddenTypes, search, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const laidOut = useMemo(() => layoutNodes(snapshot), [snapshot]);
  const byId = useMemo(() => new Map(laidOut.map((n) => [n.id, n] as const)), [laidOut]);
  const q = search.trim().toLowerCase();

  // Filter, then sort highest-degree-first so the draw cap keeps the most
  // important nodes when the graph is huge (100k+). Sorting once per filter
  // change (not per frame) keeps it cheap.
  const visible = useMemo<LaidOutNode[]>(
    () =>
      laidOut
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

    const visibleSet = new Set(visible.map((n) => n.id));
    const dense = visible.length > 350;
    // LOD: show edges/labels only when not too dense AND zoomed in enough.
    const showEdges = !dense && view.scale < 0.5;
    const showLabels = !dense && view.scale < 0.12;

    if (showEdges) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(148,163,184,0.25)';
      for (const e of snapshot.edges) {
        if (!visibleSet.has(e.from) || !visibleSet.has(e.to)) continue;
        const a = byId.get(e.from)!, b = byId.get(e.to)!;
        const pa = complexToScreen(a.wx, a.wy, w, h, view);
        const pb = complexToScreen(b.wx, b.wy, w, h, view);
        ctx.beginPath();
        ctx.moveTo(pa.px, pa.py);
        ctx.lineTo(pb.px, pb.py);
        ctx.stroke();
      }
    }

    let drawn = 0;
    for (const n of visible) {
      if (drawn >= MAX_DRAWN) break;                 // hard draw cap (100k safety)
      const p = complexToScreen(n.wx, n.wy, w, h, view);
      if (p.px < -50 || p.py < -50 || p.px > w + 50 || p.py > h + 50) continue; // viewport cull
      const radius = 4 + Math.min(n.degree * 1.5, 12);
      const color = colorFor(n.type);
      const glow = drawn < MAX_GLOW;                  // cheap dots once over the glow budget
      if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 12; }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.px, p.py, radius, 0, Math.PI * 2);
      ctx.fill();
      if (glow) ctx.shadowBlur = 0;
      if (showLabels) {
        ctx.fillStyle = 'rgba(203,213,225,0.95)';
        ctx.font = '11px Inter, system-ui, sans-serif';
        ctx.fillText(n.label, p.px + radius + 3, p.py + 3);
      }
      drawn++;
    }
  }, [visible, view, snapshot.edges, byId, colorFor]);

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

  // pointer-events: none on the canvas would block fractal drag; instead this
  // sits above and forwards drag/wheel by being transparent to them EXCEPT
  // clicks. We let clicks here select; drag/wheel are handled by the fractal
  // canvas below via event bubbling when no node is hit.
  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      className="pointer-events-none fixed inset-0 z-[1] h-full w-full"
    />
  );
}
