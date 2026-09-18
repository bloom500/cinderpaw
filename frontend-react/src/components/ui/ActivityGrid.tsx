import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/**
 * A year of days, shaded by how much happened on each.
 *
 * Built from the conversation list the sidebar already holds, so it costs no
 * request and no new table: a day is "active" if a conversation was touched on
 * it. That is a real limit and it is stated here rather than felt later — a
 * conversation carries one `updated_at`, so a week of work in one long thread
 * lands entirely on the last day of it. The grid answers "did I use this, and
 * when", not "how many hours".
 *
 * Deliberately not a dependency. The version of this on every component gallery
 * ships a canvas or an SVG chart library to draw squares; squares are what CSS
 * grid is for, and this file is the whole feature.
 */

/** How many weeks fit the width we give it. A year, like the original. */
const WEEKS = 53;
const DAY_MS = 86_400_000;

/** Midnight local time for a timestamp, as the key a day is counted under. */
function dayKey(d: Date): string {
  // Local, not UTC. Somebody in Bucharest working at 01:00 is working today,
  // and a UTC key would file half their evenings under yesterday.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Count per day, and the run of days ending today.
 *
 * Exported for its own test: the streak is the number people read first and it
 * is the easiest thing to get wrong by one.
 */
export function activityByDay(timestamps: string[], now = new Date()): {
  counts: Map<string, number>;
  streak: number;
  total: number;
} {
  const counts = new Map<string, number>();
  for (const t of timestamps) {
    const d = new Date(t);
    // An unparseable date is not a day with no activity, it is a row we cannot
    // place. Counting it as today would invent a streak out of bad data.
    if (Number.isNaN(d.getTime())) continue;
    const k = dayKey(d);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  // Today counts if it has anything; otherwise the streak may still stand on
  // yesterday, because a streak that breaks at midnight punishes somebody for
  // not having got to it yet.
  let streak = 0;
  const cursor = new Date(now);
  if (!counts.has(dayKey(cursor))) cursor.setTime(cursor.getTime() - DAY_MS);
  while (counts.has(dayKey(cursor))) {
    streak += 1;
    cursor.setTime(cursor.getTime() - DAY_MS);
  }

  return { counts, streak, total: timestamps.length };
}

/** Four steps, so one busy day does not make every other day look empty. */
function levelOf(n: number): 0 | 1 | 2 | 3 | 4 {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n <= 3) return 2;
  if (n <= 6) return 3;
  return 4;
}

const TINT: Record<number, string> = {
  0: 'bg-bg-elevated',
  1: 'bg-brand/25',
  2: 'bg-brand/45',
  3: 'bg-brand/70',
  4: 'bg-brand',
};

export function ActivityGrid({
  timestamps,
  className,
}: {
  /** One entry per thing that happened, as an ISO date string. */
  timestamps: string[];
  className?: string;
}) {
  const { counts, streak, total } = useMemo(() => activityByDay(timestamps), [timestamps]);

  // Columns are weeks, oldest first, each ending on the same weekday as today,
  // so the last square is always today wherever today falls.
  const days = useMemo(() => {
    const out: { key: string; date: Date }[] = [];
    const end = new Date();
    end.setHours(12, 0, 0, 0); // midday, so a DST shift cannot skip a day
    for (let i = WEEKS * 7 - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * DAY_MS);
      out.push({ key: dayKey(d), date: d });
    }
    return out;
  }, []);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        className="grid grid-flow-col gap-[3px]"
        style={{ gridTemplateRows: 'repeat(7, minmax(0, 1fr))' }}
        role="img"
        aria-label={
          total === 0
            ? 'No conversations yet'
            : `${total} conversations over the past year, ${streak} day streak`
        }
      >
        {days.map(({ key, date }) => {
          const n = counts.get(key) ?? 0;
          return (
            <span
              key={key}
              // `title` rather than a tooltip component: this is 371 elements,
              // and 371 mounted tooltips is a scroll that stutters.
              title={`${date.toLocaleDateString()}: ${n === 0 ? 'nothing' : `${n} conversation${n === 1 ? '' : 's'}`}`}
              className={cn('size-[9px] rounded-[2px]', TINT[levelOf(n)])}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-3 text-xs text-text-muted">
        {/* Never a zero dressed up as an achievement. On a fresh install this
            says what is true and what to do about it, instead of "0 day
            streak", which reads as a scolding on day one. */}
        {total === 0 ? (
          <span>Nothing here yet. It fills in as you talk to Cinderpaw.</span>
        ) : (
          <span>
            <span className="font-medium text-text-secondary">{streak}</span>
            {streak === 1 ? ' day' : ' days'} in a row ·{' '}
            <span className="font-medium text-text-secondary">{total}</span> conversations
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          less
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={cn('size-[9px] rounded-[2px]', TINT[l])} />
          ))}
          more
        </span>
      </div>
    </div>
  );
}
