import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { AgentOfflineBanner } from '../AgentOfflineBanner';

beforeEach(() => {
  vi.useFakeTimers();
  useCinderpawStore.setState({ isReady: false, offline: false, restarting: false });
});

afterEach(() => vi.useRealTimers());

describe('AgentOfflineBanner startup grace', () => {
  it('stays quiet during normal startup and warns only after the grace period', () => {
    render(<AgentOfflineBanner />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(14_999));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    // "Cinderpaw is waking up", not "Cinderpaw Agent": the UX contract bans `agent` from
    // the primary interface, and the person waiting does not have two things.
    expect(screen.getByRole('status')).toHaveTextContent('Cinderpaw is waking up');
  });

  it('never flashes the startup warning when ready arrives inside the grace period', () => {
    render(<AgentOfflineBanner />);

    act(() => useCinderpawStore.getState().setReady(true));
    act(() => vi.advanceTimersByTime(15_000));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
