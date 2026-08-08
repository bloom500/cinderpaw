import { describe, expect, it } from 'vitest';
import { finalTokenStats } from '../useSendMessage';

describe('finalTokenStats', () => {
  it('uses the provider count when there is one, and does not mark it estimated', () => {
    // 400 chars would guess 100 tokens; the provider said 137. The provider wins.
    const s = finalTokenStats(137, 400, 2);
    expect(s.tokenCount).toBe(137);
    expect(s.tokensEstimated).toBe(false);
    expect(s.tokensPerSec).toBe(69);
  });

  it('falls back to chars/4 and marks it estimated', () => {
    // The local-model path: no usage event ever fires.
    const s = finalTokenStats(null, 400, 2);
    expect(s.tokenCount).toBe(100);
    expect(s.tokensEstimated).toBe(true);
  });

  it('does not divide by zero when the stream finished within the same tick', () => {
    expect(finalTokenStats(50, 200, 0).tokensPerSec).toBe(0);
  });

  it('reports a real zero from the provider as measured, not as a missing number', () => {
    // `?? ` not `|| ` — a refusal that generated nothing is still the
    // provider's answer, and must not silently become our 0-char guess.
    const s = finalTokenStats(0, 0, 1);
    expect(s.tokenCount).toBe(0);
    expect(s.tokensEstimated).toBe(false);
  });
});
