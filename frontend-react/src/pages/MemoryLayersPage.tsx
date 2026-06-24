import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { tauri, events } from '@/lib/tauri';
import { deriveTreeState } from '@/lib/tree/treeState';
import { generateSkeleton } from '@/lib/tree/skeleton';
import { skeletonToBuffers } from '@/lib/tree/geometry';
import { createTreeRenderer, type TreeRenderer } from '@/lib/tree/renderer';
import { hashSeed } from '@/lib/tree/rng';
import { maturity } from '@/lib/tree/maturity';
import type { TreeInput } from '@/lib/tree/contract';

export default function MemoryLayersPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<TreeRenderer | null>(null);
  const seedRef = useRef<number>(hashSeed('feral-tree-v1'));
  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  // One-time renderer setup.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = createTreeRenderer(canvas);
    if (!r) { setUnsupported(true); return; }
    rendererRef.current = r;
    const onResize = () => {
      r.resize();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      r.dispose();
      rendererRef.current = null;
    };
  }, []);

  const renderTree = useCallback((input: TreeInput) => {
    const r = rendererRef.current;
    const canvas = canvasRef.current;
    if (!r || !canvas) return;
    const { state, floor } = deriveTreeState(input);
    maturity.save(floor);
    const skel = generateSkeleton(state, seedRef.current);
    const buffers = skeletonToBuffers(skel);
    r.draw(buffers, { aspect: canvas.clientWidth / canvas.clientHeight });
  }, []);

  // Pull memory + RSI state and recompute the tree form.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [graph, rsi] = await Promise.all([
        tauri.memory.getGraph(),
        tauri.rsi.status().catch(() => null),
      ]);
      const eliteNodeCount = graph.nodes.length;
      const clusterCount = new Set(graph.nodes.map((n) => n.type)).size;
      const rsiSignal = rsi
        ? {
            iteration: rsi.engine?.iteration ?? 0,
            boundsVersion: rsi.bounds_version ?? 0,
          }
        : null;
      const input: TreeInput = {
        clusterCount,
        eliteNodeCount,
        rsi: rsiSignal,
        persistedFloor: maturity.load(),
        clusters: [],
      };
      renderTree(input);
    } catch (err) {
      console.error('[MemoryLayersPage] refresh failed', err);
    } finally {
      setLoading(false);
    }
  }, [renderTree]);

  // Derive directly from a `grow` event's real RAPTOR payload.
  const growFrom = useCallback(async (line: { leafCount?: number; clusterCount?: number; clusters?: { x: number; y: number; weight: number }[] }) => {
    const rsi = await tauri.rsi.status().catch(() => null);
    const rsiSignal = rsi
      ? {
          iteration: rsi.engine?.iteration ?? 0,
          boundsVersion: rsi.bounds_version ?? 0,
        }
      : null;
    const input: TreeInput = {
      clusterCount: line.clusterCount ?? 0,
      eliteNodeCount: line.leafCount ?? 0,
      rsi: rsiSignal,
      persistedFloor: maturity.load(),
      clusters: line.clusters ?? [],
    };
    renderTree(input);
  }, [renderTree]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live evolution, driven by Fractal Memory Search (not RSI):
  //   grow   → derive directly from real RAPTOR payload (filament growth)
  //   recall / seed → ignored in Phase 1 (no breathing animation)
  useEffect(() => {
    let alive = true;
    const unlistenP = events.onFractalActivity.listen((e) => {
      if (!alive) return;
      if (e.kind === 'grow') void growFrom(e);
    });
    return () => { alive = false; void unlistenP.then((u) => u()).catch(() => {}); };
  }, [growFrom]);

  // Live evolution: re-pull + render whenever the RSI engine reports progress.
  useEffect(() => {
    let alive = true;
    const unlistenP = events.onRsiEngineEvent.listen(() => { if (alive) void refresh(); });
    return () => { alive = false; void unlistenP.then((u) => u()).catch(() => {}); };
  }, [refresh]);

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
