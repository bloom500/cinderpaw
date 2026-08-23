import { describe, it, expect } from 'vitest';
import { useUI } from '@/stores/ui';

/**
 * What is left of reasoning mode and the tool list after their composer
 * controls were removed: two values that are read and never written.
 *
 * The tests that used to live here exercised `cycleReasoningMode` and
 * `toggleTool`. Both are gone, and testing a setter nobody can reach would
 * only have kept the dead code alive. What matters now is the pair of defaults
 * everyone silently runs on, and the one way an old machine can fail to get
 * them.
 */
describe('useUI: the settings that no longer have a switch', () => {
  it('defaults to auto reasoning and no chat-mode tools', () => {
    expect(useUI.getState().reasoningMode).toBe('auto');
    expect(useUI.getState().enabledTools).toEqual([]);
  });

  it('ignores values an older build left in storage', () => {
    // The regression this exists for: dropping the two keys from `partialize`
    // stops them being written, but a machine that already ran an older build
    // still has them on disk, and rehydration merges that blob over the
    // defaults. Someone who once chose "suppress thinking blocks" would keep
    // suppressing them forever, with no control left on screen to undo it —
    // the fix reaching everyone EXCEPT the people who needed it.
    const merge = (useUI.persist.getOptions().merge)!;
    const merged = merge(
      { reasoningMode: 'off', enabledTools: ['file_write'], theme: 'light' },
      useUI.getState(),
    ) as ReturnType<typeof useUI.getState>;

    expect(merged.reasoningMode).toBe('auto');
    expect(merged.enabledTools).toEqual([]);
    // …while everything that IS still a setting survives untouched.
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
