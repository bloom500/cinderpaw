import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccountCard } from '@/components/connectors/AccountCard';
import type { ConnectorAccount } from '@/lib/tauri';

const account = (over: Partial<ConnectorAccount>): ConnectorAccount => ({
  connector_id: 'twitch',
  status: 'disconnected',
  metadata: {},
  ...over,
});

describe('AccountCard', () => {
  it('tells the user exactly what to type, and where', () => {
    render(
      <AccountCard
        account={account({
          status: 'pairing',
          auth_state: {
            kind: 'waiting_for_user',
            user_code: 'ABCD-1234',
            verification_uri: 'https://twitch.tv/activate',
            expires_at: 0,
          },
        })}
      />,
    );
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    expect(screen.getByText(/twitch\.tv\/activate/)).toBeTruthy();
    // The mechanism is ours to know, not theirs.
    expect(screen.queryByText(/OAuth|device code|grant/i)).toBeNull();
  });

  it('offers a way back when the credential was revoked', () => {
    render(<AccountCard account={account({ status: 'revoked' })} onConnect={() => {}} />);
    expect(screen.getByText(/disconnected/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeTruthy();
  });

  it('distinguishes a timeout from a refusal', () => {
    // Two states, two sentences: one says nobody refused anything, the other
    // says the account did. Collapsing them into "disconnected" sends people
    // hunting for a fault that is not there — or missing one that is.
    const { unmount } = render(<AccountCard account={account({ status: 'expired' })} />);
    const ranOut = screen.getByText(/ran out/i);
    expect(ranOut).toBeTruthy();
    expect(screen.queryByText(/ended this connection/i)).toBeNull();
    unmount();

    render(<AccountCard account={account({ status: 'revoked' })} />);
    expect(screen.getByText(/ended this connection/i)).toBeTruthy();
    expect(screen.queryByText(/ran out/i)).toBeNull();
  });

  it('carries the reason when something actually broke', () => {
    render(<AccountCard account={account({ status: { error: 'could not reach the provider' } })} />);
    // "It did not work" sends you to a log file. The words travel.
    expect(screen.getByText(/could not reach the provider/i)).toBeTruthy();
  });

  it('does not offer a dead button when there is nothing to click', () => {
    // Read-only context: no handler, so no button at all rather than one that
    // does nothing.
    render(<AccountCard account={account({ status: 'disconnected' })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('asks for a connection on the first run, when nothing exists yet', () => {
    const onConnect = vi.fn();
    render(<AccountCard account={account({ status: 'disconnected' })} onConnect={onConnect} />);
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(onConnect).toHaveBeenCalledWith('twitch');
  });
});
