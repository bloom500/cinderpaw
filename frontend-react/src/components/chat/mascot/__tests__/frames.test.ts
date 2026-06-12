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

  it('per-state variant counts match the v2 redesign', () => {
    const expected: Record<MascotState, number> = {
      idle: 5, typing: 3, thinking: 4, calling: 4, done: 4, running: 2,
      wave: 2, sleep: 3, surprised: 2, curious: 3, celebrate: 4,
      reading: 2, searching: 2, building: 2, writing: 2,
      stretching: 2, gaming: 2, love: 2, cool: 2, error: 3, excited: 2,
      spawning: 2,
    };
    for (const s of ALL_STATES) {
      expect(VARIANTS[s].length, `variants for ${s}`).toBe(expected[s]);
    }
  });

  it('total variant count stays in the 50-60 range', () => {
    const total = ALL_STATES.reduce((n, s) => n + VARIANTS[s].length, 0);
    expect(total).toBeGreaterThanOrEqual(50);
    expect(total).toBeLessThanOrEqual(60);
  });

  it('every variant animates: multi-frame cycles are not all identical', () => {
    for (const s of ALL_STATES) {
      for (const variant of VARIANTS[s]) {
        if (variant.length < 2) continue;
        const allSame = variant.every(f => f.join('') === variant[0].join(''));
        expect(allSame, `static multi-frame variant in ${s}`).toBe(false);
      }
    }
  });
});
