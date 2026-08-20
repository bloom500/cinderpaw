import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ConnectorAccounts } from '../ConnectorAccounts';
import { tauri, type ConnectorAccount } from '@/lib/tauri';

/**
 * The gap this closes: Phase 3 shipped start, poll and vault storage, all
 * tested, and nothing on any screen ever called poll. The card showed a code
 * and sat there forever, which from the outside is a broken feature with no
 * message saying so.
 */

const pairing: ConnectorAccount = {
  connector_id: 'twitch',
  status: 'pairing',
  metadata: {},
  auth_state: {
    kind: 'waiting_for_user',
    user_code: 'ABCD-1234',
    verification_uri: 'https://example.test/activate',
    expires_at: 0,
  },
} as ConnectorAccount;

const connected: ConnectorAccount = {
  connector_id: 'twitch',
  status: 'connected',
  display_name: 'darius',
  metadata: {},
  auth_state: null,
} as ConnectorAccount;

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ConnectorAccounts', () => {
  it('a card left waiting advances on its own, with no reload and no second click', async () => {
    vi.spyOn(tauri.connectors, 'accounts').mockResolvedValue([pairing]);
    const poll = vi.spyOn(tauri.connectors, 'pairPoll').mockResolvedValue(connected);

    render(<ConnectorAccounts />);
    expect(await screen.findByText('ABCD-1234')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(6_000);

    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
    expect(poll).toHaveBeenCalledWith('twitch');
  });

  it('does not poll when nothing is in flight', async () => {
    vi.spyOn(tauri.connectors, 'accounts').mockResolvedValue([connected]);
    const poll = vi.spyOn(tauri.connectors, 'pairPoll').mockResolvedValue(connected);

    render(<ConnectorAccounts />);
    await screen.findByText('Connected');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(poll).not.toHaveBeenCalled();
  });

  it('a fresh install says it has no accounts instead of showing an empty box', async () => {
    vi.spyOn(tauri.connectors, 'accounts').mockResolvedValue([]);
    render(<ConnectorAccounts />);
    expect(await screen.findByText(/No accounts yet/i)).toBeTruthy();
  });
});
