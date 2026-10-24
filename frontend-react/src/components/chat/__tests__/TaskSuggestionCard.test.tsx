import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { TaskSuggestionCard } from '../TaskSuggestionCard';
import { useChat } from '@/stores/chat';
import { useTasks } from '@/stores/tasks';
import { scheduleWords } from '@/pages/TasksPage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const card = {
  id: 'c1', title: 'Call the bank', task: 'Call the bank about the card.', kind: 'reminder' as const,
  schedule: { kind: 'at' as const, isoTimestamp: '2026-10-26T07:00:00.000Z' }, when: 'Mon 26 Oct at 09:00',
};

describe('task card', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    useChat.setState({ sessionId: 's1' });
    useTasks.setState({ offered: {}, jobs: [], loaded: false, error: null });
  });

  it('shows what, when and that a reminder is free; Create sends it, the answer settles it', async () => {
    useTasks.getState().offer('s1', { data: { taskSuggestion: card } });
    render(<MemoryRouter><TaskSuggestionCard /></MemoryRouter>);
    expect(screen.getByText('Call the bank')).toBeTruthy();
    expect(screen.getByText(/costs nothing/)).toBeTruthy();
    expect(screen.getByText(/runs while Cinderpaw is open/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(invoke).toHaveBeenCalledWith('cinderpaw_cron_op', expect.objectContaining({
      action: 'add', name: 'Call the bank', kind: 'reminder', sessionId: 's1', schedule: card.schedule,
    }));
    const requestId = (vi.mocked(invoke).mock.calls[0]![1] as { requestId: string }).requestId;
    useTasks.getState().receive({ id: requestId, ok: true, jobs: [] });
    expect(await screen.findByText(/Created\./)).toBeTruthy();
  });

  it('nothing is created by the offer itself, and Not now closes it', async () => {
    useTasks.getState().offer('s1', { data: { taskSuggestion: card } });
    render(<MemoryRouter><TaskSuggestionCard /></MemoryRouter>);
    expect(invoke).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Call the bank')).toBeNull();
  });
});

describe('scheduleWords', () => {
  it('reads the shapes the agent builds as sentences, and shows anything else as it is', () => {
    expect(scheduleWords({ kind: 'cron', expression: '0 9 * * 1-5' })).toBe('Every weekday at 09:00');
    expect(scheduleWords({ kind: 'cron', expression: '30 21 * * *' })).toBe('Every day at 21:30');
    expect(scheduleWords({ kind: 'cron', expression: '15 8 * * 1' })).toBe('Every Monday at 08:15');
    expect(scheduleWords({ kind: 'every', intervalMs: 6 * 3_600_000 })).toBe('Every 6 hours');
    expect(scheduleWords({ kind: 'cron', expression: '*/5 * * * *' })).toBe('Custom schedule (*/5 * * * *)');
  });
});
