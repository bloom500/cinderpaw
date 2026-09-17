import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { events, type StreamProgressEvent } from '@/lib/tauri';
import { useChat, type AgentPhase } from '@/stores/chat';
import { useModel } from '@/stores/model';
import { StreamingIndicator } from '../StreamingIndicator';

let emitLocal: (event: StreamProgressEvent) => void;
let emitAgent: (event: StreamProgressEvent) => void;
const progress = (patch: Partial<StreamProgressEvent> = {}): StreamProgressEvent => ({
  sessionId: 'active', phase: 'generating', elapsedMs: 1200,
  promptTokens: 100, tokensGenerated: 24, tokensPerSec: 20, ...patch,
});
const settle = () => act(() => vi.advanceTimersByTime(120));

beforeEach(() => {
  vi.useFakeTimers();
  useChat.setState({ sessionId: 'active' });
  useModel.setState({ isLoading: false, loadProgress: null });
  vi.spyOn(events.streamProgressEvent, 'listen').mockImplementation((cb) => {
    emitLocal = (payload) => cb({ payload } as Parameters<typeof cb>[0]);
    return Promise.resolve(vi.fn());
  });
  vi.spyOn(events.onStreamProgress, 'listen').mockImplementation((cb) => {
    emitAgent = cb;
    return Promise.resolve(vi.fn());
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('StreamingIndicator', () => {
  it.each([
    ['reading', 'Reading…'], ['searching', 'Searching…'],
    ['building', 'Building…'], ['writing', 'Writing…'],
  ] as Array<[AgentPhase, string]>)('names the %s phase', (phase, label) => {
    render(<StreamingIndicator phase={phase} />);
    settle();
    expect(screen.getByRole('status')).toHaveTextContent(label);
  });

  it('ignores other sessions on both progress channels and resets when switching chats', () => {
    render(<StreamingIndicator />);
    settle();
    act(() => { emitLocal(progress({ sessionId: 'other' })); emitAgent(progress({ sessionId: 'other' })); });
    expect(screen.queryByText(/20.0 tok\/s/)).not.toBeInTheDocument();
    act(() => emitLocal(progress()));
    expect(screen.getByText(/20.0 tok\/s/)).toBeInTheDocument();
    act(() => useChat.setState({ sessionId: 'next' }));
    settle();
    expect(screen.queryByText(/20.0 tok\/s/)).not.toBeInTheDocument();
    act(() => emitAgent(progress({ sessionId: 'next', tokensPerSec: 12 })));
    expect(screen.getByText(/12.0 tok\/s/)).toBeInTheDocument();
  });

  it('does not reuse inference telemetry after a tool call', () => {
    const { rerender } = render(<StreamingIndicator />);
    act(() => emitAgent(progress()));
    rerender(<StreamingIndicator phase="calling" tool="read_file" />);
    settle();
    expect(screen.getByText('Calling read file…')).toBeInTheDocument();
    act(() => emitAgent(progress({ tokensPerSec: 99 })));
    rerender(<StreamingIndicator phase="thinking" />);
    settle();
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument();
  });

  it('omits invalid durations and rates while retaining valid progress', () => {
    render(<StreamingIndicator />);
    settle();
    act(() => emitLocal(progress({ tokensPerSec: Infinity })));
    expect(screen.getByText('Generating…')).toBeInTheDocument();
    act(() => emitLocal(progress({ phase: 'prefill', elapsedMs: NaN })));
    expect(screen.getByText('Prefill…')).toBeInTheDocument();
    act(() => emitLocal(progress({ phase: 'prefill', elapsedMs: -1000 })));
    expect(screen.getByText('Prefill…')).toBeInTheDocument();
    act(() => emitLocal(progress({ phase: 'prefill', elapsedMs: 65000 })));
    expect(screen.getByText('Prefill · 1m 5s')).toBeInTheDocument();
  });

  it('restarts the slow-response grace period for a different chat', () => {
    render(<StreamingIndicator />);
    act(() => vi.advanceTimersByTime(5000));
    settle();
    expect(screen.getByText(/first response after loading a model/)).toBeInTheDocument();
    act(() => useChat.setState({ sessionId: 'next' }));
    settle();
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
  });

  it('releases listeners that finish registering after unmount', async () => {
    let resolveLocal!: (unlisten: () => void) => void;
    let resolveAgent!: (unlisten: () => void) => void;
    vi.mocked(events.streamProgressEvent.listen).mockReturnValue(new Promise((resolve) => { resolveLocal = resolve; }));
    vi.mocked(events.onStreamProgress.listen).mockReturnValue(new Promise((resolve) => { resolveAgent = resolve; }));
    const local = vi.fn();
    const agent = vi.fn();
    const { unmount } = render(<StreamingIndicator />);
    unmount();
    await act(async () => { resolveLocal(local); resolveAgent(agent); });
    expect(local).toHaveBeenCalledTimes(1);
    expect(agent).toHaveBeenCalledTimes(1);
  });
});
