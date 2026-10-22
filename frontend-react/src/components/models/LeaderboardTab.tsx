import { useEffect, useMemo, useState } from 'react';
import { tauri } from '@/lib/tauri';
import type { UsageSummaryLine } from '@/lib/tauri/events';
import { DURATION_LABELS, fetchLeaderboard, medianBucket, pct, usd, type Leaderboard, type LeaderRow } from '@/lib/leaderboard';

/** "92% (±4) of 140": the rate, how sure we are, and how many it rests on. */
const ci = (r: number, c: [number, number] | null, n: number) =>
  c ? `${pct(r)} (±${Math.round(((c[1] - c[0]) / 2) * 100)}) of ${n}` : '-';

const th = 'px-3 py-2 text-left text-xs font-medium text-text-muted';
const td = 'px-3 py-2 text-sm text-text-primary';

type SortKey = 'tasks' | 'installs' | 'completion_rate' | 'satisfaction' | 'cost';
const costOf = (r: LeaderRow) => r.cost_reported_per_task + r.cost_estimated_per_task;
const sortValue = (r: LeaderRow, k: SortKey) => (k === 'cost' ? costOf(r) : k === 'satisfaction' ? (r.satisfaction ?? -1) : r[k]);

export function LeaderboardTab() {
  const [mine, setMine] = useState<UsageSummaryLine | null>(null);
  const [mineErr, setMineErr] = useState(false);
  const [all, setAll] = useState<Leaderboard | null>(null);
  const [allErr, setAllErr] = useState(false);
  const [sort, setSort] = useState<SortKey>('tasks');

  useEffect(() => {
    tauri.usage.summary().then(setMine, () => setMineErr(true));
    // Offline must say so, not spin: give up after 8 s.
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    fetchLeaderboard(ac.signal).then(setAll, () => setAllErr(true)).finally(() => clearTimeout(t));
    return () => { clearTimeout(t); ac.abort(); };
  }, []);

  const myRows = useMemo(() => [...(mine?.groups ?? [])].sort((a, b) => b.tasks_main - a.tasks_main), [mine]);
  const allRows = useMemo(() => [...(all?.models ?? [])].sort((a, b) => sortValue(b, sort) - sortValue(a, sort)), [all, sort]);

  const sortTh = (k: SortKey, label: string) => (
    <th className={th} aria-sort={sort === k ? 'descending' : undefined}>
      <button type="button" onClick={() => setSort(k)} className="hover:text-text-primary">{label}{sort === k ? ' ↓' : ''}</button>
    </th>
  );

  return (
    <div className="space-y-10">
      <section>
        <h2 className="font-display text-xl text-text-primary">Your numbers</h2>
        <p className="mt-1 text-sm text-text-secondary">This month, on this computer. These never leave it unless you turn on sharing in Settings, Privacy.</p>
        {mineErr ? <p className="mt-4 text-sm text-text-muted">Cinderpaw could not load your numbers right now.</p>
          : !mine ? <p className="mt-4 text-sm text-text-muted">Loading…</p>
          : myRows.length === 0 ? <p className="mt-4 text-sm text-text-muted">No finished tasks this month yet.</p>
          : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-border-subtle">
            <table className="w-full">
              <thead className="bg-bg-surface"><tr>
                <th className={th}>Model</th><th className={th}>Tasks</th><th className={th}>Done</th>
                <th className={th}>👍 / 👎</th><th className={th}>Cost per task</th><th className={th}>Usual time</th>
              </tr></thead>
              <tbody>{myRows.map((g) => {
                const m = medianBucket(g.duration_buckets);
                return (
                  <tr key={`${g.provider}/${g.model}`} className="border-t border-border-subtle">
                    <td className={td}>{g.model}<span className="ml-2 text-xs text-text-muted">{g.provider}</span></td>
                    <td className={td}>{g.tasks_main}</td>
                    <td className={td}>{g.tasks_main ? pct((g.outcomes.completed ?? 0) / g.tasks_main) : '-'}</td>
                    <td className={td}>{g.thumbs_up} / {g.thumbs_down}</td>
                    <td className={td}>{g.tasks_main ? usd((g.cost_reported_usd + g.cost_estimated_usd) / g.tasks_main) : '-'}{g.cost_estimated_usd > 0 ? ' (est.)' : ''}</td>
                    <td className={td}>{m === null ? '-' : DURATION_LABELS[m]}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-xl text-text-primary">Everyone</h2>
        <p className="mt-1 text-sm text-text-secondary">From people who chose to share. 👍 shows how happy people were, not proof the task was right.</p>
        {allErr ? <p className="mt-4 text-sm text-text-muted">Cinderpaw could not reach the leaderboard. Check your internet and open this tab again.</p>
          : !all ? <p className="mt-4 text-sm text-text-muted">Loading…</p>
          : allRows.length === 0 ? (
            <p className="mt-4 text-sm text-text-muted">We are collecting. A model shows up once {all.minInstalls} installations have used it for at least {all.minTasks} tasks this month.</p>
          ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-border-subtle">
            <table className="w-full">
              <thead className="bg-bg-surface"><tr>
                <th className={th}>Model</th>{sortTh('installs', 'Installs')}{sortTh('tasks', 'Tasks')}{sortTh('completion_rate', 'Done')}
                {sortTh('satisfaction', '👍')}{sortTh('cost', 'Cost per task')}<th className={th}>Usual time</th>
              </tr></thead>
              <tbody>{allRows.map((r) => (
                <tr key={`${r.provider}/${r.model}`} className="border-t border-border-subtle">
                  <td className={td}>{r.model}<span className="ml-2 text-xs text-text-muted">{r.provider}</span></td>
                  <td className={td}>{r.installs}</td><td className={td}>{r.tasks}</td>
                  <td className={td}>{ci(r.completion_rate, r.completion_ci, r.tasks)}</td>
                  <td className={td}>{r.satisfaction === null ? '-' : ci(r.satisfaction, r.satisfaction_ci, r.rated)}</td>
                  <td className={td}>{usd(costOf(r))}{r.cost_estimated_per_task > 0 ? ' (est.)' : ''}</td>
                  <td className={td}>{r.median_duration_bucket === null ? '-' : DURATION_LABELS[r.median_duration_bucket]}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
