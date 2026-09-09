import { describe, it, expect, beforeEach } from 'vitest';
import {
  EMPTY_BOND,
  forcedTier,
  loadBond,
  saveBond,
  score,
  tierFor,
  traitsFor,
  type Bond,
} from '../familiarity';

const bond = (p: Partial<Bond>): Bond => ({ ...EMPTY_BOND, ...p });

beforeEach(() => window.localStorage.clear());

describe('tiers', () => {
  it('a machine that has never been set up is tier 0', () => {
    expect(tierFor(EMPTY_BOND)).toBe(0);
  });

  it('never goes down, whatever is added', () => {
    let last = 0;
    for (let n = 0; n < 200; n += 7) {
      const t = tierFor(bond({ pokes: n, sessions: n, turns: n, throws: n }));
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });

  it('working together outweighs poking it', () => {
    // Ten finished turns beat ten pokes, or the fastest bond is clicking.
    expect(score(bond({ turns: 10 }))).toBeGreaterThan(score(bond({ pokes: 10 })));
  });

  it('cannot be maxed out in one afternoon of clicking', () => {
    expect(tierFor(bond({ pokes: 200, sessions: 1 }))).toBeLessThan(3);
  });
});

describe('traits', () => {
  it('every tier is a complete creature, tier 0 included', () => {
    for (const t of [0, 1, 2, 3] as const) {
      const tr = traitsFor(t);
      expect(tr.pokesToSmitten).toBeGreaterThan(0);
      expect(tr.smittenMs).toBeGreaterThan(0);
      expect(['surprised', 'wave']).toContain(tr.greeting);
    }
  });

  it('a familiar creature warms up in fewer pokes', () => {
    expect(traitsFor(3).pokesToSmitten).toBeLessThan(traitsFor(0).pokesToSmitten);
  });
});

describe('storage', () => {
  it('round-trips', () => {
    const b = bond({ pokes: 3, throws: 1, sessions: 9, turns: 4 });
    saveBond(b);
    expect(loadBond()).toEqual(b);
  });

  it('a corrupt value costs the counter, not the history', () => {
    window.localStorage.setItem('cinderpaw.bond.v1', '{"pokes":"lots","sessions":9}');
    expect(loadBond()).toEqual(bond({ sessions: 9 }));
  });

  it('unparseable storage reads as a fresh install rather than throwing', () => {
    window.localStorage.setItem('cinderpaw.bond.v1', 'not json');
    expect(loadBond()).toEqual(EMPTY_BOND);
  });

  it('refuses counters that would run the tier backwards', () => {
    window.localStorage.setItem('cinderpaw.bond.v1', '{"pokes":-500}');
    expect(loadBond().pokes).toBe(0);
  });
});

describe('forced tier', () => {
  it('is null when nobody asked', () => {
    expect(forcedTier()).toBeNull();
  });

  it('shows a tier that has not been earned, so it can be looked at', () => {
    window.localStorage.setItem('cinderpaw.bond.force', '3');
    expect(forcedTier()).toBe(3);
  });

  it('ignores nonsense instead of picking a tier from it', () => {
    window.localStorage.setItem('cinderpaw.bond.force', '9');
    expect(forcedTier()).toBeNull();
  });
});
