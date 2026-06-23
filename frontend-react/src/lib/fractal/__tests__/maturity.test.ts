import { describe, it, expect, beforeEach } from 'vitest';
import { maturity } from '@/lib/fractal/maturity';

beforeEach(() => localStorage.clear());

describe('maturity floor', () => {
  it('starts at 0 when unset', () => {
    expect(maturity.current()).toBe(0);
  });
  it('bump is max-only (never decreases)', () => {
    maturity.bump(300);
    expect(maturity.current()).toBe(300);
    maturity.bump(120);
    expect(maturity.current()).toBe(300);
    maturity.bump(450);
    expect(maturity.current()).toBe(450);
  });
  it('negative bumps are floored at the current value', () => {
    maturity.bump(100);
    expect(maturity.bump(-50)).toBe(100);
  });
});
