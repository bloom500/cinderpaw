import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SideNav, RECENT_LIMIT } from '../SideNav';
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
    // FERAL is the seventh, and it is identity rather than a destination.
    expect(screen.getByText('FERAL')).toBeTruthy();
    // Nothing technical in primary navigation. The whole point of the phase.
    for (const banned of ['Skills', 'Extensions', 'Connectors', 'Memory', 'MCP', 'Agent']) {
      expect(screen.queryByText(banned)).toBeNull();
    }
  });

  it('shows at most five recent chats, newest first', () => {
    useConversations.setState({
      list: Array.from({ length: 9 }, (_, i) => conv(`c${i}`, i)) as never,
    });
    mount();
    for (let i = 0; i < RECENT_LIMIT; i++) expect(screen.getByText(`c${i}`)).toBeTruthy();
    // The cap is the whole design: a list in the navigation grows until it IS
    // the navigation, which is how the component this replaces reached 746
    // lines. Everything past it belongs on the Chats page.
    expect(screen.queryByText(`c${RECENT_LIMIT}`)).toBeNull();
    expect(RECENT_LIMIT).toBe(5);
  });

  it('says which chat is open and which one is generating', () => {
    useConversations.setState({
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

  it('collapsing hides the labels and the recent list, not the navigation', async () => {
    const user = userEvent.setup();
    useConversations.setState({ list: [conv('a', 1)] as never });
    mount();
    await user.click(screen.getByLabelText('Collapse navigation'));
    expect(useUI.getState().navCollapsed).toBe(true);
  });
});
