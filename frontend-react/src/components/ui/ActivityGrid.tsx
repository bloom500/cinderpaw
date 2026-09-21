import { Fragment, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useUI } from '@/stores/ui';

/**
 * A year of days, shaded by how much happened on each.
 *
 * The calendar year, January to December, Monday to Sunday, from the
 * conversation list the sidebar already holds, so it costs no
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
  // The interface language, not the OS locale: the rest of the page is
  // English while these labels came out Romanian on a Romanian Windows (20 Sep).
  const locale = useUI((u) => u.language);
  const { counts, streak, total } = useMemo(() => activityByDay(timestamps), [timestamps]);

  // The calendar year, January on the left, rows Monday to Sunday: the year
  // people mean when they say "this year", not the 53 weeks behind today.
  // Columns run from the Monday on or before 1 January to the Sunday on or
  // after 31 December; the days outside the year and the days still to come
  // are drawn blank so the shape of the grid never changes mid-year.
  const { year, weeks, todayKey } = useMemo(() => {
    const today = new Date();
    today.setHours(12, 0, 0, 0); // midday, so a DST shift cannot skip a day
    const year = today.getFullYear();
    const first = new Date(year, 0, 1, 12);
    const last = new Date(year, 11, 31, 12);
    // getDay() is Sunday-first; (d + 6) % 7 makes Monday 0.
    const start = new Date(first.getTime() - ((first.getDay() + 6) % 7) * DAY_MS);
    const stop = new Date(last.getTime() + (6 - ((last.getDay() + 6) % 7)) * DAY_MS);
    const weeks: { key: string; date: Date; inYear: boolean; future: boolean }[][] = [];
    for (let t = start.getTime(); t <= stop.getTime(); t += 7 * DAY_MS) {
      const week = [];
      for (let r = 0; r < 7; r++) {
        const d = new Date(t + r * DAY_MS);
        week.push({
          key: dayKey(d),
          date: d,
          inYear: d.getFullYear() === year,
          future: d.getTime() > today.getTime(),
        });
      }
      weeks.push(week);
    }
    return { year, weeks, todayKey: dayKey(today) };
  }, []);

  // A month label over the column that holds its first day.
  const months = useMemo(
    () =>
      weeks.map((week) => {
        const firstOfMonth = week.find((d) => d.inYear && d.date.getDate() === 1);
        return firstOfMonth ? firstOfMonth.date.toLocaleDateString(locale, { month: 'short' }) : null;
      }),
    [weeks, locale],
  );

  const weekdays = useMemo(
    () => weeks[0]!.map((d) => d.date.toLocaleDateString(locale, { weekday: 'short' })),
    [weeks, locale],
  );

  // What happened THIS year, for the line under the grid: the streak is
  // still counted across the year boundary, a run of days is a run of days.
  const yearTotal = useMemo(() => {
    let n = 0;
    for (const [k, c] of counts) if (k.startsWith(`${year}-`)) n += c;
    return n;
  }, [counts, year]);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* One grid for labels and cells, so they cannot drift apart: the first
          column is the weekday, the first row is the month, and the cells
          share the remaining columns equally. Equal shares rather than fixed
          pixels is what keeps the year inside whatever width it is given,
          instead of running under the scrollbar (20 Sep). */}
      <div
        className="grid gap-[3px] text-micro leading-none text-text-muted"
        style={{ gridTemplateColumns: `auto repeat(${weeks.length}, minmax(0, 1fr))` }}
        role="img"
        aria-label={
          total === 0
            ? 'No conversations yet'
            : `${yearTotal} conversations in ${year}, ${streak} day streak`
        }
      >
        <span />
        {months.map((m, w) => (
          <span key={w} className="overflow-visible whitespace-nowrap">{m}</span>
        ))}
        {weekdays.map((name, r) => (
          // A fragment per row: the label, then one cell per week.
          <Fragment key={r}>
            <span className="self-center pr-1">{name}</span>
            {weeks.map((week) => {
              const { key, date, inYear, future } = week[r]!;
              const n = counts.get(key) ?? 0;
              if (!inYear) return <span key={key} className="aspect-square" />;
              // Still to come: drawn, so the year reads as a year and not as
              // "it ends today", but dimmer and with nothing to say on hover.
              if (future) return <span key={key} className={cn('aspect-square rounded-[2px] opacity-40', TINT[0])} />;
              return (
                <span
                  key={key}
                  // `title` rather than a tooltip component: this is 365 elements,
                  // and 365 mounted tooltips is a scroll that stutters.
                  title={`${date.toLocaleDateString(locale)}: ${n === 0 ? 'nothing' : `${n} conversation${n === 1 ? '' : 's'}`}`}
                  className={cn(
                    'aspect-square rounded-[2px]',
                    TINT[levelOf(n)],
                    key === todayKey && 'ring-1 ring-text-muted/60',
                  )}
                />
              );
            })}
          </Fragment>
        ))}
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
            <span className="font-medium text-text-secondary">{yearTotal}</span> conversations in {year}
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
