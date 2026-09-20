import { describe, it, expect } from 'vitest';
import {
  FRAMES, VARIANTS, FRAME_W, FRAME_H, FRAME_COUNT, SHEET_COLS, type MascotState,
} from '../frames';

const ALL_STATES = Object.keys(VARIANTS) as MascotState[];

describe('mascot frames (sheet index)', () => {
  it('defines at least one frame for every state', () => {
    for (const s of ALL_STATES) {
      expect(FRAMES[s].length, s).toBeGreaterThanOrEqual(1);
    }
  });

  it('every frame index points inside the sheet', () => {
    for (const s of ALL_STATES) {
      for (const variant of VARIANTS[s]) {
        expect(variant.length, `variant of ${s}`).toBeGreaterThanOrEqual(1);
        for (const f of variant) {
          expect(Number.isInteger(f)).toBe(true);
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThan(FRAME_COUNT);
        }
      }
    }
  });

  it('every drawn frame in the sheet is used, and FRAME_COUNT matches', () => {
    // The generator writes sheet.png and FRAME_COUNT together; an index past the
    // sheet would draw blank. SHEET_COLS / FRAME_W / FRAME_H are the renderer's
    // source-rect arithmetic, so they are asserted to be sane here too.
    const used = new Set<number>();
    for (const s of ALL_STATES) for (const v of VARIANTS[s]) for (const f of v) used.add(f);
    expect(Math.max(...used) + 1).toBe(FRAME_COUNT);
    expect(used.size).toBe(FRAME_COUNT);
    expect(SHEET_COLS).toBeGreaterThan(0);
    expect(FRAME_W).toBe(64);
    expect(FRAME_H).toBe(64);
  });

  it('FRAMES[s] equals VARIANTS[s][0]', () => {
    for (const s of ALL_STATES) {
      expect(FRAMES[s]).toEqual(VARIANTS[s][0]);
    }
  });

  it('the 22 states the app already drives are all present', () => {
    for (const s of [
      'idle', 'typing', 'thinking', 'calling', 'done', 'running',
      'wave', 'sleep', 'surprised', 'curious', 'celebrate',
      'reading', 'searching', 'building', 'writing',
      'stretching', 'gaming', 'love', 'cool', 'error', 'excited',
      'spawning',
    ] as MascotState[]) {
      expect(VARIANTS[s], s).toBeDefined();
    }
  });

  // Static states are allowed (a held pose), but the ones people watch most must move.
  it('core motion states animate', () => {
    for (const s of ['idle', 'running', 'sleep', 'curious', 'typing'] as MascotState[]) {
      const variant = VARIANTS[s][0];
      expect(new Set(variant).size, `first variant of ${s} should animate`).toBeGreaterThan(1);
    }
  });

  it('holds are expressed as repeated indices, never as a frame skipped', () => {
    // A variant is a run of ticks; every drawn frame it uses appears in a contiguous run.
    for (const s of ALL_STATES) {
      for (const variant of VARIANTS[s]) {
        const seen = new Set<number>();
        let prev = -1;
        for (const f of variant) {
          if (f !== prev) {
            expect(seen.has(f), `frame ${f} reappears out of order in ${s}`).toBe(false);
            seen.add(f);
          }
          prev = f;
        }
      }
    }
  });
});
