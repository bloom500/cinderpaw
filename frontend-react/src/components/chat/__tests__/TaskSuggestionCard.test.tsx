import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { TaskSuggestionCard } from '../TaskSuggestionCard';
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
    useTasks.setState({ jobs: [], loaded: true, error: null, creating: {}, dismissed: {}, limit: { weeklyUsd: null, asked: true, spentUsd: 0 } });
  });

  it('shows what, when and that a reminder is free; Create sends it, the answer settles it', async () => {
    render(<MemoryRouter><TaskSuggestionCard card={card} sessionId="s1" /></MemoryRouter>);
    expect(screen.getByText('Call the bank')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Reminder · Free')).toBeVisible());
    expect(screen.getByText(card.when)).toBeVisible();
    expect(screen.getByText(/Quit stops/i)).not.toBeVisible();
    expect(invoke).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(invoke).toHaveBeenCalledWith('cinderpaw_cron_op', expect.objectContaining({
      action: 'add', name: 'Call the bank', kind: 'reminder', sessionId: 's1', schedule: expect.objectContaining(card.schedule),
    }));
    const requestId = (vi.mocked(invoke).mock.calls[0]![1] as { requestId: string }).requestId;
    useTasks.getState().receive({ id: requestId, ok: true, jobs: [] });
    expect(await screen.findByText(/Created\./)).toBeTruthy();
  });

  it('a card whose task already exists is not shown again after a reload', () => {
    useTasks.setState({ jobs: [{ id: 'j1', name: card.title, task: card.task, schedule: card.schedule, enabled: true, kind: 'reminder', history: [] }] });
    render(<MemoryRouter><TaskSuggestionCard card={card} sessionId="s1" /></MemoryRouter>);
    expect(screen.queryByText('Call the bank')).toBeNull();
  });

  it('Not now closes it', async () => {
    render(<MemoryRouter><TaskSuggestionCard card={card} sessionId="s1" /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    // It leaves on a spring: gone once the exit has played.
    await waitFor(() => expect(screen.queryByText('Call the bank')).toBeNull());
  });
});

describe('scheduleWords', () => {
  it('reads the shapes the agent builds as sentences, and shows anything else as it is', () => {
    expect(scheduleWords({ kind: 'cron', expression: '0 9 * * 1-5' })).toBe('Every weekday at 09:00');
    expect(scheduleWords({ kind: 'cron', expression: '30 21 * * *' })).toBe('Every day at 21:30');
    expect(scheduleWords({ kind: 'cron', expression: '15 8 * * 1' })).toBe('Every Monday at 08:15');
    expect(scheduleWords({ kind: 'every', intervalMs: 6 * 3_600_000 })).toBe('Every 6 hours');
    expect(scheduleWords({ kind: 'cron', expression: '*/5 * * * *' })).toBe('Custom schedule');
  });
});

describe('task review', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    useTasks.setState({ jobs: [], loaded: true, error: null, creating: {}, dismissed: {}, limit: { weeklyUsd: null, asked: true, spentUsd: 0 } });
  });
  it('reviews watch proof and configurable expiry before explicit creation', async () => {
    const watch = {sourceUrl:'https://example.com/releases',contains:'Version 3 is available',official:true};
    render(<MemoryRouter><TaskSuggestionCard card={{...card,kind:'watch',watch,expiryDays:30,schedule:{kind:'every',intervalMs:3600000}}} sessionId="s1" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('link', { name: 'example.com' })).toBeVisible());
    expect(screen.getByText(`“${watch.contains}”`)).toBeVisible();
    expect(screen.queryByRole('spinbutton', { name: 'Watch expiry (days)' })).toBeNull();
    expect(screen.getByText(watch.sourceUrl)).not.toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(watch.sourceUrl)).toBeVisible();
    await userEvent.clear(screen.getByLabelText('Watch expiry (days)'));
    await userEvent.type(screen.getByLabelText('Watch expiry (days)'), '14');
    await userEvent.click(screen.getByRole('button',{name:'Create task'}));
    expect(invoke).toHaveBeenCalledWith('cinderpaw_cron_op',expect.objectContaining({schedule:expect.objectContaining({taskOptions:expect.objectContaining({watch,expiryDays:14})})}));
  });
  it('the first paid card ever asks once about a weekly limit; No limit is the default', async () => {
    useTasks.setState({ limit: { weeklyUsd: null, asked: false, spentUsd: 0 } });
    const { unmount } = render(<MemoryRouter><TaskSuggestionCard card={{...card,id:'a1',kind:'agent'}} sessionId="s1" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/asked once/i)).toBeVisible());
    expect(screen.getByRole('radio', { name: /No limit/ })).toBeChecked();
    await userEvent.clear(screen.getByLabelText('Weekly limit in dollars'));
    await userEvent.type(screen.getByLabelText('Weekly limit in dollars'), '3');
    await userEvent.click(screen.getByRole('button',{name:'Create task'}));
    expect(invoke).toHaveBeenCalledWith('cinderpaw_cron_op',expect.objectContaining({action:'limit',schedule:{taskOptions:{weeklyLimitUsd:3}}}));
    expect(invoke).toHaveBeenCalledWith('cinderpaw_cron_op',expect.objectContaining({action:'add',kind:'agent'}));
    unmount();
    // Answered: the next paid card does not ask again.
    useTasks.setState({ limit: { weeklyUsd: 3, asked: true, spentUsd: 0 } });
    render(<MemoryRouter><TaskSuggestionCard card={{...card,id:'a2',title:'Other',kind:'agent'}} sessionId="s1" /></MemoryRouter>);
    expect(screen.queryByText(/asked once/i)).toBeNull();
    await waitFor(() => expect(screen.getByText('Uses your AI model · weekly limit $3')).toBeVisible());
  });

});
