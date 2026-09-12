import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open } from '@tauri-apps/plugin-shell';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { MessageList } from '../MessageList';
import { CallToolScreen } from '../CallToolScreen';
import { MessageToolWidgets } from '../MessageToolWidgets';
import { startActivity, finishActivity } from '@/hooks/useLiveToolActivity';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../MessageItem', () => ({ MessageItem: ({ message }: { message: { content: string } }) => <p>{message.content}</p> }));
vi.mock('../StreamingIndicator', () => ({ StreamingIndicator: () => <span>Thinking…</span> }));

beforeEach(() => {
  vi.useFakeTimers();
  useUI.setState({ inputMode: 'agent', language: 'en' });
  useChat.setState({ sessionId: 'chat', streamStatus: 'streaming', agentPhase: 'calling', agentTool: 'web_search', messages: [
    { id: 'reply', role: 'assistant', content: 'Let me check.', thinking: 'Checking sources', thinkingComplete: false, createdAt: Date.now() },
  ] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('chat tool widgets', () => {
  it('draws the call widget open while the reply streams, folds it after, and reopens on click', () => {
    const running = startActivity('web_search', { query: 'Cinderpaw guide' });
    const { rerender } = render(<MessageToolWidgets activity={[running]} streaming />);
    expect(screen.getByText('Cinderpaw guide')).toBeInTheDocument();
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();

    const done = finishActivity(running, { ok: true, data: [{ text: 'Guide — setup instructions', url: 'https://example.com/guide' }] });
    rerender(<MessageToolWidgets activity={[done]} streaming />);
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    expect(open).toHaveBeenCalledWith('https://example.com/guide');

    // The reply is finished: one line, the widget behind a click.
    rerender(<MessageToolWidgets activity={[done]} streaming={false} />);
    expect(screen.queryByRole('button', { name: 'Guide' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /web_search/ }));
    expect(screen.getByRole('button', { name: 'Guide' })).toBeInTheDocument();
  });

  it('draws the application the agent is driving, from its own accessibility tree', () => {
    finishActivity(startActivity('computer_use', { action: 'list_windows' }), {
      ok: true, data: [{ pid: 9, title: 'Untitled - Notepad', app_name: 'notepad.exe' }],
    });
    const tree = finishActivity(startActivity('computer_use', { action: 'get_tree', pid: 9 }), {
      ok: true, data: { id: 'w', role: 'Window', name: 'Untitled - Notepad', bounding_rect: { x: 0, y: 0, width: 400, height: 300 },
        children: [{ id: 'b', role: 'Button', name: 'Save', bounding_rect: { x: 10, y: 10, width: 80, height: 20 } }] },
    });
    const click = startActivity('computer_use', { action: 'click', pid: 9, element_id: 'b' });
    render(<MessageToolWidgets activity={[tree, click]} streaming />);
    expect(screen.getAllByText('notepad · Untitled - Notepad')).toHaveLength(2);
    expect(screen.getByText('Clicking «Save»')).toBeInTheDocument();
    const lit = document.querySelector('.border-brand');
    expect(lit).toHaveAttribute('title', 'Button Save');
    expect(lit?.parentElement?.style.aspectRatio).toContain('/');
  });

  /** The element that actually scrolls, which is NOT the outer wrapper: the
   *  wrapper is the positioning context that keeps "Jump to bottom" still. */
  function scrollerOf(container: HTMLElement): HTMLElement {
    const el = container.querySelector('.overflow-y-auto');
    if (!el) throw new Error('MessageList rendered no scroll container');
    return el as HTMLElement;
  }

  /** Scroll away from the bottom, which is what reveals the button. */
  function scrollUp(container: HTMLElement): HTMLElement {
    const scroller = scrollerOf(container);
    Object.defineProperties(scroller, { scrollHeight: { value: 2000 }, clientHeight: { value: 600 } });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    return scroller;
  }

  it('keeps the viewport position when a reply changes while reading older messages', () => {
    const { container } = render(<MessageList />);
    const scroller = scrollUp(container);
    act(() => useChat.getState().updateLastAssistantMessage({ toolActivity: [startActivity('read_file', { path: 'guide.txt' })] }));
    expect(scroller.scrollTop).toBe(100);
  });

  describe('jump to bottom stays above the composer', () => {
    it('is not a child of the scroller, so it cannot scroll out of view', () => {
      // The original bug: an absolute child of a scroll container is laid out
      // against the scrolled CONTENT, so the button rode up with the
      // transcript and was only on screen when already at the bottom.
      const { container } = render(<MessageList />);
      const scroller = scrollUp(container);
      const button = screen.getByRole('button', { name: /Jump to bottom|new/ });
      expect(scroller.contains(button)).toBe(false);
      expect(button.parentElement).toBe(container.firstElementChild);
      expect(container.firstElementChild).toHaveClass('relative');
    });

    it('clears the composer by its measured height, never a fixed number', () => {
      // `bottom-20` was a flat 80px: right for a one-line draft, wrong the
      // moment the composer grew. The height is published by ChatPage.
      const { container } = render(<MessageList />);
      scrollUp(container);
      const button = screen.getByRole('button', { name: /Jump to bottom|new/ });
      expect(button.style.bottom).toContain('var(--chat-dock-h');
      expect(button.className).not.toMatch(/bottom-\d/);
    });

    it('is not rendered at all while the transcript is already at the bottom', () => {
      render(<MessageList />);
      expect(screen.queryByRole('button', { name: /Jump to bottom/ })).not.toBeInTheDocument();
    });
  });

  it('draws a browser as a browser: real tab title, real address, and says when the layout is unread', () => {
    finishActivity(startActivity('computer_use', { action: 'list_windows' }), {
      ok: true, data: [{ pid: 4, title: 'New chat - Claude - Brave', app_name: 'brave.exe' }],
    });
    const launched = finishActivity(startActivity('computer_use', { action: 'launch', app: 'brave.exe' }), { ok: true, data: { launched: true, pid: 4 } });
    const { unmount } = render(<MessageToolWidgets activity={[launched]} streaming />);
    expect(screen.getByText('layout not read yet')).toBeInTheDocument();
    expect(screen.getByText(/appears once the agent reads it/)).toBeInTheDocument();
    unmount();

    const tree = finishActivity(startActivity('computer_use', { action: 'get_tree', pid: 4 }), {
      ok: true, data: { id: 'w', role: 'Window', name: 'New chat - Claude - Brave', bounding_rect: { x: 0, y: 0, width: 1000, height: 800 }, children: [
        { id: 'a', role: 'Edit', name: 'Address and search bar', value: 'https://claude.ai/new', bounding_rect: { x: 100, y: 40, width: 700, height: 24 } },
        { id: 'p', role: 'Pane', name: '', bounding_rect: { x: 0, y: 120, width: 1000, height: 680 } },
      ] },
    });
    render(<MessageToolWidgets activity={[tree]} streaming />);
    expect(screen.getByText('https://claude.ai/new')).toBeInTheDocument();
    expect(screen.getByText('New chat - Claude - Brave')).toBeInTheDocument();
    // The address bar is toolbar, not page: the wireframe holds only the Pane.
    expect(document.querySelector('[title="Pane"]')).not.toBeNull();
    expect(document.querySelector('[title="Edit Address and search bar"]')).toBeNull();
  });

  it('shows command output, file facts and failures, each in its own widget', () => {
    const shell = finishActivity(startActivity('shell_exec', { command: 'bun test', cwd: 'D:/project' }), { ok: true, content: '42 tests passed' });
    const file = finishActivity(startActivity('read_file', { path: 'notes.txt' }), { ok: true, data: { path: 'notes.txt', lines: 5, bytes: 100 } });
    const memory = finishActivity(startActivity('recall', { query: 'project notes' }), { ok: false, content: 'Memory unavailable' });
    render(<MessageToolWidgets activity={[shell, file, memory]} streaming />);
    expect(screen.getByText('bun test')).toBeInTheDocument();
    expect(screen.getByText('42 tests passed')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('Memory unavailable')).toBeInTheDocument();
  });

  it('keeps the voice layout as the default', () => {
    const { container } = render(<CallToolScreen activity={[{
      id: 'voice', tool: 'recall', kind: 'memory', subject: 'notes', status: 'done', startedAt: 0, endedAt: 1000,
      note: null, hits: [], files: [], output: '', cwd: '', facts: ['Remembered fact'], desktop: null, error: null,
    }]} />);
    expect(container.firstChild).toHaveClass('absolute');
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText('Remembered fact')).toBeInTheDocument();
  });
});
