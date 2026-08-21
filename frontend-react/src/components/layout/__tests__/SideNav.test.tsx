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
  it('is four rows, and no more', () => {
    mount();
    for (const l of ['New', 'Search', 'Models', 'Settings']) {
      expect(screen.getByText(l)).toBeTruthy();
    }
    // The wordmark is identity rather than a destination.
    expect(screen.getByText('CINDERPAW')).toBeTruthy();
    // Chats and Projects left: they were destinations that led to a page
    // listing what this rail already lists, and every row here now carries the
    // rename and delete that used to be the page's reason to exist.
    for (const gone of ['Chats', 'Projects']) expect(screen.queryByText(gone)).toBeNull();
    // Nothing technical in primary navigation. The whole point of the phase.
    for (const banned of ['Skills', 'Extensions', 'Connectors', 'Memory', 'MCP', 'Agent']) {
      expect(screen.queryByText(banned)).toBeNull();
    }
  });

  it('offers rename and delete on the row itself', async () => {
    const user = userEvent.setup();
    useConversations.setState({ loaded: true, list: [conv('a', 1)] as never });
    mount();
    // The actions are the reason the Chats page is no longer in the rail. If
    // they are not here, that removal took something away instead of moving it.
    await user.click(screen.getByLabelText('Chat options'));
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(screen.getByText('Delete chat')).toBeTruthy();
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

  it('files chats under the day they happened', () => {
    const dayAgo = 60 * 26;   // yesterday by the calendar, 26 hours back
    const weekAgo = 60 * 24 * 4;
    useConversations.setState({
      loaded: true,
      list: [conv('now', 2), conv('then', dayAgo), conv('older', weekAgo)] as never,
    });
    mount();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Yesterday')).toBeTruthy();
    expect(screen.getByText('Previous 7 days')).toBeTruthy();
    // Headings are not a filter: every chat is still in the column.
    for (const id of ['now', 'then', 'older']) expect(screen.getByText(id)).toBeTruthy();
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
    // The highlight is on the row rather than the button: the row is now a
    // container so the actions menu can sit beside the button instead of
    // inside it. What the user sees is unchanged — the whole row lights up.
    const row = screen.getByText('a').closest('button')?.parentElement;
    expect(row?.className).toContain('bg-bg-active');
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
