import { describe, it, expect } from 'vitest';
import { breathingMorph, BREATH_WINDOW_MS, BREATH_MORPH_MAX } from '@/lib/fractal/breathing';

/**
 * Breathing envelope — the ONLY continuous motion in the organism, and it is
 * gated: a recall pulse starts it, and it decays to exactly 0 within a fixed
 * window so the render loop can stop (no idle animation). These tests pin that
 * self-terminating, bounded, non-negative shape.
 */
describe('breathingMorph', () => {
  it('is 0 at the very start of the breath (begins at rest)', () => {
    expect(breathingMorph(0)).toBe(0);
  });

  it('is exactly 0 once the window has elapsed (self-terminating)', () => {
    expect(breathingMorph(BREATH_WINDOW_MS)).toBe(0);
    expect(breathingMorph(BREATH_WINDOW_MS + 500)).toBe(0);
  });

  it('is 0 for negative / pre-start elapsed (guard)', () => {
    expect(breathingMorph(-100)).toBe(0);
  });

  it('rises above 0 partway into the window', () => {
    // A quarter of the way in there should be visible morph.
    const v = breathingMorph(BREATH_WINDOW_MS * 0.25);
    expect(v).toBeGreaterThan(0);
  });

  it('never exceeds the morph cap and never goes negative across a full sweep', () => {
    for (let t = 0; t <= BREATH_WINDOW_MS; t += 25) {
      const v = breathingMorph(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(BREATH_MORPH_MAX);
    }
  });

  it('decays: a later peak is weaker than an earlier peak', () => {
    // Sample the max morph in the first half vs the second half of the window.
    const peak = (from: number, to: number) => {
      let m = 0;
      for (let t = from; t <= to; t += 5) m = Math.max(m, breathingMorph(t));
      return m;
    };
    const early = peak(0, BREATH_WINDOW_MS * 0.5);
    const late = peak(BREATH_WINDOW_MS * 0.5, BREATH_WINDOW_MS);
    expect(late).toBeLessThan(early);
  });
});
