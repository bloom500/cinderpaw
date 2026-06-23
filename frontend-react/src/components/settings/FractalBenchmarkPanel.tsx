/**
 * PROVISIONAL — temporary one-click trigger for the Fractal Memory Search
 * benchmark gate. Remove this file (and its render in AgentSettingsTab) once
 * the ship/hold decision is made. It invokes `feral_run_fractal_benchmark`
 * (Rust → sidecar) and listens for `fractal_bench_progress` /
 * `fractal_bench_result` lines the sidecar emits back over
 * `feral://agent-output`.
 *
 * Hardening (so the button can never spin forever):
 *   - `fractal_bench_progress` events drive a live status line
 *     ("Generating queries 4/12" / "Running queries 4/12")
 *   - a "last update Xs ago" hint under the status shows when the
 *     sidecar last said anything; if it stalls for >90s the panel can
 *     warn the user (the sidecar has its own 10-min bench + 15-min
 *     build hard timeouts, but a stalled UI is still bad UX)
 *   - `fractal_bench_result {ok:false, error, phase}` is rendered as a
 *     actionable error (we tell the user which phase blew the budget)
 *   - a manual "Cancel" button appears once any progress has arrived
 *     (the sidecar will still finish in the background — this just
 *     clears the local spinner)
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { FlaskConical, RefreshCw, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BenchProgress {
  kind: 'generate_queries' | 'run_queries';
  current: number;
  total: number;
  message: string;
}

interface BenchResult {
  ok: boolean;
  error?: string;
  phase?: 'build' | 'queries' | 'run';
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

/** Phases the sidecar reports on the result error path. */
const PHASE_HINT: Record<NonNullable<BenchResult['phase']>, string> = {
  build: 'Tree build ran past its 15-min budget. Likely cause: embedding model is slow or the corpus is huge — try a smaller corpus first.',
  queries: 'Query generation (local model) blew its 10-min budget. Likely cause: local model is too slow for 12 paraphrases; supply a hand-authored JSONL query set instead.',
  run: 'The actual measurement blew its 10-min budget. Likely cause: a single embed/retrieve call is taking many seconds — check the tree is reasonable size.',
};

export function FractalBenchmarkPanel() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BenchProgress | null>(null);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  // Ticking clock so the "last update Xs ago" hint re-renders while idle.
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    void listen<{ data: string }>('feral://agent-output', (raw) => {
      if (!alive) return;
      try {
        const parsed = JSON.parse(raw.payload.data) as
          | { type?: string }
          | (BenchProgress & { type: 'fractal_bench_progress' })
          | (BenchResult & { type: 'fractal_bench_result' });
        const t = (parsed as { type?: string }).type;
        if (t === 'fractal_bench_progress') {
          const p = parsed as BenchProgress & { type: 'fractal_bench_progress' };
          setProgress({ kind: p.kind, current: p.current, total: p.total, message: p.message });
          setLastUpdate(Date.now());
          return;
        }
        if (t === 'fractal_bench_result') {
          const r = parsed as BenchResult & { type: 'fractal_bench_result' };
          setRunning(false);
          // Always cache the result — even on ok:false the `phase` field is
          // what drives the actionable hint below the error line, and it
          // only renders when `result?.phase` is populated. Without this
          // the user just sees the raw error string with no explanation.
          setResult(r);
          if (r.ok) {
            setError(null);
          } else {
            setError(r.error ?? 'Benchmark failed.');
          }
        }
      } catch {
        /* non-JSON sidecar line — ignore */
      }
    }).then((u) => { unlisten = u; });
    return () => { alive = false; unlisten?.(); };
  }, []);

  // Re-render the "last update" hint every second while running.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const run = async () => {
    setError(null);
    setResult(null);
    setProgress(null);
    setLastUpdate(Date.now());
    setRunning(true);
    try {
      await invoke('feral_run_fractal_benchmark');
    } catch (e) {
      setRunning(false);
      setError(String(e));
    }
  };

  // Local cancel just hides the spinner; the sidecar's run is fire-and-forget
  // and will still emit a fractal_bench_result line when it finishes.
  const cancel = () => {
    setRunning(false);
    setProgress(null);
  };

  const secondsSinceUpdate = lastUpdate > 0 ? Math.max(0, Math.floor((Date.now() - lastUpdate) / 1000)) : 0;
  const stalled = running && lastUpdate > 0 && secondsSinceUpdate > 90;

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
        <div className="flex items-center gap-1.5">
          {running && (
            <button
              type="button"
              onClick={cancel}
              title="Hide the spinner (the sidecar will still finish in the background)"
              className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-base px-2 py-1.5 text-xs text-text-secondary hover:text-text-primary"
            >
              <X size={12} /> Hide
            </button>
          )}
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
      </div>

      <p className="text-xs text-text-muted">
        Compares the fractal (RAPTOR) retrieval against flat FTS5 on auto-generated
        queries. Needs the embedding model present and the memory tree built. Ships only
        if fractal recall ≥ FTS5 and p99 latency &lt; 80&nbsp;ms.
      </p>

      {progress && running && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-primary">{progress.message}</span>
            {progress.total > 0 && (
              <span className="text-text-muted">
                {Math.round((progress.current / progress.total) * 100)}%
              </span>
            )}
          </div>
          {progress.total > 0 && (
            <div className="h-1 w-full overflow-hidden rounded bg-bg-muted">
              <div
                className="h-full bg-accent transition-[width] duration-150"
                style={{ width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }}
              />
            </div>
          )}
          <p className={cn('text-[10px]', stalled ? 'text-amber-400' : 'text-text-muted')}>
            {stalled
              ? `No update for ${secondsSinceUpdate}s — sidecar may be stalled (hard timeout is 10–15 min)`
              : lastUpdate > 0
                ? `last update ${secondsSinceUpdate}s ago`
                : 'starting…'}
          </p>
        </div>
      )}

      {error && (
        <div className="space-y-1 text-xs">
          <p className="text-red-400">⚠ {error}</p>
          {result?.phase && (
            <p className="text-text-muted">{PHASE_HINT[result.phase]}</p>
          )}
        </div>
      )}

      {result?.ok && (
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
