import { describe, it, expect } from 'vitest';
import { computePeaks, pcm16ToFloat32 } from '../audio';

/** base64 of raw bytes, the way Rust's `speak_text` encodes a PCM chunk. */
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('pcm16ToFloat32', () => {
  it('reads signed little-endian 16-bit into -1..1', () => {
    //   0x0000 = silence, 0x7FFF = full positive, 0x8000 = full negative
    const { samples, carry } = pcm16ToFloat32(b64([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]));
    expect(carry).toHaveLength(0);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBeCloseTo(1, 4);
    expect(samples[2]).toBe(-1);
  });

  it('carries a split sample into the next chunk instead of dropping it', () => {
    // The network cut between the two bytes of a single 0x7FFF sample.
    const first = pcm16ToFloat32(b64([0xff]));
    expect(first.samples).toHaveLength(0);
    expect(first.carry).toHaveLength(1);

    const second = pcm16ToFloat32(b64([0x7f, 0x00, 0x00]), first.carry);
    expect(second.samples).toHaveLength(2);
    expect(second.samples[0]).toBeCloseTo(1, 4); // reassembled across the split
    expect(second.samples[1]).toBe(0);
    expect(second.carry).toHaveLength(0);
  });
});

describe('computePeaks', () => {
  it('returns the requested number of buckets', () => {
    const s = new Float32Array(1000).map((_, i) => Math.sin(i / 5));
    expect(computePeaks(s, 16)).toHaveLength(16);
  });

  it('normalizes peaks into 0..1 with the max bucket at 1', () => {
    const s = new Float32Array(100).fill(0);
    s[50] = 0.5; // single loud sample
    const peaks = computePeaks(s, 10);
    expect(Math.max(...peaks)).toBeCloseTo(1, 5);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0);
  });

  it('handles silence without NaN', () => {
    const peaks = computePeaks(new Float32Array(100), 8);
    expect(peaks.every((p) => Number.isFinite(p))).toBe(true);
  });
});
