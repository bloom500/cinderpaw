import { beforeEach, describe, expect, it } from 'vitest';
import { useAttention } from '../attention';

const s = () => useAttention.getState();
const settle = () => new Promise<void>((r) => queueMicrotask(r));
beforeEach(() => useAttention.setState({ waiting: [], holder: null }));

describe('one notice at a time', () => {
  it('notices that arrive together: the most important goes first, not the first in line', async () => {
    s().want('usage', true);
    s().want('alpha', true);
    s().want('whatsNew', true);
    await settle();
    expect(s().holder).toBe('whatsNew');
  });

  it("What's new, then Alpha, then the rest, each after the one before is closed", async () => {
    for (const slot of ['update', 'alpha', 'whatsNew', 'usage'] as const) s().want(slot, true);
    const seen: string[] = [];
    while (s().waiting.length) {
      await settle();
      seen.push(s().holder!);
      s().want(s().holder!, false);
    }
    expect(seen).toEqual(['whatsNew', 'alpha', 'update', 'usage']);
  });

  it('a card being read is not swapped for a more important one that arrives later', async () => {
    s().want('usage', true);
    await settle();
    s().want('whatsNew', true);
    await settle();
    expect(s().holder).toBe('usage');
  });

  it('closing the last one leaves the screen clear', async () => {
    s().want('alpha', true);
    await settle();
    s().want('alpha', false);
    await settle();
    expect(s().holder).toBeNull();
    expect(s().waiting).toEqual([]);
  });
});
