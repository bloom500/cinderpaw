import { describe, it, expect } from 'vitest';
import { screenToComplex, complexToScreen, DEFAULT_VIEW } from '@/lib/fractal/organism';

describe('organism projection', () => {
  const W = 800, H = 600;
  it('screen center maps to the view center', () => {
    const c = screenToComplex(W / 2, H / 2, W, H, DEFAULT_VIEW);
    expect(c.x).toBeCloseTo(DEFAULT_VIEW.centerX, 6);
    expect(c.y).toBeCloseTo(DEFAULT_VIEW.centerY, 6);
  });
  it('complexToScreen inverts screenToComplex', () => {
    const v = { centerX: -0.4, centerY: 0.15, scale: 0.01 };
    const c = screenToComplex(123, 456, W, H, v);
    const s = complexToScreen(c.x, c.y, W, H, v);
    expect(s.px).toBeCloseTo(123, 4);
    expect(s.py).toBeCloseTo(456, 4);
  });
});
