import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { fetchLeaderboard } = vi.hoisted(() => ({ fetchLeaderboard: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauri: { usage: { summary: vi.fn().mockResolvedValue({ ok: true, month: '2026-10', sent: [], preview: null, sharing: null, groups: [
  { provider: 'openrouter.ai', model: 'm1', tasks_part: 3, tasks_main: 2, outcomes: { completed: 1, stuck: 0, out_of_time: 0, ceiling: 0, stopped: 0, no_answer: 0, error: 1 },
    errors: {}, thumbs_up: 1, thumbs_down: 0, tokens_in: 0, tokens_out: 0, cache_read: null, cache_write: null, cost_reported_usd: 0.2, cost_estimated_usd: 0,
    duration_buckets: [0, 2, 0, 0, 0, 0, 0, 0], tool_calls: 0, fallbacks: 0, retries: 0, by_flags: {} } ] }) } } }));
vi.mock('@/lib/leaderboard', async (orig) => ({ ...(await orig<typeof import('@/lib/leaderboard')>()), fetchLeaderboard }));

import { LeaderboardTab } from '../LeaderboardTab';

describe('LeaderboardTab', () => {
  it('your numbers render from the local summary', async () => {
    fetchLeaderboard.mockResolvedValue({ month: '2026-10', minInstalls: 20, minTasks: 100, installs: 3, hidden: 1, models: [], counting: true });
    render(<LeaderboardTab />);
    expect(await screen.findByText('m1')).toBeInTheDocument();
    expect(await screen.findByText(/We are collecting/)).toBeInTheDocument();
  });
  it('everyone section says offline', async () => {
    fetchLeaderboard.mockRejectedValue(new Error('net'));
    render(<LeaderboardTab />);
    expect(await screen.findByText(/could not reach the leaderboard/i)).toBeInTheDocument();
  });
});
