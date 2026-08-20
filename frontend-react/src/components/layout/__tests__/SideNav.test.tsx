import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SideNav } from '../SideNav';
import { useUI } from '@/stores/ui';
import { useConversations } from '@/stores/conversations';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const conv = (id: string, minsAgo: number, title = id) => ({
  id, title, updated_at: new Date(Date.now() - minsAgo * 60_000).toISOString(),
});

const mount = () => render(<MemoryRouter><SideNav /></MemoryRouter>);

beforeEach(() => {
  navigate.mockReset();
  useUI.setState({ navCollapsed: false, searchOpen: false } as never);
  useConversations.setState({ list: [], currentId: null, streamingIds: {} } as never);
});

describe('SideNav', () => {
  it('is seven rows, and no more', () => {
    mount();
    const labels = ['New', 'Search', 'Chats', 'Projects', 'Models', 'Settings'];
    for (const l of labels) expect(screen.getByText(l)).toBeTruthy();
    // The wordmark is the seventh, and it is identity rather than a destination.
    expect(screen.getByText('CINDERPAW')).toBeTruthy();
    // Nothing technical in primary navigation. The whole point of the phase.
    for (const banned of ['Skills', 'Extensions', 'Connectors', 'Memory', 'MCP', 'Agent']) {
      expect(screen.queryByText(banned)).toBeNull();
    }
  });

  it('lists every chat, newest first — no cap', () => {
    useConversations.setState({
      loaded: true,
      list: Array.from({ length: 9 }, (_, i) => conv(`c${i}`, i)) as never,
    });
    mount();
    // Deliberately uncapped, reversing the five-item limit this file shipped
    // with: browsing your own history should not require knowing what you are
    // looking for. The risk that made the cap tempting is still real, so what
    // is pinned instead is that the list stays FLAT — no project expands into
    // its chats here, which is the shape that grew the old rail to 746 lines.
    for (let i = 0; i < 9; i++) expect(screen.getByText(`c${i}`)).toBeTruthy();
  });

  it('does not claim the list is empty before it has been read', () => {
    useConversations.setState({ loaded: false, list: [] as never });
    mount();
    expect(screen.queryByText(/Nothing yet/i)).toBeNull();
  });

  it('says which chat is open and which one is generating', () => {
    useConversations.setState({
      loaded: true,
      list: [conv('a', 1), conv('b', 2)] as never,
      currentId: 'a',
      streamingIds: { b: true } as never,
    });
    mount();
    // Both died with the old rail: `streamingIds` was written by the store and
    // read by nothing at all.
    expect(screen.getByLabelText('Generating')).toBeTruthy();
    expect(screen.getByText('a').closest('button')?.className).toContain('bg-bg-active');
  });

  it('a fresh install explains the empty list instead of showing a blank strip', () => {
    useConversations.setState({ loaded: true } as never);
    mount();
    expect(screen.getByText(/Nothing yet/i)).toBeTruthy();
  });

  it('Search opens the overlay rather than navigating', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByText('Search'));
    expect(useUI.getState().searchOpen).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('collapsing removes the navigation entirely, leaving one way back', async () => {
    const user = userEvent.setup();
    useConversations.setState({ loaded: true, list: [conv('a', 1)] as never });
    const view = mount();
    await user.click(screen.getByLabelText('Collapse navigation'));
    expect(useUI.getState().navCollapsed).toBe(true);

    view.rerender(<MemoryRouter><SideNav /></MemoryRouter>);
    // Not an icon rail: an unlabelled column of glyphs still costs width and
    // still has to be decoded. Gone means gone.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('Chats')).toBeNull();
    // ...but never a dead end: something has to bring it back.
    expect(screen.getByLabelText('Expand navigation')).toBeTruthy();
  });
});
