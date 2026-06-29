import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Layers, RefreshCw, Sparkles } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import type { MemoryGraphNodeView, DreamEpisode } from '@/lib/tauri';
import { rsiState, type RsiSnapshot, type RsiPhase } from './rsiState';

/**
 * Memory Layers — the user-friendly surface of Feral's FMS + RSI systems.
 *
 * We deliberately NO LONGER draw a stylized tree: matching a hand-painted
 * reference procedurally takes more artistic range than a runtime renderer
 * can give, and the result was distracting instead of helpful. Non-technical
 * users care about three things, all surfaced here:
 *
 *   1. What does Feral remember about me?   → tiered memory list
 *      (Today / This week / This month / Older).
 *   2. Is Feral self-improving right now?   → live RSI pill (idle / dreaming /
 *      ratcheted / error) tied to actual engine events.
 *   3. Has Feral been dreaming?            → recent dream episodes with score
 *      progression so the user sees something actually changing.
 *
 * The visual layer is the recency tier structure: more recent = more
 * saturated, older = dimmer. New memories fade in at the top of "Today".
 * A live dream pulses the "Feral's Dreams" panel; a ratchet flashes the
 * best score line.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type Tier = 'today' | 'week' | 'month' | 'older';
const TIER_LABELS: Record<Tier, string> = {
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
  older: 'Older',
};

/** Sort a node into a tier based on its `touched_at` ms-epoch. */
function tierOf(now: number, touchedAt: number): Tier {
  const age = Math.max(0, now - touchedAt);
  if (age <= DAY_MS) return 'today';
  if (age <= 7 * DAY_MS) return 'week';
  if (age <= 30 * DAY_MS) return 'month';
  return 'older';
}

function formatTimeAgo(now: number, ts: number): string {
  const dt = Math.max(0, now - ts);
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < DAY_MS) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / DAY_MS)}d ago`;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function describeStop(stopReason: string | undefined): string {
  if (!stopReason) return 'finished';
  const s = stopReason.toLowerCase();
  if (s.includes('plateau')) return 'converged on plateau';
  if (s.includes('budget')) return 'hit the USD budget';
  if (s.includes('token')) return 'hit the token limit';
  if (s.includes('iter')) return 'finished the iteration budget';
  if (s.includes('error')) return 'ended on error';
  return stopReason;
}

/** Tier panel — shows the memories inside a single recency window. */
function TierPanel({
  tier,
  nodes,
  totalAllTime,
  now,
}: {
  tier: Tier;
  nodes: MemoryGraphNodeView[];
  totalAllTime: number;
  now: number;
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const total = totalAllTime;
  const saturation =
    tier === 'today' ? 'border-[#e8731c]/60'
    : tier === 'week' ? 'border-[#a04a14]/60'
    : tier === 'month' ? 'border-[#5c3416]/50'
                       : 'border-[#3a210f]/40';
  const headerDot =
    tier === 'today' ? 'bg-[#e8731c]'
    : tier === 'week' ? 'bg-[#c66a25]'
    : tier === 'month' ? 'bg-[#7a3d0e]'
                       : 'bg-[#3a210f]';
  const share = total === 0 ? 0 : (nodes.length / total) * 100;
  return (
    <section className={`rounded-lg border bg-zinc-900/60 ${saturation} p-4`}>
      <header className="mb-3 flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${headerDot}`} />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-100">
            {TIER_LABELS[tier]}
          </h2>
          <span className="text-xs text-zinc-400">
            {nodes.length} {nodes.length === 1 ? 'memory' : 'memories'}
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          {share.toFixed(0)}% of all
        </span>
      </header>
      {nodes.length === 0 ? (
        <p className="text-xs text-zinc-500">
          {tier === 'today'
            ? 'Nothing yet today — chat with Feral to fill this tier.'
            : `No memories in this tier yet.`}
        </p>
      ) : (
        <ul className="space-y-2">
          {nodes.map((n, i) => {
            const expanded = expandedIdx === i;
            return (
              <li
                key={n.id}
                onClick={() => setExpandedIdx(expanded ? null : i)}
                className={`cursor-pointer rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 transition hover:border-[#e8731c]/60 hover:bg-zinc-900 ${expanded ? 'border-[#e8731c]/50' : ''}`}
              >
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="font-mono text-[#e8731c]">{formatClock(n.touched_at)}</span>
                  <span className="text-zinc-500">{formatTimeAgo(now, n.touched_at)}</span>
                </div>
                <div className="mt-1 text-xs text-zinc-100">{n.label}</div>
                {expanded && (
                  <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px] text-zinc-500">
                    <span>type</span><span>{n.type}</span>
                    <span>id</span><span className="font-mono">{n.id}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Dream episode card — last N dream cycles, newest first. */
function DreamCard({ ep, now, bestScore }: { ep: DreamEpisode; now: number; bestScore: number | null }) {
  const improve = bestScore !== null && ep.ratchets > 0;
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-mono text-[#e8731c]">
          {ep.iterations} {ep.iterations === 1 ? 'iteration' : 'iterations'}
        </span>
        <span className="text-zinc-500">{formatTimeAgo(now, ep.startedAt)}</span>
      </div>
      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-[10px] text-zinc-400">
        <span className="text-zinc-500">trigger</span><span>{ep.trigger}</span>
        <span className="text-zinc-500">stop</span><span>{describeStop(ep.stopReason)}</span>
        <span className="text-zinc-500">tokens</span><span>{ep.tokens}</span>
        <span className="text-zinc-500">ratchets</span><span className={ep.ratchets > 0 ? 'text-[#ffe7a8]' : ''}>{ep.ratchets}</span>
        {improve && (
          <>
            <span className="text-zinc-500">best</span>
            <span className="text-[#ffe7a8]">{bestScore?.toFixed(1)}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Live RSI pill — same data as before, now lives above the Feral's Dreams
 *  panel so the connection is obvious. */
function RsiHud({ snapshot }: { snapshot: RsiSnapshot }) {
  const phase = snapshot.phase;
  const tone =
    phase === 'dreaming' ? 'border-[#e8731c] text-[#e8731c]'
    : phase === 'ratcheted' ? 'border-[#ffe7a8] text-[#ffe7a8]'
    : phase === 'error'    ? 'border-red-500 text-red-400'
                            : 'border-zinc-700 text-zinc-400';
  const dot =
    phase === 'dreaming' ? 'bg-[#e8731c] animate-pulse'
    : phase === 'ratcheted' ? 'bg-[#ffe7a8]'
    : phase === 'error'    ? 'bg-red-500'
                            : 'bg-zinc-500';
  const label =
    phase === 'dreaming' ? 'dreaming'
    : phase === 'ratcheted' ? 'ratcheted'
    : phase === 'error'    ? 'error'
                            : 'idle';
  const detail =
    phase === 'dreaming' ? 'Feral is exploring new params'
    : phase === 'ratcheted' ? snapshot.lastRatchetScore != null
        ? `champion score ${snapshot.lastRatchetScore.toFixed(1)}`
        : 'new champion applied'
    : snapshot.lastRatchetAt
      ? `last ratchet ${formatTimeAgo(Date.now(), snapshot.lastRatchetAt)}`
      : 'no ratchets yet';
  return (
    <div className={`pointer-events-auto inline-flex items-center gap-2 rounded-full border bg-zinc-950 px-3 py-1.5 text-[11px] backdrop-blur ${tone}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <Brain size={11} className="opacity-70" />
      <span className="font-medium uppercase tracking-wide">RSI · {label}</span>
      <span className="opacity-70">· {detail}</span>
    </div>
  );
}

export default function MemoryLayersPage() {
  const [nodes, setNodes] = useState<MemoryGraphNodeView[]>([]);
  const [dreamLast, setDreamLast] = useState<DreamEpisode[]>([]);
  const [bestScore, setBestScore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rsiSnapRef = useRef<RsiSnapshot>(rsiState.snapshot());

  // Tick the clock so "Xs ago" stays accurate without prop drilling.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // One subscription covers live RSI phase + drives the HUD pill re-render.
  useEffect(() => {
    return rsiState.subscribe((snap) => {
      rsiSnapRef.current = snap;
      // Force a re-render only on phase or score changes — keeps the clock
      // tick cheap. setNow above handles the per-second time-ago re-render.
      if (snap.lastRatchetScore !== undefined) setBestScore(snap.lastRatchetScore);
      setNow((n) => n); // touch to trigger re-render
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [graph, telemetry, rsi] = await Promise.all([
        tauri.memory.getGraph(),
        tauri.rsi.dreamTelemetry(20).catch(() => ({ episodes: 0, ratchets: 0, tokens: 0, iterations: 0, last: [] })),
        tauri.rsi.status().catch(() => null),
      ]);
      setNodes(graph.nodes);
      setDreamLast(telemetry.last ?? []);
      // If the engine has a current best, surface it in the dream cards.
      const status = (rsi as { best_score?: number } | null);
      if (status && typeof status.best_score === 'number') setBestScore(status.best_score);
    } catch (err) {
      console.error('[MemoryLayersPage] refresh failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Group nodes by tier (newest first).
  const tiers = useMemo(() => {
    const out: Record<Tier, MemoryGraphNodeView[]> = {
      today: [], week: [], month: [], older: [],
    };
    for (const n of nodes) out[tierOf(now, n.touched_at)].push(n);
    for (const t of Object.keys(out) as Tier[]) {
      out[t].sort((a, b) => b.touched_at - a.touched_at);
    }
    return out;
  }, [nodes, now]);

  const stats = useMemo(() => {
    const total = nodes.length;
    const today = tiers.today.length;
    const week = tiers.week.length;
    const month = tiers.month.length;
    return { total, today, week, month };
  }, [nodes, tiers]);

  const rsiPhase: RsiPhase = rsiSnapRef.current.phase;
  const panelGlow =
    rsiPhase === 'dreaming' ? 'shadow-[0_0_24px_-4px_rgba(232,115,28,0.6)]'
    : rsiPhase === 'ratcheted' ? 'shadow-[0_0_24px_-4px_rgba(255,231,168,0.6)]'
    : '';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
        {/* ── HEADER ──────────────────────────────────────────────── */}
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-[#e8731c]">
            <Layers size={14} />
            <span>Feral · Memory Layers</span>
          </div>
          <h1 className="text-2xl font-semibold leading-tight text-zinc-100">
            Everything Feral remembers.
          </h1>
          <p className="max-w-2xl text-sm text-zinc-400">
            Facts Feral learned from your conversations, grouped by how long ago. New
            memories land in <span className="text-[#e8731c]">Today</span>; older ones
            stay searchable so Feral can recall them when context demands.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <RsiHud snapshot={rsiSnapRef.current} />
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="Refresh memory layers"
              className="ml-auto rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>

        {/* ── HERO STATS ─────────────────────────────────────────── */}
        {stats.total === 0 ? (
          <section className="rounded-lg border border-[#e8731c]/30 bg-zinc-900 px-5 py-6 text-center">
            <h2 className="text-base font-semibold text-[#e8731c]">
              Feral hasn't remembered anything yet.
            </h2>
            <p className="mt-1 text-xs text-zinc-400">
              As you chat, facts you mention begin to fill the layers below.
              Start a conversation in <span className="text-[#e8731c]">Chat</span>{' '}
              and come back — memories land in real time.
            </p>
          </section>
        ) : (
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([
              ['Total', stats.total],
              ['Today', stats.today],
              ['This Week', stats.week],
              ['This Month', stats.month],
            ] as const).map(([label, value]) => (
              <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                <div className="text-[10px] uppercase tracking-wide text-zinc-400">{label}</div>
                <div className="mt-1 text-2xl font-semibold leading-none text-zinc-100">
                  {value}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ── TIERS ─────────────────────────────────────────────── */}
        {(Object.keys(tiers) as Tier[])
          .filter((t) => tiers[t].length > 0)
          .map((t) => (
            <TierPanel key={t} tier={t} nodes={tiers[t]} totalAllTime={stats.total} now={now} />
          ))}

        {/* ── FERAL'S DREAMS ────────────────────────────────────── */}
        <section className={`rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 transition-shadow ${panelGlow}`}>
          <header className="mb-3 flex items-center gap-2">
            <Sparkles size={14} className="text-[#e8731c]" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-100">
              Feral's Dreams
            </h2>
            <span className="text-xs text-zinc-400">
              {dreamLast.length} {dreamLast.length === 1 ? 'cycle' : 'cycles'}
            </span>
          </header>
          {dreamLast.length === 0 ? (
            <p className="text-xs text-zinc-400">
              No dream cycles yet. Feral tunes its own parameters while you're away —
              leave the app for ~5 minutes and the first dream will land here.
            </p>
          ) : (
            <ul className="space-y-2">
              {dreamLast.map((ep, i) => (
                <li key={`${ep.startedAt}-${i}`}>
                  <DreamCard ep={ep} now={now} bestScore={bestScore} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
