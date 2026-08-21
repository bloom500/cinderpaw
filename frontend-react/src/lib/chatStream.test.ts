import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Listener registration is the one thing in this module that runs before any
 * chat can happen at all, so its failure path is the one that strands a user:
 * a rejected registration used to be cached forever, leaving chat dead until a
 * window reload that nothing on screen suggested.
 */

const listen = vi.fn();
const stream = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/tauri', () => {
  const channel = { listen: (cb: unknown) => listen(cb) };
  return {
    tauri: { chat: { stream: (...a: unknown[]) => stream(...a), stop: vi.fn() } },
    events: {
      tokenEvent: channel,
      streamDoneEvent: channel,
      streamErrorEvent: channel,
      streamTruncatedEvent: channel,
      streamStartEvent: channel,
      streamUsageEvent: channel,
    },
  };
});

/** Fresh module per test — `unlistens` is module-level state, and a test that
 *  registered successfully would otherwise short-circuit the next one. */
async function load() {
  vi.resetModules();
  return (await import('./chatStream')).startChatStream;
}

// Not `as const`: the tuple is spread into startChatStream, whose `messages`
// parameter is a mutable Message[], and a readonly tuple does not satisfy it.
const args = (): Parameters<typeof import('./chatStream').startChatStream> =>
  ['s1', [], {} as never, null, {
    onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onStopped: vi.fn(),
  }];

describe('ensureListeners failure handling', () => {
  beforeEach(() => { listen.mockReset(); stream.mockClear(); });

  it('retries registration after a failed attempt instead of staying dead', async () => {
    const startChatStream = await load();
    listen.mockRejectedValueOnce(new Error('host not ready'));
    await expect(startChatStream(...args())).rejects.toThrow('host not ready');

    // Second attempt: every listen succeeds. Before the fix this still rejected
    // with the cached first error and chat never recovered.
    listen.mockResolvedValue(vi.fn());
    await expect(startChatStream(...args())).resolves.toBeUndefined();
    expect(stream).toHaveBeenCalledOnce();
  });

  it('releases already-registered listeners when a later one fails', async () => {
    const startChatStream = await load();
    const unlisten = vi.fn();
    listen
      .mockResolvedValueOnce(unlisten)
      .mockResolvedValueOnce(unlisten)
      .mockRejectedValueOnce(new Error('boom'));

    await expect(startChatStream(...args())).rejects.toThrow('boom');
    // Both survivors released — otherwise the next successful attempt would
    // deliver every token twice.
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
