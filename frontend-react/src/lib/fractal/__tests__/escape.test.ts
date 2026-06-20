import { describe, it, expect } from 'vitest';
import { escapeTime, filamentTangent } from '@/lib/fractal/escape';

describe('escapeTime', () => {
  it('returns maxIter for an interior point (origin is in the set)', () => {
    expect(escapeTime(0, 0, 256)).toBe(256);
  });
  it('returns a small smooth count for a fast-escaping point', () => {
    const t = escapeTime(2.0, 2.0, 256);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(5);
  });
});

describe('filamentTangent', () => {
  it('returns a unit-length vector near the boundary', () => {
    const { tx, ty } = filamentTangent(-0.75, 0.1, 256, 1e-4);
    expect(Math.hypot(tx, ty)).toBeCloseTo(1, 6);
  });
});
