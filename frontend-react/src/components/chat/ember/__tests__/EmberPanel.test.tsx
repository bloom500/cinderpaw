import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EmberPanel, READY_TIMEOUT_MS } from '../EmberPanel';
import type { EmberRun } from '../useEmberRun';
import { useChat, type ToolCallEvent } from '@/stores/chat';
import { useUI } from '@/stores/ui';

const runOf = (over: Partial<EmberRun> = {}): EmberRun => ({
  offered: false, open: true, round: { since: 0, ended: null }, openPanel: vi.fn(), closePanel: vi.fn(), ...over,
});
const frame = () => screen.getByTitle("Cinderpaw's campfire") as HTMLIFrameElement;
function fromGame(msg: object, source: MessageEventSource | null = frame().contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg), source, origin: window.location.origin }));
  });
}
const tool = (id: string, name: string): ToolCallEvent => ({
  id, kind: 'tool', name, emoji: '', mainArg: null, status: 'running', startedAt: 10, endedAt: null,
});

describe('EmberPanel', () => {
  beforeEach(() => {
    useChat.setState({ toolCallStream: [] });
    useUI.setState({ emberBest: 17 });
  });
  afterEach(() => vi.useRealTimers());

  it('shows nothing without a round', () => {
    const { container } = render(<EmberPanel run={runOf({ round: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('loads the game and starts it with the best score once it is ready', () => {
    render(<EmberPanel run={runOf()} />);
    expect(frame().getAttribute('src')).toBe('/games/ember/index.html');
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');
    fromGame({ type: 'ready' });
    expect(post).toHaveBeenCalledWith(JSON.stringify({ type: 'start', best: 17 }), window.location.origin);
  });

  it('throws a spark for each new tool call', () => {
    render(<EmberPanel run={runOf()} />);
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');
    fromGame({ type: 'ready' });
    act(() => useChat.setState({ toolCallStream: [tool('a', 'web_search')] }));
    expect(post).toHaveBeenCalledWith(JSON.stringify({ type: 'spark', kind: 'search' }), window.location.origin);
  });

  it('says so on screen when the engine never starts', () => {
    vi.useFakeTimers();
    render(<EmberPanel run={runOf()} />);
    act(() => { vi.advanceTimersByTime(READY_TIMEOUT_MS); });
    expect(screen.getByRole('alert')).toHaveTextContent("didn't start");
  });

  it("closes on Escape outside the game and on the game's own close", () => {
    const run = runOf();
    const onClosed = vi.fn();
    render(<EmberPanel run={run} onClosed={onClosed} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /close the game/i }), { key: 'Escape' });
    expect(run.closePanel).toHaveBeenCalledTimes(1);
    fromGame({ type: 'close' });
    expect(run.closePanel).toHaveBeenCalledTimes(2);
    expect(onClosed).toHaveBeenCalledTimes(2);
  });

  it('records the final score', () => {
    render(<EmberPanel run={runOf({ round: { since: 0, ended: { ok: true } } })} />);
    fromGame({ type: 'ready' });
    fromGame({ type: 'score', value: 40 });
    expect(useUI.getState().emberBest).toBe(40);
  });

  it('ignores messages that do not come from its own game', () => {
    const run = runOf();
    render(<EmberPanel run={run} />);
    fromGame({ type: 'close' }, window);
    expect(run.closePanel).not.toHaveBeenCalled();
  });

  it('lets a finished round go when its panel is closed', () => {
    const run = runOf({ open: false, round: { since: 0, ended: { ok: true } } });
    render(<EmberPanel run={run} />);
    expect(run.closePanel).toHaveBeenCalled();
  });
});
