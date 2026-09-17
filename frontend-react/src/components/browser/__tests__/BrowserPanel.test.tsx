import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('framer-motion', async (orig) => {
  const actual = await orig<typeof import('framer-motion')>();
  const { useEffect } = await import('react');
  // Finish the slide-in at once, so the panel reports where the page goes.
  function Aside({ onAnimationComplete, initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown>) {
    useEffect(() => (onAnimationComplete as (() => void) | undefined)?.(), [onAnimationComplete]);
    return <aside {...(rest as object)} />;
  }
  return { ...actual, motion: { ...actual.motion, aside: Aside } };
});

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, browser: { ui: vi.fn().mockResolvedValue({ ok: true, url: 'https://example.ro/' }) } } };
});

import { BrowserPanel } from '../BrowserPanel';
import { useBrowser } from '@/stores/browser';
import { tauri } from '@/lib/tauri';

const ui = tauri.browser.ui as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  ui.mockClear();
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
  useBrowser.setState({ panelOpen: true, url: '', loading: false, error: null, tabs: [], active: null, wide: false, chatOpen: false });
});
afterEach(cleanup);

describe('the browser panel', () => {
  it('opens what is typed into the address bar', async () => {
    render(<BrowserPanel />);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'rar.ro' } });
    fireEvent.submit(screen.getByLabelText('Address').closest('form')!);
    await waitFor(() => expect(ui).toHaveBeenCalledWith('open', { url: 'rar.ro' }));
    await waitFor(() => expect(useBrowser.getState().url).toBe('https://example.ro/'));
  });

  it('tells the host where the page goes once the panel has arrived', async () => {
    render(<BrowserPanel />);
    await waitFor(() => expect(ui.mock.calls.some((c) => c[0] === 'set_bounds' && c[1].visible === true)).toBe(true));
  });

  it('parks the page before the panel closes, so it does not float where the panel was', async () => {
    render(<BrowserPanel />);
    ui.mockClear();
    fireEvent.click(screen.getByLabelText('Close browser'));
    expect(ui).toHaveBeenCalledWith('set_bounds', { visible: false });
    expect(useBrowser.getState().panelOpen).toBe(false);
  });

  it('back is off with nothing behind, on once there is, and reload always goes', async () => {
    render(<BrowserPanel />);
    expect(screen.getByLabelText('Back')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Reload'));
    await act(async () => {});
    expect(ui).toHaveBeenCalledWith('reload');
    act(() => {
      useBrowser.setState({ tabs: [{ id: 1, title: 'Wiki', url: 'https://wikipedia.org/', loading: false, canBack: true, canForward: false }], active: 1 });
    });
    fireEvent.click(screen.getByLabelText('Back'));
    await act(async () => {});
    expect(ui).toHaveBeenCalledWith('back');
  });

  it('tabs: shows each, switches, closes, and opens a new one', async () => {
    const tabs = [
      { id: 1, title: 'Wiki', url: 'https://wikipedia.org/', loading: false, canBack: false, canForward: false },
      { id: 2, title: '', url: 'about:blank', loading: false, canBack: false, canForward: false },
    ];
    ui.mockResolvedValue({ active: 2, tabs });
    useBrowser.setState({ tabs, active: 1 });
    render(<BrowserPanel />);
    expect(screen.getByRole('tab', { name: /Wiki/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /New tab/ }));
    await waitFor(() => expect(ui).toHaveBeenCalledWith('switch_tab', { id: 2 }));
    fireEvent.click(screen.getByLabelText('Close tab Wiki'));
    await waitFor(() => expect(ui).toHaveBeenCalledWith('close_tab', { id: 1 }));
    fireEvent.click(screen.getByLabelText('New tab'));
    await waitFor(() => expect(ui).toHaveBeenCalledWith('new_tab'));
    fireEvent.click(screen.getByLabelText('Home'));
    await waitFor(() => expect(ui).toHaveBeenCalledWith('home'));
  });
});

describe('the new tab page and the edge', () => {
  it('searches from the start page', async () => {
    render(<BrowserPanel />);
    fireEvent.change(screen.getByLabelText('Search the web'), { target: { value: 'formular rev 3' } });
    fireEvent.submit(screen.getByLabelText('Search the web').closest('form')!);
    await waitFor(() => expect(ui).toHaveBeenCalledWith('open', { url: 'formular rev 3' }));
  });

  it('resizes with the keyboard and never squeezes the chat', () => {
    const { container } = render(<div><BrowserPanel /></div>);
    Object.defineProperty(container.firstElementChild!, 'clientWidth', { value: 1200, configurable: true });
    const edge = screen.getByRole('separator', { name: 'Resize browser panel' });
    const before = Number(edge.getAttribute('aria-valuenow'));
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(Number(edge.getAttribute('aria-valuenow'))).toBe(before + 24);
    for (let i = 0; i < 100; i++) fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(Number(edge.getAttribute('aria-valuenow'))).toBe(1200 - 448);
  });
});

describe('wide mode', () => {
  it('fills the window, and the bubble opens the conversation beside the page', () => {
    render(<BrowserPanel chat={<div>the conversation</div>} />);
    expect(screen.queryByText('the conversation')).toBeNull();
    fireEvent.click(screen.getByLabelText('Fill the window'));
    expect(useBrowser.getState().wide).toBe(true);
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.click(screen.getByLabelText('Chat with Cinderpaw'));
    expect(screen.getByText('the conversation')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Back to split view'));
    expect(useBrowser.getState().wide).toBe(false);
  });
});
