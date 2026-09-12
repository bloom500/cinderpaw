import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatsPage } from '../ChatsPage';
import { useConversations } from '@/stores/conversations';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const mount = () => render(<MemoryRouter><ChatsPage /></MemoryRouter>);

beforeEach(() => {
  navigate.mockClear();
  useConversations.setState({ list: [], loaded: false, currentId: null, streamingIds: {} } as never);
});

describe('ChatsPage', () => {
  it('filters titles ignoring case and surrounding spaces, and clears with Escape', () => {
    useConversations.setState({ loaded: true, list: [
      { id: 'a', title: 'Weekend plans', updated_at: new Date().toISOString() },
      { id: 'b', title: 'Work notes', updated_at: new Date().toISOString() },
    ] as never });
    mount();
    const search = screen.getByRole('searchbox', { name: 'Filter conversations by title' });
    fireEvent.change(search, { target: { value: '  WEEKEND  ' } });
    expect(screen.getByText('Weekend plans')).toBeTruthy();
    expect(screen.queryByText('Work notes')).toBeNull();
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No matching conversations.')).toBeTruthy();
    expect(screen.queryByText(/No conversations yet/)).toBeNull();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.getByText('Work notes')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(screen.getByText('Weekend plans')).toBeTruthy();
    expect(search).toHaveFocus();
  });

  it('starts a fresh conversation from the empty list', () => {
    useConversations.setState({ loaded: true, currentId: 'old-chat' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(useConversations.getState().currentId).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/chat');
  });

  it('does not claim you have no chats before it has looked', () => {
    mount();
    // `list` starts as [], so "empty" and "not read yet" are the same value.
    // Telling someone with hundreds of conversations that they have none, for
    // as long as the disk takes, is worse than saying nothing.
    expect(screen.queryByText(/No conversations yet/i)).toBeNull();
  });

  it('says it is empty once the read has come back empty', () => {
    useConversations.setState({ loaded: true } as never);
    mount();
    expect(screen.getByText(/No conversations yet/i)).toBeTruthy();
  });

  it('marks the open chat and the generating one', () => {
    useConversations.setState({
      loaded: true,
      list: [
        { id: 'a', title: 'Open one', updated_at: new Date().toISOString() },
        { id: 'b', title: 'Busy one', updated_at: new Date(Date.now() - 60_000).toISOString() },
      ] as never,
      currentId: 'a',
      streamingIds: { b: true } as never,
    });
    mount();
    expect(screen.getByLabelText('Generating')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open one/ })).toHaveAttribute('aria-current', 'page');
  });
});
