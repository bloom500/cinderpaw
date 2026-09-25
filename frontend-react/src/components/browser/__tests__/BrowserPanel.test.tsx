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

// Events from the host, deliverable from a test: `emitTauri(name, payload)`.
const listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    return () => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== cb));
  },
  emit: async () => {},
}));
async function emitTauri(name: string, payload: unknown) {
  for (const cb of listeners.get(name) ?? []) cb({ payload });
}

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, browser: { ui: vi.fn().mockResolvedValue({ ok: true, url: 'https://example.ro/' }) } } };
});

import { BrowserPanel } from '../BrowserPanel';
import { toAddress } from '@/stores/browser';
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
    await waitFor(() => expect(ui).toHaveBeenCalledWith('open', { url: 'https://rar.ro' }));
    await waitFor(() => expect(useBrowser.getState().url).toBe('https://example.ro/'));
  });

  it('tells the host where the page goes once the panel has arrived', async () => {
    render(<BrowserPanel />);
    await waitFor(() => expect(ui.mock.calls.some((c) => c[0] === 'set_bounds' && c[1].visible === true)).toBe(true));
  });

  it('parks the page when the window itself reloads (Ctrl+R)', async () => {
    // React's cleanup never runs on a reload, and the page is a native view on
    // top of everything: it floated over the loading screen until something
    // placed it again (17 Sep).
    render(<BrowserPanel />);
    ui.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(ui).toHaveBeenCalledWith('set_bounds', { visible: false });
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
      useBrowser.setState({ tabs: [{ id: 1, title: 'Wiki', url: 'https://wikipedia.org/', loading: false, canBack: true, canForward: false, blocked: 0 }], active: 1 });
    });
    fireEvent.click(screen.getByLabelText('Back'));
    await act(async () => {});
    expect(ui).toHaveBeenCalledWith('back');
  });

  it('tabs: shows each, switches, closes, and opens a new one', async () => {
    const tabs = [
      { id: 1, title: 'Wiki', url: 'https://wikipedia.org/', loading: false, canBack: false, canForward: false, blocked: 0 },
      { id: 2, title: '', url: 'about:blank', loading: false, canBack: false, canForward: false, blocked: 0 },
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
    await waitFor(() => expect(ui).toHaveBeenCalledWith('open', { url: 'https://duckduckgo.com/?q=formular%20rev%203' }));
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

describe('toAddress', () => {
  it('keeps a URL, completes a domain, and searches words with the chosen engine', () => {
    expect(toAddress('https://a.b/c', 'duckduckgo')).toBe('https://a.b/c');
    expect(toAddress('wikipedia.org', 'duckduckgo')).toBe('https://wikipedia.org');
    expect(toAddress('formular rev 3', 'brave')).toBe('https://search.brave.com/search?q=formular%20rev%203');
    expect(toAddress('cum fac o cerere', 'nope')).toBe('https://duckduckgo.com/?q=cum%20fac%20o%20cerere');
  });

  it('opens a local server instead of searching for it, and searches what only looks like a scheme', () => {
    expect(toAddress('localhost:3000', 'duckduckgo')).toBe('http://localhost:3000');
    expect(toAddress('localhost:5173/app', 'duckduckgo')).toBe('http://localhost:5173/app');
    expect(toAddress('127.0.0.1:8080', 'duckduckgo')).toBe('http://127.0.0.1:8080');
    expect(toAddress('example.com:8443/x', 'duckduckgo')).toBe('https://example.com:8443/x');
    expect(toAddress('Re: meeting notes', 'brave')).toBe('https://search.brave.com/search?q=Re%3A%20meeting%20notes');
    expect(toAddress('about:blank', 'duckduckgo')).toBe('about:blank');
    // Refused by the host, not quietly searched.
    expect(toAddress('javascript:alert(1)', 'duckduckgo')).toBe('javascript:alert(1)');
  });
});

describe('the promise on the start page', () => {
  it('picks the engine from its mark, and shows what Cinderpaw is doing', () => {
    render(<BrowserPanel />);
    fireEvent.click(screen.getByRole('radio', { name: /Brave Search/ }));
    expect(useBrowser.getState().engine).toBe('brave');
    expect(screen.getByPlaceholderText('Search Brave Search or type an address')).toBeInTheDocument();
    expect(screen.getByText(/Cinderpaw can use this browser too/)).toBeInTheDocument();
    act(() => useBrowser.setState({ agent: { op: 'click', ref: '12', busy: true } }));
    expect(screen.getByRole('status')).toHaveTextContent('Cinderpaw clicked control 12…');
  });
  it('reader view is a toggle: the article is a page of our own, and the chrome shows the original address', async () => {
    render(<BrowserPanel />);
    act(() => {
      useBrowser.setState({ url: 'https://wikipedia.org/', tabs: [{ id: 1, title: 'Wiki', url: 'https://wikipedia.org/', loading: false, canBack: false, canForward: false, blocked: 0 }], active: 1 });
    });
    const reader = screen.getByLabelText('Reader view');
    expect(reader).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(reader);
    await act(async () => {});
    expect(ui).toHaveBeenCalledWith('reader');
    // the host navigates to the reader page; the panel reads its state off the address
    act(() => { useBrowser.setState({ url: 'http://cinderpaw-reader.localhost/abc?u=https%3A%2F%2Fwikipedia.org%2F' }); });
    expect(screen.getByLabelText('Leave reader view')).toHaveAttribute('aria-pressed', 'true');
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('https://wikipedia.org/');
  });

  it('zooms with the keyboard, shows the level, and resets from it', async () => {
    render(<BrowserPanel />);
    act(() => { useBrowser.setState({ url: 'https://wikipedia.org/' }); });
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    expect(screen.getByText('110%')).toBeInTheDocument();
    expect(ui).toHaveBeenCalledWith('zoom', { factor: 1.1 });
    fireEvent.click(screen.getByText('110%'));
    expect(screen.queryByText('110%')).toBeNull();
    expect(ui).toHaveBeenCalledWith('zoom', { factor: 1 });
  });

  it('downloads live behind a toolbar button, with a count, even before there are any', () => {
    render(<BrowserPanel />);
    fireEvent.click(screen.getByLabelText('Downloads'));
    expect(screen.getByText('Nothing downloaded yet this session.')).toBeInTheDocument();
    act(() => { useBrowser.setState({ downloads: [{ name: 'report.pdf', at: 1, artifact: true }] }); });
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Downloads').parentElement!.textContent).toContain('1');
  });

  it('one press on the star saves the page with sparks; the next press opens the editor', async () => {
    render(<BrowserPanel />);
    act(() => {
      useBrowser.setState({ url: 'https://wikipedia.org/', tabs: [{ id: 1, title: 'Wiki', url: 'https://wikipedia.org/', loading: false, canBack: false, canForward: false, blocked: 0 }], active: 1 });
    });
    fireEvent.click(screen.getByLabelText('Bookmark this page'));
    expect(document.querySelectorAll('.spark')).toHaveLength(8);
    expect(screen.getByLabelText('Edit bookmark').className).toContain('star-pop');
    expect(screen.queryByLabelText('Tags')).toBeNull();
    fireEvent.click(screen.getByLabelText('Edit bookmark'));
    expect(screen.getByLabelText('Tags')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Remove'));
    expect(screen.getByLabelText('Bookmark this page')).toBeInTheDocument();
  });

  it('a shortcut relayed from the page lands in the same handler', async () => {
    render(<BrowserPanel />);
    act(() => { useBrowser.setState({ url: 'https://wikipedia.org/' }); });
    await act(async () => { await emitTauri('browser://key', { key: '=', shift: false }); });
    expect(screen.getByText('110%')).toBeInTheDocument();
  });
});
