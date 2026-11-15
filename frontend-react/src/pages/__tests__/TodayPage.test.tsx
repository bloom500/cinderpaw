import { describe, expect, it, vi } from 'vitest';
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

describe('What I learned (spec 4.7)', () => {
  it('shows each learned line with Undo, sends the Undo, and is hidden when empty', async () => {
    const { render, screen, fireEvent } = await import('@testing-library/react');
    const { useTasks } = await import('@/stores/tasks');
    const { Learned } = await import('../TodayPage');
    const undoLearned = vi.fn();
    useTasks.setState({ learned: [], undoLearned });
    const empty = render(<Learned />);
    expect(empty.container).toBeEmptyDOMElement();
    empty.unmount();
    useTasks.setState({ learned: [{ bucket: 'followup:evening', line: 'I stopped mentioning unfinished work in the evening. You closed it 3 times.' }], undoLearned });
    render(<Learned />);
    expect(screen.getByText(/I stopped mentioning unfinished work in the evening/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undoLearned).toHaveBeenCalledWith('followup:evening');
  });
});

describe('Send my numbers (spec 4.12)', () => {
  it('sends only when pressed, then says it was sent', async () => {
    const { render, screen, fireEvent } = await import('@testing-library/react');
    const { useTasks } = await import('@/stores/tasks');
    const { SendNumbers } = await import('../TodayPage');
    const sendNumbers = vi.fn();
    useTasks.setState({ numbers: { state: 'idle' }, sendNumbers });
    const view = render(<SendNumbers />);
    expect(screen.getByText(/no messages, no names, no times/)).toBeInTheDocument();
    expect(sendNumbers).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send my numbers' }));
    expect(sendNumbers).toHaveBeenCalledTimes(1);
    view.unmount();
    useTasks.setState({ numbers: { state: 'failed', error: 'Could not reach the server.' } });
    render(<SendNumbers />);
    expect(screen.getByText(/Not sent\. Could not reach the server\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
