import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import { HeadsUpCard } from '@/components/chat/HeadsUpCard';
import { useChat } from '@/stores/chat';
import { useHeadsUp } from '@/stores/headsUp';

const RESULT = {
  ok: true,
  content: 'Shown to the person',
  data: { headsUp: { id: 'card-1', title: 'The total does not match', detail: 'You said 1,200 lei; the PDF says 1,450.', more: 'Page 2 adds a delivery line.' } },
};

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useHeadsUp.setState({ bySession: {} });
  useChat.setState({ sessionId: 's1' });
});

describe('HeadsUpCard: "Something you should know" above the message box', () => {
  it('shows nothing until the agent sends a card, and only in its own chat', () => {
    const { container } = render(<HeadsUpCard />);
    expect(container).toBeEmptyDOMElement();
    useHeadsUp.getState().show('another-chat', RESULT);
    expect(screen.queryByText('The total does not match')).toBeNull();
  });

  it('Learn more opens the evidence in place; the card stays', () => {
    useHeadsUp.getState().show('s1', RESULT);
    render(<HeadsUpCard />);
    expect(screen.getByRole('region', { name: 'Something you should know' })).toBeInTheDocument();
    expect(screen.getByText('The total does not match')).toBeInTheDocument();
    expect(screen.queryByText(/delivery line/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Learn more' }));
    expect(screen.getByText(/delivery line/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('cinderpaw_heads_up_answer', { sessionId: 's1', headsUpId: 'card-1', choice: 'more' });
  });

  it('"I already knew this" tells the agent and closes the card', () => {
    useHeadsUp.getState().show('s1', RESULT);
    render(<HeadsUpCard />);
    fireEvent.click(screen.getByRole('button', { name: 'I already knew this' }));
    expect(invoke).toHaveBeenCalledWith('cinderpaw_heads_up_answer', { sessionId: 's1', headsUpId: 'card-1', choice: 'knew' });
    expect(screen.queryByText('The total does not match')).toBeNull();
  });

  it('keys 1, 2, 3 answer the card, but never while typing in a field', () => {
    useHeadsUp.getState().show('s1', RESULT);
    render(<><textarea aria-label="composer" /><HeadsUpCard /></>);
    fireEvent.keyDown(screen.getByLabelText('composer'), { key: '2' });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: '1' });
    expect(screen.getByText(/delivery line/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: '3' });
    expect(invoke).toHaveBeenLastCalledWith('cinderpaw_heads_up_answer', { sessionId: 's1', headsUpId: 'card-1', choice: 'dismiss' });
    expect(screen.queryByText('The total does not match')).toBeNull();
  });

  it('a card with no evidence has no Learn more', () => {
    useHeadsUp.getState().show('s1', { data: { headsUp: { id: 'c2', title: 'Heads up', detail: 'Short.' } } });
    render(<HeadsUpCard />);
    expect(screen.queryByRole('button', { name: 'Learn more' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Dismiss' }).length).toBeGreaterThan(0);
  });
});
