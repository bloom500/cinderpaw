import { useEffect, useState } from 'react';
import { Moon, Sparkles, Check, X, AlertTriangle } from 'lucide-react';
import { tauri, type DreamTelemetrySummary, type JournalRow, type ChampionTreeRow } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';
import { useDream, type DreamStage } from '@/stores/dream';

/** The §2.8 stages the sidecar actually emits (dream/mutate are subsumed by the
 *  opaque engine episode in Faza 1). The live indicator walks these in order. */
const STAGE_STEPS: { key: DreamStage; label: string }[] = [
  { key: 'wake', label: 'Wake' },
  { key: 'observe', label: 'Observe' },
  { key: 'evaluate', label: 'Evaluate' },
  { key: 'remember', label: 'Remember' },
  { key: 'sleep', label: 'Sleep' },
];

/** Live Dream Cycle stage indicator — lights up wake→observe→evaluate→remember
 *  →sleep as the sidecar emits `dream_cycle` stage pulses. Shown only while a
 *  cycle is running. The `evaluate` step spans the whole episode (the engine's
 *  proposal/eval loop is opaque in Faza 1), so it dwells there the longest. */
function DreamStageStepper({ stage }: { stage: DreamStage | null }) {
  const activeIdx = STAGE_STEPS.findIndex((s) => s.key === stage);
  return (
    <div className="flex items-center gap-1.5 text-[10px]" aria-label="Dream cycle stage">
      {STAGE_STEPS.map((s, i) => {
        const state = activeIdx < 0 ? 'idle' : i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'todo';
        return (
          <span key={s.key} className="flex items-center gap-1">
            <span
              className={
                state === 'active'
                  ? 'text-brand font-medium'
                  : state === 'done'
                    ? 'text-text-secondary'
                    : 'text-text-muted'
              }
            >
              {s.label}
            </span>
            {i < STAGE_STEPS.length - 1 && <span className="text-text-muted">›</span>}
          </span>
        );
      })}
    </div>
  );
}

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
  const [receipts, setReceipts] = useState<JournalRow[]>([]);
  const [champions, setChampions] = useState<ChampionTreeRow[]>([]);
  const [requested, setRequested] = useState(false);
  const dreaming = useDream((s) => s.dreaming);
  const stage = useDream((s) => s.stage);

  // BRSI §2.8 `user` Wake trigger: ask the Dream Cycle to run one episode now
  // instead of waiting for the idle gate. Best-effort — a failure (sidecar not
  // running) is swallowed; the scheduler launches on its next tick.
  const dreamNow = async () => {
    try {
      await tauri.rsi.dreamNow();
      setRequested(true);
      setTimeout(() => setRequested(false), 4000);
    } catch { /* sidecar not running — ignore */ }
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await tauri.rsi.dreamTelemetry(RECENT_LIMIT);
        if (alive) { setSummary(s); setError(null); }
      } catch (e) {
        if (alive) setError(String(e));
      }
      // Receipts are a soft add-on: a failure here (e.g. no journal yet)
      // must never blank the whole panel, so it has its own guard.
      try {
        const rows = await tauri.rsi.journalRecent(RECENT_LIMIT);
        if (alive) setReceipts(rows);
      } catch {
        if (alive) setReceipts([]);
      }
      // Tree of Champions (§7.4) — its own guard, same soft-add-on discipline.
      try {
        const tree = await tauri.rsi.championTree();
        if (alive) setChampions(tree);
      } catch {
        if (alive) setChampions([]);
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
        <button
          type="button"
          onClick={dreamNow}
          disabled={requested}
          title="Run one dream episode now (bypasses the idle wait)"
          className="ml-auto rounded border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary hover:text-text-primary hover:border-brand disabled:opacity-60"
        >
          {requested ? 'Dreaming soon…' : 'Dream now'}
        </button>
      </header>

      {dreaming && (
        <div className="flex items-center gap-2 rounded border border-brand/30 bg-brand/5 px-2.5 py-1.5">
          <Moon size={11} className="shrink-0 animate-pulse text-brand" />
          <DreamStageStepper stage={stage} />
        </div>
      )}

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

          <Receipts rows={receipts} />
          <ChampionsByNiche rows={champions} />
        </>
      )}
    </div>
  );
}

/** Tree of Champions (§7.4) — the best config per behavioural niche. Shows that
 *  Feral keeps DIVERSITY, not just the single global best: each row is a
 *  distinct region (`t:c:r:d` — temperature / context / retrieval / depth) that
 *  won on its own terms. Empty until the engine has ratcheted a niche. */
function ChampionsByNiche({ rows }: { rows: ChampionTreeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-2.5">
      <span className="text-[11px] font-medium text-text-secondary">
        Champions by niche <span className="text-text-muted">({rows.length})</span>
      </span>
      <ul className="space-y-1">
        {rows.map((c) => (
          <li key={c.niche} className="flex items-center gap-2 text-[11px]">
            <span className="font-mono text-text-muted">{c.niche}</span>
            <span className="ml-auto tabular-nums text-text-secondary">{c.score.toFixed(1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Recent Evolution Journal rows (BRSI §2.9) — the auditable "receipts" of
 *  what each dream episode decided and why. Read-only, honest: shows the
 *  promotion decision, why candidates were blocked (confidence / Tier 0
 *  floor), and how much budget was left. Empty until the journal has rows. */
function Receipts({ rows }: { rows: JournalRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-2.5">
      <span className="text-[11px] font-medium text-text-secondary">Receipts</span>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          // Per-candidate Contract rows share the episode's cycleId, so the
          // key needs the index to stay unique.
          <li key={`${r.cycleId}:${i}`} className="text-[11px]">
            <div className="flex items-center gap-1.5">
              <DecisionBadge action={r.decided.action} />
              <span className="text-text-muted tabular-nums">
                {new Date(r.timestamp).toLocaleString([], {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </span>
            </div>
            <p className="mt-0.5 text-text-secondary">{r.decided.reason}</p>
            {r.result && (
              // Per-candidate fitness receipt (Contract FSM rows only).
              <p className="mt-0.5 text-text-muted tabular-nums">
                fitness {r.result.aggregate.toFixed(2)}
                {' · '}satisfaction {r.result.fitnessVector.userSatisfaction.toFixed(2)}
                {' · '}tier0 {r.result.tier0}
              </p>
            )}
            {r.observed.length > 0 && (
              <ul className="mt-0.5 space-y-0.5 pl-3 text-text-muted">
                {r.observed.map((line, i) => (
                  <li key={i} className="list-disc marker:text-border-subtle">{line}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DecisionBadge({ action }: { action: string }) {
  const map: Record<string, { icon: typeof Check; cls: string; label: string }> = {
    accept: { icon: Check, cls: 'text-brand', label: 'promoted' },
    reject: { icon: X, cls: 'text-text-muted', label: 'no change' },
    halt: { icon: AlertTriangle, cls: 'text-amber-500', label: 'halted' },
  };
  const { icon: Icon, cls, label } = map[action] ?? map.reject;
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${cls}`}>
      <Icon size={11} />
      {label}
    </span>
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
