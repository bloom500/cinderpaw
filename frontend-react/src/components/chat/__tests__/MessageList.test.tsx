import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open } from '@tauri-apps/plugin-shell';
import { events } from '@/lib/tauri/events';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { MessageList } from '../MessageList';
import { CallToolScreen } from '../CallToolScreen';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../MessageItem', () => ({ MessageItem: ({ message }: { message: { content: string } }) => <p>{message.content}</p> }));
vi.mock('../StreamingIndicator', () => ({ StreamingIndicator: () => <span>Thinking…</span> }));

let emit: (line: unknown) => void;
beforeEach(() => {
  vi.useFakeTimers();
  useUI.setState({ inputMode: 'agent', language: 'en' });
  useChat.setState({ sessionId: 'chat', streamStatus: 'streaming', agentPhase: 'calling', agentTool: 'web_search', messages: [
    { id: 'reply', role: 'assistant', content: 'Let me check.', thinking: 'Checking sources', thinkingComplete: false, createdAt: Date.now() },
  ] });
  vi.spyOn(events.cinderpawAgentOutputEvent, 'listen').mockImplementation((cb) => {
    emit = (line) => cb({ payload: { data: JSON.stringify(line) } } as Parameters<typeof cb>[0]);
    return Promise.resolve(vi.fn());
  });
  vi.spyOn(events.liveStatusEvent, 'listen').mockResolvedValue(vi.fn());
  vi.spyOn(events.liveKitEvent, 'listen').mockResolvedValue(vi.fn());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('chat tool widgets', () => {
  it('renders the real call widget after prose/reasoning, with progress and clickable results', () => {
    render(<MessageList />);
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();
    act(() => emit({ type: 'tool_start', sessionId: 'chat', tool: 'web_search', args: { query: 'Cinderpaw guide' } }));
    expect(screen.getByText('Let me check.')).toBeInTheDocument();
    expect(screen.getByText('Cinderpaw guide')).toBeInTheDocument();
    const details = screen.getByText('Tools').closest('details');
    expect(details).toHaveAttribute('open');
    fireEvent.click(screen.getByText('Tools'));
    expect(details).not.toHaveAttribute('open');
    act(() => emit({ type: 'tool_progress', sessionId: 'chat', tool: 'web_search', message: 'Reading sources' }));
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Tools'));
    expect(screen.getByText('Reading sources')).toBeInTheDocument();
    act(() => emit({ type: 'tool_done', sessionId: 'chat', tool: 'web_search', result: {
      ok: true, data: [{ text: 'Guide — setup instructions', url: 'https://example.com/guide' }],
    } }));
    act(() => { useChat.setState({ streamStatus: 'done' }); vi.advanceTimersByTime(10000); });
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    expect(open).toHaveBeenCalledWith('https://example.com/guide');
    expect(screen.getByText('Guide')).toBeInTheDocument();
  });

  it('keeps the viewport position when tool events arrive while reading older messages', () => {
    const { container } = render(<MessageList />);
    const scroller = container.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, { scrollHeight: { value: 2000 }, clientHeight: { value: 600 } });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    act(() => emit({ type: 'tool_start', sessionId: 'chat', tool: 'read_file', args: { path: 'guide.txt' } }));
    expect(scroller.scrollTop).toBe(100);
  });

  it('shows command output, file facts and failures without mixing sessions', () => {
    render(<MessageList />);
    act(() => {
      emit({ type: 'tool_start', sessionId: 'other', tool: 'shell_exec', args: { command: 'secret command' } });
      emit({ type: 'tool_start', sessionId: 'chat', tool: 'shell_exec', args: { command: 'bun test', cwd: 'D:/project' } });
      emit({ type: 'tool_done', sessionId: 'chat', tool: 'shell_exec', result: { ok: true, content: '42 tests passed' } });
      emit({ type: 'tool_start', sessionId: 'chat', tool: 'read_file', args: { path: 'notes.txt' } });
      emit({ type: 'tool_done', sessionId: 'chat', tool: 'read_file', result: { ok: true, data: { path: 'notes.txt', lines: 5, bytes: 100 } } });
      emit({ type: 'tool_start', sessionId: 'chat', tool: 'recall', args: { query: 'project notes' } });
      emit({ type: 'tool_done', sessionId: 'chat', tool: 'recall', result: { ok: false, content: 'Memory unavailable' } });
    });
    expect(screen.queryByText('secret command')).not.toBeInTheDocument();
    expect(screen.getByText('bun test')).toBeInTheDocument();
    expect(screen.getByText('42 tests passed')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('Memory unavailable')).toBeInTheDocument();
    act(() => useChat.setState({ sessionId: 'other' }));
    expect(screen.queryByText('bun test')).not.toBeInTheDocument();
  });

  it('does not subscribe to agent widgets in plain chat mode', () => {
    useUI.setState({ inputMode: 'chat' });
    render(<MessageList />);
    expect(events.cinderpawAgentOutputEvent.listen).not.toHaveBeenCalled();
  });

  it('keeps the voice layout as the default', () => {
    const { container } = render(<CallToolScreen activity={[{
      id: 'voice', tool: 'recall', kind: 'memory', subject: 'notes', status: 'done', startedAt: 0, endedAt: 1000,
      note: null, hits: [], files: [], output: '', cwd: '', facts: ['Remembered fact'], error: null,
    }]} />);
    expect(container.firstChild).toHaveClass('absolute');
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText('Remembered fact')).toBeInTheDocument();
  });
});
