import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityGrid, activityByDay } from '../ActivityGrid';

/** Local midnight for a day offset from a fixed "now", as an ISO string. */
const NOW = new Date(2026, 8, 16, 14, 0, 0); // 16 Sep 2026, local
const daysAgo = (n: number, hour = 10) =>
  new Date(2026, 8, 16 - n, hour, 0, 0).toISOString();

describe('activityByDay', () => {
  it('counts per local day, not per UTC day', () => {
    // 01:00 local in a positive offset is the previous day in UTC. Somebody
    // working late is working today, and a UTC key files half their evenings
    // under yesterday.
    const lateLastNight = new Date(2026, 8, 16, 1, 0, 0).toISOString();
    const { counts } = activityByDay([lateLastNight], NOW);
    expect(counts.get('2026-09-16')).toBe(1);
  });

  it('counts the run of days ending today', () => {
    const { streak, total } = activityByDay([daysAgo(0), daysAgo(1), daysAgo(2)], NOW);
    expect(streak).toBe(3);
    expect(total).toBe(3);
  });

  it('a gap ends the streak', () => {
    // Today, yesterday, then nothing on the day before: the run is 2, not 3.
    const { streak } = activityByDay([daysAgo(0), daysAgo(1), daysAgo(3)], NOW);
    expect(streak).toBe(2);
  });

  it('a streak survives a day you have not got to yet', () => {
    // Nothing today, but yesterday and the day before. Breaking the streak at
    // midnight punishes somebody for not having opened the app by lunchtime.
    const { streak } = activityByDay([daysAgo(1), daysAgo(2)], NOW);
    expect(streak).toBe(2);
  });

  it('no activity is a streak of zero, not of one', () => {
    expect(activityByDay([], NOW).streak).toBe(0);
  });

  it('a row with an unreadable date is dropped, not counted as today', () => {
    // Counting it as today would invent a streak out of bad data.
    const { streak, counts } = activityByDay(['not a date'], NOW);
    expect(streak).toBe(0);
    expect(counts.size).toBe(0);
  });
});

describe('ActivityGrid', () => {
  it('says what is true on a fresh install instead of scolding with a zero', () => {
    render(<ActivityGrid timestamps={[]} />);
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
    expect(screen.queryByText(/0 day/)).toBeNull();
  });

  it('describes itself for a screen reader, which cannot see 371 squares', () => {
    render(<ActivityGrid timestamps={[daysAgo(0), daysAgo(1)]} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/2 conversations/);
  });
});
