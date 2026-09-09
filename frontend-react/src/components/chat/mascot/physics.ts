/**
 * The bit of physics a draggable pet needs, and not one term more.
 *
 * Kept out of the component and free of React on purpose: a step function that
 * takes a body and a slice of time and hands back the next body is something a
 * test can drive frame by frame, and something a person reading the numbers can
 * change without understanding the perch at all. The perch owns the pointer and
 * the render loop; this file owns gravity.
 *
 * Units are pixels and SECONDS. Every constant below is therefore readable out
 * loud: gravity is 2200 pixels per second per second, the creature keeps 42% of
 * its speed through a bounce. Per-frame constants would have been shorter to
 * write and would silently mean something different on a 120Hz screen.
 */

export interface Body {
  /** Offset from the perch. `y` grows DOWNWARD like every other screen
   *  coordinate, so the perch floor is `y = 0` and being held up in the air is
   *  a negative `y`. */
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
}

const GRAVITY = 2_200;
/** Speed kept after hitting the floor. Under a half, so a drop settles in two
 *  or three visible bounces instead of pattering for a second and a half. */
const FLOOR_BOUNCE = 0.42;
const WALL_BOUNCE = 0.5;
/** Sideways speed lost per floor contact, and per second in the air. Landing
 *  scrubs speed much faster than flying does, which is what makes a dropped
 *  thing stop rather than skate. */
const FLOOR_FRICTION = 0.72;
const AIR_DRAG_PER_S = 0.6;
/** Below this, in pixels per second, it has stopped. Without a floor like this
 *  a bounce halves forever and the creature never comes to rest. */
const REST_SPEED = 40;

/** One step of free flight. `dt` is seconds; the caller clamps it. */
export function step(body: Body, dt: number, bounds: Bounds): { body: Body; landed: boolean } {
  let { x, y, vx, vy } = body;
  let landed = false;

  vy += GRAVITY * dt;
  // Exponential decay rather than a straight subtraction: subtracting a fixed
  // amount per frame can drive the speed through zero and out the other side,
  // which reads as the creature twitching backwards at the end of a throw.
  vx *= Math.max(0, 1 - AIR_DRAG_PER_S * dt);

  x += vx * dt;
  y += vy * dt;

  if (x < bounds.minX) {
    x = bounds.minX;
    vx = -vx * WALL_BOUNCE;
  } else if (x > bounds.maxX) {
    x = bounds.maxX;
    vx = -vx * WALL_BOUNCE;
  }

  if (y >= 0) {
    y = 0;
    landed = true;
    vy = -vy * FLOOR_BOUNCE;
    vx *= FLOOR_FRICTION;
    // Resting is a state, not a slow limit. Both components go to zero
    // together so it cannot end up sliding along the floor with no bounce
    // left, which looks like a bug rather than a creature.
    if (Math.abs(vy) < REST_SPEED) {
      vy = 0;
      if (Math.abs(vx) < REST_SPEED) vx = 0;
    }
  }

  return { body: { x, y, vx, vy }, landed };
}

/** Has it stopped? Only true on the floor, so a body at the top of its arc
 *  with no speed for one frame is not mistaken for a settled one. */
export function atRest(body: Body): boolean {
  return body.y === 0 && body.vx === 0 && body.vy === 0;
}
