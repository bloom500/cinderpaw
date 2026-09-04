import { describe, it, expect } from 'vitest';
import { bucketOf, groupByRecency } from '@/lib/chatGroups';

/**
 * The calendar arithmetic, pinned. Everything here is a case where dividing
 * elapsed milliseconds by a day gives a different — wrong — answer than asking
 * which date something happened on.
 */

/** Local time, so the test means the same thing as the code it tests. */
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m, d, h, min).toISOString();

const NOW = new Date(2026, 7, 21, 9, 30).getTime(); // 21 Aug 2026, 09:30 local

describe('bucketOf', () => {
  it('calls late last night yesterday, not today', () => {
    // 10.5 hours ago. Elapsed-hours maths says "today"; the calendar says the
    // 20th, and the calendar is what the heading claims to describe.
    expect(bucketOf(at(2026, 7, 20, 23, 0), NOW).kind).toBe('yesterday');
  });

  it('calls early this morning today, not yesterday', () => {
    // Also ~8 hours away from now, in the other direction.
    expect(bucketOf(at(2026, 7, 21, 1, 0), NOW).kind).toBe('today');
  });

  it('puts a future timestamp in today rather than a bucket of its own', () => {
    expect(bucketOf(at(2026, 7, 22, 8, 0), NOW).kind).toBe('today');
  });

  it('walks the boundaries in order', () => {
    expect(bucketOf(at(2026, 7, 19), NOW).kind).toBe('last7');  // 2 days
    expect(bucketOf(at(2026, 7, 15), NOW).kind).toBe('last7');  // 6 days
    expect(bucketOf(at(2026, 7, 14), NOW).kind).toBe('last30'); // 7 days
    expect(bucketOf(at(2026, 6, 23), NOW).kind).toBe('last30'); // 29 days
    expect(bucketOf(at(2026, 6, 22), NOW).kind).toBe('month');  // 30 days
  });

  it('groups older entries by their own month and year', () => {
    expect(bucketOf(at(2025, 11, 3), NOW)).toEqual({ kind: 'month', year: 2025, month: 11 });
  });

  it('refuses to date what it cannot read', () => {
    // Guessing sends a conversation from last year to the top of the list.
    expect(bucketOf(undefined, NOW).kind).toBe('undated');
    expect(bucketOf('', NOW).kind).toBe('undated');
    expect(bucketOf('not a date', NOW).kind).toBe('undated');
  });
});

describe('groupByRecency', () => {
  const conv = (id: string, iso: string | null) => ({ id, updated_at: iso });

  it('orders groups newest first and sorts within them', () => {
    const groups = groupByRecency(
      [
        conv('old', at(2026, 6, 1)),
        conv('today-early', at(2026, 7, 21, 8)),
        conv('yesterday', at(2026, 7, 20, 15)),
        conv('today-late', at(2026, 7, 21, 9, 20)),
      ],
      (c) => c.updated_at,
      NOW,
    );
    expect(groups.map((g) => g.id)).toEqual(['today', 'yesterday', 'month-2026-6']);
    expect(groups[0]!.items.map((c) => c.id)).toEqual(['today-late', 'today-early']);
  });

  it('does not open a second group for a month it already closed', () => {
    // Unsorted input used to interleave, producing two "July" headings with
    // one chat each — the failure the caller's own sort was hiding.
    const groups = groupByRecency(
      [conv('a', at(2026, 5, 2)), conv('b', at(2026, 6, 9)), conv('c', at(2026, 5, 28))],
      (c) => c.updated_at,
      NOW,
    );
    expect(groups.map((g) => g.id)).toEqual(['month-2026-6', 'month-2026-5']);
    expect(groups[1]!.items.map((c) => c.id)).toEqual(['c', 'a']);
  });

  it('keeps undated conversations, and keeps them last', () => {
    const groups = groupByRecency(
      [conv('nodate', null), conv('today', at(2026, 7, 21, 9))],
      (c) => c.updated_at,
      NOW,
    );
    expect(groups.map((g) => g.id)).toEqual(['today', 'undated']);
    expect(groups[1]!.items.map((c) => c.id)).toEqual(['nodate']);
  });

  it('returns nothing for nothing', () => {
    expect(groupByRecency([], (c: { updated_at: string }) => c.updated_at, NOW)).toEqual([]);
  });
});
