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
  it('is conjugate-symmetric (real-axis mirror) with no shear', () => {
    // z^2 + c commutes with conjugation, so (x, y) and (x, -y) escape identically.
    // This symmetry is exactly what reads as the "doubled" fractal on screen.
    expect(escapeTime(-0.5, 0.5, 256)).toBe(escapeTime(-0.5, -0.5, 256));
  });
  it('breaks the real-axis mirror when sheared', () => {
    // A shear cx += shear*cy is not invariant under y -> -y, so the upper and
    // lower halves diverge — the on-screen mirror disappears.
    const up = escapeTime(-0.5, 0.5, 256, 0.3);
    const down = escapeTime(-0.5, -0.5, 256, 0.3);
    expect(up).not.toBe(down);
  });
});

describe('filamentTangent', () => {
  it('returns a unit-length vector near the boundary', () => {
    const { tx, ty } = filamentTangent(-0.75, 0.1, 256, 1e-4);
    expect(Math.hypot(tx, ty)).toBeCloseTo(1, 6);
  });
});
