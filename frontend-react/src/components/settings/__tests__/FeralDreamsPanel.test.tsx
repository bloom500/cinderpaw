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

    render(<FeralDreamsPanel />);

    expect(await screen.findByText('12')).toBeInTheDocument(); // dreams
    expect(screen.getByText('4')).toBeInTheDocument(); // improvements
    expect(screen.getByText('37')).toBeInTheDocument(); // iterations
    // Last dream line uses the newest (idle, 2 improvements).
    expect(screen.getByText(/idle-triggered/)).toBeInTheDocument();
    expect(screen.getByText(/2 improvements/)).toBeInTheDocument();
    expect(screen.getByText(/Converged/)).toBeInTheDocument();
  });

  it('shows a clean empty state when no dreams have run', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue({
      episodes: 0, ratchets: 0, tokens: 0, iterations: 0, last: [],
    });

    render(<FeralDreamsPanel />);

    expect(await screen.findByText(/No dreams yet/)).toBeInTheDocument();
  });

  it('surfaces a read error without crashing', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockRejectedValue('disk gone');

    render(<FeralDreamsPanel />);

    expect(await screen.findByText(/Couldn't read dream history/)).toBeInTheDocument();
  });
});
