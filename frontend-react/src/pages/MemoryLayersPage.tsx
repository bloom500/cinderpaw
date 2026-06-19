import { useEffect, useMemo, useRef, useState } from 'react';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
import { tauri, type MemoryGraphSnapshot } from '@/lib/tauri';
import { useUI } from '@/stores/ui';
import { RefreshCw, Brain, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Cognee-inspired graph visualization. All chrome lives in ONE floating
 * panel over the canvas (no sidebar, no separators), styled with the app's
 * semantic tokens so it follows Light/Dark mode, and rendered in Inter —
 * including the vis-network node/edge labels.
 */
const VIS_FONT = "'Inter Variable', Inter, system-ui, sans-serif";

/** Per-theme palette for the canvas (vis-network needs concrete hex values). */
const THEME_VIS = {
  dark: {
    types: { entity: '#a78bfa', concept: '#22d3ee', event: '#fbbf24', fact: '#34d399' } as Record<string, string>,
    fallback: '#94a3b8',
    nodeLabel: '#cbd5e1',
    labelStroke: '#0b0b12',
    edge: '#38bdf8',
    edgeOpacity: 0.28,
    edgeHighlight: '#7dd3fc',
    edgeLabel: '#64748b',
    glowSize: 22,
  },
  light: {
    types: { entity: '#7c3aed', concept: '#0891b2', event: '#d97706', fact: '#059669' } as Record<string, string>,
    fallback: '#64748b',
    nodeLabel: '#334155',
    labelStroke: '#ffffff',
    edge: '#0284c7',
    edgeOpacity: 0.3,
    edgeHighlight: '#0369a1',
    edgeLabel: '#94a3b8',
    glowSize: 10,
  },
} as const;

const NODE_TYPES = ['entity', 'concept', 'event', 'fact'] as const;

interface SelectedNode {
  id: string;
  label: string;
  type: string;
  neighbors: { relation: string; label: string; direction: 'out' | 'in' }[];
}

export function MemoryLayersPage() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const resolvedTheme = useUI((s) => s.resolvedTheme);
  const [graph, setGraph] = useState<MemoryGraphSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [showLabels, setShowLabels] = useState(true);
  const [selected, setSelected] = useState<SelectedNode | null>(null);

  const vis = THEME_VIS[resolvedTheme];
  const colorFor = (type: string) => vis.types[type] ?? vis.fallback;

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
    return () => {
      networkRef.current?.destroy();
      networkRef.current = null;
    };
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

  // (Re)build the network when the subgraph, label mode, or theme changes.
  useEffect(() => {
    if (!canvasRef.current || loading || visible.nodes.length === 0) return;

    // Node size scales with degree so hubs read as clusters.
    const degree = new Map<string, number>();
    for (const e of visible.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }

    const nodes = new DataSet(
      visible.nodes.map((n) => {
        const c = colorFor(n.type);
        const d = degree.get(n.id) ?? 0;
        return {
          id: n.id,
          label: showLabels ? n.label : undefined,
          shape: 'dot',
          size: 9 + Math.min(d * 2.5, 18),
          color: {
            background: c,
            border: `${c}55`,
            highlight: { background: vis.nodeLabel, border: c },
            hover: { background: c, border: vis.nodeLabel },
          },
          font: {
            color: vis.nodeLabel,
            size: 11,
            face: VIS_FONT,
            strokeWidth: 4,
            strokeColor: vis.labelStroke,
          },
          shadow: { enabled: true, color: c, size: vis.glowSize, x: 0, y: 0 },
          title: `${n.label} (${n.type})`,
        };
      }),
    );
    const edges = new DataSet(
      visible.edges.map((e, i) => ({
        id: i,
        from: e.from,
        to: e.to,
        label: showLabels ? e.relation : undefined,
        arrows: { to: { enabled: true, scaleFactor: 0.4 } },
        color: { color: vis.edge, opacity: vis.edgeOpacity, highlight: vis.edgeHighlight },
        width: 1,
        smooth: { enabled: true, type: 'continuous', roundness: 0.4 },
        font: {
          color: vis.edgeLabel,
          size: 9,
          face: VIS_FONT,
          align: 'middle',
          strokeWidth: 3,
          strokeColor: vis.labelStroke,
        },
      })),
    );

    networkRef.current?.destroy();
    const network = new Network(
      canvasRef.current,
      { nodes, edges },
      {
        physics: {
          solver: 'forceAtlas2Based',
          forceAtlas2Based: {
            gravitationalConstant: -42,
            centralGravity: 0.012,
            springLength: 110,
            springConstant: 0.06,
            damping: 0.5,
          },
          stabilization: { iterations: 160 },
        },
        interaction: { hover: true, zoomView: true, tooltipDelay: 120 },
        layout: { randomSeed: 42 },
        autoResize: true,
      },
    );
    networkRef.current = network;

    network.on('click', (params: { nodes: (string | number)[] }) => {
      const nodeId = params.nodes[0];
      if (nodeId === undefined) {
        setSelected(null);
        return;
      }
      const node = visible.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const byId = new Map(visible.nodes.map((n) => [n.id, n] as const));
      const neighbors: SelectedNode['neighbors'] = [];
      for (const e of visible.edges) {
        if (e.from === nodeId) {
          const to = byId.get(e.to);
          if (to) neighbors.push({ relation: e.relation, label: to.label, direction: 'out' });
        } else if (e.to === nodeId) {
          const from = byId.get(e.from);
          if (from) neighbors.push({ relation: e.relation, label: from.label, direction: 'in' });
        }
      }
      setSelected({ id: node.id, label: node.label, type: node.type, neighbors });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, showLabels, loading, resolvedTheme]);

  const toggleType = (type: string) =>
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });

  const empty = !loading && (graph?.nodes.length ?? 0) === 0;

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

      <button
        type="button"
        onClick={() => void load()}
        className="absolute top-4 right-4 z-10 inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-surface/90 backdrop-blur px-2.5 py-1.5 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover"
      >
        <RefreshCw size={11} /> Refresh
      </button>

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

      {/* Full-bleed graph canvas: spans the whole window (under the floating
          sidebar) so the sidebar's translucent backdrop samples the nodes —
          1:1 with how the control card reveals the graph behind it. Sits at
          z-0, below the sidebar (z-20) and the control cards (z-10). */}
      <div ref={canvasRef} className="fixed inset-0 z-0" />

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
