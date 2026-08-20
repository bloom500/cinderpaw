import { describe, it, expect } from 'vitest';
import { pcm16Base64 } from '../micPcm';
import { pcm16ToFloat32 } from '../audio';

/**
 * The only thing worth testing here is the byte layout, and it is worth testing
 * because getting it wrong is silent: a wrong endianness or an unclamped sample
 * still produces a stream the server accepts, decodes and answers to — with
 * static. The player's decoder is the exact inverse, so a round trip through
 * both is the check.
 */
describe('pcm16Base64', () => {
  it('round-trips through the decoder the player uses', () => {
    const input = new Float32Array([0, 0.5, -0.5, 0.25, -1, 0.999]);
    const { samples, carry } = pcm16ToFloat32(pcm16Base64(input));
    expect(carry.length).toBe(0);
    expect(samples.length).toBe(input.length);
    for (let i = 0; i < input.length; i++) {
      // Two quantisation steps of 16-bit. One would be the bound if the two sides
      // scaled by the same constant, but positives are encoded against 0x7fff and
      // decoded against 0x8000 — the standard asymmetry, which keeps +1.0 from
      // clipping. Anything larger than this means the bytes were assembled wrong.
      expect(Math.abs(samples[i] - input[i])).toBeLessThan(2 / 32768);
    }
  });

  it('clamps instead of wrapping', () => {
    // autoGainControl overshoots past 1.0 in practice. Wrapping turns the peak of
    // a loud syllable into its opposite — a click, not a clip.
    const { samples } = pcm16ToFloat32(pcm16Base64(new Float32Array([2, -2])));
    expect(samples[0]).toBeGreaterThan(0.99);
    expect(samples[1]).toBeCloseTo(-1, 5);
  });

  it('writes little-endian, two bytes per sample', () => {
    // 0.5 × 0x7fff = 16383 = 0x3fff → bytes ff 3f. Spelled out rather than
    // inferred from the round trip, which would pass just as happily if both
    // sides were big-endian.
    const b64 = pcm16Base64(new Float32Array([0.5]));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect([...bytes]).toEqual([0xff, 0x3f]);
  });
});
