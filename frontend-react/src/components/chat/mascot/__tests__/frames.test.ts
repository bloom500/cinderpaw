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

  it('idle has 7 variants', () => {
    expect(VARIANTS.idle.length).toBe(7);
  });

  it('calling has 10 variants', () => {
    expect(VARIANTS.calling.length).toBe(10);
  });

  it('done has 6 variants', () => {
    expect(VARIANTS.done.length).toBe(6);
  });

  it('thinking has 6 variants', () => {
    expect(VARIANTS.thinking.length).toBe(6);
  });

  it('typing has 4 variants', () => {
    expect(VARIANTS.typing.length).toBe(4);
  });

  it('wave has 4 variants', () => {
    expect(VARIANTS.wave.length).toBe(4);
  });

  it('sleep has 3 variants', () => {
    expect(VARIANTS.sleep.length).toBe(3);
  });

  it('surprised has 4 variants', () => {
    expect(VARIANTS.surprised.length).toBe(4);
  });

  it('celebrate has 5 variants', () => {
    expect(VARIANTS.celebrate.length).toBe(5);
  });

  it('running has 3 variants', () => {
    expect(VARIANTS.running.length).toBe(3);
  });

  it('curious has 3 variants', () => {
    expect(VARIANTS.curious.length).toBe(3);
  });

  it('gaming has 2 variants', () => {
    expect(VARIANTS.gaming.length).toBe(2);
  });

  it('cool has 2 variants', () => {
    expect(VARIANTS.cool.length).toBe(2);
  });

  it('error has 3 variants', () => {
    expect(VARIANTS.error.length).toBe(3);
  });
});
