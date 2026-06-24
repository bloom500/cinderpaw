import { describe, it, expect } from 'vitest';
import { mulberry32, hashSeed } from '../rng';

describe('mulberry32', () => {
  it('is deterministic for the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0,1) and differs across seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const va = a(), vb = b();
    expect(va).toBeGreaterThanOrEqual(0);
    expect(va).toBeLessThan(1);
    expect(va).not.toEqual(vb);
  });

  it('hashSeed maps strings to stable 32-bit seeds', () => {
    expect(hashSeed('feral')).toBe(hashSeed('feral'));
    expect(hashSeed('feral')).not.toBe(hashSeed('feline'));
    expect(Number.isInteger(hashSeed('x'))).toBe(true);
  });
});
