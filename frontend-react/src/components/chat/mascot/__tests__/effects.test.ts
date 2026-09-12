import { describe, expect, it } from 'vitest';
import { EFFECTS, FX_MARGIN_X } from '../effects';

/**
 * The sleep glyph used to be a "3×3 Z", which cannot exist: with three columns
 * the diagonal lands dead centre and the glyph draws an I. Three grey I's
 * floating off a sleeping animal read as debris, not as sleep — which is the
 * confusion the mascot audit filed as "is it asleep or is it broken".
 */
describe('the sleeping Z', () => {
  const sleep = EFFECTS.sleep!;

  /**
   * One glyph is emitted as a contiguous run of pixels, and a glyph that would
   * fall outside the canvas is skipped rather than half-drawn, so chunking the
   * list is exactly grouping by glyph.
   */
  function glyphs(tick: number) {
    const px = sleep(tick);
    const out: { x: number; y: number }[][] = [];
    for (let i = 0; i < px.length; i += 10) {
      out.push(px.slice(i, i + 10).map((p) => ({ x: p.x, y: p.y })));
    }
    return out;
  }

  it('draws something while asleep', () => {
    const ticks = [0, 1, 2, 3, 4, 5, 6];
    expect(ticks.some((t) => sleep(t).length > 0)).toBe(true);
  });

  it('has a diagonal: the two inner rows are not the same column', () => {
    for (const g of glyphs(0)) {
      if (g.length < 8) continue; // a glyph clipped by the canvas edge
      const top = Math.min(...g.map((p) => p.y));
      const inner1 = g.filter((p) => p.y === top + 1).map((p) => p.x);
      const inner2 = g.filter((p) => p.y === top + 2).map((p) => p.x);
      expect(inner1.length).toBe(1);
      expect(inner2.length).toBe(1);
      // The whole point: an I keeps the stem in one column, a Z steps across.
      expect(inner1[0]).not.toBe(inner2[0]);
    }
  });

  it('stays clear of the body and inside the canvas', () => {
    const bodyRight = FX_MARGIN_X + 16;
    for (let t = 0; t < 12; t++) {
      for (const p of sleep(t)) {
        expect(p.x).toBeGreaterThanOrEqual(bodyRight);
        expect(p.x).toBeLessThanOrEqual(FX_MARGIN_X * 2 + 16 - 1);
        expect(p.y).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
