import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RsiEngineStatusPanel } from '@/components/settings/RsiEngineStatusPanel';
import { tauri } from '@/lib/tauri';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeStatus(
  overrides: Partial<{
    initialized: boolean;
    max_total_cost_usd: number | null;
    main_tip: string | null;
    main_tip_score: number | null;
  }> = {},
  engineOverrides: Partial<{
    running: boolean;
    iteration: number;
    best_score: number | null;
    cost_so_far_usd: number;
    concurrency: number;
    stop_reason: string | null;
  }> = {},
) {
  return {
    initialized: true,
    bounds_sha256: null,
    bounds_version: 1,
    cost_warning_ratio: null,
    main_tip: 'abc1234def',
    main_tip_score: 0.42,
    max_total_cost_usd: 0,
    ...overrides,
    engine: {
      running: true,
      iteration: 17,
      best_score: 0.81,
      cost_so_far_usd: 0.0007,
      concurrency: 1,
      stop_reason: null,
      ...engineOverrides,
    },
  };
}

describe('RsiEngineStatusPanel', () => {
  it('shows the running pill and stats when the engine is up', async () => {
    vi.spyOn(tauri.rsi, 'status').mockResolvedValue(makeStatus() as any);

    render(<RsiEngineStatusPanel />);

    expect(await screen.findByText('running')).toBeInTheDocument();
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getByText('0.810')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('switches to "stopped" pill with the stop reason when the engine halts', async () => {
    vi.spyOn(tauri.rsi, 'status').mockResolvedValue(makeStatus(
      {},
      { running: false, stop_reason: 'CostBudgetExhausted', iteration: 23, best_score: 0.5 },
    ) as any);

    render(<RsiEngineStatusPanel />);

    expect(await screen.findByText(/stopped/)).toBeInTheDocument();
    expect(screen.getByText(/CostBudgetExhausted/)).toBeInTheDocument();
    // Stop button is only shown while running.
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('shows the cap subline when max_total_cost_usd is set', async () => {
    vi.spyOn(tauri.rsi, 'status').mockResolvedValue(makeStatus({
      max_total_cost_usd: 5.0,
    }) as any);

    render(<RsiEngineStatusPanel />);

    expect(await screen.findByText(/cap \$5\.00/)).toBeInTheDocument();
  });

  it('fires rsi_set_concurrency when a concurrency chip is clicked', async () => {
    vi.spyOn(tauri.rsi, 'status').mockResolvedValue(makeStatus({}, { concurrency: 1 }) as any);
    const setSpy = vi.spyOn(tauri.rsi, 'setConcurrency').mockResolvedValue(undefined as any);

    const user = userEvent.setup();
    render(<RsiEngineStatusPanel />);
    await screen.findByText('running');

    await user.click(screen.getByRole('button', { name: 'Set concurrency to 3' }));

    expect(setSpy).toHaveBeenCalledWith(3);
  });

  it('fires rsi_stop when the Stop button is pressed', async () => {
    vi.spyOn(tauri.rsi, 'status').mockResolvedValue(makeStatus() as any);
    const stopSpy = vi.spyOn(tauri.rsi, 'stop').mockResolvedValue({ delivered: true } as any);

    const user = userEvent.setup();
    render(<RsiEngineStatusPanel />);
    await screen.findByText('running');

    await user.click(screen.getByRole('button', { name: /stop/i }));

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error message when the status call fails', async () => {
    vi.spyOn(tauri.rsi, 'status').mockRejectedValue(new Error('sidecar down'));

    render(<RsiEngineStatusPanel />);

    expect(await screen.findByText(/RSI engine status unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/sidecar down/)).toBeInTheDocument();
  });
});
