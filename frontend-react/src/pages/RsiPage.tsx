/**
 * Faza 1 — RSI page (Fractal Memory): minimal UI for starting, observing
 * and stopping the sidecar's RSI engine.
 *
 * Scope of this page (7d, per HANDOFF.md):
 *   - Display the RSI substrate state (initialized, bounds, main tip).
 *   - Show the engine state mirror (running, iteration, best_score,
 *     cost, concurrency, stop_reason) — falls back to "engine not
 *     wired" while the sidecar hasn't emitted its first event.
 *   - Form for rsi_start(goal, budget, max_iterations, concurrency).
 *   - Stop button → rsi_stop.
 *   - Live concurrency slider → rsi_set_concurrency (visible while
 *     running).
 *   - Live event feed: subscribe to feral://agent-output, filter for
 *     `type === "rsi_engine_event"`, show last N events with timestamp
 *     + event name + key fields. The engine mirror in Rust is the
 *     source of truth; this feed is for human reading.
 *
 * NOT in scope (later phases):
 *   - Visualising lineage / taste-vector / hall-of-fame (Faza 3+).
 *   - Editing SandboxBounds (the rsi_update_bounds UI lives elsewhere
 *     in a future phase).
 *   - Real runEval — the bridge is wired but the eval worker just
 *     stubs Tier 0 results today.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, CircleDashed, Pause, Play, RefreshCw } from 'lucide-react';
import { tauri, type RsiStatus } from '@/lib/tauri';
import { events, type RsiEngineEventLine } from '@/lib/tauri/events';
import { cn } from '@/lib/utils';

/** Polling interval for `rsi_status` while the engine might be
 *  running (every 1.5 s). When idle we still poll but slower. The
 *  `engine` field in the response is the source of truth for the
 *  running state, so the page doesn't need its own polling flag. */
const POLL_RUNNING_MS = 1_500;
const POLL_IDLE_MS = 4_000;

/** Maximum events kept in the live feed. Older events are dropped;
 *  the feed is for human reading, not an audit log (Rust owns the
 *  audit log via `rsi_engine_event` interception). */
const MAX_FEED_EVENTS = 100;

/** Helper: format a float cost in USD with 4 decimals and a `$` prefix. */
function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Helper: format a sha256 hash for compact display (first 12 chars). */
function fmtSha(s: string | null): string {
  if (!s) return '—';
  return s.length > 12 ? `${s.slice(0, 12)}…` : s;
}

/** Helper: render the `running` state as a coloured badge. */
function RunningBadge({ running, stopReason }: { running: boolean; stopReason: string | null }) {
  if (running) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-brand/15 text-brand">
        <Activity size={12} className="animate-pulse" /> running
      </span>
    );
  }
  if (stopReason) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-bg-elevated text-text-muted">
        <CircleDashed size={12} /> {stopReason}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-bg-elevated text-text-muted">
      <CircleDashed size={12} /> idle
    </span>
  );
}

/** Helper: render a numeric metric — label on top, big value below. */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-bg-elevated px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="text-base font-semibold text-text-primary tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-text-muted mt-0.5">{hint}</div>}
    </div>
  );
}

/** One row in the live event feed. */
function FeedRow({ ev }: { ev: RsiEngineEventLine }) {
  const time = new Date().toLocaleTimeString();
  const tone =
    ev.event === 'started'        ? 'text-success' :
    ev.event === 'stopped'        ? 'text-warning' :
    ev.event === 'concurrency_set' ? 'text-brand' :
                                    'text-text-muted';
  return (
    <div className="flex items-baseline gap-2 font-mono text-[11px] leading-5">
      <span className="text-text-disabled shrink-0 tabular-nums">{time}</span>
      <span className={cn('shrink-0 uppercase tracking-wider', tone)}>{ev.event}</span>
      <span className="text-text-secondary truncate">
        {ev.iteration !== undefined && <span className="ml-2">iter {ev.iteration}</span>}
        {ev.bestScore !== undefined && ev.bestScore !== null && (
          <span className="ml-2">best {ev.bestScore.toFixed(2)}</span>
        )}
        {ev.costSoFarUsd !== undefined && (
          <span className="ml-2">cost ${ev.costSoFarUsd.toFixed(4)}</span>
        )}
        {ev.concurrency !== undefined && (
          <span className="ml-2">× {ev.concurrency}</span>
        )}
        {ev.stopReason && <span className="ml-2 text-warning">{ev.stopReason}</span>}
      </span>
    </div>
  );
}

/**
 * Parse one raw `feral://agent-output` line into a typed
 * `RsiEngineEventLine`, or `null` if it's not a line we care about.
 *
 * Exported so the wire-shape parsing can be unit-tested without
 * mounting React or mocking Tauri. Lives next to `RsiPage` because
 * no other consumer cares about it.
 *
 * Defensive on every field — the sidecar's Rust handler drops unknown
 * `event` names with a warn log rather than crashing, so a future
 * event variant (e.g. "rate_limited") shouldn't break the feed.
 * We accept only the four documented variants; unknown variants are
 * dropped (return null) and the caller can log a warning.
 */
export function parseRsiEngineEvent(line: string): RsiEngineEventLine | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'rsi_engine_event') return null;
  const ev = obj.event;
  if (ev !== 'started' && ev !== 'stopped' && ev !== 'concurrency_set' && ev !== 'progress') {
    return null;
  }
  return {
    type: 'rsi_engine_event',
    event: ev,
    id: typeof obj.id === 'string' ? obj.id : undefined,
    iteration: typeof obj.iteration === 'number' ? obj.iteration : undefined,
    bestScore: typeof obj.bestScore === 'number' || obj.bestScore === null ? obj.bestScore : undefined,
    costSoFarUsd: typeof obj.costSoFarUsd === 'number' ? obj.costSoFarUsd : undefined,
    concurrency: typeof obj.concurrency === 'number' ? obj.concurrency : undefined,
    stopReason: typeof obj.stopReason === 'string' ? obj.stopReason : undefined,
  };
}

export function RsiPage() {
  const [status, setStatus] = useState<RsiStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [feed, setFeed] = useState<RsiEngineEventLine[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Form state. Goal is the only user-facing free text; the rest are
  // numbers with safe defaults that match the Faza 1 demo profile.
  const [goal, setGoal] = useState('improve agent accuracy on Tier 0 sanity suite');
  const [budgetUsd, setBudgetUsd] = useState(1.0);
  const [maxIterations, setMaxIterations] = useState(50);
  const [concurrency, setConcurrency] = useState(1);

  // ── Polling: refresh status on an interval that depends on whether
  // the engine might be running. Cleared on unmount.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const next = await tauri.rsi.status();
        if (cancelled) return;
        setStatus(next);
        setStatusError(null);
        const ms = next.engine?.running ? POLL_RUNNING_MS : POLL_IDLE_MS;
        timer = setTimeout(tick, ms);
      } catch (e) {
        if (cancelled) return;
        setStatusError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(tick, POLL_IDLE_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // ── Live event feed: subscribe once to feral://agent-output and
  // filter for rsi_engine_event lines. The Rust side keeps the
  // canonical mirror in rsi_status.engine — this feed is for humans.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await events.feralAgentOutputEvent.listen((e) => {
        if (cancelled) return;
        const line = parseRsiEngineEvent(e.payload.data);
        if (!line) return;
        setFeed((prev) => {
          const next = [line, ...prev];
          return next.length > MAX_FEED_EVENTS ? next.slice(0, MAX_FEED_EVENTS) : next;
        });
      });
      if (cancelled) { u(); return; }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // ── Init on first mount. Idempotent: Rust's setup() already
  // bootstrapped the substrate (PLAN.md + git + SandboxBounds) at
  // app launch. The Tauri call returns the same tip both times.
  const initOnceRef = useRef(false);
  useEffect(() => {
    if (initOnceRef.current) return;
    initOnceRef.current = true;
    tauri.rsi.init().catch((e) => setActionError(
      e instanceof Error ? e.message : String(e),
    ));
  }, []);

  const onStart = useCallback(async () => {
    setActionError(null);
    setBusy(true);
    try {
      await tauri.rsi.start(goal.trim(), budgetUsd, maxIterations, concurrency);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [goal, budgetUsd, maxIterations, concurrency]);

  const onStop = useCallback(async () => {
    setActionError(null);
    setBusy(true);
    try {
      await tauri.rsi.stop();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onSetConcurrency = useCallback(async (n: number) => {
    setActionError(null);
    try {
      await tauri.rsi.setConcurrency(n);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const engine = status?.engine ?? null;
  const running = engine?.running ?? false;

  // Form disabled states.
  const initDisabled = !status?.initialized || busy;
  const startDisabled = initDisabled || running;
  const stopDisabled = initDisabled || !running;

  // Concurrency options for the live slider. The hard ceiling is
  // intentionally low (4) because today runEval is sequential and a
  // higher value would just queue; bumping it is part of Faza 3.
  const concurrencyOptions = useMemo(() => [1, 2, 3, 4], []);

  return (
    <div className="flex flex-col h-full overflow-y-auto px-6 py-4 max-w-5xl mx-auto w-full">
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-xl font-semibold text-text-primary">Fractal Memory</h1>
        {status && (
          <RunningBadge running={running} stopReason={engine?.stop_reason ?? null} />
        )}
      </div>
      <p className="text-xs text-text-muted mb-6">
        Recursive Self-Improvement substrate. The Rust sidecar drives the loop; this page is the
        minimal UI for starting, observing and stopping it.
      </p>

      {/* ── Substrate + engine status card ─────────────────────────── */}
      <section className="rounded-lg border border-border-subtle bg-bg-surface p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary">Substrate</h2>
          {statusError && (
            <span className="text-xs text-error flex items-center gap-1">
              <AlertTriangle size={12} /> {statusError}
            </span>
          )}
        </div>
        {!status ? (
          <div className="text-sm text-text-muted">Loading…</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric
              label="Initialized"
              value={status.initialized ? 'yes' : 'no'}
              hint={status.initialized ? 'git + bounds + audit chain live' : 'call rsi_init'}
            />
            <Metric
              label="Bounds"
              value={status.bounds_version != null ? `v${status.bounds_version}` : '—'}
              hint={fmtSha(status.bounds_sha256)}
            />
            <Metric
              label="Main tip"
              value={fmtSha(status.main_tip)}
              hint={
                status.main_tip_score != null
                  ? `score ${status.main_tip_score.toFixed(2)}`
                  : 'no commit yet'
              }
            />
            <Metric
              label="Budget cap"
              value={status.max_total_cost_usd != null ? fmtUsd(status.max_total_cost_usd) : '—'}
              hint={status.cost_warning_ratio != null ? `warn @ ${(status.cost_warning_ratio * 100).toFixed(0)}%` : undefined}
            />
          </div>
        )}
      </section>

      {/* ── Engine state mirror card ──────────────────────────────── */}
      <section className="rounded-lg border border-border-subtle bg-bg-surface p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary">Engine</h2>
          {!engine && (
            <span className="text-xs text-text-muted italic">
              engine not wired — sidecar has not emitted rsi_engine_event yet
            </span>
          )}
        </div>
        {!engine ? (
          <div className="text-sm text-text-muted px-2 py-3">
            Start an engine run below. The mirror populates as soon as the sidecar acks
            <code className="mx-1 px-1 rounded bg-bg-elevated text-text-secondary text-xs">rsi_start</code>.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric
              label="Iteration"
              value={String(engine.iteration)}
            />
            <Metric
              label="Best score"
              value={engine.best_score != null ? engine.best_score.toFixed(2) : '—'}
            />
            <Metric
              label="Cost so far"
              value={fmtUsd(engine.cost_so_far_usd)}
            />
            <Metric
              label="Concurrency"
              value={`× ${engine.concurrency}`}
            />
          </div>
        )}
      </section>

      {/* ── Goal form + Start / Stop ──────────────────────────────── */}
      <section className="rounded-lg border border-border-subtle bg-bg-surface p-4 mb-4">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Run</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Goal (free text)</span>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. improve Tier 0 reliability"
              className="rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Max iterations</span>
            <input
              type="number"
              min={1}
              max={10_000}
              value={maxIterations}
              onChange={(e) => setMaxIterations(Math.max(1, Number(e.target.value) || 1))}
              className="rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand tabular-nums"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Budget (USD)</span>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(Math.max(0.01, Number(e.target.value) || 0.01))}
              className="rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand tabular-nums"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Initial concurrency</span>
            <select
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand"
            >
              {concurrencyOptions.map((n) => (
                <option key={n} value={n}>× {n}</option>
              ))}
            </select>
          </label>
        </div>

        {actionError && (
          <div className="mb-3 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error flex items-start gap-2">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="font-mono break-all">{actionError}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onStart()}
            disabled={startDisabled || goal.trim().length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play size={14} /> Start
          </button>
          <button
            type="button"
            onClick={() => void onStop()}
            disabled={stopDisabled}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-bg-elevated text-text-primary text-sm font-medium hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Pause size={14} /> Stop
          </button>

          {running && engine && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-text-muted">live concurrency</span>
              <select
                value={engine.concurrency}
                onChange={(e) => void onSetConcurrency(Number(e.target.value))}
                className="rounded-md border border-bg-hover bg-bg-primary px-2 py-1 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand"
              >
                {concurrencyOptions.map((n) => (
                  <option key={n} value={n}>× {n}</option>
                ))}
              </select>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              tauri.rsi.status()
                .then(setStatus)
                .catch((e) => setStatusError(e instanceof Error ? e.message : String(e)));
            }}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            aria-label="Refresh status"
          >
            <RefreshCw size={12} /> refresh
          </button>
        </div>
      </section>

      {/* ── Live event feed ──────────────────────────────────────── */}
      <section className="rounded-lg border border-border-subtle bg-bg-surface p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-text-primary">Live event feed</h2>
          <span className="text-[11px] text-text-muted">
            last {feed.length}{feed.length === MAX_FEED_EVENTS ? ` (cap)` : ''}
          </span>
        </div>
        {feed.length === 0 ? (
          <div className="text-xs text-text-muted px-2 py-3 italic">
            no events yet — start an engine run to populate
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto bg-bg-elevated rounded-md p-2 scrollbar-hide">
            {feed.map((ev, i) => (
              <FeedRow key={`${ev.event}-${i}-${ev.id ?? ''}`} ev={ev} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
