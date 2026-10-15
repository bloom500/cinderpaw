import { describe, it, expect } from 'vitest';
import { useUI } from '@/stores/ui';

/**
 * Chat mode is gone, and with it `inputMode` and the Tools menu's two values.
 * Removing them from the store does not remove them from the blob an older
 * build saved, and rehydration merges that blob over the defaults.
 */
describe('useUI: the chat-mode keys an older build saved', () => {
  it('drops them on rehydrate and keeps every real setting', () => {
    const merge = (useUI.persist.getOptions().merge)!;
    const merged = merge(
      { inputMode: 'chat', reasoningMode: 'off', enabledTools: ['file_write'], theme: 'light' },
      useUI.getState(),
    ) as unknown as Record<string, unknown>;

    expect(merged).not.toHaveProperty('inputMode');
    expect(merged).not.toHaveProperty('reasoningMode');
    expect(merged).not.toHaveProperty('enabledTools');
    expect(merged.theme).toBe('light');
  });
});

/**
 * The retired call engines.
 *
 * `pipeline` and `live` are gone from the picker and their code still runs, so
 * the only thing standing between a returning user and a retired engine is the
 * migration in `merge`. Exactly the shape of the test above, and for exactly
 * the same reason: dropping something from the UI does not drop it from the
 * blob that rehydration merges over the defaults, so the install that has been
 * using voice the longest is the one that would never move.
 */
describe('useUI: engines that are retired rather than deleted', () => {
  const merge = () => useUI.persist.getOptions().merge!;
  const rehydrate = (persisted: Record<string, unknown>) =>
    merge()(persisted, useUI.getState()) as ReturnType<typeof useUI.getState>;

  it('defaults a fresh install to LiveKit with no provider picked', () => {
    expect(useUI.getState().callEngine).toBe('livekit');
    // null is a working state, not a broken one: Rust falls back to whichever
    // provider has a key. Asserted so nobody "fixes" it to a vendor id.
    expect(useUI.getState().s2sProvider).toBeNull();
  });

  it.each(['pipeline', 'live'] as const)('moves a stored %s engine to livekit', (retired) => {
    expect(rehydrate({ callEngine: retired }).callEngine).toBe('livekit');
  });

  it('leaves a stored livekit choice and the provider alone', () => {
    const merged = rehydrate({ callEngine: 'livekit', s2sProvider: 'openai' });
    expect(merged.callEngine).toBe('livekit');
    expect(merged.s2sProvider).toBe('openai');
  });
});

describe('useUI: theme default', () => {
  it('a fresh install follows the OS', () => {
    // The initial state, before any setTheme: what a stranger starts with.
    expect(useUI.getInitialState().theme).toBe('system');
  });
});

describe('useUI: the campfire game', () => {
  it('is offered by default, and its best score only goes up', () => {
    expect(useUI.getState().emberGameEnabled).toBe(true);
    useUI.getState().recordEmberScore(30);
    useUI.getState().recordEmberScore(12);
    expect(useUI.getState().emberBest).toBe(30);
  });

  it('keeps its setting and best score across launches', () => {
    const saved = useUI.persist.getOptions().partialize!(useUI.getState()) as Record<string, unknown>;
    expect(saved).toHaveProperty('emberGameEnabled');
    expect(saved).toHaveProperty('emberBest');
  });
});

/**
 * Glass effects default to off (solid): backdrop blur re-runs on every
 * scrolled frame, and the default is what weak machines get.
 */
describe('useUI: glass effects', () => {
  it('starts a fresh install solid', () => {
    expect(useUI.getInitialState().glassEffects).toBe(false);
  });

  it('keeps the choice across launches', () => {
    const saved = useUI.persist.getOptions().partialize!(useUI.getState()) as Record<string, unknown>;
    expect(saved).toHaveProperty('glassEffects');
  });

  it('stamps the document when the choice changes', () => {
    useUI.getState().setGlassEffects(true);
    expect(useUI.getState().glassEffects).toBe(true);
    expect(document.documentElement.getAttribute('data-glass')).toBe('on');
    useUI.getState().setGlassEffects(false);
    expect(document.documentElement.getAttribute('data-glass')).toBe('off');
  });

  it('gives an old install without the key the new default', () => {
    // The blob predates the switch, so there is nothing to keep: solid,
    // stamped, same as a stranger.
    const start = useUI.persist.getOptions().onRehydrateStorage;
    const finish = start?.(useUI.getInitialState());
    expect(finish).toBeDefined();
    document.documentElement.removeAttribute('data-glass');
    finish?.({ theme: 'system' } as never, undefined);
    expect(document.documentElement.getAttribute('data-glass')).toBe('off');
  });
});
