import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConnectorCard as Card } from '../ConnectorsPage';
import type { ConnectorCatalogEntry, ConnectorView } from '@/lib/tauri';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async () => ({ ...(await vi.importActual<object>('react-router-dom')), useNavigate: () => navigate }));
/** The card links to the chat, so it lives inside a router, as in the app. */
const ConnectorCard = (p: React.ComponentProps<typeof Card>) => <MemoryRouter><Card {...p} /></MemoryRouter>;

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

  it("says the engine's reason when WhatsApp cannot start, not a spinner", () => {
    const wa = { ...entry, id: 'whatsapp', name: 'WhatsApp', auth_kind: 'qr', fields: [] } as unknown as ConnectorCatalogEntry;
    const why = 'WhatsApp support is not downloaded yet. Ask Cinderpaw in the chat to connect WhatsApp; it offers the download.';
    const state = { id: 'whatsapp', enabled: true, linked: false, live: false, liveError: why, allowlist: [], channels: [], filled: [] } as unknown as ConnectorView;
    render(<ConnectorCard entry={wa} state={state} onChanged={() => {}} />);
    expect(screen.getByText(why)).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByText(/Getting a QR code ready/)).toBeNull();
    // Next to the reason, the way out: ask Cinderpaw, in a new chat, words in the box.
    fireEvent.click(screen.getByRole('button', { name: 'Ask Cinderpaw' }));
    expect(navigate).toHaveBeenCalledWith('/chat', { state: { compose: 'Help me connect WhatsApp.' } });
  });

  it('offers to set it up by asking Cinderpaw, beside Set up', () => {
    render(<ConnectorCard entry={entry} state={null} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask Cinderpaw' }));
    expect(navigate).toHaveBeenCalledWith('/chat', { state: { compose: 'Help me connect Telegram.' } });
  });
});
