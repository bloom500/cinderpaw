import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAttention, useAttentionTurn } from '../attention';

const s = () => useAttention.getState();
const settle = () => new Promise<void>((r) => queueMicrotask(r));
beforeEach(() => useAttention.setState({ waiting: [], holder: null, startup: false, wizard: false }));

describe('one notice at a time', () => {
  it('notices that arrive together: the most important goes first, not the first in line', async () => {
    s().want('usage', true);
    s().want('update', true);
    s().want('whatsNew', true);
    await settle();
    expect(s().holder).toBe('whatsNew');
  });

  it("What's new, then the update, then the usage question, each after the one before is closed", async () => {
    for (const slot of ['usage', 'update', 'whatsNew'] as const) s().want(slot, true);
    const seen: string[] = [];
    while (s().waiting.length) {
      await settle();
      seen.push(s().holder!);
      s().want(s().holder!, false);
    }
    expect(seen).toEqual(['whatsNew', 'update', 'usage']);
  });

  it('a card being read is not swapped for a more important one that arrives later', async () => {
    s().want('usage', true);
    await settle();
    s().want('whatsNew', true);
    await settle();
    expect(s().holder).toBe('usage');
  });

  it('closing the last one leaves the screen clear', async () => {
    s().want('update', true);
    await settle();
    s().want('update', false);
    await settle();
    expect(s().holder).toBeNull();
    expect(s().waiting).toEqual([]);
  });
});

// The update card drew over the loading screen and the first-run wizard
// (Darius, 31 Oct): a notice waits until the screen is free, then shows.
describe('not over the loading screen or the wizard', () => {
  it.each(['startup', 'wizard'] as const)('a notice that won its turn waits while the %s is up', async (what) => {
    useAttention.setState({ [what]: true });
    const { result } = renderHook(() => useAttentionTurn('update', true));
    await act(settle);
    expect(s().holder).toBe('update');
    expect(result.current).toBe(false);
    act(() => useAttention.setState({ [what]: false }));
    expect(result.current).toBe(true);
  });
});

describe('the loading screen', () => {
  it('holds notices from the first frame until the pre-paint script marks the page ready', async () => {
    const startup = document.createElement('div');
    startup.id = 'cinderpaw-startup';
    document.body.appendChild(startup);
    vi.resetModules();
    const fresh = await import('../attention');
    expect(fresh.useAttention.getState().startup).toBe(true);
    document.documentElement.classList.add('cinderpaw-ready');
    await new Promise((r) => setTimeout(r, 0));
    expect(fresh.useAttention.getState().startup).toBe(false);
    document.documentElement.classList.remove('cinderpaw-ready');
    startup.remove();
  });
});
