import { describe, it, expect } from 'vitest';
import { GROUPS, frameFor, artUrl, FRAME_W, FRAME_H, type MascotState } from '../frames';

const ALL_STATES: MascotState[] = [
  'idle', 'typing', 'thinking', 'calling', 'done', 'running',
  'wave', 'sleep', 'surprised', 'curious', 'celebrate',
  'reading', 'searching', 'building', 'writing',
  'stretching', 'gaming', 'love', 'cool', 'error', 'excited',
  'spawning', 'meditating',
];

// Corpul e unul singur, fetele si propsurile difera pe stari. Testele pazesc
// catalogul: fiecare stare are cadre, ciclarea e determinista, iar tranzitiile
// cu doua cadre chiar misca.

describe('mascot states catalog', () => {
  it('defines at least one frame for every state', () => {
    for (const s of ALL_STATES) {
      expect(GROUPS[s].length, `${s} has no frames`).toBeGreaterThanOrEqual(1);
    }
  });

  it('frame choice is a pure function of state and tick', () => {
    for (const s of ALL_STATES) {
      expect(frameFor(s, 7)).toBe(frameFor(s, 7));
    }
  });

  it('single-frame states hold still', () => {
    expect(frameFor('typing', 0)).toBe(frameFor('typing', 99));
    expect(frameFor('running', 3)).toBe(frameFor('running', 4));
  });

  it('two-frame transitions actually move', () => {
    for (const s of ['thinking', 'calling', 'done', 'error'] as MascotState[]) {
      expect(GROUPS[s].length, `${s} lost its transition`).toBe(2);
      expect(frameFor(s, 0), `${s} never changes`).not.toBe(frameFor(s, 1));
    }
  });

  it('idle blinks and looks around inside its loop', () => {
    expect(GROUPS.idle.length).toBe(4);
    expect(new Set(GROUPS.idle).size).toBe(4);
  });

  it('artUrl resolves every catalogued frame and rejects unknown names', () => {
    for (const s of ALL_STATES) {
      for (const name of GROUPS[s]) {
        expect(typeof artUrl(name), name).toBe('string');
        expect(artUrl(name).length, name).toBeGreaterThan(0);
      }
    }
    expect(() => artUrl('nu-exista-asa-ceva')).toThrow();
  });

  it('art is 32px cells shown at 64', () => {
    expect(FRAME_W).toBe(32);
    expect(FRAME_H).toBe(32);
  });

  it('spot-check: thinking grows its bubble', () => {
    expect(GROUPS.thinking).toEqual(['thinking-1', 'thinking-2']);
  });
});
