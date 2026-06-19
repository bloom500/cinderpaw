import { useEffect, useMemo, useState } from 'react';
import { tauri, type MemoryGraphSnapshot } from '@/lib/tauri';
import { useUI } from '@/stores/ui';
import { RefreshCw, Brain, Search, X, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MandelbrotCanvas } from '@/components/memory/MandelbrotCanvas';
import { NodeOverlay } from '@/components/memory/NodeOverlay';
import { SEAHORSE_VIEW, complexToScreen, type View } from '@/lib/fractal/mandelbrot';
import { layoutNodes } from '@/lib/fractal/layout';

/** Per-theme palette for the node/edge tints (theme → node type color). */
const TYPE_COLORS: Record<'dark' | 'light', Record<string, string>> = {
  dark:  { entity: '#a78bfa', concept: '#22d3ee', event: '#fbbf24', fact: '#34d399' },
  light: { entity: '#7c3aed', concept: '#0891b2', event: '#d97706', fact: '#059669' },
};
const TYPE_FALLBACK: Record<'dark' | 'light', string> = { dark: '#94a3b8', light: '#64748b' };

const NODE_TYPES = ['entity', 'concept', 'event', 'fact'] as const;
const HIT_PX = 14;

interface SelectedNode {
  id: string;
  label: string;
  type: string;
  neighbors: { relation: string; label: string; direction: 'out' | 'in' }[];
}

export function MemoryLayersPage() {
  const resolvedTheme = useUI((s) => s.resolvedTheme);
  const [graph, setGraph] = useState<MemoryGraphSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [showLabels, setShowLabels] = useState(true);
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [view, setView] = useState<View>(SEAHORSE_VIEW);

  const fractalTheme: 'dark' | 'light' = resolvedTheme === 'dark' ? 'dark' : 'light';
  const colorFor = (type: string) =>
    TYPE_COLORS[fractalTheme][type] ?? TYPE_FALLBACK[fractalTheme];

  const load = async () => {
    setLoading(true);
    setSelected(null);
    try {
      setGraph(await tauri.memory.getGraph());
    } catch {
      setGraph({ nodes: [], edges: [] });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Per-type counts for the filter chips (computed on the FULL graph).
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graph?.nodes ?? []) {
      counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    }
    return counts;
  }, [graph]);

  // Relation counts for the "Edges" chips.
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of graph?.edges ?? []) {
      counts.set(e.relation, (counts.get(e.relation) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [graph]);

  // Visible subgraph after type filter + search.
  const visible = useMemo(() => {
    if (!graph) return { nodes: [], edges: [] };
    const q = search.trim().toLowerCase();
    const nodes = graph.nodes.filter(
      (n) => !hiddenTypes.has(n.type) && (!q || n.label.toLowerCase().includes(q)),
    );
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    return { nodes, edges };
  }, [graph, hiddenTypes, search]);

  // Pre-laid-out nodes (for click hit-test) — same ordering the overlay uses.
  const laidOut = useMemo(
    () => (graph ? layoutNodes(graph) : []),
    [graph],
  );

  // Container-level click hit-test: a click that lands on the scene (overlay
  // is pointer-events-none, so this catches clicks that reached the fractal
  // canvas below). A drag pans; a click selects the nearest node within
  // HIT_PX, or clears the selection if none.
  const onSceneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!graph) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let bestId: string | null = null;
    let bestD = HIT_PX;
    for (const n of laidOut) {
      if (hiddenTypes.has(n.type)) continue;
      const p = complexToScreen(n.wx, n.wy, rect.width, rect.height, view);
      const d = Math.hypot(p.px - px, p.py - py);
      if (d <= bestD) { bestD = d; bestId = n.id; }
    }
    if (!bestId) { setSelected(null); return; }
    const node = graph.nodes.find((n) => n.id === bestId);
    if (!node) return;
    const neighbors: SelectedNode['neighbors'] = [];
    for (const e2 of graph.edges) {
      if (e2.from === bestId) {
        const to = graph.nodes.find((n) => n.id === e2.to);
        if (to) neighbors.push({ relation: e2.relation, label: to.label, direction: 'out' });
      } else if (e2.to === bestId) {
        const from = graph.nodes.find((n) => n.id === e2.from);
        if (from) neighbors.push({ relation: e2.relation, label: from.label, direction: 'in' });
      }
    }
    setSelected({ id: node.id, label: node.label, type: node.type, neighbors });
  };

  const toggleType = (type: string) =>
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });

  const empty = !loading && (graph?.nodes.length ?? 0) === 0;
  const hasScene = !loading && !empty;

  return (
    <div className="relative h-full overflow-hidden">
      {/* Single floating control panel — no sections, no separators */}
      <div className="absolute top-4 left-4 z-10 w-60 rounded-xl border border-border-subtle bg-bg-surface/90 backdrop-blur px-4 py-4 space-y-3 shadow-lg">
        <div className="flex items-center gap-2">
          <Brain size={15} className="text-brand" />
          <h1 className="text-sm font-semibold text-text-primary">Memory Layers</h1>
        </div>

        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search nodes…"
            className="w-full rounded-md bg-bg-elevated border border-border-subtle pl-7 pr-7 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {NODE_TYPES.map((type) => {
            const active = !hiddenTypes.has(type);
            const count = typeCounts.get(type) ?? 0;
            return (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors',
                  active
                    ? 'bg-bg-hover text-text-primary'
                    : 'bg-transparent text-text-disabled hover:text-text-muted',
                )}
              >
                <span
                  className="w-2 h-2 rounded-full inline-block shrink-0"
                  style={{
                    backgroundColor: active ? colorFor(type) : 'var(--text-disabled)',
                    boxShadow: active ? `0 0 6px ${colorFor(type)}` : 'none',
                  }}
                />
                {type}
                <span className={cn('tabular-nums', active ? 'text-text-muted' : 'text-text-disabled')}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {relationCounts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {relationCounts.map(([relation, count]) => (
              <span
                key={relation}
                className="rounded-md bg-bg-elevated px-2 py-0.5 text-[10px] text-text-secondary"
              >
                {relation} <span className="text-text-muted tabular-nums">{count}</span>
              </span>
            ))}
          </div>
        )}

        <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => setShowLabels(e.target.checked)}
            className="accent-[var(--brand)]"
          />
          Show labels
        </label>

        <p className="text-[11px] text-text-muted">
          {graph
            ? `${graph.nodes.length.toLocaleString()} nodes · ${graph.edges.length.toLocaleString()} edges`
            : '—'}
        </p>
      </div>

      <div className="absolute top-4 right-4 z-10 flex gap-2">
        <button
          type="button"
          onClick={() => setView(SEAHORSE_VIEW)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-surface/90 backdrop-blur px-2.5 py-1.5 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover"
        >
          <RotateCcw size={11} /> Reset view
        </button>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-surface/90 backdrop-blur px-2.5 py-1.5 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover"
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="animate-pulse text-sm text-text-muted">Loading memory graph…</div>
        </div>
      )}

      {empty && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-8">
          <Brain size={36} className="text-text-disabled" />
          <p className="text-sm text-text-secondary">No memory graph yet.</p>
          <p className="text-xs text-text-muted">
            Start a few conversations and memories will appear here.
          </p>
        </div>
      )}

      {!loading && !empty && visible.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-xs text-text-muted">No nodes match the current filters.</p>
        </div>
      )}

      {/* Scene: fractal backdrop + node overlay. Click anywhere on the scene
          to select the nearest node (drag still pans via the canvas below). */}
      {hasScene && graph && (
        <div
          onClick={onSceneClick}
          className="fixed inset-0 z-0"
        >
          <MandelbrotCanvas view={view} theme={fractalTheme} onViewChange={setView} />
          <NodeOverlay
            snapshot={graph}
            view={view}
            colorFor={colorFor}
            hiddenTypes={hiddenTypes}
            search={search}
            showLabels={showLabels}
            onSelect={(id) => {
              if (!id) { setSelected(null); return; }
              const node = graph.nodes.find((n) => n.id === id);
              if (!node) return;
              const neighbors: SelectedNode['neighbors'] = [];
              for (const e of graph.edges) {
                if (e.from === id) {
                  const to = graph.nodes.find((n) => n.id === e.to);
                  if (to) neighbors.push({ relation: e.relation, label: to.label, direction: 'out' });
                } else if (e.to === id) {
                  const from = graph.nodes.find((n) => n.id === e.from);
                  if (from) neighbors.push({ relation: e.relation, label: from.label, direction: 'in' });
                }
              }
              setSelected({ id: node.id, label: node.label, type: node.type, neighbors });
            }}
          />
        </div>
      )}

      {/* Selected node detail card */}
      {selected && (
        <div className="absolute bottom-4 right-4 z-10 w-64 rounded-xl border border-border-subtle bg-bg-surface/95 backdrop-blur px-4 py-3 shadow-lg">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-text-primary font-medium break-words">{selected.label}</p>
              <p
                className="text-[10px] uppercase tracking-wider mt-0.5"
                style={{ color: colorFor(selected.type) }}
              >
                {selected.type}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label="Close details"
              className="text-text-muted hover:text-text-secondary shrink-0"
            >
              <X size={13} />
            </button>
          </div>
          {selected.neighbors.length > 0 && (
            <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
              {selected.neighbors.map((n, i) => (
                <li key={i} className="text-[11px] text-text-muted break-words">
                  {n.direction === 'out'
                    ? <>—{n.relation}→ <span className="text-text-secondary">{n.label}</span></>
                    : <><span className="text-text-secondary">{n.label}</span> —{n.relation}→ this</>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
