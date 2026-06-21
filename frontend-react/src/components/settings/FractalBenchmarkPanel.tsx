/**
 * PROVISIONAL — temporary one-click trigger for the Fractal Memory Search
 * benchmark gate. Remove this file (and its render in AgentSettingsTab) once
 * the ship/hold decision is made. It invokes `feral_run_fractal_benchmark`
 * (Rust → sidecar) and listens for the `fractal_bench_result` line the sidecar
 * emits back over `feral://agent-output`.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { FlaskConical, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BenchResult {
  ok: boolean;
  error?: string;
  ship?: boolean;
  reasons?: string[];
  n?: number;
  k?: number;
  fractalRecall?: number;
  ftsRecall?: number;
  fractalP99Ms?: number;
  ftsP99Ms?: number;
  path?: string;
}

const pct = (x: number | undefined) => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const ms = (x: number | undefined) => (x === undefined ? '—' : `${x.toFixed(1)} ms`);

export function FractalBenchmarkPanel() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    void listen<{ data: string }>('feral://agent-output', (raw) => {
      if (!alive) return;
      try {
        const parsed = JSON.parse(raw.payload.data) as { type?: string } & BenchResult;
        if (parsed?.type !== 'fractal_bench_result') return;
        setRunning(false);
        if (parsed.ok) {
          setResult(parsed);
          setError(null);
        } else {
          setError(parsed.error ?? 'Benchmark failed.');
        }
      } catch {
        /* non-JSON sidecar line — ignore */
      }
    }).then((u) => { unlisten = u; });
    return () => { alive = false; unlisten?.(); };
  }, []);

  const run = async () => {
    setError(null);
    setResult(null);
    setRunning(true);
    try {
      await invoke('feral_run_fractal_benchmark');
    } catch (e) {
      setRunning(false);
      setError(String(e));
    }
  };

  return (
    <div className="rounded-md border border-border-subtle bg-bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical size={16} className="text-text-secondary" />
          <h3 className="text-sm font-medium text-text-primary">Fractal Memory Benchmark</h3>
          <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
            provisional
          </span>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-base px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw size={13} className={running ? 'animate-spin' : ''} />
          {running ? 'Running…' : 'Run benchmark'}
        </button>
      </div>

      <p className="text-xs text-text-muted">
        Compares the fractal (RAPTOR) retrieval against flat FTS5 on auto-generated
        queries. Needs the embedding model present and the memory tree built. Ships only
        if fractal recall ≥ FTS5 and p99 latency &lt; 80&nbsp;ms.
      </p>

      {error && (
        <p className="text-xs text-red-400">⚠ {error}</p>
      )}

      {result && (
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-semibold',
                result.ship ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400',
              )}
            >
              {result.ship ? 'SHIP' : 'HOLD'}
            </span>
            <span className="text-text-muted">
              {result.n} queries · recall@{result.k}
            </span>
          </div>
          <table className="w-full text-left text-text-secondary">
            <thead>
              <tr className="text-text-muted">
                <th className="font-normal" />
                <th className="font-normal">recall</th>
                <th className="font-normal">p99</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="pr-3 text-text-primary">Fractal</td>
                <td>{pct(result.fractalRecall)}</td>
                <td>{ms(result.fractalP99Ms)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-text-primary">FTS5</td>
                <td>{pct(result.ftsRecall)}</td>
                <td>{ms(result.ftsP99Ms)}</td>
              </tr>
            </tbody>
          </table>
          {result.reasons && result.reasons.length > 0 && (
            <ul className="list-disc pl-4 text-amber-400">
              {result.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          {result.path && (
            <p className="text-text-muted">Full report: <code>{result.path}</code></p>
          )}
        </div>
      )}
    </div>
  );
}
