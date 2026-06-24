import { describe, it, expect, beforeEach } from 'vitest';
import { maturity } from '../maturity';

beforeEach(() => {
  localStorage.clear();
});

describe('maturity store', () => {
  it('returns 0 when localStorage has no entry', () => {
    expect(maturity.load()).toBe(0);
  });

  it('save + load round-trips a positive value', () => {
    maturity.save(3.5);
    expect(maturity.load()).toBe(3.5);
  });

  it('save returns the stored value', () => {
    const result = maturity.save(2);
    expect(result).toBe(2);
  });

  it('is monotonic — save never decreases below current floor', () => {
    maturity.save(5);
    maturity.save(2); // lower value — should be ignored
    expect(maturity.load()).toBe(5);
  });

  it('save returns the existing floor when given a lower value', () => {
    maturity.save(5);
    const result = maturity.save(1);
    expect(result).toBe(5);
  });

  it('clamps negative values to 0', () => {
    maturity.save(-10);
    expect(maturity.load()).toBe(0);
  });

  it('returns 0 for non-finite stored values', () => {
    localStorage.setItem('feral.fractal.maturityFloor', 'NaN');
    expect(maturity.load()).toBe(0);
  });

  it('returns 0 for zero stored explicitly', () => {
    localStorage.setItem('feral.fractal.maturityFloor', '0');
    expect(maturity.load()).toBe(0);
  });

  it('can be bumped incrementally', () => {
    maturity.save(1);
    maturity.save(3);
    maturity.save(2); // below current — stays at 3
    maturity.save(7);
    expect(maturity.load()).toBe(7);
  });
});
