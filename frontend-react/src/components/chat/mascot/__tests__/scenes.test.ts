import { describe, it, expect } from 'vitest';
import { SCENES, sceneFor } from '../scenes';
import { FX_MARGIN_X, FX_MARGIN_TOP } from '../effects';
import { VARIANTS, FRAME_W, FRAME_H, type MascotState } from '../frames';

const CANVAS_W = 44;
const CANVAS_H = 38;
const Y0 = FX_MARGIN_TOP + 1;

/**
 * Where the creature can be, in ANY pose.
 *
 * Not the resting frame: a state animates, so `wave` raises an arm and
 * `celebrate` throws both up. Measuring against the resting pose alone is how
 * scenes ended up welded to a limb that only appears while it moves.
 */
const occupied = new Set<string>();
for (const variants of Object.values(VARIANTS)) {
  for (const variant of variants) {
    for (const frame of variant) {
      frame.forEach((row, r) => {
        [...row].forEach((ch, c) => {
          if (ch !== '.') occupied.add(`${Y0 + r},${FX_MARGIN_X + c}`);
        });
      });
    }
  }
}

/** Both positions `sceneFor` draws a scene in: at rest, and lifted one cell. */
const LIFTS = [0, 1];

describe('mascot scenes', () => {
  /**
   * This is the whole point of the file under test.
   *
   * The props used to be carved INTO the 16x16 body, two to four pixels each,
   * and at that size they read as damage to the animal rather than as objects.
   * They live in the margin now, and this is the check that keeps them there:
   * a prop that overlaps any pose is that bug coming back.
   */
  it('no prop is ever drawn on the creature, in any pose, at either lift', () => {
    for (const [state, group] of Object.entries(SCENES)) {
      group.forEach((scene, i) => {
        for (const lift of LIFTS) {
          const hit = scene.filter(([x, y]) => occupied.has(`${y + lift},${x}`));
          expect(hit.length, `${state} scene ${i + 1} lands ${hit.length} px on the body (lift ${lift}) at ${JSON.stringify(hit.slice(0, 3))}`).toBe(0);
        }
      });
    }
  });

  it('no prop is drawn outside the canvas', () => {
    // Off the bottom is the composer's text field, which is why the canvas
    // grows upward and sideways only. A prop clipped there covers what
    // somebody is typing.
    for (const [state, group] of Object.entries(SCENES)) {
      group.forEach((scene, i) => {
        for (const lift of LIFTS) {
          const out = scene.filter(
            ([x, y]) => x < 0 || x >= CANVAS_W || y + lift < 0 || y + lift >= CANVAS_H,
          );
          expect(out.length, `${state} scene ${i + 1} puts ${out.length} px off-canvas (lift ${lift})`).toBe(0);
        }
      });
    }
  });

  it('the states a stranger sees most are not empty rooms', () => {
    // `idle` is every second the app is open, `typing` every second they spend
    // writing, `stretching` what a poke or a drop lands on. Somebody who never
    // starts a turn should still see a creature in a room.
    for (const s of ['idle', 'typing', 'stretching'] as MascotState[]) {
      expect(sceneFor(s, 0).length, `${s} has no scene`).toBeGreaterThan(10);
    }
  });

  it('a scene holds still while the state does', () => {
    // Variety comes from ENTERING a state, never from a prop swapping itself
    // while somebody is reading. Only the one-cell lift may move.
    sceneFor('idle', 0);
    const a = sceneFor('calling', 0);
    const b = sceneFor('calling', 4); // a tick later, and one cell lower
    expect(a.map((p) => `${p.x},${p.color}`)).toEqual(b.map((p) => `${p.x},${p.color}`));
    expect(b.every((p, i) => p.y - a[i].y === 1)).toBe(true);
  });
});

// Referenced so a change to the sprite size is a compile error here too.
void FRAME_W;
void FRAME_H;
