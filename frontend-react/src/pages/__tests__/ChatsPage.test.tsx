import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatsPage } from '../ChatsPage';
import { useConversations } from '@/stores/conversations';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

const mount = () => render(<MemoryRouter><ChatsPage /></MemoryRouter>);

beforeEach(() => {
  useConversations.setState({ list: [], loaded: false, currentId: null, streamingIds: {} } as never);
});

describe('ChatsPage', () => {
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
    expect(screen.getByText('Open one').closest('div')?.className).toBeDefined();
  });
});
