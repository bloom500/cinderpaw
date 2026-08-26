import { afterEach, describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoworkTranscriptPanel } from '../CoworkTranscriptPanel';
import { useCoworkTranscript, type CoworkExchange } from '@/stores/coworkTranscript';

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
});

describe('CoworkTranscriptPanel', () => {
  test('renders NOTHING with zero cowork traffic (fresh-install discipline)', () => {
    const { container } = render(<CoworkTranscriptPanel />);
    expect(container.firstChild).toBeNull();
  });

  test('renders a live exchange with both sides of the conversation', () => {
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
    expect(screen.queryByTitle('agents active')).toBeNull();
    expect(screen.getByTitle('idle')).toBeInTheDocument();
  });

  test('a running exchange pulses the live dot', () => {
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'live', status: 'running', requestText: 'working…', responseText: null })] });
    render(<CoworkTranscriptPanel />);
    expect(screen.getByTitle('agents active')).toBeInTheDocument();
  });

  test('shows an idle dot when nothing is running', () => {
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'x', status: 'done', responseText: 'ok' })] });
    render(<CoworkTranscriptPanel />);
    expect(screen.queryByTitle('agents active')).toBeNull();
    expect(screen.getByTitle('idle')).toBeInTheDocument();
  });

  test('collapse toggle hides the transcript list and persists its state', async () => {
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'y' })] });
    render(<CoworkTranscriptPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Agent Cowork/ }));
    expect(screen.queryByText('count the files')).toBeNull();
    expect(localStorage.getItem('cowork-panel-collapsed')).toBe('1');

    // A remount honours the persisted collapsed state.
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'z', requestText: 'again' })] });
    render(<CoworkTranscriptPanel />);
    expect(screen.queryByText('again')).toBeNull();

    await userEvent.click(screen.getAllByRole('button', { name: /Agent Cowork/ })[0]);
    expect(localStorage.getItem('cowork-panel-collapsed')).toBe('0');
  });

  test('approval exchanges show their class badge and human target', () => {
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
    expect(screen.getByText('rm -rf dist/')).toBeInTheDocument();
  });
});
