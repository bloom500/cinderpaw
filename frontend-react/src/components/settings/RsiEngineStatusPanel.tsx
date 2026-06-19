import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Pause, RefreshCw, Square, Zap } from 'lucide-react';
import { tauri, type RsiStatus } from '@/lib/tauri';
import { cn } from '@/lib/utils';

/** Polling cadence for the engine status panel. Two seconds is the smallest
 *  interval that feels live without flooding the IPC channel; the engine
 *  emits status events at most a few times per minute (iteration boundaries),
 *  so any sub-second display update would be theatre, not signal. */
const POLL_MS = 2_000;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 4;

/**
 * Live status panel for the passive RSI background engine. Read-only by
 * design: the engine is autostart on launch per Faza 1 and continuous
 * (`b59195f`), so the user observes rather than pilots. The only knob
 * surfaced here is concurrency, which the engine re-reads on the next
 * worker-pool refill — so changing it doesn't interrupt in-flight evals.
 *
 * Substrate state (initialized, main tip, bounds) is also shown because
 * it tells the user whether the sidecar is up at all. A null `engine`
 * means the sidecar has not yet emitted any engine events — the engine
 * may still be starting; we show that explicitly rather than implying
 * "stopped".
 */
export function RsiEngineStatusPanel() {
  const [status, setStatus] = useState<RsiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await tauri.rsi.status();
        if (!cancelled) {
          setStatus(s);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const onStop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await tauri.rsi.stop();
    } catch (e) {
      setStopError(String(e));
    } finally {
      setStopping(false);
    }
  };

  const onRefresh = () => {
    void tauri.rsi.status()
      .then((s) => { setStatus(s); setError(null); })
      .catch((e: unknown) => setError(String(e)));
  };

  const onConcurrencyChange = (n: number) => {
    // Fire-and-forget; the next status poll will reflect the change.
    tauri.rsi.setConcurrency(n).catch((e: unknown) => setError(String(e)));
  };

  if (error) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3 text-xs text-text-muted">
        <div className="flex items-center gap-2 text-text-secondary">
          <AlertTriangle size={13} className="text-text-muted" />
          <span>RSI engine status unavailable</span>
        </div>
        <p className="mt-1 text-text-disabled">{error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-text-muted">
        <RefreshCw size={11} className="animate-spin" /> Loading engine status…
      </div>
    );
  }

  const e = status.engine;
  const running = e?.running === true;
  const capped = (status.max_total_cost_usd ?? null) !== null;
  const capDisplay = capped
    ? `$${(status.max_total_cost_usd as number).toFixed(2)}`
    : 'unbounded';

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3 space-y-3">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity size={13} className={running ? 'text-brand' : 'text-text-muted'} />
          <span className="text-sm font-medium text-text-primary">Engine</span>
          <StatusPill running={running} stopReason={e?.stop_reason ?? null} engineKnown={e !== null} />
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh engine status"
            className="rounded-md p-1 text-text-muted hover:text-text-primary hover:bg-bg-hover"
          >
            <RefreshCw size={11} />
          </button>
          {running && (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              <Square size={10} /> {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
        <Stat label="Iteration" value={e ? e.iteration.toLocaleString() : '—'} />
        <Stat label="Best score" value={e?.best_score != null ? e.best_score.toFixed(3) : '—'} />
        <Stat label="Spent" value={`$${(e?.cost_so_far_usd ?? 0).toFixed(4)}`} sub={capped ? `cap ${capDisplay}` : 'no cap'} />
        <Stat label="Main tip" value={status.main_tip ? status.main_tip.slice(0, 7) : '—'} sub={status.main_tip_score != null ? status.main_tip_score.toFixed(3) : 'no score'} />
      </div>

      <div className="flex items-center gap-3 text-[11px]">
        <span className="flex items-center gap-1.5 text-text-secondary">
          <Zap size={11} /> Concurrency
        </span>
        <div className="flex items-center gap-1">
          {Array.from({ length: MAX_CONCURRENCY - MIN_CONCURRENCY + 1 }, (_, i) => MIN_CONCURRENCY + i).map((n) => {
            const active = (e?.concurrency ?? 0) === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => onConcurrencyChange(n)}
                aria-label={`Set concurrency to ${n}`}
                className={cn(
                  'min-w-[24px] rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
                  active
                    ? 'bg-brand text-white'
                    : 'bg-bg-elevated text-text-secondary hover:text-text-primary',
                )}
              >
                {n}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-text-muted">
          {e
            ? (e.concurrency < MIN_CONCURRENCY || e.concurrency > MAX_CONCURRENCY
                ? 'clamped to 1..4 by the engine'
                : 'applied on next pool refill')
            : '—'}
        </span>
      </div>

      {stopError && (
        <p className="text-[11px] text-text-muted">
          <Pause size={10} className="inline-block align-text-bottom mr-1" />
          Stop failed: {stopError}
        </p>
      )}

      <p className="text-[10px] text-text-muted">
        Engine autostarts on launch and re-reads <code className="text-text-secondary">FERAL_RSI_MAX_COST_USD</code> on every restart. Set the USD cap in the section above.
      </p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-text-muted">{label}</div>
      <div className="font-mono text-text-primary">{value}</div>
      {sub && <div className="text-[10px] text-text-muted">{sub}</div>}
    </div>
  );
}

function StatusPill({ running, stopReason, engineKnown }: { running: boolean; stopReason: string | null; engineKnown: boolean }) {
  if (!engineKnown) {
    return <span className="rounded-md bg-bg-elevated px-1.5 py-0.5 text-[10px] text-text-muted">starting…</span>;
  }
  if (running) {
    return <span className="rounded-md bg-brand/15 px-1.5 py-0.5 text-[10px] text-brand">running</span>;
  }
  return (
    <span className="rounded-md bg-bg-elevated px-1.5 py-0.5 text-[10px] text-text-secondary">
      stopped{stopReason ? ` · ${stopReason}` : ''}
    </span>
  );
}
