import { afterEach, describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoworkTranscriptPanel } from '../CoworkTranscriptPanel';
import { useConversations } from '@/stores/conversations';
import { useChat } from '@/stores/chat';
import { useCoworkTranscript, type CoworkExchange } from '@/stores/coworkTranscript';

function setThread(id: string) {
  useConversations.setState({ currentId: id });
}

function exchange(overrides: Partial<CoworkExchange>): CoworkExchange {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    threadId: 't1',
    kind: 'message',
    fromAgentId: 'alice',
    toAgentId: 'bob',
    requestText: 'count the files',
    responseText: null,
    status: 'running',
    at: new Date(2026, 7, 25, 14, 30).getTime(),
    ...overrides,
  };
}

afterEach(() => {
  useCoworkTranscript.setState({ exchanges: [] });
  localStorage.removeItem('cowork-panel-collapsed');
  useConversations.setState({ currentId: null });
  useChat.setState({ sessionId: 'test-session' });
});

describe('CoworkTranscriptPanel', () => {
  test('renders NOTHING with zero cowork traffic (fresh-install discipline)', () => {
    const { container } = render(<CoworkTranscriptPanel />);
    expect(container.firstChild).toBeNull();
  });

  test('renders a live exchange with both sides of the conversation', () => {
    setThread('t1');
    useCoworkTranscript.setState({
      exchanges: [
        exchange({
          id: 'msg:m1',
          responseText: 'done — 42 files',
          status: 'done',
        }),
      ],
    });
    render(<CoworkTranscriptPanel />);
    expect(screen.getByTestId('cowork-transcript-panel')).toBeInTheDocument();
    expect(screen.getByText('count the files')).toBeInTheDocument();
    expect(screen.getByText('done — 42 files')).toBeInTheDocument();
    // Status is done ⇒ the header dot reads idle, not pulsing.
    expect(screen.queryByTitle('working')).toBeNull();
  });

  test('a running exchange pulses the live dot', () => {
    setThread('t1');
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'live', status: 'running', requestText: 'working…', responseText: null })] });
    render(<CoworkTranscriptPanel />);
    expect(screen.getByTitle('working')).toBeInTheDocument();
  });

  test('shows an idle dot when nothing is running', () => {
    setThread('t1');
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'x', status: 'done', responseText: 'ok' })] });
    render(<CoworkTranscriptPanel />);
    expect(screen.queryByTitle('working')).toBeNull();
  });

  test('collapse toggle hides the transcript list and persists its state', async () => {
    setThread('t1');
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'y' })] });
    const { unmount } = render(<CoworkTranscriptPanel />);
    await userEvent.click(screen.getByTestId('cowork-transcript-panel').querySelector('button')!);
    expect(screen.queryByText('count the files')).toBeNull();
    expect(localStorage.getItem('cowork-panel-collapsed')).toBe('1');
    unmount();

    // A remount honours the persisted collapsed state.
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'z', requestText: 'again' })] });
    render(<CoworkTranscriptPanel />);
    expect(screen.queryByText('again')).toBeNull();

    await userEvent.click(screen.getByTestId('cowork-bubble'));
    expect(localStorage.getItem('cowork-panel-collapsed')).toBe('0');
  });

  test('approval exchanges show their class badge and human target', () => {
    setThread('t1');
    useCoworkTranscript.setState({
      exchanges: [
        exchange({
          id: 'approval:r1',
          kind: 'approval',
          fromAgentId: 'bob',
          toAgentId: 'human',
          requestText: 'rm -rf dist/',
          approvalClass: 'delete',
          status: 'running',
          responseText: null,
        }),
      ],
    });
    render(<CoworkTranscriptPanel />);
    expect(screen.getByText('delete')).toBeInTheDocument();
    expect(screen.getByText(/needs your approval/)).toBeInTheDocument();
    // The class alone is not a decision: a person asked to approve "a delete"
    // has to be shown WHICH one, or the gate is theatre.
    expect(screen.getByText('rm -rf dist/')).toBeInTheDocument();
  });
});
