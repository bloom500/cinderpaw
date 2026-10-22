/** The public Model Leaderboard, served by the same worker as the install counter. */
export const LEADERBOARD_URL = 'https://cinderpaw-bug-report.bloommediacorporation.workers.dev/leaderboard';
/** Task duration ranges, in the order of `duration_buckets`. */
export const DURATION_LABELS = ['under 5 s', '5-15 s', '15-30 s', '30-60 s', '1-2 min', '2-5 min', '5-15 min', 'over 15 min'];

export interface LeaderRow {
  provider: string; model: string; installs: number; tasks: number; tasks_part: number;
  completion_rate: number; completion_ci: [number, number] | null;
  rated: number; satisfaction: number | null; satisfaction_ci: [number, number] | null;
  cost_reported_per_task: number; cost_estimated_per_task: number;
  median_duration_bucket: number | null; cache_share: number | null; errors: Record<string, number>;
}
export interface Leaderboard { month: string; minInstalls: number; minTasks: number; installs: number; hidden: number; models: LeaderRow[]; counting: boolean }

export async function fetchLeaderboard(signal?: AbortSignal): Promise<Leaderboard> {
  const r = await fetch(LEADERBOARD_URL, { signal });
  if (!r.ok) throw new Error(`leaderboard ${r.status}`);
  return (await r.json()) as Leaderboard;
}

/** Index of the duration range that holds the middle task, or null with no tasks. */
export function medianBucket(b: number[]): number | null {
  const total = b.reduce((a, x) => a + x, 0);
  if (!total) return null;
  let seen = 0;
  for (let i = 0; i < b.length; i++) { seen += b[i]!; if (seen >= total / 2) return i; }
  return b.length - 1;
}

export const pct = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`);
export const usd = (x: number) => (x === 0 ? '$0' : x < 0.01 ? '<$0.01' : `$${x.toFixed(2)}`);
