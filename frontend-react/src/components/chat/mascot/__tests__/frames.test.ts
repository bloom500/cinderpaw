import { describe, it, expect } from 'vitest';
import { FRAMES, VARIANTS, FRAME_W, FRAME_H, PALETTE, type MascotState } from '../frames';

const ALL_STATES: MascotState[] = [
  'idle', 'typing', 'thinking', 'calling', 'done', 'running',
  'wave', 'sleep', 'surprised', 'curious', 'celebrate',
  'reading', 'searching', 'building', 'writing',
  'stretching', 'gaming', 'love', 'cool', 'error', 'excited',
  'spawning',
];

describe('mascot frames', () => {
  it('defines at least one frame for every state', () => {
    for (const s of ALL_STATES) {
      expect(FRAMES[s].length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every frame is FRAME_H rows of FRAME_W chars', () => {
    for (const s of ALL_STATES) {
      for (const frame of FRAMES[s]) {
        expect(frame).toHaveLength(FRAME_H);
        for (const row of frame) {
          expect(row).toHaveLength(FRAME_W);
        }
      }
    }
  });

  it('every pixel char is a known palette key', () => {
    const keys = new Set(Object.keys(PALETTE));
    for (const s of ALL_STATES) {
      for (const frame of FRAMES[s]) {
        for (const row of frame) {
          for (const ch of row) {
            expect(keys.has(ch)).toBe(true);
          }
        }
      }
    }
  });

  it('sleep has more than one distinct frame (breathing animation)', () => {
    const frames = FRAMES.sleep;
    expect(frames.length).toBeGreaterThan(1);
    const allSame = frames.every(f => f.join('') === frames[0].join(''));
    expect(allSame).toBe(false);
  });

  it('curious has more than one distinct frame (head-tilt animation)', () => {
    const frames = FRAMES.curious;
    expect(frames.length).toBeGreaterThan(1);
    const allSame = frames.every(f => f.join('') === frames[0].join(''));
    expect(allSame).toBe(false);
  });
});

describe('mascot variants', () => {
  it('defines at least one variant for every state', () => {
    for (const s of ALL_STATES) {
      expect(VARIANTS[s].length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every variant has at least one frame', () => {
    for (const s of ALL_STATES) {
      for (const variant of VARIANTS[s]) {
        expect(variant.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('every variant frame is FRAME_H rows of FRAME_W chars', () => {
    for (const s of ALL_STATES) {
      for (const variant of VARIANTS[s]) {
        for (const frame of variant) {
          expect(frame).toHaveLength(FRAME_H);
          for (const row of frame) {
            expect(row).toHaveLength(FRAME_W);
          }
        }
      }
    }
  });

  it('every pixel in every variant is a known palette key', () => {
    const keys = new Set(Object.keys(PALETTE));
    for (const s of ALL_STATES) {
      for (const variant of VARIANTS[s]) {
        for (const frame of variant) {
          for (const row of frame) {
            for (const ch of row) {
              expect(keys.has(ch)).toBe(true);
            }
          }
        }
      }
    }
  });

  it('FRAMES[s] equals VARIANTS[s][0] for backwards compat', () => {
    for (const s of ALL_STATES) {
      expect(FRAMES[s]).toEqual(VARIANTS[s][0]);
    }
  });

  it('per-state variant counts match the original mascot sheet', () => {
    const expected: Record<MascotState, number> = {
      idle: 7, typing: 4, thinking: 6, calling: 10, done: 6, running: 3,
      wave: 4, sleep: 3, surprised: 4, curious: 3, celebrate: 5,
      reading: 1, searching: 1, building: 1, writing: 1,
      stretching: 1, gaming: 2, love: 1, cool: 2, error: 3, excited: 1,
      spawning: 1,
    };
    for (const s of ALL_STATES) {
      expect(VARIANTS[s].length, `variants for ${s}`).toBe(expected[s]);
    }
  });

  it('total variant count stays in the 60-80 range', () => {
    const total = ALL_STATES.reduce((n, s) => n + VARIANTS[s].length, 0);
    expect(total).toBeGreaterThanOrEqual(60);
    expect(total).toBeLessThanOrEqual(80);
  });

  // The original sheet intentionally contains some static poses (duplicated
  // frames) — only the core motion states are required to animate.
  it('core motion states animate', () => {
    for (const s of ['idle', 'running', 'sleep'] as MascotState[]) {
      const variant = VARIANTS[s][0];
      const allSame = variant.every(f => f.join('') === variant[0].join(''));
      expect(allSame, `first variant of ${s} should animate`).toBe(false);
    }
  });
});
