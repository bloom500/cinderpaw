import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoworkTranscriptPanel, toMessages } from '../CoworkTranscriptPanel';
import { useCoworkTranscript, type CoworkExchange } from '@/stores/coworkTranscript';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  tauri: {
    cinderpawAgent: {
      coworkSendMessage: vi.fn().mockResolvedValue(undefined),
      coworkStop: vi.fn().mockResolvedValue(undefined),
      // The panel asks for a thread's history on mount. Absent from this mock,
      // the call threw synchronously — before the component's own `.catch`
      // could see it — and took every test in the file down with it.
      coworkHistory: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

/**
 * The panel is a group chat, not a list of exchange cards, so these pin what a
 * chat has to get right: who spoke, in what order, whose name shows, and
 * whether anyone is still typing. The behavioural guarantees from the card
 * version — self-hiding on a fresh install, collapse persistence, both halves
 * of an exchange visible — are unchanged and still asserted here.
 */

function exchange(overrides: Partial<CoworkExchange>): CoworkExchange {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    threadId: 't1',
    kind: 'message',
    fromAgentId: 'human',
    toAgentId: 'demo-agent-atlas',
    toName: 'Atlas',
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
  // Without this a "was not called" assertion passes or fails depending on
  // what the previous test did — the exact way a negative assertion rots.
  vi.clearAllMocks();
});

describe('toMessages — exchanges flattened into a conversation', () => {
  test('a request and its reply become two messages, in that order', () => {
    const msgs = toMessages([
      exchange({ id: 'm1', responseText: 'done — 42 files', status: 'done' }),
    ]);
    expect(msgs.map((m) => m.text)).toEqual(['count the files', 'done — 42 files']);
    expect(msgs.map((m) => m.authorId)).toEqual(['human', 'demo-agent-atlas']);
  });

  test('the human sits on the right, agents on the left — same as the app chat', () => {
    const msgs = toMessages([
      exchange({ id: 'm1', responseText: 'ok', status: 'done' }),
    ]);
    expect(msgs[0]?.side).toBe('right');
    expect(msgs[1]?.side).toBe('left');
  });

  test('an unanswered request is one message, not an empty reply bubble', () => {
    expect(toMessages([exchange({ id: 'm1' })])).toHaveLength(1);
  });

  test('approvals are not chat messages — they get their own row', () => {
    const msgs = toMessages([
      exchange({ id: 'a1', kind: 'approval', requestText: 'rm -rf dist/' }),
    ]);
    expect(msgs).toEqual([]);
  });

  test('a failed reply is marked so the bubble can show it', () => {
    const msgs = toMessages([
      exchange({ id: 'm1', responseText: 'model unreachable', status: 'error' }),
    ]);
    expect(msgs[1]?.failed).toBe(true);
  });
});

describe('CoworkTranscriptPanel', () => {
  test('renders NOTHING with zero cowork traffic (fresh-install discipline)', () => {
    const { container } = render(<CoworkTranscriptPanel />);
    expect(container.firstChild).toBeNull();
  });

  test('renders both sides of the conversation', () => {
    useCoworkTranscript.setState({
      exchanges: [exchange({ id: 'msg:m1', responseText: 'done — 42 files', status: 'done' })],
    });
    render(<CoworkTranscriptPanel />);
    expect(screen.getByTestId('cowork-transcript-panel')).toBeInTheDocument();
    expect(screen.getByText('count the files')).toBeInTheDocument();
    expect(screen.getByText('done — 42 files')).toBeInTheDocument();
  });

  test('speakers are named from the roster, never by raw id', () => {
    // The whole point of carrying agentName through the event: a person must
    // not have to read "demo-agent-atlas" to find out who answered.
    useCoworkTranscript.setState({
      exchanges: [exchange({ id: 'm1', responseText: 'done', status: 'done' })],
    });
    render(<CoworkTranscriptPanel />);
    expect(screen.getAllByText('Atlas').length).toBeGreaterThan(0);
    expect(screen.queryByText('demo-agent-atlas')).toBeNull();
  });

  test('an id with no roster name still renders, trimmed', () => {
    useCoworkTranscript.setState({
      exchanges: [
        exchange({ id: 'm1', toAgentId: 'stranger', toName: undefined, responseText: 'hi', status: 'done' }),
      ],
    });
    render(<CoworkTranscriptPanel />);
    expect(screen.getAllByText('stranger').length).toBeGreaterThan(0);
  });

  test('a working agent shows a typing row that names them', () => {
    useCoworkTranscript.setState({
      exchanges: [exchange({ id: 'live', status: 'running', responseText: null })],
    });
    render(<CoworkTranscriptPanel />);
    expect(screen.getByText(/Atlas is working/)).toBeInTheDocument();
  });

  test('no typing row once the reply has landed', () => {
    useCoworkTranscript.setState({
      exchanges: [exchange({ id: 'x', status: 'done', responseText: 'ok' })],
    });
    render(<CoworkTranscriptPanel />);
    expect(screen.queryByText(/is working/)).toBeNull();
  });

  test('collapse toggle hides the transcript and persists its state', async () => {
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'y' })] });
    const { unmount } = render(<CoworkTranscriptPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Collapse cowork transcript/ }));
    expect(screen.queryByText('count the files')).toBeNull();
    expect(localStorage.getItem('cowork-panel-collapsed')).toBe('1');
    unmount();

    // A remount honours the persisted collapsed state.
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'z', requestText: 'again' })] });
    render(<CoworkTranscriptPanel />);
    expect(screen.queryByText('again')).toBeNull();

    // Collapsed, the control is the bubble — named for what it does, not for
    // who is in the conversation. Querying it by a participant's name is what
    // made this assertion depend on the panel's visual state.
    await userEvent.click(screen.getByRole('button', { name: /Open cowork transcript/ }));
    expect(localStorage.getItem('cowork-panel-collapsed')).toBe('0');
  });

  test('a blocked storage read does not take the panel down', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    try {
      useCoworkTranscript.setState({ exchanges: [exchange({ id: 'q' })] });
      render(<CoworkTranscriptPanel />);
      expect(screen.getByTestId('cowork-transcript-panel')).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  test('an approval is a system row, with its class and who is asking', () => {
    useCoworkTranscript.setState({
      exchanges: [
        exchange({
          id: 'approval:r1',
          kind: 'approval',
          fromAgentId: 'demo-agent-bolt',
          fromName: 'Bolt',
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
    expect(screen.getByText(/Bolt needs your approval/)).toBeInTheDocument();
  });
});

describe('talking to a teammate directly', () => {
  test('sends to the teammate who spoke last, in the same thread', async () => {
    useCoworkTranscript.setState({
      exchanges: [exchange({ id: 'm1', responseText: 'done', status: 'done' })],
    });
    render(<CoworkTranscriptPanel />);
    await userEvent.type(screen.getByPlaceholderText(/Message Atlas/), 'thanks');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(tauri.cinderpawAgent.coworkSendMessage).toHaveBeenCalledWith(
      'demo-agent-atlas',
      'thanks',
      't1',
    );
  });

  test('Enter sends; the box empties', async () => {
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'm1' })] });
    render(<CoworkTranscriptPanel />);
    const box = screen.getByPlaceholderText(/Message Atlas/);
    await userEvent.type(box, 'hello{Enter}');
    expect(tauri.cinderpawAgent.coworkSendMessage).toHaveBeenCalled();
    expect((box as HTMLInputElement).value).toBe('');
  });

  test('whitespace is not a message', async () => {
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'm1' })] });
    render(<CoworkTranscriptPanel />);
    await userEvent.type(screen.getByPlaceholderText(/Message Atlas/), '   {Enter}');
    expect(tauri.cinderpawAgent.coworkSendMessage).not.toHaveBeenCalled();
  });

  test('a failed send is reported ON SCREEN, not swallowed', async () => {
    vi.mocked(tauri.cinderpawAgent.coworkSendMessage).mockRejectedValueOnce(
      new Error('cinderpaw-agent is not running'),
    );
    useCoworkTranscript.setState({ exchanges: [exchange({ id: 'm1' })] });
    render(<CoworkTranscriptPanel />);
    await userEvent.type(screen.getByPlaceholderText(/Message Atlas/), 'hi{Enter}');
    expect(await screen.findByText(/cinderpaw-agent is not running/)).toBeInTheDocument();
  });

  test('Stop aborts that teammate, not the whole app', async () => {
    useCoworkTranscript.setState({
      exchanges: [exchange({ id: 'live', status: 'running', responseText: null })],
    });
    render(<CoworkTranscriptPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(tauri.cinderpawAgent.coworkStop).toHaveBeenCalledWith('demo-agent-atlas');
  });
});
