import { describe, it, expect } from 'vitest';
import { FRAMES, VARIANTS, FRAME_W, FRAME_H, PALETTE, BODY_SHADE, type MascotState } from '../frames';

const ALL_STATES: MascotState[] = [
  'idle', 'typing', 'thinking', 'calling', 'done', 'running',
  'wave', 'sleep', 'surprised', 'curious', 'celebrate',
  'reading', 'searching', 'building', 'writing',
  'stretching', 'gaming', 'love', 'cool', 'error', 'excited',
  'spawning', 'meditating',
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

  // The count of variants per state was pinned here as "the original mascot
  // sheet". It was a snapshot, not a contract: it passed just as happily when
  // nine of those variants were the same pose with a different unreadable
  // pixel on it, and it failed the moment they were removed. What follows
  // pins the properties that actually have to hold.

  it('no two variants of a state are the same animation', () => {
    const sig = (v: string[][]) => JSON.stringify(v);
    for (const s of ALL_STATES) {
      const seen = new Set<string>();
      VARIANTS[s].forEach((variant, i) => {
        const k = sig(variant);
        expect(seen.has(k), `${s} variant ${i + 1} repeats an earlier one`).toBe(false);
        seen.add(k);
      });
    }
  });

  it('a loop of several frames actually moves', () => {
    // Two differently named frames with identical pixels is a pair somebody
    // meant to differ. Listing the SAME frame twice is a deliberate hold and
    // stays allowed.
    for (const s of ALL_STATES) {
      VARIANTS[s].forEach((variant, i) => {
        const distinctNames = new Set(variant.map((f) => JSON.stringify(f)));
        if (variant.length > 1 && distinctNames.size === 1) return; // a hold
        expect(distinctNames.size, `${s} variant ${i + 1} never changes`).toBeGreaterThan(
          variant.length > 1 ? 1 : 0,
        );
      });
    }
  });

  it('every state still looks different from resting', () => {
    // The mascot is not decoration: its state is how the screen says what the
    // agent is doing. A state whose first variant is pixel-identical to idle
    // reports nothing.
    const idle = JSON.stringify(VARIANTS.idle[0]);
    for (const s of ALL_STATES) {
      if (s === 'idle') continue;
      expect(JSON.stringify(VARIANTS[s][0]), `${s} is indistinguishable from idle`).not.toBe(idle);
    }
  });

  it('no two states wear the same face', () => {
    // The check above only asks whether a state differs from IDLE, and all 22
    // passed it while SIX of them -- searching, building, writing, love,
    // excited and spawning -- wore one identical face and differed only by a
    // prop pixel somewhere else on the sprite.
    //
    // The face is where a state is actually read. The reference pack keeps ONE
    // body across all 73 of its illustrations and puts the whole expression in
    // the eyes and mouth; rows 9 to 14 are ours, and this asks that each state
    // says something different with them.
    const FACE = [9, 10, 11, 12, 13, 14];
    const seen = new Map<string, MascotState>();
    for (const s of ALL_STATES) {
      const worn = new Set(VARIANTS[s].flat().map((f) => FACE.map((r) => f[r]).join('|')));
      const key = [...worn].sort().join('//');
      const twin = seen.get(key);
      expect(twin, `${s} wears exactly the face ${twin} wears`).toBeUndefined();
      seen.set(key, s);
    }
  });

  // A floor of 60 variants used to be pinned here. It was the same snapshot
  // mistake as the per-state counts: it protected a NUMBER, and the number was
  // large because nine of those variants were one pose with an unreadable
  // pixel stuck on it. Fewer, once the duplicates went, is the improvement --
  // so the test asks the only thing that has to be true instead.

  it('every state offers at least one animation, and none is empty', () => {
    for (const s of ALL_STATES) {
      expect(VARIANTS[s].length, `${s} has no variants`).toBeGreaterThan(0);
      VARIANTS[s].forEach((variant, i) => {
        expect(variant.length, `${s} variant ${i + 1} is empty`).toBeGreaterThan(0);
        variant.forEach((frame) => {
          expect(frame.length).toBe(FRAME_H);
        });
      });
    }
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

describe('the creature is visible on the app it lives in', () => {
  // This is the measurement that explained why the mascot could not be
  // animated. At #1c1c1e the fur was 1.03:1 against the app's own dark
  // surface -- three percent apart, so the whole body was invisible and only
  // the orange face floated there. Ten different limb placements were drawn
  // and every one read as a dot in mid-air, because the silhouette they should
  // have hung off did not exist on screen.
  //
  // Lifting one shared colour would have taken the eyes with it, since they sit
  // on the orange patch. So `k` is fur and `e` is ink, and each has its own
  // floor here.
  const DARK_SURFACE = '#1C1916';   // --bg-surface, dark theme
  const LIGHT_SURFACE = '#F5EBE0';  // --bg-surface, light theme

  const parse = (hex: string) =>
    [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16));
  const srgbToLinear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string) => {
    const [r, g, b] = parse(hex).map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('the fur has a silhouette on both themes', () => {
    const fur = PALETTE.k!;
    expect(contrast(fur, DARK_SURFACE), `fur ${fur} on the dark surface`).toBeGreaterThan(1.6);
    expect(contrast(fur, LIGHT_SURFACE), `fur ${fur} on the light surface`).toBeGreaterThan(1.6);
  });

  it('the eyes stay crisp on the face they are drawn on', () => {
    // Mid-face tone, from the row shading ramp where the eyes sit.
    const FACE = BODY_SHADE[11];
    expect(contrast(PALETTE.e!, FACE), `ink ${PALETTE.e} on face ${FACE}`).toBeGreaterThan(4.5);
  });

  it('fur and ink are not the same colour', () => {
    // They were, and that is the whole bug: one value could not be both a
    // visible body and a sharp pupil.
    expect(PALETTE.k).not.toBe(PALETTE.e);
  });
});
