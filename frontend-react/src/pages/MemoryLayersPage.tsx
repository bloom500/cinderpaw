import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import {
  createOrganismRenderer,
  DEFAULT_VIEW,
  type OrganismRenderer,
  type OrganismView,
} from '@/lib/fractal/organism';
import { deriveOrganismState, type OrganismState } from '@/lib/fractal/signal';
import { maturity } from '@/lib/fractal/maturity';

const REST_STATE: OrganismState = { power: 2, depthBoost: 0, morph: 0, warpSeeds: [] };

export default function MemoryLayersPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrganismRenderer | null>(null);
  const viewRef = useRef<OrganismView>({ ...DEFAULT_VIEW });
  const stateRef = useRef<OrganismState>(REST_STATE);
  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  const draw = useCallback(() => {
    rendererRef.current?.render(viewRef.current, stateRef.current);
  }, []);

  // One-time renderer setup.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = createOrganismRenderer(canvas);
    if (!r) { setUnsupported(true); return; }
    rendererRef.current = r;
    draw();
    const onResize = () => { r.resize(); draw(); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); r.dispose(); rendererRef.current = null; };
  }, [draw]);

  // Pull memory + RSI state and recompute the organism form.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [graph, rsi] = await Promise.all([
        tauri.memory.getGraph(),
        tauri.rsi.status().catch(() => null),
      ]);
      const eliteNodeCount = graph.nodes.length;
      const clusterCount = new Set(graph.nodes.map((n) => n.type)).size; // diversity proxy (3a)
      const { state, floor } = deriveOrganismState({
        clusterCount,
        eliteNodeCount,
        rsi,
        persistedFloor: maturity.current(),
      });
      maturity.bump(floor);
      stateRef.current = state;
      draw();
    } finally {
      setLoading(false);
    }
  }, [draw]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Pan / zoom — pure vector navigation of the organism.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    viewRef.current = { ...viewRef.current, scale: Math.max(1e-7, viewRef.current.scale * factor) };
    draw();
  }, [draw]);

  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { dragRef.current = { x: e.clientX, y: e.clientY }; };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const v = viewRef.current;
    const aspect = canvas.clientWidth / canvas.clientHeight;
    viewRef.current = {
      ...v,
      centerX: v.centerX - ((e.clientX - d.x) / canvas.clientWidth) * 2 * v.scale * aspect,
      centerY: v.centerY + ((e.clientY - d.y) / canvas.clientHeight) * 2 * v.scale,
    };
    dragRef.current = { x: e.clientX, y: e.clientY };
    draw();
  };
  const onPointerUp = () => { dragRef.current = null; };

  if (unsupported) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black">
        <p className="text-xs text-text-muted">WebGL2 unavailable — organism view disabled.</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      />
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading}
        aria-label="Refresh organism"
        className="absolute top-4 right-4 z-10 rounded-lg border border-border-subtle bg-bg-surface/70 backdrop-blur p-2 text-text-secondary hover:text-text-primary disabled:opacity-50"
      >
        <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  );
}
