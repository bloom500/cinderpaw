import { describe, expect, it } from 'vitest';
import type { ScheduledTask } from '@/lib/tauri';
import { doneLately, headline, plannedToday } from '../TodayPage';

const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 14 + dayOffset, h, m).getTime();
const NOW = at(15);
const job = (over: Partial<ScheduledTask>): ScheduledTask => ({
  id: over.name ?? 'j', name: 'j', task: 't', schedule: { kind: 'every', everyMs: 3_600_000 } as never,
  enabled: true, kind: 'reminder', history: [], ...over,
});

describe('Today', () => {
  it('lists what runs later today, earliest first; not what ran, is off, or is tomorrow', () => {
    const jobs = [
      job({ name: 'Summary', nextRunMs: at(20) }),
      job({ name: 'Call', nextRunMs: at(16, 30) }),
      job({ name: 'Already past', nextRunMs: at(9) }),
      job({ name: 'Tomorrow', nextRunMs: at(9, 0, 1) }),
      job({ name: 'Off', nextRunMs: at(17), enabled: false }),
      job({ name: 'No time' }),
    ];
    expect(plannedToday(jobs, NOW).map((j) => j.name)).toEqual(['Call', 'Summary']);
  });

  it('shows what went well since yesterday, newest first, never failures or older runs', () => {
    const jobs = [
      job({ name: 'Water', history: [
        { runAt: at(10, 0, -1), status: 'ok', durationMs: 1 },
        { runAt: at(10), status: 'ok', durationMs: 1, result: 'Reminded you.' },
      ] }),
      job({ name: 'Page', history: [
        { runAt: at(12), status: 'error', durationMs: 1, error: 'offline' },
        { runAt: at(10, 0, -3), status: 'ok', durationMs: 1 },
      ] }),
    ];
    expect(doneLately(jobs, NOW).map(({ job: j, run }) => [j.name, run.runAt])).toEqual([
      ['Water', at(10)],
      ['Water', at(10, 0, -1)],
    ]);
  });

  it('the line under the greeting counts what needs you', () => {
    expect(headline(0)).toBe('Nothing needs you right now. The rest is handled.');
    expect(headline(1)).toBe('One thing needs you. The rest is handled.');
    expect(headline(3)).toBe('3 things need you. The rest is handled.');
  });
});
