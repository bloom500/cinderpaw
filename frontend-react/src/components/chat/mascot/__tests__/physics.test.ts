import { describe, it, expect } from 'vitest';
import { atRest, step, type Body } from '../physics';

const FRAME = 1 / 60;
const WIDE = { minX: -1_000, maxX: 1_000 };

/** Run the body until it stops, or give up. The cap is the guard: a bounce
 *  that keeps half its speed forever never settles, and a test that waits for
 *  it would hang rather than fail. */
function settle(body: Body, bounds = WIDE, maxFrames = 600) {
  let b = body;
  let frames = 0;
  while (frames < maxFrames) {
    b = step(b, FRAME, bounds).body;
    frames++;
    if (atRest(b)) return { body: b, frames };
  }
  return { body: b, frames: Infinity };
}

describe('mascot physics', () => {
  it('a creature let go in mid-air falls to the perch and stops', () => {
    const { body, frames } = settle({ x: 0, y: -200, vx: 0, vy: 0 });
    expect(body.y).toBe(0);
    expect(atRest(body)).toBe(true);
    // Under two seconds, or the drop reads as slow motion rather than a drop.
    expect(frames).toBeLessThan(120);
  });

  it('bounces off the floor before it settles, rather than sticking on contact', () => {
    let b: Body = { x: 0, y: -200, vx: 0, vy: 0 };
    let bounces = 0;
    for (let i = 0; i < 600 && !atRest(b); i++) {
      const r = step(b, FRAME, WIDE);
      // A landing that sends it back up is a bounce; the last one does not.
      if (r.landed && r.body.vy < 0) bounces++;
      b = r.body;
    }
    expect(bounces).toBeGreaterThanOrEqual(2);
  });

  it('cannot be thrown out of the composer', () => {
    const bounds = { minX: -20, maxX: 120 };
    const { body } = settle({ x: 100, y: -50, vx: 4_000, vy: 0 }, bounds);
    expect(body.x).toBeLessThanOrEqual(bounds.maxX);
    expect(body.x).toBeGreaterThanOrEqual(bounds.minX);
  });

  it('a hard throw still comes to rest', () => {
    const { body, frames } = settle({ x: 0, y: -10, vx: 3_000, vy: -3_000 }, { minX: -200, maxX: 200 });
    expect(frames).not.toBe(Infinity);
    expect(atRest(body)).toBe(true);
  });

  it('never sits still in the air', () => {
    // One frame of a body at the top of its arc: speed is momentarily zero in
    // both axes, and calling that "at rest" would strand it mid-air.
    const b: Body = { x: 0, y: -100, vx: 0, vy: 0 };
    expect(atRest(b)).toBe(false);
    expect(step(b, FRAME, WIDE).body.vy).toBeGreaterThan(0);
  });

  it('a long stalled frame does not teleport it through the floor', () => {
    // The caller clamps `dt`, and this is why: a whole second integrated at
    // once puts it 1100px below a floor it never touched.
    const oneSecond = step({ x: 0, y: -20, vx: 0, vy: 0 }, 1, WIDE).body;
    expect(oneSecond.y).toBe(0);
  });
});
