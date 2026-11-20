import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    phone: { via: null, tested: false } as { via: string | null; tested: boolean } | null,
    refresh: vi.fn(),
  },
}));
vi.mock('@/stores/tasks', () => ({ useTasks: (sel: (s: typeof state) => unknown) => sel(state) }));

import { ConnectPhoneCard } from '../ConnectPhoneCard';
import { useConversations } from '@/stores/conversations';
import { useAttention } from '@/lib/attention';

const show = () => render(
  <MemoryRouter initialEntries={['/chat']}>
    <Routes>
      <Route path="/chat" element={<ConnectPhoneCard />} />
      <Route path="/settings" element={<p>Accounts page</p>} />
    </Routes>
  </MemoryRouter>,
);

describe('ConnectPhoneCard', () => {
  beforeEach(() => {
    localStorage.clear();
    state.refresh.mockClear();
    state.phone = { via: null, tested: false };
    useConversations.setState({ list: [{ id: 'c1' }] as never });
    useAttention.setState({ waiting: [], holder: null, startup: false, wizard: false });
  });

  it('offers WhatsApp after a first conversation when no messenger is connected', async () => {
    show();
    expect(await screen.findByText('Get my messages on WhatsApp')).toBeInTheDocument();
    expect(screen.getByText(/Keep this computer on and Cinderpaw open/)).toBeInTheDocument();
  });

  it('waits for a first conversation', async () => {
    useConversations.setState({ list: [] });
    const { container } = show();
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it('stays hidden while the engine has not said where tasks go, and asks it', async () => {
    state.phone = null;
    const { container } = show();
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it('stays hidden when a messenger is already connected', async () => {
    state.phone = { via: 'telegram', tested: false };
    const { container } = show();
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('Not now closes it for good', async () => {
    const first = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    useAttention.setState({ waiting: [], holder: null });
    const again = show();
    await new Promise((r) => setTimeout(r, 0));
    expect(again.container).toBeEmptyDOMElement();
  });

  it('Connect WhatsApp opens Accounts and does not come back', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect WhatsApp' }));
    expect(await screen.findByText('Accounts page')).toBeInTheDocument();
    expect(localStorage.getItem('cinderpaw.phoneNotice.done')).toBe('1');
  });
});
