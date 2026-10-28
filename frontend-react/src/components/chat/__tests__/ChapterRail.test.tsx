import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { useChat } from '@/stores/chat';
import { ChapterRail } from '../ChapterRail';

const turn = (id: string, role: 'user' | 'assistant', content = id) => ({ id, role, content, createdAt: 1 });

function show() {
  return render(
    <MessageScroller.Provider>
      <MessageScroller.Root className="relative">
        {/* The rail measures against this viewport in the real app too. */}
        <MessageScroller.Viewport aria-label="Conversation" />
        <ChapterRail />
      </MessageScroller.Root>
    </MessageScroller.Provider>,
  );
}

beforeEach(() => {
  useChat.setState({
    streamStatus: 'idle',
    messages: [
      turn('q1', 'user', 'First question about scrollbars'),
      turn('a1', 'assistant', 'An answer'),
      turn('q2', 'user', 'Second question about chapters'),
      turn('a2', 'assistant', 'Another answer'),
      turn('q3', 'user', 'Third question about popups'),
    ],
  });
});
afterEach(() => cleanup());

describe('ChapterRail', () => {
  it('renders one tick per user turn, assistant replies excluded', () => {
    show();
    expect(screen.getByRole('button', { name: /go to message 1/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /go to message 2/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /go to message 3/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /go to message 4/i })).toBeNull();
  });

  it('stays hidden when there is nothing to navigate', () => {
    useChat.setState({ messages: [turn('q1', 'user', 'Only one')] });
    const { container } = show();
    expect(container.textContent).toBe('');
  });

  it('opens the chapter list from the count pill and keeps it open across jumps', () => {
    show();
    expect(screen.queryByRole('dialog', { name: /conversation chapters/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /conversation chapters, 3 turns/i }));
    const dialog = screen.getByRole('dialog', { name: /conversation chapters/i });
    expect(dialog.textContent).toContain('First question about scrollbars');
    expect(dialog.textContent).toContain('Third question about popups');
    // Jumping (scrollToMessage is a no-op in jsdom, must not throw) keeps
    // the list open for the next pick; Esc closes it.
    fireEvent.click(within(dialog).getByRole('button', { name: /second question about chapters/i }));
    expect(screen.getByRole('dialog', { name: /conversation chapters/i })).toBeDefined();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /conversation chapters/i })).toBeNull();
  });

    it('marks the latest turn live before anything is measured', () => {

    show();
    // No layout in jsdom, so no anchor/visibility yet: the last turn reads live.
    expect(screen.getByRole('button', { name: /go to message 3/i }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: /go to message 1/i }).getAttribute('aria-current')).toBe('false');
  });

  it('opens on rail hover and closes shortly after leaving both rail and dialog', () => {
    vi.useFakeTimers();
    try {
      show();
      const rail = screen.getByRole('list', { name: /chapters/i });
      fireEvent.mouseEnter(rail);
      const dialog = screen.getByRole('dialog', { name: /conversation chapters/i });
      // Sliding from the rail into the dialog keeps it open.
      fireEvent.mouseLeave(rail, { relatedTarget: dialog });
      expect(screen.getByRole('dialog', { name: /conversation chapters/i })).toBeDefined();
      // Entering the dialog cancels the pending close: lingering over the
      // rows to pick one must not blink the list away.
      fireEvent.mouseEnter(dialog);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByRole('dialog', { name: /conversation chapters/i })).toBeDefined();
      // Leaving both only schedules the close (travel grace period).
      fireEvent.mouseLeave(dialog, { relatedTarget: document.body });
      expect(screen.getByRole('dialog', { name: /conversation chapters/i })).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByRole('dialog', { name: /conversation chapters/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spaces ticks evenly before the first DOM measure (jsdom has no layout)', () => {
    show();
    const topOf = (n: number) =>
      screen.getByRole('button', { name: new RegExp(`go to message ${n}:`, 'i') }).style.top;
    // jsdom normalises the serialised percentage (0.00% reads back as 0%).
    expect(topOf(1)).toBe('0%');
    expect(topOf(2)).toBe('50%');
    expect(topOf(3)).toBe('100%');
  });

  it('hides the rail when the transcript fits without scrolling', async () => {
    show();
    expect(screen.getByRole('list', { name: /chapters/i })).toBeDefined();
    const viewport = screen.getByRole('region', { name: /conversation/i });
    // The rail stands in for the native bar only while it shows.
    expect(viewport.hasAttribute('data-chapter-rail')).toBe(true);
    Object.defineProperty(viewport, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 800, configurable: true });
    fireEvent(window, new Event('resize'));
    // Let the rAF-scheduled measure run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByRole('list', { name: /chapters/i })).toBeNull();
    expect(viewport.hasAttribute('data-chapter-rail')).toBe(false);
  });

  it('marks the part of the chat on screen with a band that follows the scroll', async () => {
    show();
    const viewport = screen.getByRole('region', { name: /conversation/i });
    Object.defineProperty(viewport, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 500, configurable: true });
    viewport.scrollTop = 1000;
    fireEvent.scroll(viewport);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const band = screen.getByTestId('chapter-band');
    expect(band.style.top).toBe('50%');
    expect(band.style.height).toBe('25%');
  });

  it('does not touch layout while a reply streams, then measures once after', async () => {
    show();
    const viewport = screen.getByRole('region', { name: /conversation/i });
    Object.defineProperty(viewport, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 800, configurable: true });
    // Let the initial measure run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const rect = vi.spyOn(viewport, 'getBoundingClientRect');
    rect.mockClear();
    // Streaming: resizes schedule passes that must not read a single rect —
    // every chunk grows scrollHeight, and chapters never move mid-stream.
    useChat.setState({ streamStatus: 'streaming' });
    fireEvent(window, new Event('resize'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(rect).not.toHaveBeenCalled();
    // Stream over: the next pass measures again.
    useChat.setState({ streamStatus: 'idle' });
    fireEvent(window, new Event('resize'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(rect).toHaveBeenCalled();
    rect.mockRestore();
  });

  it('drags the rail strip to scroll the transcript', () => {
    show();
    const viewport = screen.getByRole('region', { name: /conversation/i });
    Object.defineProperty(viewport, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 800, configurable: true });
    // Rail container has no layout in jsdom: the drag falls back to the
    // viewport height as its span (800). Pulling 300px down must scroll
    // 300/800 of the 1200px range, i.e. to 450.
    const tick = screen.getByRole('button', { name: /go to message 1:/i });
    fireEvent.pointerDown(tick, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 400 });
    expect(viewport.scrollTop).toBe(450);
    fireEvent.pointerUp(window);
    // The click trailing the drag must not jump anywhere.
    fireEvent.click(tick);
    expect(screen.queryByRole('dialog', { name: /conversation chapters/i })).toBeNull();
    expect(viewport.scrollTop).toBe(450);
  });
});
