import { describe, it, expect } from 'vitest';
import { screenToComplex, complexToScreen, SEAHORSE_VIEW } from '@/lib/fractal/mandelbrot';

describe('mandelbrot projection', () => {
  const W = 800, H = 600;
  it('screen center maps to the view center', () => {
    const c = screenToComplex(W / 2, H / 2, W, H, SEAHORSE_VIEW);
    expect(c.x).toBeCloseTo(SEAHORSE_VIEW.centerX, 6);
    expect(c.y).toBeCloseTo(SEAHORSE_VIEW.centerY, 6);
  });
  it('complexToScreen is the inverse of screenToComplex', () => {
    const view = { centerX: -0.5, centerY: 0.2, scale: 0.004 };
    const back = complexToScreen(
      ...(Object.values(screenToComplex(123, 456, W, H, view)) as [number, number]),
      W, H, view,
    );
    expect(back.px).toBeCloseTo(123, 4);
    expect(back.py).toBeCloseTo(456, 4);
  });
  it('zooming in (smaller scale) shrinks the complex span', () => {
    const wide = screenToComplex(0, H / 2, W, H, { centerX: 0, centerY: 0, scale: 0.01 });
    const deep = screenToComplex(0, H / 2, W, H, { centerX: 0, centerY: 0, scale: 0.001 });
    expect(Math.abs(deep.x)).toBeLessThan(Math.abs(wide.x));
  });
});
