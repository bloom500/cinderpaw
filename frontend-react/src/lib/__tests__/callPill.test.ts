import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { CallPhase } from '@/hooks/useCallSession';

/**
 * The parking rules of the call pill, against a simulated host window. Each
 * one has already failed once in the app (21 Sep): the pill built before the
 * hide and retired by the focus bounce; a timer bringing the window back over
 * the next park; a minimised window taken for "back in front".
 */
const h = vi.hoisted(() => {
  const calls: string[] = [];
  const state = { visible: true, minimized: false, hideHides: true };
  const handlers: {
    close: null | ((e: { preventDefault(): void }) => Promise<void>);
    focus: null | ((e: { payload: boolean }) => Promise<void>);
  } = { close: null, focus: null };
  let pillOpened: () => void = () => {};
  let holdPill = false;
  const win = {
    onCloseRequested: async (fn: typeof handlers.close) => { handlers.close = fn; return () => {}; },
    onFocusChanged: async (fn: typeof handlers.focus) => { handlers.focus = fn; return () => {}; },
    hide: async () => { calls.push('hide'); if (state.hideHides) state.visible = false; },
    show: async () => { calls.push('show'); state.visible = true; },
    unminimize: async () => { state.minimized = false; },
    setFocus: async () => {},
    isVisible: async () => state.visible,
    isMinimized: async () => state.minimized,
  };
  return {
    calls, state, handlers, win,
    holdPillOpen() { holdPill = true; return () => { holdPill = false; pillOpened(); }; },
    invoke: async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'call_pill_open' && holdPill) await new Promise<void>((r) => { pillOpened = r; });
    },
  };
});

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => h.win }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string) => h.invoke(cmd) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: async () => null } }));

import { useCallPill, parked } from '../callPill';

const call = (phase: CallPhase) => ({ phase, heard: '', interrupt: () => {}, hangUp: () => {} });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('parking a call in the pill', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    h.calls.length = 0;
    Object.assign(h.state, { visible: true, minimized: false, hideHides: true });
    h.handlers.close = null;
    h.handlers.focus = null;
    parked.current = false;
  });
  afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

  it('X hides the window first, then builds the pill', async () => {
    renderHook(() => useCallPill(call('listening')));
    await flush();
    await act(async () => { await h.handlers.close!({ preventDefault() {} }); });
    expect(h.calls.indexOf('hide')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('hide')).toBeLessThan(h.calls.indexOf('call_pill_open'));
    expect(parked.current).toBe(true);
  });

  it('a focus event while the pill is being built does not retire it', async () => {
    renderHook(() => useCallPill(call('listening')));
    await flush();
    // The race: the window still reads as visible while it is leaving.
    h.state.hideHides = false;
    const release = h.holdPillOpen();
    let parking!: Promise<void>;
    act(() => { parking = h.handlers.close!({ preventDefault() {} }); });
    await flush();
    await act(async () => { await h.handlers.focus!({ payload: true }); });
    expect(h.calls).not.toContain('call_pill_close');
    release();
    await act(async () => { await parking; });
  });

  it('the window back in front retires the pill; a minimised one given the focus does not', async () => {
    renderHook(() => useCallPill(call('listening')));
    await flush();
    Object.assign(h.state, { visible: true, minimized: true });
    await act(async () => { await h.handlers.focus!({ payload: true }); });
    expect(h.calls).not.toContain('call_pill_close');
    Object.assign(h.state, { visible: true, minimized: false });
    parked.current = true;
    await act(async () => { await h.handlers.focus!({ payload: true }); });
    expect(h.calls).toContain('call_pill_close');
    expect(parked.current).toBe(false);
  });

  it('the call ending brings back a hidden window, and leaves a minimised one where it is', async () => {
    const hidden = renderHook(({ phase }) => useCallPill(call(phase)), { initialProps: { phase: 'listening' as CallPhase } });
    await flush();
    h.state.visible = false;
    parked.current = true;
    hidden.rerender({ phase: 'idle' });
    await flush();
    expect(h.calls).toContain('show');
    expect(parked.current).toBe(false);
    hidden.unmount();

    h.calls.length = 0;
    Object.assign(h.state, { visible: true, minimized: true });
    const minimised = renderHook(({ phase }) => useCallPill(call(phase)), { initialProps: { phase: 'listening' as CallPhase } });
    await flush();
    parked.current = true;
    minimised.rerender({ phase: 'idle' });
    await flush();
    expect(h.calls).not.toContain('show');
    expect(parked.current).toBe(false);
  });
  it('a call that ends while its pill is being built takes the pill with it', async () => {
    const hook = renderHook(({ phase }) => useCallPill(call(phase)), { initialProps: { phase: 'listening' as CallPhase } });
    await flush();
    const release = h.holdPillOpen();
    let parking!: Promise<void>;
    act(() => { parking = h.handlers.close!({ preventDefault() {} }); });
    await flush();
    // The vendor ends the call mid-build: the cleanup finds no pill to close yet.
    hook.rerender({ phase: 'idle' });
    await flush();
    h.calls.length = 0;
    release();
    await act(async () => { await parking; });
    expect(h.calls).toContain('call_pill_close');
    expect(h.state.visible).toBe(true);
  });
});
