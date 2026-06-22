import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { tauri, events } from '@/lib/tauri';
import { useOrganismImpulse } from '@/hooks/useOrganismImpulse';
import {
  createOrganismRenderer,
  DEFAULT_VIEW,
  screenToComplex,
  type OrganismRenderer,
  type OrganismView,
} from '@/lib/fractal/organism';
import { deriveOrganismState, type OrganismState } from '@/lib/fractal/signal';
import { breathingMorph, BREATH_WINDOW_MS } from '@/lib/fractal/breathing';
import { maturity } from '@/lib/fractal/maturity';

const REST_STATE: OrganismState = { power: 2, depthBoost: 0, morph: 0, warpSeeds: [] };

export default function MemoryLayersPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrganismRenderer | null>(null);
  const viewRef = useRef<OrganismView>({ ...DEFAULT_VIEW });
  const stateRef = useRef<OrganismState>(REST_STATE);
  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  // Active breath: a self-terminating RAF started by a `recall` pulse. null
  // when the organism is at rest (no idle animation).
  const breathRef = useRef<{ raf: number; start: number; base: OrganismState } | null>(null);

  const draw = useCallback(() => {
    rendererRef.current?.render(viewRef.current, stateRef.current);
  }, []);

  const { impulseTo } = useOrganismImpulse({
    onFrame: (s) => { stateRef.current = s; draw(); },
  });

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
      impulseTo(stateRef.current, state);
    } catch (err) {
      console.error('[MemoryLayersPage] refresh failed', err);
    } finally {
      setLoading(false);
    }
  }, [impulseTo]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Breathing: a `recall` pulse makes the organism breathe over the active
  // region for one window, then it goes perfectly still again. The loop reads
  // the current resting state as its base and overlays the morph swell on top,
  // restoring the base and stopping itself once the window elapses.
  const startBreathing = useCallback(() => {
    if (breathRef.current) cancelAnimationFrame(breathRef.current.raf);
    const base = stateRef.current;
    const start = performance.now();
    const tick = () => {
      const elapsed = performance.now() - start;
      if (elapsed >= BREATH_WINDOW_MS) {
        stateRef.current = base;       // back to rest
        draw();
        breathRef.current = null;      // loop stops — no idle animation
        return;
      }
      const m = breathingMorph(elapsed);
      stateRef.current = { ...base, morph: Math.max(base.morph, m) };
      draw();
      breathRef.current = { raf: requestAnimationFrame(tick), start, base };
    };
    breathRef.current = { raf: requestAnimationFrame(tick), start, base };
  }, [draw]);

  // Stop any in-flight breath on unmount.
  useEffect(() => () => {
    if (breathRef.current) cancelAnimationFrame(breathRef.current.raf);
    breathRef.current = null;
  }, []);

  // Live evolution, driven by Fractal Memory Search (not RSI):
  //   grow   → re-pull memory + ease the form to its new size (filament growth)
  //   recall → breathe over the just-traversed region
  useEffect(() => {
    let alive = true;
    const unlistenP = events.onFractalActivity.listen((e) => {
      if (!alive) return;
      if (e.kind === 'grow') void refresh();
      else if (e.kind === 'recall') startBreathing();
    });
    return () => { alive = false; void unlistenP.then((u) => u()).catch(() => {}); };
  }, [refresh, startBreathing]);

  // Live evolution: re-pull + pulse whenever the RSI engine reports progress.
  useEffect(() => {
    let alive = true;
    const unlistenP = events.onRsiEngineEvent.listen(() => { if (alive) void refresh(); });
    return () => { alive = false; void unlistenP.then((u) => u()).catch(() => {}); };
  }, [refresh]);

  // Pan / zoom — pure vector navigation of the organism.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const v = viewRef.current;
    const before = screenToComplex(px, py, w, h, v);
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    const scale = Math.max(1e-7, v.scale * factor);
    const v2 = { ...v, scale };
    const after = screenToComplex(px, py, w, h, v2);
    viewRef.current = { ...v2, centerX: v2.centerX + (before.x - after.x), centerY: v2.centerY + (before.y - after.y) };
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
        className="absolute bottom-4 right-4 z-10 rounded-lg border border-border-subtle bg-bg-surface/70 backdrop-blur p-2 text-text-secondary hover:text-text-primary disabled:opacity-50"
      >
        <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  );
}
