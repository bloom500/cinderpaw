import { useEffect, useState } from 'react';
import { Moon, Sparkles } from 'lucide-react';
import { tauri, type DreamTelemetrySummary } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';

/**
 * "Feral's Dreams" — lifetime view of the Dream Cycle (RSI self-improvement
 * that runs while the user is idle). Reads aggregated telemetry from
 * `~/.feral/rsi/dream.jsonl` via `rsi_dream_telemetry` and refreshes whenever
 * a new episode ends (the `dream_cycle` pulse the sidecar emits). Read-only:
 * the user watches Feral improve itself, they don't pilot it.
 *
 * `ratchets` is the number that matters — each one is a real improvement
 * committed to main, so "N improvements" is the honest "it got better" signal
 * (vs `episodes`, which only counts that it tried).
 */
const RECENT_LIMIT = 16;

export function FeralDreamsPanel() {
  const [summary, setSummary] = useState<DreamTelemetrySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await tauri.rsi.dreamTelemetry(RECENT_LIMIT);
        if (alive) { setSummary(s); setError(null); }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void load();
    // A completed episode appends a new line → reload to pick it up.
    const unlistenP = events.onDreamCycle.listen((e) => {
      if (alive && e.phase === 'ended') void load();
    });
    return () => { alive = false; void unlistenP.then((u) => u()).catch(() => {}); };
  }, []);

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3 space-y-3">
      <header className="flex items-center gap-2">
        <Moon size={13} className="text-brand" />
        <span className="text-sm font-medium text-text-primary">Feral&apos;s Dreams</span>
        <span className="text-[11px] text-text-muted">self-improvement while you&apos;re idle</span>
      </header>

      {error ? (
        <p className="text-[11px] text-text-muted">Couldn&apos;t read dream history ({error}).</p>
      ) : summary === null ? (
        <p className="text-[11px] text-text-muted">Loading…</p>
      ) : summary.episodes === 0 ? (
        <p className="text-[11px] text-text-muted">
          No dreams yet — Feral dreams when you step away for a while.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-[11px]">
            <Stat label="Dreams" value={summary.episodes.toLocaleString()} />
            <Stat
              label="Improvements"
              value={summary.ratchets.toLocaleString()}
              accent={summary.ratchets > 0}
            />
            <Stat label="Iterations" value={summary.iterations.toLocaleString()} />
          </div>

          <RatchetSparkline episodes={summary.last} />

          {summary.last[0] && (
            <p className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <Sparkles size={11} className="text-brand" />
              Last dream: {summary.last[0].trigger}-triggered ·{' '}
              {summary.last[0].ratchets > 0
                ? `${summary.last[0].ratchets} improvement${summary.last[0].ratchets === 1 ? '' : 's'}`
                : 'no improvement'}{' '}
              · {summary.last[0].stopReason}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-text-muted">{label}</span>
      <span className={accent ? 'font-medium text-brand' : 'font-medium text-text-primary'}>{value}</span>
    </div>
  );
}

/** Tiny bar chart of ratchets per recent episode (oldest → newest). Bars are
 *  scaled to the busiest episode; a flat row of zero-height stubs means "tried
 *  but didn't improve", which is itself useful signal. */
function RatchetSparkline({ episodes }: { episodes: DreamTelemetrySummary['last'] }) {
  if (episodes.length === 0) return null;
  // `last` is newest-first; show oldest-first so it reads left→right in time.
  const ordered = [...episodes].reverse();
  const max = Math.max(1, ...ordered.map((e) => e.ratchets));
  return (
    <div
      className="flex items-end gap-0.5 h-8"
      role="img"
      aria-label={`Ratchets per recent dream: ${ordered.map((e) => e.ratchets).join(', ')}`}
    >
      {ordered.map((e, i) => (
        <div
          key={i}
          className="flex-1 rounded-sm bg-brand/70 min-h-[2px]"
          style={{ height: `${(e.ratchets / max) * 100}%` }}
          title={`${e.trigger}: ${e.ratchets} improvement${e.ratchets === 1 ? '' : 's'}`}
        />
      ))}
    </div>
  );
}
