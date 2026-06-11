import { useEffect, useRef, useState } from 'react';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
import { tauri, type MemoryGraphSnapshot } from '@/lib/tauri';
import { RefreshCw, Brain } from 'lucide-react';

const TYPE_COLORS: Record<string, string> = {
  entity: '#7c3aed',
  concept: '#0891b2',
  event: '#d97706',
  fact: '#059669',
};

export function MemoryGraphPage() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const graph: MemoryGraphSnapshot = await tauri.memory.getGraph();
      renderGraph(graph);
    } catch {
      // empty graph is fine
    } finally {
      setLoading(false);
    }
  };

  const renderGraph = (graph: MemoryGraphSnapshot) => {
    if (!canvasRef.current) return;
    setNodeCount(graph.nodes.length);
    setEdgeCount(graph.edges.length);

    const nodes = new DataSet(
      graph.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        color: { background: TYPE_COLORS[n.type] ?? '#6b7280', border: 'transparent' },
        font: { color: '#f9fafb', size: 12 },
        shape: 'dot',
        size: 14,
        title: `${n.label} (${n.type})`,
      })),
    );
    const edges = new DataSet(
      graph.edges.map((e, i) => ({
        id: i,
        from: e.from,
        to: e.to,
        label: e.relation,
        arrows: 'to',
        color: { color: '#4b5563', opacity: 0.7 },
        font: { color: '#9ca3af', size: 10, align: 'middle' },
      })),
    );

    if (networkRef.current) networkRef.current.destroy();
    networkRef.current = new Network(
      canvasRef.current,
      { nodes, edges },
      {
        physics: { stabilization: { iterations: 100 } },
        interaction: { hover: true, navigationButtons: false, zoomView: true },
        layout: { randomSeed: 42 },
        autoResize: true,
      },
    );
  };

  useEffect(() => {
    void load();
    return () => {
      networkRef.current?.destroy();
    };
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 py-5 border-b border-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain size={18} className="text-brand" />
          <h1 className="text-base font-semibold text-text-primary">Memory Graph</h1>
          {!loading && (
            <span className="text-xs text-text-muted ml-1">
              {nodeCount} nodes · {edgeCount} edges
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-text-muted hover:text-text-secondary inline-flex items-center gap-1"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-pulse text-sm text-text-muted">Loading memory graph…</div>
        </div>
      )}

      {/* Empty state */}
      {!loading && nodeCount === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-8">
          <Brain size={36} className="text-text-muted/40" />
          <p className="text-sm text-text-muted">No memory graph yet.</p>
          <p className="text-xs text-text-muted/70">
            Start a few conversations and memories will appear here.
          </p>
        </div>
      )}

      {/* Graph canvas */}
      <div
        ref={canvasRef}
        className="flex-1 w-full"
        style={{ display: loading || nodeCount === 0 ? 'none' : 'block' }}
      />

      {/* Legend */}
      <div className="shrink-0 px-6 py-2 border-t border-border-subtle">
        <div className="flex gap-3 flex-wrap">
          {Object.entries(TYPE_COLORS).map(([type, color]) => (
            <span key={type} className="flex items-center gap-1 text-[10px] text-text-muted">
              <span
                className="w-2 h-2 rounded-full inline-block shrink-0"
                style={{ backgroundColor: color }}
              />
              {type}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
