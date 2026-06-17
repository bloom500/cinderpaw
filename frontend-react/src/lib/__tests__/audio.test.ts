import { describe, it, expect } from 'vitest';
import { computePeaks } from '../audio';

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
