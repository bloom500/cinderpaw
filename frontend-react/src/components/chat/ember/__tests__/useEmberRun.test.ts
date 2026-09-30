import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../emberAvailability', () => ({ emberAvailability: vi.fn(() => Promise.resolve({ ok: true })) }));

import { useEmberRun, OFFER_AFTER_MS } from '../useEmberRun';
import { emberAvailability } from '../emberAvailability';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';

async function mount() {
  const hook = renderHook(() => useEmberRun());
  await act(async () => {});  // the availability answer arrives
  return hook;
}

function runFor(ms: number) {
  act(() => useChat.setState({ streamStatus: 'streaming' }));
  act(() => { vi.advanceTimersByTime(ms); });
}

describe('useEmberRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChat.setState({ streamStatus: 'idle', sessionId: 's1' });
    useUI.setState({ emberGameEnabled: true, mascotEnabled: true });
  });
  afterEach(() => vi.useRealTimers());

  it('offers the game only once a task has run for 15 s', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS - 1);
    expect(result.current.offered).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.offered).toBe(true);
  });

  it('never offers it when the setting or the mascot is off', async () => {
    useUI.setState({ emberGameEnabled: false });
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    expect(result.current.offered).toBe(false);
    act(() => useUI.setState({ emberGameEnabled: true, mascotEnabled: false }));
    expect(result.current.offered).toBe(false);
  });

  it('never offers it on a machine that cannot run it', async () => {
    vi.mocked(emberAvailability).mockResolvedValueOnce({ ok: false, reason: 'no WebGL 2' });
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    expect(result.current.offered).toBe(false);
  });

  it('stops offering when the task ends', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    act(() => useChat.setState({ streamStatus: 'done' }));
    expect(result.current.offered).toBe(false);
  });

  it('keeps a round through closing the panel, and ends it with the task', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    act(() => result.current.openPanel());
    const since = result.current.round?.since;
    act(() => result.current.closePanel());
    expect(result.current.round).toEqual({ since, ended: null });
    expect(result.current.offered).toBe(true);
    act(() => result.current.openPanel());
    expect(result.current.round?.since).toBe(since);
    act(() => useChat.setState({ streamStatus: 'done' }));
    expect(result.current.round?.ended).toEqual({ ok: true });
  });

  it('ends a round as not ok on an error, and drops it when closed after the end', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    act(() => result.current.openPanel());
    act(() => useChat.setState({ streamStatus: 'error' }));
    expect(result.current.round?.ended).toEqual({ ok: false });
    act(() => result.current.closePanel());
    expect(result.current.round).toBeNull();
  });

  it('abandons the round when the person switches chats', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    act(() => result.current.openPanel());
    act(() => useChat.setState({ sessionId: 's2' }));
    expect(result.current.round).toBeNull();
    expect(result.current.open).toBe(false);
  });
});
