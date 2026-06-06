import { describe, it, expect } from 'vitest';
import { FRAMES, FRAME_W, FRAME_H, PALETTE, type MascotState } from '../frames';

const STATES: MascotState[] = ['idle', 'typing', 'thinking', 'calling', 'done', 'running'];

describe('mascot frames', () => {
  it('defines at least one frame for every state', () => {
    for (const s of STATES) {
      expect(FRAMES[s].length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every frame is FRAME_H rows of FRAME_W chars', () => {
    for (const s of STATES) {
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
    for (const s of STATES) {
      for (const frame of FRAMES[s]) {
        for (const row of frame) {
          for (const ch of row) {
            expect(keys.has(ch)).toBe(true);
          }
        }
      }
    }
  });
});
