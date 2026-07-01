import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeralDreamsPanel } from '@/components/settings/FeralDreamsPanel';
import { tauri, type DreamTelemetrySummary } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';

afterEach(() => {
  vi.restoreAllMocks();
});

function stubListener() {
  // onDreamCycle.listen returns Promise<UnlistenFn>; the panel only needs it
  // to resolve to a no-op unlisten.
  vi.spyOn(events.onDreamCycle, 'listen').mockResolvedValue(() => {});
}

const SUMMARY: DreamTelemetrySummary = {
  episodes: 12,
  ratchets: 4,
  tokens: 9800,
  iterations: 37,
  last: [
    { startedAt: 5000, endedAt: 6000, trigger: 'idle', iterations: 4, tokens: 200, ratchets: 2, stopReason: 'Converged' },
    { startedAt: 3000, endedAt: 4000, trigger: 'error', iterations: 2, tokens: 50, ratchets: 0, stopReason: 'BudgetExhausted' },
  ],
};

describe('FeralDreamsPanel', () => {
  it('renders lifetime totals and the last dream summary', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);

    render(<FeralDreamsPanel />);

    expect(await screen.findByText('12')).toBeInTheDocument(); // dreams
    expect(screen.getByText('4')).toBeInTheDocument(); // improvements
    expect(screen.getByText('37')).toBeInTheDocument(); // iterations
    // Last dream line uses the newest (idle, 2 improvements).
    expect(screen.getByText(/idle-triggered/)).toBeInTheDocument();
    expect(screen.getByText(/2 improvements/)).toBeInTheDocument();
    expect(screen.getByText(/Converged/)).toBeInTheDocument();
  });

  it('renders journal receipts with the decision and observed lines', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([
      {
        cycleId: 'c-2026-07-01T12:00:00.000Z',
        timestamp: Date.UTC(2026, 6, 1, 12, 0, 0),
        durationMin: 1.5,
        observed: [
          '12 evaluation(s), 2 promoted to main',
          '3 candidate(s) beat the score but were blocked by a promotion gate (confidence / Tier 0 floor)',
          'budget left: 18000 tokens, 6.0 min',
        ],
        decided: { action: 'accept', reason: '2 candidate(s) cleared the confidence gate and ratcheted main' },
      },
    ]);

    render(<FeralDreamsPanel />);

    expect(await screen.findByText('Receipts')).toBeInTheDocument();
    expect(screen.getByText('promoted')).toBeInTheDocument();
    expect(screen.getByText(/cleared the confidence gate/)).toBeInTheDocument();
    expect(screen.getByText(/blocked by a promotion gate/)).toBeInTheDocument();
    expect(screen.getByText(/budget left: 18000 tokens/)).toBeInTheDocument();
  });

  it('shows a clean empty state when no dreams have run', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue({
      episodes: 0, ratchets: 0, tokens: 0, iterations: 0, last: [],
    });
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);

    render(<FeralDreamsPanel />);

    expect(await screen.findByText(/No dreams yet/)).toBeInTheDocument();
  });

  it('surfaces a read error without crashing', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockRejectedValue('disk gone');
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);

    render(<FeralDreamsPanel />);

    expect(await screen.findByText(/Couldn't read dream history/)).toBeInTheDocument();
  });
});
