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
  useBrowser.setState({ panelOpen: true, url: '', loading: false, error: null });
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

  it('back, forward and reload go to the page', async () => {
    render(<BrowserPanel />);
    fireEvent.click(screen.getByLabelText('Back'));
    fireEvent.click(screen.getByLabelText('Reload'));
    await act(async () => {});
    expect(ui).toHaveBeenCalledWith('back');
    expect(ui).toHaveBeenCalledWith('reload');
  });
});
