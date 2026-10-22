import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectorCard } from '../ConnectorsPage';
import type { ConnectorCatalogEntry, ConnectorView } from '@/lib/tauri';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const entry = {
  id: 'telegram', name: 'Telegram', description: 'Talk to it from Telegram.', icon: '', auth_kind: 'token',
  coming_soon: false, fields: [{ key: 'TOKEN', label: 'Bot token', secret: true }],
  console_url: 'https://t.me/BotFather',
} as unknown as ConnectorCatalogEntry;

describe('a connector card on the Accounts page', () => {
  it('starts closed, opens on Set up, and says where the token comes from', () => {
    render(<ConnectorCard entry={entry} state={null} onChanged={() => {}} />);
    expect(screen.queryByText('Bot token')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(screen.getByText('Bot token')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Where do I get this/ })).toHaveAttribute('href', 'https://t.me/BotFather');
  });

  it('opens at once when it is already set up, or when the wizard picked it', () => {
    const saved = { id: 'telegram', enabled: true, allowlist: [], channels: [], filled: ['TOKEN'] } as unknown as ConnectorView;
    const { unmount } = render(<ConnectorCard entry={entry} state={saved} onChanged={() => {}} />);
    expect(screen.getByText('Bot token')).toBeInTheDocument();
    unmount();
    render(<ConnectorCard entry={entry} state={null} onChanged={() => {}} startOpen />);
    expect(screen.getByText('Bot token')).toBeInTheDocument();
  });
});
