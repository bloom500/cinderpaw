import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, RefreshCw, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { tauri, events } from '@/lib/tauri';
import { layoutTree, type ClusterInput, type TreeLayout } from '@/lib/tree/layout';
import { deriveTreeSignal } from '@/lib/tree/signal';
import {
  createTreeRenderer,
  DEFAULT_TREE_VIEW,
  type TreeRenderer,
  type TreeView,
  type RenderAnim,
} from '@/lib/tree/render';
import { PALETTE } from '@/lib/tree/sprites';
import { rsiState, type RsiSnapshot, type RsiPhase } from './rsiState';

/**
 * Memory Layers — the painterly reactive tree. Maps 1:1 to the RAPTOR substrate
 * (clusters = branches, memories = leaves) and consumes the Fractal Memory
 * Search pulses: `seed` sprouts a leaf, `grow` extends a branch, `recall`
 * lights the traversed crown, `prune` drops a leaf (never below the maturity
 * floor). The trunk's ambient aura and season tint come from the RSI engine
 * (dreaming → warm autumn glow, ratcheted → white flash that fades, error →
 * crimson wash). Idle = a fine ambient sway, the only permanent animation.
 */

/** Monotonic min-branch floor, persisted per-install. */
const FLOOR_KEY = 'feral.tree.minBranchFloor';
const treeFloor = {
  current(): number {
    try {
      const v = localStorage.getItem(FLOOR_KEY);
      const n = v == null ? 0 : parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  },
  bump(value: number): number {
    const next = Math.max(this.current(), value, 0);
    try {
      localStorage.setItem(FLOOR_KEY, String(next));
    } catch {
      /* storage unavailable — session-only floor */
    }
    return next;
  },
};

const RECALL_DECAY_MS = 1400;
const SEED_POP_MS = 380;
const PRUNE_FALL_MS = 700;
const RATCHET_FLASH_MS = 1200;

interface LeafCard {
  branch: number;
  leaf: number;
  clusterIndex: number;
  leaves: { leafId: number; text: string; ts: number }[];
}

/** Map an RSI phase → additive trunk aura + global season tint. */
function phaseTints(phase: RsiPhase, ratcheted: boolean): {
  rsiAura: string;
  season: 'spring' | 'summer' | 'autumn' | 'winter';
} {
  if (phase === 'error') return { rsiAura: PALETTE.rsiAuraError, season: 'winter' };
  if (phase === 'dreaming') return { rsiAura: PALETTE.rsiAuraDream, season: 'autumn' };
  if (phase === 'ratcheted' || ratcheted) return { rsiAura: PALETTE.rsiAuraRatchet, season: 'spring' };
  return { rsiAura: PALETTE.rsiAuraIdle, season: 'summer' };
}

/** HUD pill — sits in the top-right corner, mirrors the dream-cycle toast. */
function RsiHud({ snapshot }: { snapshot: RsiSnapshot }) {
  const phase = snapshot.phase;
  const tone =
    phase === 'dreaming' ? 'border-[#e8731c] text-[#e8731c]'
    : phase === 'ratcheted' ? 'border-[#ffe7a8] text-[#ffe7a8]'
    : phase === 'error'    ? 'border-red-500 text-red-400'
                            : 'border-border-subtle text-text-secondary';
  const dot =
    phase === 'dreaming' ? 'bg-[#e8731c] animate-pulse'
    : phase === 'ratcheted' ? 'bg-[#ffe7a8]'
    : phase === 'error'    ? 'bg-red-500'
                            : 'bg-text-muted';
  const label =
    phase === 'dreaming' ? 'dreaming…'
    : phase === 'ratcheted' ? 'ratcheted'
    : phase === 'error'    ? 'error'
                            : 'idle';
  const detail =
    phase === 'dreaming' ? 'Feral is exploring new params'
    : phase === 'ratcheted' ? snapshot.lastRatchetScore != null
        ? `champion score ${snapshot.lastRatchetScore.toFixed(1)}`
        : 'new champion applied'
    : snapshot.lastRatchetAt
      ? `last ratchet ${formatAgo(snapshot.lastRatchetAt)}`
      : 'no ratchets yet';
  return (
    <div className={`pointer-events-auto flex items-center gap-2 rounded-full border bg-black/70 px-3 py-1.5 text-[11px] backdrop-blur ${tone}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <Brain size={11} className="opacity-70" />
      <span className="font-medium uppercase tracking-wide">RSI · {label}</span>
      <span className="opacity-70">· {detail}</span>
    </div>
  );
}

function formatAgo(ms: number): string {
  const dt = Math.max(0, Date.now() - ms);
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

export default function MemoryLayersPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<TreeRenderer | null>(null);
  const viewRef = useRef<TreeView>({ ...DEFAULT_TREE_VIEW });
  const layoutRef = useRef<TreeLayout>({ trunk: { x0: 0, y0: 0, x1: 0, y1: 0, thickness: 12 }, branches: [] });
  const clustersRef = useRef<ClusterInput[]>([]);
  const minBranchesRef = useRef<number>(treeFloor.current());

  // Active pulse state, mutated by events and read each animation frame.
  const litRef = useRef<Map<number, { start: number }>>(new Map());
  const seedRef = useRef<Map<number, { start: number }>>(new Map());
  const fallRef = useRef<{ x: number; y: number; start: number }[]>([]);
  const rafRef = useRef<number | null>(null);
  const rsiSnapRef = useRef<RsiSnapshot>(rsiState.snapshot());
  // Forcing a render re-read while the page is mounted (so the HUD pill
  // updates without us re-running the whole effect graph).
  const [, setTick] = useState(0);

  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [card, setCard] = useState<LeafCard | null>(null);
  const cardReqRef = useRef<string>('');

  const relayout = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    layoutRef.current = layoutTree(clustersRef.current, {
      width: canvas.clientWidth || 800,
      height: canvas.clientHeight || 600,
      minBranches: minBranchesRef.current,
    });
  }, []);

  // The single continuous loop: ambient sway + decaying pulses.
  const loop = useCallback((now: number) => {
    const r = rendererRef.current;
    if (r) {
      const branchLit = new Map<number, number>();
      for (const [idx, p] of litRef.current) {
        const k = 1 - (now - p.start) / RECALL_DECAY_MS;
        if (k <= 0) litRef.current.delete(idx);
        else branchLit.set(idx, k);
      }
      const seedPop = new Map<number, number>();
      for (const [idx, p] of seedRef.current) {
        const k = (now - p.start) / SEED_POP_MS;
        if (k >= 1) seedRef.current.delete(idx);
        else seedPop.set(idx, Math.max(0.1, k));
      }
      const falling = fallRef.current
        .map((f) => ({ x: f.x, y: f.y, t: (now - f.start) / PRUNE_FALL_MS }))
        .filter((f) => f.t < 1);
      fallRef.current = fallRef.current.filter((f) => (now - f.start) / PRUNE_FALL_MS < 1);

      // RSI phase → trunk aura + season wash. Ratchet pulses the white
      // aura briefly even after the snapshot flips back to idle so the
      // user actually sees the ratcheted notification.
      const snap = rsiSnapRef.current;
      const ratcheted = snap.lastRatchetAt != null &&
        now - snap.lastRatchetAt < RATCHET_FLASH_MS;
      const { rsiAura, season } = phaseTints(snap.phase, ratcheted);

      const anim: RenderAnim = {
        timeMs: now,
        branchLit,
        seedPop,
        falling,
        season,
        rsiAura,
      };
      r.render(layoutRef.current, viewRef.current, anim);
    }
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  // One-time renderer + loop setup.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = createTreeRenderer(canvas);
    if (!r) { setUnsupported(true); return; }
    rendererRef.current = r;
    relayout();
    rafRef.current = requestAnimationFrame(loop);
    const onResize = () => { r.resize(); relayout(); };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      r.dispose();
      rendererRef.current = null;
    };
  }, [loop, relayout]);

  // RSI snapshot subscription — feeds the HUD pill + the render tints.
  useEffect(() => {
    return rsiState.subscribe((snap) => {
      rsiSnapRef.current = snap;
      setTick((n) => (n + 1) % 1024);
    });
  }, []);

  // Tick the HUD pill once a second so the "last ratchet 12s ago" stays
  // accurate even when no RSI events are firing.
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => (n + 1) % 1024), 1000);
    return () => window.clearInterval(t);
  }, []);

  const branchForLeaf = (leafId?: number, clusterIndex?: number): number => {
    const n = layoutRef.current.branches.length;
    if (n === 0) return 0;
    if (clusterIndex != null) return clusterIndex % n;
    return Math.abs(leafId ?? 0) % n;
  };

  // Pull memory + RSI and recompute the tree form.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [graph, rsi] = await Promise.all([
        tauri.memory.getGraph(),
        tauri.rsi.status().catch(() => null),
      ]);
      void rsi;
      const eliteNodeCount = graph.nodes.length;
      const clusterCount = new Set(graph.nodes.map((n) => n.type)).size;
      const { signal, floor } = deriveTreeSignal({
        clusterCount,
        eliteNodeCount,
        persistedFloor: treeFloor.current(),
      });
      treeFloor.bump(floor);
      minBranchesRef.current = signal.minBranches;
      relayout();
    } catch (err) {
      console.error('[MemoryLayersPage] refresh failed', err);
    } finally {
      setLoading(false);
    }
  }, [relayout]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live evolution from Fractal Memory Search.
  useEffect(() => {
    let alive = true;
    const unlistenP = events.onFractalActivity.listen((e) => {
      if (!alive) return;
      if (e.kind === 'grow') {
        clustersRef.current = (e.clusters ?? []).map((c) => ({ weight: c.weight }));
        if (e.clusterCount != null) {
          minBranchesRef.current = treeFloor.bump(Math.max(minBranchesRef.current, e.clusterCount));
        }
        relayout();
      } else if (e.kind === 'seed') {
        seedRef.current.set(branchForLeaf(e.leafId, e.clusterIndex), { start: performance.now() });
      } else if (e.kind === 'recall') {
        const ranked = [...layoutRef.current.branches]
          .sort((a, b) => b.leaves.length - a.leaves.length)
          .slice(0, Math.max(1, Math.min(e.hits ?? 1, layoutRef.current.branches.length)));
        for (const b of ranked) litRef.current.set(b.index, { start: performance.now() });
      } else if (e.kind === 'prune') {
        const idx = branchForLeaf(e.leafId, e.clusterIndex);
        const b = layoutRef.current.branches[idx];
        if (b) fallRef.current.push({ x: b.x1, y: b.y1, start: performance.now() });
      }
    });
    return () => { alive = false; void unlistenP.then((u) => u()).catch(() => {}); };
  }, [relayout]);

  // RSI engine events still drive a re-pull; the snapshot store handles
  // the live "dreaming"/"ratcheted" phase on its own.
  useEffect(() => {
    let alive = true;
    const unlistenP = events.onRsiEngineEvent.listen(() => { if (alive) void refresh(); });
    return () => { alive = false; void unlistenP.then((u) => u()).catch(() => {}); };
  }, [refresh]);

  // Drill-down responses → fill the leaf card.
  useEffect(() => {
    let alive = true;
    const unlistenP = events.onFractalClusterLeaves.listen((e) => {
      if (!alive || e.id !== cardReqRef.current) return;
      setCard((c) => (c ? { ...c, leaves: e.leaves } : c));
    });
    return () => { alive = false; void unlistenP.then((u) => u()).catch(() => {}); };
  }, []);

  // Pan / zoom.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const v = viewRef.current;
    const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    const zoom = Math.max(0.3, Math.min(8, v.zoom * factor));
    const wx = (px - v.offsetX) / v.zoom;
    const wy = (py - v.offsetY) / v.zoom;
    viewRef.current = { zoom, offsetX: px - wx * zoom, offsetY: py - wy * zoom };
  }, []);

  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { dragRef.current = { x: e.clientX, y: e.clientY, moved: false }; };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const v = viewRef.current;
    viewRef.current = { ...v, offsetX: v.offsetX + (e.clientX - d.x), offsetY: v.offsetY + (e.clientY - d.y) };
    dragRef.current = { x: e.clientX, y: e.clientY, moved: true };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved) return;
    const canvas = canvasRef.current;
    const r = rendererRef.current;
    if (!canvas || !r) return;
    const rect = canvas.getBoundingClientRect();
    // Prefer leaf-level hit, fall back to branch.
    const leaf = r.hitTestLeaf(e.clientX - rect.left, e.clientY - rect.top, layoutRef.current, viewRef.current);
    const idx = leaf?.branch ?? r.hitTestBranch(e.clientX - rect.left, e.clientY - rect.top, layoutRef.current, viewRef.current);
    if (idx == null) { setCard(null); return; }
    const reqId = `cl-${Date.now()}-${idx}`;
    cardReqRef.current = reqId;
    setCard({ branch: idx, leaf: leaf?.leaf ?? -1, clusterIndex: idx, leaves: [] });
    void invoke('feral_fractal_cluster_leaves', { requestId: reqId, clusterIndex: idx }).catch((err) => {
      console.error('[MemoryLayersPage] drill-down failed', err);
    });
  };

  if (unsupported) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black">
        <p className="text-xs text-text-muted">Canvas2D unavailable — tree view disabled.</p>
      </div>
    );
  }

  const hasNoMemories =
    !loading && layoutRef.current.branches.length === 0;

  const rsiSnapshot = rsiSnapRef.current;

  return (
    <div className="fixed inset-0 bg-black">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { dragRef.current = null; }}
      />

      <div className="absolute right-4 top-4 z-10">
        <RsiHud snapshot={rsiSnapshot} />
      </div>

      {hasNoMemories && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto max-w-md rounded-lg border border-[#e8731c]/30 bg-black/80 px-6 py-5 text-center backdrop-blur">
            <h2 className="text-base font-semibold text-[#e8731c] mb-1">
              Your memory tree is empty
            </h2>
            <p className="text-xs text-text-secondary leading-relaxed">
              Every fact Feral learns from your chats sprouts a leaf here.
              Start a conversation in{' '}
              <button
                type="button"
                onClick={() => window.history.back()}
                className="text-brand hover:underline"
              >
                Chat
              </button>{' '}
              and come back — the tree grows as you talk.
            </p>
          </div>
        </div>
      )}

      {card && (
        <div className="absolute left-4 top-4 z-10 max-h-[70vh] w-80 overflow-auto rounded-lg border border-[#e8731c]/40 bg-black/85 p-3 backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-[#e8731c]">
              Cluster {card.clusterIndex}
              {card.leaf >= 0 && <span className="ml-1 opacity-70">· leaf {card.leaf}</span>}
            </span>
            <button type="button" onClick={() => setCard(null)} aria-label="Close" className="text-text-muted hover:text-text-primary">
              <X size={14} />
            </button>
          </div>
          {card.leaves.length === 0 ? (
            <p className="text-xs text-text-muted">Loading memories…</p>
          ) : (
            <ul className="space-y-2">
              {card.leaves.map((l) => (
                <li key={l.leafId} className="border-l-2 border-[#e8731c]/50 pl-2 text-xs text-text-secondary">
                  {l.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading}
        aria-label="Refresh tree"
        className="absolute bottom-4 right-4 z-10 rounded-lg border border-border-subtle bg-bg-surface/70 p-2 text-text-secondary backdrop-blur hover:text-text-primary disabled:opacity-50"
      >
        <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  );
}
