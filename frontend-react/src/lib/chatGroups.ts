/**
 * Grouping a list of conversations into the date headings every other app uses:
 * Today, Yesterday, Previous 7 days, Previous 30 days, then months and years.
 *
 * Two rules make this correct rather than approximately correct, and both were
 * chosen because the obvious version is wrong in a way people notice:
 *
 * 1. **Calendar days, not elapsed hours.** "Yesterday" means yesterday's date.
 *    A chat from 11pm last night is yesterday at 9am even though it is ten
 *    hours old, and a chat from 1am today is today even though it is also ten
 *    hours old. Dividing a millisecond difference by 86,400,000 gets both of
 *    those backwards, which is how a list ends up saying you spoke to it
 *    yesterday when you have the conversation open from this morning.
 * 2. **Nothing is invented.** A conversation whose timestamp is missing or
 *    unparseable goes to its own heading at the bottom rather than being folded
 *    into Today. Guessing puts a chat from last year at the top of the list.
 *
 * Local time throughout: the headings describe the user's day, and the only
 * clock that means anything to them is the one on their wall.
 */

import { t, type StringKey } from '@/lib/i18n';
import { useUI } from '@/stores/ui';

/** Midnight local time, as a timestamp. The unit every comparison here uses. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Whole calendar days between two instants — 0 for the same day, 1 for
 * yesterday, and negative for the future.
 *
 * `Math.round` rather than `floor`: a DST change makes one of these days 23 or
 * 25 hours long, and flooring would report the wrong day for every entry across
 * that boundary twice a year.
 */
function daysApart(now: number, then: number): number {
  return Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
}

export type BucketKey =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'last7' }
  | { kind: 'last30' }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'undated' };

/**
 * Which heading an instant belongs under.
 *
 * A timestamp in the future lands in Today rather than in a bucket of its own.
 * Clock skew is real — a machine that corrects its clock, a file copied from
 * another timezone — and "Today" is the least surprising answer to "this
 * happened at a time that has not arrived yet".
 */
export function bucketOf(iso: string | null | undefined, now: number): BucketKey {
  if (!iso) return { kind: 'undated' };
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return { kind: 'undated' };

  const days = daysApart(now, ms);
  if (days <= 0) return { kind: 'today' };
  if (days === 1) return { kind: 'yesterday' };
  if (days < 7) return { kind: 'last7' };
  if (days < 30) return { kind: 'last30' };

  const d = new Date(ms);
  return { kind: 'month', year: d.getFullYear(), month: d.getMonth() };
}

/** Stable identity for a bucket, for React keys and for merging. */
function bucketId(b: BucketKey): string {
  return b.kind === 'month' ? `month-${b.year}-${b.month}` : b.kind;
}

const FIXED_LABELS: Record<Exclude<BucketKey['kind'], 'month'>, StringKey> = {
  today:     'chats.group.today',
  yesterday: 'chats.group.yesterday',
  last7:     'chats.group.last7',
  last30:    'chats.group.last30',
  undated:   'chats.group.undated',
};

/**
 * What the heading reads.
 *
 * Month names come from the platform in the user's own language rather than
 * from a hardcoded list — the app already lets someone pick Romanian, and a
 * column that says "Today" in Romanian and "August" in English is a column that
 * was translated halfway. The year is dropped for the current one, because
 * "August 2026" in August 2026 is noise.
 */
function bucketLabel(b: BucketKey, now: number): string {
  if (b.kind !== 'month') return t(FIXED_LABELS[b.kind]);
  const locale = useUI.getState().language === 'ro' ? 'ro-RO' : 'en-US';
  const sameYear = b.year === new Date(now).getFullYear();
  return new Date(b.year, b.month, 1).toLocaleDateString(locale, {
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export interface DatedGroup<T> {
  id: string;
  label: string;
  items: T[];
}

/**
 * Newest first, cut into headed groups.
 *
 * The input is sorted here rather than by the caller, because a group list
 * built from an unsorted array silently interleaves the buckets — and every
 * caller was already sorting the same way immediately before rendering.
 *
 * Undated entries are collected and appended last, whatever order they arrived
 * in: they cannot be placed among dated ones without inventing a position.
 */
export function groupByRecency<T>(
  items: readonly T[],
  at: (item: T) => string | null | undefined,
  now: number = Date.now(),
): DatedGroup<T>[] {
  const dated = items
    .filter((i) => bucketOf(at(i), now).kind !== 'undated')
    .slice()
    .sort((a, b) => new Date(at(b)!).getTime() - new Date(at(a)!).getTime());
  const undated = items.filter((i) => bucketOf(at(i), now).kind === 'undated');

  const groups: DatedGroup<T>[] = [];
  for (const item of dated) {
    const bucket = bucketOf(at(item), now);
    const id = bucketId(bucket);
    const last = groups[groups.length - 1];
    if (last && last.id === id) last.items.push(item);
    else groups.push({ id, label: bucketLabel(bucket, now), items: [item] });
  }
  if (undated.length > 0) {
    groups.push({
      id: 'undated',
      label: bucketLabel({ kind: 'undated' }, now),
      items: undated,
    });
  }
  return groups;
}
