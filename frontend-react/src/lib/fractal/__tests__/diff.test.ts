import { describe, it, expect } from 'vitest';
import { diffNodes } from '@/lib/fractal/diff';

describe('diffNodes', () => {
  it('classifies born / extinct / surviving', () => {
    const d = diffNodes(['a', 'b', 'c'], ['b', 'c', 'd']);
    expect([...d.born]).toEqual(['d']);
    expect([...d.extinct]).toEqual(['a']);
    expect([...d.surviving].sort()).toEqual(['b', 'c']);
    expect(d.changed).toBe(true);
  });
  it('changed is false for identical sets', () => {
    const d = diffNodes(['a', 'b'], ['b', 'a']);
    expect(d.changed).toBe(false);
    expect(d.born.size).toBe(0);
    expect(d.extinct.size).toBe(0);
  });
});
